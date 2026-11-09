import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { datesMsg, datesOk, dataQualityOut, eventName, fieldName, headerFrom, indexMetadata, num, periodFields, periodOut, quotaOut, reportPeriod } from "../report";
import type { FunnelStep } from "../types";
import { accountId, ga4Read } from "./common";
import { UNTRUSTED } from "./properties";

/**
 * run_ga4_funnel_report: Data API v1alpha runFunnelReport. Google labels it alpha ("expect breaking changes"), so it lives in
 * its own file, says so in its output, and no combined tool depends on it. Reduced, honest input: each step is one event.
 */
const ALPHA_NOTE = "Google's alpha API: syntax and results may change";
/** GA4 returns the totals of a broken-down funnel as extra rows whose breakdown value is this. */
const RESERVED_TOTAL = "RESERVED_TOTAL";
const stepOut = z.object({
  step: z.string().describe("GA4's funnelStepName, passed through."),
  breakdown: z.string().nullable(),
  active_users: z.number().nullable(),
  completion_rate: z.number().nullable(),
  abandonments: z.number().nullable(),
  abandonment_rate: z.number().nullable(),
});

export const runGa4FunnelReport = ga4Read({
  name: "run_ga4_funnel_report",
  title: "Run a GA4 funnel report (alpha API)",
  description: `Fetched live from Google Analytics (Data API v1alpha runFunnelReport: ${ALPHA_NOTE}). How many users completed each step of a funnel of 2-10 events (e.g. view_item → add_to_cart → purchase), with completion and abandonment per step, optionally broken down by one dimension. With a breakdown, steps[] has one row per step and breakdown value (only the first breakdown_limit values), and GA4's per-step totals across all values are in step_totals[], never in steps[]: do not add the breakdown rows up to get a total. A closed funnel counts only users who entered at step 1; steps can require being directly followed or a maximum time since the previous step. ${UNTRUSTED}`,
  input: z
    .object({
      account_id: accountId,
      ...periodFields,
      steps: z
        .array(
          z.object({
            name: z.string().min(1).max(100),
            event_name: eventName,
            directly_followed: z.boolean().default(false).describe("This step must directly follow the previous one."),
            within_seconds: z.number().int().min(1).max(31_536_000).optional().describe("Maximum time since the previous step."),
          }),
        )
        .min(2)
        .max(10),
      open_funnel: z.boolean().default(false).describe("Open funnel: users may enter at any step."),
      breakdown_dimension: fieldName.optional(),
      breakdown_limit: z.number().int().min(1).max(15).default(5),
    })
    .refine(datesOk, datesMsg)
    .refine((v) => !v.steps[0]!.directly_followed && v.steps[0]!.within_seconds === undefined, { message: "the first step cannot set directly_followed or within_seconds" }),
  output: z.object({
    api_version: z.literal("v1alpha"),
    api_note: z.string(),
    property: z.string(),
    period: periodOut,
    time_zone: z.string().nullable(),
    breakdown_dimension: z.string().nullable(),
    steps: z.array(stepOut).describe("One row per step (and breakdown value). GA4's RESERVED_TOTAL rows are not here; they are in step_totals."),
    step_totals: z
      .array(stepOut.omit({ breakdown: true }))
      .describe("With a breakdown: GA4's per-step totals across all breakdown values (its RESERVED_TOTAL rows). Empty without a breakdown, where steps[] already holds the totals."),
    data_quality: dataQualityOut,
    quota: quotaOut,
  }),
  handler: async (a, ctx) => {
    const ga4 = ctx.services.ga4;
    const { period, timeZone, notes } = await reportPeriod(ga4, a);
    let breakdown: string | null = null;
    if (a.breakdown_dimension) {
      const idx = indexMetadata(await ga4.getMetadata());
      breakdown = idx.dims.get(a.breakdown_dimension) ?? null;
      if (!breakdown) throw new ToolError("invalid_argument", `Unknown dimension "${a.breakdown_dimension}" for this property. get_ga4_metadata lists the valid names.`);
    }
    const steps: FunnelStep[] = a.steps.map((s) => ({
      name: s.name,
      ...(s.directly_followed ? { isDirectlyFollowedBy: true } : {}),
      ...(s.within_seconds !== undefined ? { withinDurationFromPriorStep: `${s.within_seconds}s` } : {}),
      filterExpression: { funnelEventFilter: { eventName: s.event_name } },
    }));
    const res = await ga4.runFunnelReport({
      dateRanges: [{ startDate: period.start_date, endDate: period.end_date }],
      funnel: { isOpenFunnel: a.open_funnel, steps },
      ...(breakdown ? { funnelBreakdown: { breakdownDimension: { name: breakdown }, limit: String(a.breakdown_limit) } } : {}),
      funnelVisualizationType: "STANDARD_FUNNEL",
    });
    const t = res.funnelTable ?? {};
    const dn = (t.dimensionHeaders ?? []).map((h) => h.name ?? "");
    const mn = (t.metricHeaders ?? []).map((h) => h.name ?? "");
    const header = headerFrom(ga4, period, timeZone, notes, { metadata: { samplingMetadatas: t.metadata?.samplingMetadatas }, propertyQuota: res.propertyQuota });
    // Columns are mapped by header name, never by position.
    const col = (r: (typeof rows)[number], name: string) => {
      const i = mn.indexOf(name);
      return i < 0 ? null : num(r.metricValues?.[i]?.value);
    };
    const dimVal = (r: (typeof rows)[number], name: string) => {
      const i = dn.indexOf(name);
      return i < 0 ? null : (r.dimensionValues?.[i]?.value ?? null);
    };
    const rows = t.rows ?? [];
    const shaped = rows.map((r) => ({
      step: dimVal(r, "funnelStepName") ?? "",
      breakdown: breakdown ? dimVal(r, breakdown) : null,
      active_users: col(r, "activeUsers"),
      completion_rate: col(r, "funnelStepCompletionRate"),
      abandonments: col(r, "funnelStepAbandonments"),
      abandonment_rate: col(r, "funnelStepAbandonmentRate"),
    }));
    const isTotal = (s: (typeof shaped)[number]) => breakdown !== null && s.breakdown === RESERVED_TOTAL;
    const stepRows = shaped.filter((s) => !isTotal(s));
    const step_totals = shaped.filter(isTotal).map(({ breakdown: _b, ...rest }) => rest);
    if (breakdown) {
      const values = new Set(stepRows.map((s) => s.breakdown));
      if (values.size >= a.breakdown_limit)
        header.data_quality.notes.push(
          `Only the first ${a.breakdown_limit} values of ${breakdown} are shown (breakdown_limit); other values are left out, so the breakdown rows of a step may not add up to its total in step_totals.`,
        );
    }
    return {
      api_version: "v1alpha" as const,
      api_note: ALPHA_NOTE,
      property: ga4.property,
      period,
      time_zone: header.time_zone,
      breakdown_dimension: breakdown,
      steps: stepRows,
      step_totals,
      data_quality: header.data_quality,
      quota: header.quota,
    };
  },
});
