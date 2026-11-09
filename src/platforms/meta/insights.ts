import { z } from "zod";
import { ToolError } from "../../mcp/errors";
import { isRealDate, ratio, round } from "../core/report-math";
import type { MetaAdsClient, MetaRow } from "./client";

/**
 * Shared helpers for every Meta Insights read (GET /{object}/insights). Checked against the Marketing API reference
 * (Ad Account Insights, Ad Campaign Group Insights, Ad Insights) for v27.0 on 2026-11-05:
 * - Periods: `date_preset` (today, yesterday, this_month, last_month, last_7d, last_14d, last_30d, ...) or
 *   `time_range={since,until}` (YYYY-MM-DD, until inclusive). Dates are in the ad account's time zone. The start date may not
 *   be more than 37 months back (error 3018).
 * - `use_unified_attribution_setting=true` reports with the ad set's attribution setting; Meta's note says to set it "to get
 *   the same behavior as in the Ads Manager".
 * - Money in insights (`spend`, `action_values`) is already in the account currency's units (e.g. "19.49"), NOT the minor
 *   units used by budgets, bids and spend caps, so it is never passed through fromMinor().
 * - `actions` / `action_values` are lists of {action_type, value}. They mix engagement (link_click, video_view, ...) with
 *   conversions, so conversions are counted only from an explicit list of conversion action types (below).
 * Not used, because they could not be confirmed in the v27 reference: insights `filtering` on campaign.id / adset.id and the
 * `omni_*` action types. Filtering is done by choosing the endpoint (/{campaign_id}/insights) or locally.
 */

/** Named periods, mapped to Meta date_preset values. The names match the Google tools' date_range values. */
export const DATE_PRESETS = {
  LAST_7_DAYS: "last_7d",
  LAST_14_DAYS: "last_14d",
  LAST_30_DAYS: "last_30d",
  THIS_MONTH: "this_month",
  LAST_MONTH: "last_month",
  YESTERDAY: "yesterday",
  TODAY: "today",
} as const;
type Preset = keyof typeof DATE_PRESETS;
const PRESET_NAMES = Object.keys(DATE_PRESETS) as [Preset, ...Preset[]];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, "not a real date");
export const insightsDateFields = {
  date_range: z.enum(PRESET_NAMES).default("LAST_30_DAYS").describe("Named period, evaluated in the ad account's time zone (last N days exclude today)."),
  start_date: day.optional().describe("Explicit start date (YYYY-MM-DD, ad account time zone). Use with end_date; overrides date_range. At most 37 months back."),
  end_date: day.optional().describe("Explicit end date (YYYY-MM-DD, inclusive, ad account time zone). Not in the future."),
};
export const datesOk = (v: { start_date?: string; end_date?: string }) => (v.start_date === undefined) === (v.end_date === undefined);
export const datesMsg = { message: "start_date and end_date must be given together" };

export { todayIn } from "../core/report-math";
import { todayIn } from "../core/report-math";

const monthsBack = (d: string, months: number): string => {
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 - months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(dd, last))).toISOString().slice(0, 10);
};

/** The period as Meta parameters plus a label for the output. Validates order, future end dates and the 37-month limit. */
export function insightsPeriod(v: { date_range: Preset; start_date?: string; end_date?: string }, timeZone: string | null, now = new Date()): { params: Record<string, string>; period: string } {
  if (v.start_date && v.end_date) {
    if (v.start_date > v.end_date) throw new ToolError("invalid_argument", "start_date must not be after end_date");
    const today = todayIn(timeZone, now);
    if (v.end_date > today) throw new ToolError("invalid_argument", `end_date ${v.end_date} is in the future (today is ${today} in the ad account's time zone).`);
    const earliest = monthsBack(today, 37);
    if (v.start_date < earliest) throw new ToolError("invalid_argument", `Meta keeps insights for 37 months: start_date must be on or after ${earliest}.`);
    return { params: { time_range: JSON.stringify({ since: v.start_date, until: v.end_date }) }, period: `${v.start_date}..${v.end_date}` };
  }
  return { params: { date_preset: DATE_PRESETS[v.date_range] }, period: v.date_range };
}

// ---------------------------------------------------------------------------------------------------------------
// Conversions. Standard action types from the Insights / Meta Pixel / App Events references.

/** Shorthands for conversion_action. Each expands to website (Pixel / Conversions API) and app events of that kind. */
export const CONVERSION_GROUPS: Record<string, string[]> = {
  purchase: ["offsite_conversion.fb_pixel_purchase", "app_custom_event.fb_mobile_purchase"],
  lead: ["offsite_conversion.fb_pixel_lead"],
  complete_registration: ["offsite_conversion.fb_pixel_complete_registration", "app_custom_event.fb_mobile_complete_registration"],
};
/** Counted as conversions when no conversion_action is given. Engagement (clicks, video views, post engagement) never is. */
export const DEFAULT_CONVERSION_TYPES = [...new Set(Object.values(CONVERSION_GROUPS).flat())];

