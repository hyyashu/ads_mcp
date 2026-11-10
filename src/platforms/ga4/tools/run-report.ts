import { z } from "zod";
import { HARD_ROW_CAP } from "../../gapi/client";
import { datesOk, datesMsg, day, fieldName, filterFields, metricMap, periodFields, reportHeaderShape, runGa4Report, totalsOut } from "../report";
import { accountId, ga4Read } from "./common";
import { UNTRUSTED } from "./properties";

export const rowOut = z.object({ dimensions: z.record(z.string(), z.string()), metrics: metricMap });

export const runGa4ReportTool = ga4Read({
  name: "run_ga4_report",
  title: "Run a GA4 report",
  description: `Fetched live from Google Analytics (Data API v1beta runReport). Any dimensions (up to 9) and metrics (up to 10) for a period in the property's time zone, with filters, ordering, paging and an optional comparison range. Names are checked against the property's metadata and Google's compatibility check first (unknown names get suggestions; GA4 calls conversions "key events"). Totals are GA4's totals over all rows. The response flags sampling, thresholding and the "(other)" row. ${UNTRUSTED}`,
  input: z
    .object({
      account_id: accountId,
      dimensions: z.array(fieldName).max(9).default([]),
      metrics: z.array(fieldName).min(1).max(10),
      ...periodFields,
      compare_start_date: day.optional().describe("Second range to compare with (YYYY-MM-DD). Use with compare_end_date. Rows then carry a dateRange dimension (date_range_0 = main period, date_range_1 = comparison)."),
      compare_end_date: day.optional(),
      ...filterFields,
      order_by: z.array(z.object({ field: fieldName, desc: z.boolean().default(true), numeric: z.boolean().default(false).describe("Dimensions only: order numerically.") })).max(3).optional().describe("Default: first metric, descending."),
      limit: z.number().int().min(1).max(HARD_ROW_CAP).default(1000),
      offset: z.number().int().min(0).default(0).describe("Row offset for paging (use next_offset)."),
      include_totals: z.boolean().default(true),
      keep_empty_rows: z.boolean().default(false).describe("Keep rows whose metrics are all zero (GA4 omits them by default)."),
    })
    .refine(datesOk, datesMsg)
    .refine((v) => (v.compare_start_date === undefined) === (v.compare_end_date === undefined), { message: "compare_start_date and compare_end_date must be given together" }),
  output: z.object({
    ...reportHeaderShape,
    periods: z.array(z.object({ name: z.string(), start_date: z.string(), end_date: z.string() })),
    dimensions: z.array(z.string()),
    metrics: z.array(z.string()),
    renamed: z.array(z.object({ from: z.string(), to: z.string() })).describe("Deprecated names replaced by their current name."),
    rows: z.array(rowOut),
    metric_headers: z.array(z.object({ name: z.string(), type: z.string() })),
    totals: totalsOut,
    totals_by_range: z.record(z.string(), metricMap).nullable(),
    row_count: z.number().int(),
    returned: z.number().int(),
    offset: z.number().int(),
    truncated: z.boolean(),
    next_offset: z.number().int().nullable(),
  }),
  handler: (a, ctx) =>
    runGa4Report(ctx.services.ga4, {
      dimensions: a.dimensions,
      metrics: a.metrics,
      period: a,
      ...(a.compare_start_date && a.compare_end_date ? { compare: { start_date: a.compare_start_date, end_date: a.compare_end_date } } : {}),
      dimension_filters: a.dimension_filters,
      dimension_filter_logic: a.dimension_filter_logic,
      metric_filters: a.metric_filters,
      order_by: a.order_by,
      limit: a.limit,
      offset: a.offset,
      include_totals: a.include_totals,
      keep_empty_rows: a.keep_empty_rows,
    }),
});
