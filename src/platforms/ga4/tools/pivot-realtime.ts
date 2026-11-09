import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { byMetric, datesMsg, datesOk, fieldName, filterFields, headerFrom, metricHeadersOf, quotaOf, quotaOut, reportHeaderShape, reportPeriod, shapeRows, toDimensionFilter, toMetricFilter, totalsOf, totalsOut, validateFields, periodFields } from "../report";
import { accountId, ga4Read } from "./common";
import { UNTRUSTED } from "./properties";
import { rowOut } from "./run-report";

// ------------------------------------------------------------------------------------------------ run_ga4_pivot_report
/** Our cap on the product of the pivot limits (Google allows 250,000; this server reads at most 10,000 cells per call). */
const PIVOT_PRODUCT_CAP = 10_000;

const pivotIn = z.object({
  dimensions: z.array(fieldName).min(1).max(4),
  limit: z.number().int().min(1).max(1000).describe("Distinct value combinations of this pivot's dimensions to return."),
  order_by_metric: fieldName.optional().describe("A requested metric to order this pivot's values by."),
  desc: z.boolean().default(true),
});

export const runGa4PivotReport = ga4Read({
  name: "run_ga4_pivot_report",
  title: "Run a GA4 pivot report",
  description: `Fetched live from Google Analytics (Data API v1beta runPivotReport). Metrics cross-tabulated by up to 3 pivots (each 1-4 dimensions with its own limit and ordering), e.g. sessions by channel × device. Names are checked against the property's metadata and Google's compatibility check first. Each pivot reports GA4's count of its values and whether it was truncated. The product of the pivot limits may be at most ${PIVOT_PRODUCT_CAP.toLocaleString("en-US")}. ${UNTRUSTED}`,
  input: z
    .object({
      account_id: accountId,
      metrics: z.array(fieldName).min(1).max(10),
      ...periodFields,
      ...filterFields,
      pivots: z.array(pivotIn).min(1).max(3),
    })
    .refine(datesOk, datesMsg)
    .refine((v) => {
      const all = v.pivots.flatMap((p) => p.dimensions);
      return new Set(all).size === all.length && all.length <= 9;
    }, { message: "each dimension may appear in one pivot only, and at most 9 dimensions in total" })
    .refine((v) => v.pivots.reduce((n, p) => n * p.limit, 1) <= PIVOT_PRODUCT_CAP, { message: `the product of the pivot limits must be at most ${PIVOT_PRODUCT_CAP}` }),
  output: z.object({
    ...reportHeaderShape,
    pivots: z.array(z.object({ dimensions: z.array(z.string()), row_count: z.number().int().describe("GA4's count of distinct values of this pivot."), returned: z.number().int(), truncated: z.boolean() })),
    rows: z.array(rowOut),
    metric_headers: z.array(z.object({ name: z.string(), type: z.string() })),
    renamed: z.array(z.object({ from: z.string(), to: z.string() })),
  }),
  handler: async (a, ctx) => {
    const ga4 = ctx.services.ga4;
    const { period, timeZone, notes } = await reportPeriod(ga4, a);
    const f = await validateFields(ga4, { dimensions: a.pivots.flatMap((p) => p.dimensions), metrics: a.metrics, dimension_filters: a.dimension_filters, metric_filters: a.metric_filters });
    const renameOf = (n: string) => f.renamed.find((r) => r.from === n)?.to ?? n;
    const pivots = a.pivots.map((p) => {
      const order = p.order_by_metric ? renameOf(p.order_by_metric) : null;
      if (order && !f.metrics.includes(order)) throw new ToolError("invalid_argument", `order_by_metric "${p.order_by_metric}" must be one of the requested metrics.`);
      return { fieldNames: p.dimensions.map(renameOf), limit: p.limit, ...(order ? { orderBys: [byMetric(order, p.desc)] } : {}) };
    });
    const dimensionFilter = toDimensionFilter(f.dimension_filters, a.dimension_filter_logic);
    const metricFilter = toMetricFilter(f.metric_filters);
    const res = await ga4.runPivotReport({
      dimensions: f.dimensions.map((name) => ({ name })),
      metrics: f.metrics.map((name) => ({ name })),
      dateRanges: [{ startDate: period.start_date, endDate: period.end_date }],
      pivots,
      ...(dimensionFilter ? { dimensionFilter } : {}),
      ...(metricFilter ? { metricFilter } : {}),
    });
    return {
      ...headerFrom(ga4, period, timeZone, notes, res),
      pivots: pivots.map((p, i) => {
        const h = res.pivotHeaders?.[i];
        const returned = h?.pivotDimensionHeaders?.length ?? 0;
        const row_count = h?.rowCount ?? returned;
        return { dimensions: p.fieldNames, row_count, returned, truncated: row_count > returned };
      }),
      rows: shapeRows(res),
      metric_headers: metricHeadersOf(res),
      renamed: f.renamed,
    };
  },
});

// ------------------------------------------------------------------------------------------------ get_ga4_realtime
const REALTIME_DIMS = ["unifiedScreenName", "country", "city", "deviceCategory", "platform", "eventName", "streamName", "minutesAgo", "audienceName"] as const;
const REALTIME_METRICS = ["activeUsers", "screenPageViews", "eventCount", "keyEvents"];
export const REALTIME_NOTE = "Realtime has no traffic-source dimension in the GA4 API; unifiedScreenName is the page title (web) or screen name (app).";

export const getGa4Realtime = ga4Read({
  name: "get_ga4_realtime",
  title: "GA4 realtime activity",
  description: `Fetched live from Google Analytics (Data API v1beta runRealtimeReport). Active users, views, events and key events in the last 1-30 minutes, broken down by up to 2 of: page title / screen (unifiedScreenName), country, city, device category, platform, event name, stream, minutes ago, audience. ${REALTIME_NOTE} ${UNTRUSTED}`,
  input: z.object({
    account_id: accountId,
    breakdown: z.array(z.enum(REALTIME_DIMS)).max(2).default(["unifiedScreenName"]),
    minutes: z.number().int().min(1).max(30).default(30).describe("The last N minutes (GA4 Standard properties allow up to 30)."),
    limit: z.number().int().min(1).max(1000).default(25),
  }),
  output: z.object({
    property: z.string(),
    minutes: z.number().int(),
    breakdown: z.array(z.string()),
    rows: z.array(rowOut),
    totals: totalsOut,
    row_count: z.number().int(),
    returned: z.number().int(),
    truncated: z.boolean(),
    quota: quotaOut,
    note: z.string(),
  }),
  handler: async (a, ctx) => {
    const ga4 = ctx.services.ga4;
    if (new Set(a.breakdown).size !== a.breakdown.length) throw new ToolError("invalid_argument", "breakdown lists a dimension twice.");
    const res = await ga4.runRealtimeReport({
      dimensions: a.breakdown.map((name) => ({ name })),
      metrics: REALTIME_METRICS.map((name) => ({ name })),
      limit: a.limit,
      metricAggregations: ["TOTAL"],
      orderBys: [byMetric("activeUsers")],
      minuteRanges: [{ startMinutesAgo: a.minutes - 1, endMinutesAgo: 0 }],
    });
    const rows = shapeRows(res);
    const row_count = res.rowCount ?? rows.length;
    return { property: ga4.property, minutes: a.minutes, breakdown: a.breakdown, rows, totals: totalsOf(res).totals, row_count, returned: rows.length, truncated: rows.length < row_count, quota: quotaOf(res.propertyQuota), note: REALTIME_NOTE };
  },
});