export const conversionActionInput = z
  .string()
  .regex(/^[a-z0-9_.]{1,120}$/, "an action type such as purchase or offsite_conversion.fb_pixel_purchase")
  .optional()
  .describe(
    `Which conversions to count: purchase, lead or complete_registration (website Pixel/Conversions API plus app events of that kind), or one exact Meta action_type such as offsite_conversion.fb_pixel_purchase or offsite_conversion.custom.<id>. Default: ${DEFAULT_CONVERSION_TYPES.join(", ")}.`,
  );

export function conversionTypes(action?: string): string[] {
  return action ? (CONVERSION_GROUPS[action] ?? [action]) : DEFAULT_CONVERSION_TYPES;
}

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Sum of the values in an actions / action_values list for the given action types. */
export function sumActions(list: unknown, types: readonly string[]): number {
  if (!Array.isArray(list)) return 0;
  const want = new Set(types);
  return list.reduce((acc: number, a) => (a && typeof a === "object" && want.has(String((a as MetaRow).action_type)) ? acc + n((a as MetaRow).value) : acc), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Metrics

const Money = z.number().describe("In the account's currency (Meta reports insights money in currency units, not minor units).");
export const metricsShape = {
  spend: Money,
  impressions: z.number(),
  reach: z.number().nullable().describe("Unique people reached (Meta's estimate). Not additive across rows."),
  frequency: z.number().nullable().describe("Average times each person saw the ad (Meta's estimate)."),
  clicks: z.number().describe("All clicks, as Meta counts them."),
  inline_link_clicks: z.number(),
  ctr: z.number().nullable().describe("clicks / impressions as a fraction (Ads Manager shows it as a percentage), or null with no impressions."),
  cpc: Money.nullable().describe("spend / clicks, or null with no clicks."),
  cpm: Money.nullable().describe("spend / impressions x 1000, or null with no impressions."),
  conversions: z.number().describe("Sum of the action types listed in conversion_types."),
  cost_per_conversion: Money.nullable().describe("spend / conversions, or null with no conversions."),
  conversion_value: Money.describe("Sum of action_values for the same action types."),
  roas: z.number().nullable().describe("conversion_value / spend, or null with no spend."),
};
export type Metrics = { [K in keyof typeof metricsShape]: z.infer<(typeof metricsShape)[K]> };

/** Ratios are computed here from the base numbers (the same way as the Google tools), never taken from Meta's rounded fields. */
export function computeMetrics(b: { spend: number; impressions: number; clicks: number; inline_link_clicks: number; conversions: number; conversion_value: number; reach: number | null; frequency: number | null }): Metrics {
  return {
    spend: round(b.spend, 2)!,
    impressions: b.impressions,
    reach: b.reach,
    frequency: round(b.frequency, 4),
    clicks: b.clicks,
    inline_link_clicks: b.inline_link_clicks,
    ctr: round(ratio(b.clicks, b.impressions)),
    cpc: round(ratio(b.spend, b.clicks), 2),
    cpm: round(ratio(b.spend * 1000, b.impressions), 2),
    conversions: round(b.conversions, 2)!,
    cost_per_conversion: round(ratio(b.spend, b.conversions), 2),
    conversion_value: round(b.conversion_value, 2)!,
    roas: round(ratio(b.conversion_value, b.spend)),
  };
}

const opt = (v: unknown): number | null => (v === undefined || v === null || v === "" ? null : n(v));

/** Base numbers of one insights row. */
export function baseOf(row: MetaRow, types: readonly string[]) {
  return {
    spend: n(row.spend),
    impressions: n(row.impressions),
    clicks: n(row.clicks),
    inline_link_clicks: n(row.inline_link_clicks),
    conversions: sumActions(row.actions, types),
    conversion_value: sumActions(row.action_values, types),
    reach: opt(row.reach),
    frequency: opt(row.frequency),
  };
}

export const metricsOf = (row: MetaRow, types: readonly string[]): Metrics => computeMetrics(baseOf(row, types));

// ---------------------------------------------------------------------------------------------------------------
// Fetching

export const METRIC_FIELDS = ["spend", "impressions", "reach", "frequency", "clicks", "inline_link_clicks", "actions", "action_values"];
const LEVEL_FIELDS = {
  account: [],
  campaign: ["campaign_id", "campaign_name"],
  adset: ["campaign_id", "campaign_name", "adset_id", "adset_name"],
  ad: ["campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name"],
} as const;
export type InsightsLevel = keyof typeof LEVEL_FIELDS;

/** Most insights rows read for one call. Above this the result says truncated. */
export const INSIGHTS_ROW_CAP = 2_000;

/**
 * Reads insights for `objectPath` ("act_..." or an owned campaign id) at `level`, following cursor paging up to `cap` rows.
 * Always sends use_unified_attribution_setting=true. `daily` adds time_increment=1 (one row per object per day).
 */
export async function fetchInsights(m: MetaAdsClient, o: { objectPath: string; level: InsightsLevel; period: Record<string, string>; daily?: boolean; cap?: number; breakdowns?: readonly string[] }): Promise<{ rows: MetaRow[]; truncated: boolean }> {
  const cap = o.cap ?? INSIGHTS_ROW_CAP;
  const rows = await m.list(
    `${o.objectPath}/insights`,
    {
      level: o.level,
      fields: [...LEVEL_FIELDS[o.level], ...METRIC_FIELDS].join(","),
      use_unified_attribution_setting: "true",
      time_increment: o.daily ? "1" : "all_days",
      ...(o.breakdowns?.length ? { breakdowns: o.breakdowns.join(",") } : {}),
      ...o.period,
    },
    cap + 1,
  );
  return { rows: rows.slice(0, cap), truncated: rows.length > cap };
}

export const conversionTypesOutput = z.array(z.string()).describe("The action types counted as conversions.");
export const attributionNote = "Unified attribution setting (the ad sets' own attribution windows), matching Ads Manager.";

// ---------------------------------------------------------------------------------------------------------------
// Breakdowns. Values and valid combinations from "Insights API Breakdowns" (v27, updated 2026-10-15): single breakdowns from the
// `breakdowns` enum, and the documented combinations age+gender and publisher_platform+platform_position. The same page says
// `region` no longer returns off-Meta action metrics, so conversions are reported as unavailable for it.
export const BREAKDOWNS = {
  age: ["age"],
  gender: ["gender"],
  age_gender: ["age", "gender"],
  country: ["country"],
  region: ["region"],
  publisher_platform: ["publisher_platform"],
  placement: ["publisher_platform", "platform_position"],
  device_platform: ["device_platform"],
} as const;
export type BreakdownName = keyof typeof BREAKDOWNS;
export const breakdownInput = z.enum(Object.keys(BREAKDOWNS) as [BreakdownName, ...BreakdownName[]]).describe("age, gender, age_gender, country, region, publisher_platform, placement (publisher_platform + platform_position) or device_platform.");
/** Breakdowns for which Meta does not return off-Meta conversions (Insights API Breakdowns, "Type 1"). */
export const NO_CONVERSIONS: readonly BreakdownName[] = ["region"];
export const segmentOf = (row: MetaRow, b: BreakdownName): Record<string, string | null> => Object.fromEntries(BREAKDOWNS[b].map((k) => [k, row[k] === undefined || row[k] === null ? null : String(row[k])]));
export const segmentLabel = (seg: Record<string, string | null>) => Object.values(seg).map((v) => v ?? "unknown").join(" / ");

/** Base figures added up over rows (reach and frequency are not additive and are left out). */
export function sumBase(rows: MetaRow[], types: readonly string[]) {
  const t = { spend: 0, impressions: 0, clicks: 0, inline_link_clicks: 0, conversions: 0, conversion_value: 0, reach: null as number | null, frequency: null as number | null };
  for (const r of rows) {
    const b = baseOf(r, types);
    t.spend += b.spend;
    t.impressions += b.impressions;
    t.clicks += b.clicks;
    t.inline_link_clicks += b.inline_link_clicks;
    t.conversions += b.conversions;
    t.conversion_value += b.conversion_value;
  }
  return t;
}

/** YYYY-MM-DD plus n days (n may be negative). */
export function addDays(d: string, n: number): string {
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
}

/** An explicit period input ({start_date, end_date}) for tools that compare two periods. */
export const periodInput = z
  .object({ start_date: day.describe("YYYY-MM-DD, ad account time zone."), end_date: day.describe("YYYY-MM-DD, inclusive.") })
  .refine((p) => p.start_date <= p.end_date, "start_date must not be after end_date");
/** time_range params for an explicit period, with the same checks as insightsPeriod (future end date, 37-month limit). */
export const rangeParams = (p: { start_date: string; end_date: string }, timeZone: string | null, now = new Date()) => insightsPeriod({ date_range: "LAST_30_DAYS", ...p }, timeZone, now).params;

/** The fields every insights report starts with: the period read, the attribution used and which actions count as conversions. */
export const reportHeaderShape = { period: z.string(), attribution: z.string(), conversion_types: conversionTypesOutput };

/** Common start of an insights handler: request period, conversion types, and the report header to return. */
export function reportStart(a: { date_range: Preset; start_date?: string; end_date?: string; conversion_action?: string }, timeZone: string | null) {
  const { params, period } = insightsPeriod(a, timeZone);
  const types = conversionTypes(a.conversion_action);
  return { params, period, types, header: { period, attribution: attributionNote, conversion_types: types } };
}
