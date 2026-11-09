import { z } from "zod";
import { ToolError } from "../../mcp/errors";
import { isRealDate, round, todayIn } from "../core/report-math";
import { HARD_ROW_CAP } from "../gapi/client";
import type { Ga4Client } from "./client";
import type { FilterExpression, Ga4Filter, StringMatchType, Ga4Metadata, Ga4Row, MetricMetadata, NumericValue, OrderBy, PropertyQuota, ResponseMetaData, RunReportBody, RunReportResponse } from "./types";

/**
 * Shared GA4 report machinery (Data API v1beta, checked 2026-11-10; facts in docs/VERIFICATION.md "GA4 tools (2026-11-10)").
 *
 * - Periods are always resolved to explicit YYYY-MM-DD dates in the property's reporting time zone, so every response states
 *   the exact days used. LAST_N_DAYS = N complete days ending yesterday (GA's `NdaysAgo`..`yesterday`).
 * - Field names are checked against the property's live metadata (no cache) and Google's checkCompatibility before a
 *   generic report runs: unknown names get suggestions, deprecated names are renamed and reported, blocked cost/revenue
 *   metrics are refused, incompatible combinations are refused before any report call.
 * - Responses keep GA4's flags visible: sampling, thresholding, the "(other)" row, empty reasons and the property quota.
 *   Metric strings are parsed with Number; anything non-numeric is null, never 0. "(not set)" and "(other)" rows are kept.
 * - Lists are never cut silently: `row_count` is GA4's count of all rows, `truncated` says when more exist than were returned.
 * The public entry points for other builders (combined tools) are re-exported, with signatures, from ./api.ts.
 */

// ------------------------------------------------------------------------------------------------ names
/** A GA4 API name: `sessions`, `customEvent:plan_type`, `sessionKeyEventRate:purchase`. */
export const fieldName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,99}(:[A-Za-z0-9_[\]]{1,100})?$/, "not a GA4 dimension or metric API name")
  .describe("GA4 API name, e.g. sessionSource, sessions, customEvent:plan_type (see get_ga4_metadata).");

/** Event names as this server accepts them (conservative: letter first, letters/digits/underscore, at most 40). */
export const eventName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "event names start with a letter and use letters, digits and underscores (at most 40)");

// ------------------------------------------------------------------------------------------------ periods
export const GA4_DATE_RANGES = ["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_14_DAYS", "LAST_28_DAYS", "LAST_30_DAYS", "LAST_90_DAYS", "THIS_MONTH", "LAST_MONTH"] as const;
export type Ga4DateRangeName = (typeof GA4_DATE_RANGES)[number];

export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").refine(isRealDate, "not a real date");

/** Spread into a tool's input. Pair with `.refine(datesOk, datesMsg)` on the object. */
export const periodFields = {
  date_range: z.enum(GA4_DATE_RANGES).default("LAST_28_DAYS").describe("Named period in the property's time zone. LAST_N_DAYS are N complete days ending yesterday."),
  start_date: day.optional().describe("Explicit start (YYYY-MM-DD, property time zone). Use with end_date; overrides date_range."),
  end_date: day.optional().describe("Explicit end (YYYY-MM-DD, inclusive, property time zone). Not after today."),
};
export const datesOk = (v: { start_date?: string; end_date?: string }) => (v.start_date === undefined) === (v.end_date === undefined);
const DATES_TOGETHER = "start_date and end_date must be given together";
/** For `.refine(datesOk, datesMsg)`. zod rewrites the params object it is given, so code never reads datesMsg back. */
export const datesMsg = { message: DATES_TOGETHER };

export interface PeriodInput {
  date_range: Ga4DateRangeName;
  start_date?: string;
  end_date?: string;
}
export interface ResolvedPeriod {
  start_date: string;
  end_date: string;
  label: string;
}

export function addDays(d: string, n: number): string {
  const t = Date.parse(`${d}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const LAST_N: Partial<Record<Ga4DateRangeName, number>> = { LAST_7_DAYS: 7, LAST_14_DAYS: 14, LAST_28_DAYS: 28, LAST_30_DAYS: 30, LAST_90_DAYS: 90 };

/**
 * The period as explicit dates in the property time zone `tz`. With an unknown zone, LAST_N/TODAY/YESTERDAY are sent in GA's
 * relative form (evaluated by Google in the property's zone); calendar months cannot be, so they are refused.
 */
export function resolvePeriod(v: PeriodInput, tz: string | null, now = new Date()): ResolvedPeriod {
  const today = todayIn(tz, now);
  if (v.start_date !== undefined || v.end_date !== undefined) {
    if (!v.start_date || !v.end_date) throw new ToolError("invalid_argument", DATES_TOGETHER);
    if (v.start_date > v.end_date) throw new ToolError("invalid_argument", "start_date must not be after end_date.");
    if (v.end_date > today) throw new ToolError("invalid_argument", `end_date ${v.end_date} is in the future (today is ${today} in the property's time zone${tz ? `, ${tz}` : ""}).`);
    return { start_date: v.start_date, end_date: v.end_date, label: `${v.start_date}..${v.end_date}` };
  }
  const n = LAST_N[v.date_range];
  if (!tz) {
    if (n) return { start_date: `${n}daysAgo`, end_date: "yesterday", label: v.date_range };
    if (v.date_range === "TODAY") return { start_date: "today", end_date: "today", label: v.date_range };
    if (v.date_range === "YESTERDAY") return { start_date: "yesterday", end_date: "yesterday", label: v.date_range };
    throw new ToolError("invalid_argument", "The property's time zone is unknown, so calendar months cannot be resolved. Use start_date and end_date.");
  }
  const yesterday = addDays(today, -1);
  if (n) return { start_date: addDays(today, -n), end_date: yesterday, label: v.date_range };
  if (v.date_range === "TODAY") return { start_date: today, end_date: today, label: v.date_range };
  if (v.date_range === "YESTERDAY") return { start_date: yesterday, end_date: yesterday, label: v.date_range };
  const first = `${today.slice(0, 7)}-01`;
  if (v.date_range === "THIS_MONTH") return { start_date: first, end_date: today, label: v.date_range };
  const lastOfPrev = addDays(first, -1);
  return { start_date: `${lastOfPrev.slice(0, 7)}-01`, end_date: lastOfPrev, label: v.date_range };
}

/** The property's reporting time zone: stored at connect, else read once from properties.get, else null. */
export async function propertyTimeZone(ga4: Ga4Client): Promise<string | null> {
  if (ga4.timeZone) return ga4.timeZone;
  return (await ga4.getProperty()).timeZone ?? null;
}

/** Resolves a period for a report on `ga4`, with the notes the response must carry. */
export async function reportPeriod(ga4: Ga4Client, v: PeriodInput, now = new Date()): Promise<{ period: ResolvedPeriod; timeZone: string | null; notes: string[] }> {
  const timeZone = await propertyTimeZone(ga4);
  const period = resolvePeriod(v, timeZone, now);
  const notes = timeZone ? [] : ["The property's time zone is unknown here, so GA4 resolved the relative dates itself in the property's time zone."];
  return { period, timeZone, notes };
}

/** A note when the property now reports in a different zone than the one the dates were resolved in. */
export function zoneNotes(used: string | null, reported: string | undefined): string[] {
  return used && reported && used !== reported ? [`Dates were resolved in ${used}, but the property now reports in ${reported} (changed since connect; reconnect to refresh).`] : [];
}

// ------------------------------------------------------------------------------------------------ filters
export const dimFilterInput = z
  .object({
    field: fieldName,
    match: z.enum(["exact", "begins_with", "ends_with", "contains", "full_regexp", "partial_regexp", "in_list", "empty"]),
    value: z.string().max(500).optional().describe("Required unless match is in_list or empty."),
    values: z.array(z.string().max(500)).min(1).max(50).optional().describe("in_list only."),
    case_sensitive: z.boolean().default(false),
    negate: z.boolean().default(false).describe("True keeps the rows that do NOT match."),
  })
  .superRefine((f, c) => {
    if (f.match === "in_list" ? !f.values : f.match === "empty" ? f.value !== undefined || f.values !== undefined : f.value === undefined || f.values !== undefined)
      c.addIssue({ code: "custom", message: `match ${f.match} needs ${f.match === "in_list" ? "values (and no value)" : f.match === "empty" ? "neither value nor values" : "value (and no values)"}` });
  });
export type DimFilterIn = z.infer<typeof dimFilterInput>;

export const metricFilterInput = z
  .object({
    field: fieldName,
    op: z.enum(["eq", "lt", "lte", "gt", "gte", "between"]),
    value: z.number().finite(),
    to_value: z.number().finite().optional().describe("between only (inclusive upper bound)."),
  })
  .superRefine((f, c) => {
    if ((f.op === "between") !== (f.to_value !== undefined)) c.addIssue({ code: "custom", message: "to_value is required with between and only with between" });
  });
export type MetricFilterIn = z.infer<typeof metricFilterInput>;

export const filterFields = {
  dimension_filters: z.array(dimFilterInput).max(10).optional().describe("Filters on dimensions (applied before aggregation)."),
  dimension_filter_logic: z.enum(["and", "or"]).default("and").describe("How dimension_filters combine."),
  metric_filters: z.array(metricFilterInput).max(5).optional().describe("Filters on metrics, applied after aggregation (like SQL HAVING); always ANDed."),
};

const MATCH: Record<string, StringMatchType> = {
  exact: "EXACT",
  begins_with: "BEGINS_WITH",
  ends_with: "ENDS_WITH",
  contains: "CONTAINS",
  full_regexp: "FULL_REGEXP",
  partial_regexp: "PARTIAL_REGEXP",
};
const OP = { eq: "EQUAL", lt: "LESS_THAN", lte: "LESS_THAN_OR_EQUAL", gt: "GREATER_THAN", gte: "GREATER_THAN_OR_EQUAL" } as const;

/** Integers as int64Value (a string in JSON), others as doubleValue. */
export const numericValue = (n: number): NumericValue => (Number.isInteger(n) ? { int64Value: String(n) } : { doubleValue: n });

function dimFilter(f: DimFilterIn): FilterExpression {
  const filter: Ga4Filter =
    f.match === "in_list"
      ? { fieldName: f.field, inListFilter: { values: f.values!, caseSensitive: f.case_sensitive } }
      : f.match === "empty"
        ? { fieldName: f.field, emptyFilter: {} }
        : { fieldName: f.field, stringFilter: { matchType: MATCH[f.match]!, value: f.value!, caseSensitive: f.case_sensitive } };
  return f.negate ? { notExpression: { filter } } : { filter };
}

function metricFilter(f: MetricFilterIn): FilterExpression {
  if (f.op === "between") return { filter: { fieldName: f.field, betweenFilter: { fromValue: numericValue(f.value), toValue: numericValue(f.to_value!) } } };
  return { filter: { fieldName: f.field, numericFilter: { operation: OP[f.op], value: numericValue(f.value) } } };
}

/** One expression → itself; several → andGroup / orGroup. */
export function combine(list: FilterExpression[], logic: "and" | "or" = "and"): FilterExpression | undefined {
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  return logic === "and" ? { andGroup: { expressions: list } } : { orGroup: { expressions: list } };
}
export const toDimensionFilter = (fs: DimFilterIn[] | undefined, logic: "and" | "or" = "and") => combine((fs ?? []).map(dimFilter), logic);
export const toMetricFilter = (fs: MetricFilterIn[] | undefined) => combine((fs ?? []).map(metricFilter), "and");

/** Simple string filter used by the fixed-shape tools. */
export const stringFilter = (fieldName: string, matchType: "EXACT" | "CONTAINS" | "BEGINS_WITH", value: string, caseSensitive = false): FilterExpression => ({ filter: { fieldName, stringFilter: { matchType, value, caseSensitive } } });
export const inListFilter = (fieldName: string, values: string[]): FilterExpression => ({ filter: { fieldName, inListFilter: { values, caseSensitive: true } } });

// ------------------------------------------------------------------------------------------------ field validation
/** GA4 renamed "conversions" to "key events"; old names give a fixed hint when the property's metadata does not know them. */
const RENAMED_HINT: Record<string, string> = { conversions: "keyEvents", sessionConversionRate: "sessionKeyEventRate", userConversionRate: "userKeyEventRate" };

interface MetaIndex {
  dims: Map<string, string>; // apiName or deprecated name → apiName
  mets: Map<string, string>;
  metrics: Map<string, MetricMetadata>;
  dimList: { apiName: string; uiName: string }[];
  metList: { apiName: string; uiName: string }[];
}

export function indexMetadata(m: Ga4Metadata): MetaIndex {
  const dims = new Map<string, string>();
  const mets = new Map<string, string>();
  const metrics = new Map<string, MetricMetadata>();
  for (const d of m.dimensions ?? []) if (d.apiName) dims.set(d.apiName, d.apiName);
  for (const x of m.metrics ?? []) if (x.apiName) (mets.set(x.apiName, x.apiName), metrics.set(x.apiName, x));
  // Deprecated names only where they do not shadow a current name.
  for (const d of m.dimensions ?? []) for (const old of d.deprecatedApiNames ?? []) if (d.apiName && !dims.has(old)) dims.set(old, d.apiName);
  for (const x of m.metrics ?? []) for (const old of x.deprecatedApiNames ?? []) if (x.apiName && !mets.has(old)) mets.set(old, x.apiName);
  const list = (xs: { apiName?: string; uiName?: string }[] | undefined) => (xs ?? []).filter((x) => x.apiName).map((x) => ({ apiName: x.apiName!, uiName: x.uiName ?? "" }));
  return { dims, mets, metrics, dimList: list(m.dimensions), metList: list(m.metrics) };
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** Up to 3 names that look like `name`: prefix or substring matches on apiName / uiName first, then close spellings. */
export function suggest(name: string, list: { apiName: string; uiName: string }[]): string[] {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n) return [];
  const rank = (x: { apiName: string; uiName: string }): number | null => {
    const a = x.apiName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const u = x.uiName.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (a.startsWith(n) || u.startsWith(n)) return 0;
    if (a.includes(n) || u.includes(n)) return 1;
    const d = Math.min(editDistance(n, a), editDistance(n, u));
    return d <= Math.max(2, Math.floor(n.length / 4)) ? 1 + d : null;
  };
  return list
    .map((x) => ({ x, r: rank(x) }))
    .filter((y): y is { x: { apiName: string; uiName: string }; r: number } => y.r !== null)
    .sort((p, q) => p.r - q.r || p.x.apiName.length - q.x.apiName.length || p.x.apiName.localeCompare(q.x.apiName))
    .slice(0, 3)
    .map((y) => y.x.apiName);
}

export interface FieldRequest {
  dimensions: string[];
  metrics: string[];
  dimension_filters?: DimFilterIn[];
  metric_filters?: MetricFilterIn[];
  order_by?: { field: string; desc: boolean; numeric: boolean }[];
}
export interface CheckedFields extends Required<Omit<FieldRequest, "order_by">> {
  order_by: { field: string; desc: boolean; numeric: boolean }[];
  renamed: { from: string; to: string }[];
}

const BLOCK_WORD: Record<string, string> = { NO_COST_METRICS: "cost", NO_REVENUE_METRICS: "revenue" };

/**
 * Checks every name of a generic report against the property's metadata and Google's compatibility check.
 * Throws invalid_argument (unknown, misplaced, incompatible) or platform_permission_denied (blocked metrics).
 */
export async function validateFields(ga4: Ga4Client, req: FieldRequest): Promise<CheckedFields> {
  const idx = indexMetadata(await ga4.getMetadata());
  const renamed: { from: string; to: string }[] = [];
  const resolve = (kind: "dimension" | "metric", name: string): string => {
    const own = kind === "dimension" ? idx.dims : idx.mets;
    const hit = own.get(name);
    if (hit) {
      if (hit !== name && !renamed.some((r) => r.from === name)) renamed.push({ from: name, to: hit });
      return hit;
    }
    const other = kind === "dimension" ? idx.mets : idx.dims;
    if (other.has(name)) throw new ToolError("invalid_argument", `"${name}" is a ${kind === "dimension" ? "metric" : "dimension"}, not a ${kind}${kind === "dimension" ? " (use it in metrics or metric_filters)" : " (use it in dimensions or dimension_filters)"}.`);
    const hint = kind === "metric" && RENAMED_HINT[name] ? ` GA4 renamed conversions to key events: use ${RENAMED_HINT[name]}.` : "";
    const s = suggest(name, kind === "dimension" ? idx.dimList : idx.metList);
    throw new ToolError("invalid_argument", `Unknown ${kind} "${name}" for this property.${hint}${s.length ? ` Did you mean: ${s.join(", ")}?` : ""} get_ga4_metadata lists the valid names.`);
  };
  const dimensions = req.dimensions.map((d) => resolve("dimension", d));
  const metrics = req.metrics.map((m) => resolve("metric", m));
  const dupe = (xs: string[]) => xs.find((x, i) => xs.indexOf(x) !== i);
  const dd = dupe(dimensions) ?? dupe(metrics);
  if (dd) throw new ToolError("invalid_argument", `"${dd}" is requested twice.`);
  const dimension_filters = (req.dimension_filters ?? []).map((f) => ({ ...f, field: resolve("dimension", f.field) }));
  const metric_filters = (req.metric_filters ?? []).map((f) => ({ ...f, field: resolve("metric", f.field) }));

  for (const m of new Set([...metrics, ...metric_filters.map((f) => f.field)])) {
    const blocked = idx.metrics.get(m)?.blockedReasons ?? [];
    if (blocked.length) {
      const what = [...new Set(blocked.map((b) => BLOCK_WORD[b] ?? b))].join(" and ");
      throw new ToolError("platform_permission_denied", `Your access to ${what} metrics is blocked for this property, so "${m}" cannot be reported. A property administrator can change data restrictions in GA4.`);
    }
  }

  const order_by = (req.order_by ?? []).map((o) => {
    const isMetric = idx.mets.has(o.field);
    const field = isMetric ? resolve("metric", o.field) : idx.dims.has(o.field) ? resolve("dimension", o.field) : resolve("metric", o.field);
    if (!metrics.includes(field) && !dimensions.includes(field)) throw new ToolError("invalid_argument", `order_by "${o.field}" must be one of the requested dimensions or metrics.`);
    return { ...o, field };
  });

  const incompatible = await incompatibleFields(ga4, { dimensions, metrics, dimensionFilter: toDimensionFilter(dimension_filters), metricFilter: toMetricFilter(metric_filters) });
  if (incompatible.length) throw new ToolError("invalid_argument", `These cannot be combined in one GA4 report: ${incompatible.join(", ")}. Remove them or use get_ga4_metadata to pick compatible fields.`);
  return { dimensions, metrics, dimension_filters, metric_filters, order_by, renamed };
}

/** Names Google's checkCompatibility marks INCOMPATIBLE with the rest of the request. */
export async function incompatibleFields(ga4: Ga4Client, q: { dimensions: string[]; metrics: string[]; dimensionFilter?: FilterExpression; metricFilter?: FilterExpression }): Promise<string[]> {
  const res = await ga4.checkCompatibility({
    dimensions: q.dimensions.map((name) => ({ name })),
    metrics: q.metrics.map((name) => ({ name })),
    ...(q.dimensionFilter ? { dimensionFilter: q.dimensionFilter } : {}),
    ...(q.metricFilter ? { metricFilter: q.metricFilter } : {}),
  });
  const bad = [
    ...(res.dimensionCompatibilities ?? []).filter((c) => c.compatibility === "INCOMPATIBLE").map((c) => c.dimensionMetadata?.apiName),
    ...(res.metricCompatibilities ?? []).filter((c) => c.compatibility === "INCOMPATIBLE").map((c) => c.metricMetadata?.apiName),
  ];
  return [...new Set(bad.filter((x): x is string => !!x))];
}

// ------------------------------------------------------------------------------------------------ response shaping
/** A GA4 metric string as a number; missing, empty or non-numeric → null (never 0). */
export function num(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface ShapedRow {
  dimensions: Record<string, string>;
  metrics: Record<string, number | null>;
}

/** Rows keyed by header name (never by position assumptions about which column is which). */
export function shapeRows(res: { dimensionHeaders?: { name?: string }[]; metricHeaders?: { name?: string }[]; rows?: Ga4Row[] }): ShapedRow[] {
  const dn = (res.dimensionHeaders ?? []).map((h, i) => h.name ?? `dimension_${i}`);
  const mn = (res.metricHeaders ?? []).map((h, i) => h.name ?? `metric_${i}`);
  return (res.rows ?? []).map((r) => ({
    dimensions: Object.fromEntries(dn.map((n, i) => [n, r.dimensionValues?.[i]?.value ?? ""])),
    metrics: Object.fromEntries(mn.map((n, i) => [n, num(r.metricValues?.[i]?.value)])),
  }));
}

export const metricHeadersOf = (res: { metricHeaders?: { name?: string; type?: string }[] }) => (res.metricHeaders ?? []).map((h) => ({ name: h.name ?? "", type: h.type ?? "" }));

/** GA4's TOTAL rows: one per date range. `totals` is the first; `totals_by_range` keys them by the dateRange column when present. */
export function totalsOf(res: RunReportResponse): { totals: Record<string, number | null> | null; totals_by_range: Record<string, Record<string, number | null>> | null } {
  const rows = shapeRows({ dimensionHeaders: res.dimensionHeaders, metricHeaders: res.metricHeaders, rows: res.totals });
  if (!rows.length) return { totals: null, totals_by_range: null };
  const hasRange = (res.dimensionHeaders ?? []).some((h) => h.name === "dateRange");
  return { totals: rows[0]!.metrics, totals_by_range: hasRange ? Object.fromEntries(rows.map((r, i) => [r.dimensions.dateRange || `date_range_${i}`, r.metrics])) : null };
}

export interface DataQuality {
  sampled: boolean;
  sampling: { date_range_index: number; samples_read: number | null; sampling_space_size: number | null; percent_of_events: number | null }[];
  subject_to_thresholding: boolean;
  other_row: boolean;
  empty_reason: string | null;
  notes: string[];
}
export interface QuotaOut {
  tokens_per_day_remaining: number | null;
  tokens_per_hour_remaining: number | null;
  tokens_per_project_per_hour_remaining: number | null;
}

export function quotaOf(q: PropertyQuota | undefined): QuotaOut | null {
  if (!q) return null;
  return { tokens_per_day_remaining: num(q.tokensPerDay?.remaining), tokens_per_hour_remaining: num(q.tokensPerHour?.remaining), tokens_per_project_per_hour_remaining: num(q.tokensPerProjectPerHour?.remaining) };
}

/** Plain-language flags for one response. `extra` notes (periods, zones) come first. */
export function dataQuality(meta: ResponseMetaData | undefined, quota: PropertyQuota | undefined, extra: string[] = []): DataQuality {
  const notes = [...extra];
  const sampling = (meta?.samplingMetadatas ?? []).map((s, i) => {
    const read = num(s.samplesReadCount);
    const space = num(s.samplingSpaceSize);
    return { date_range_index: i, samples_read: read, sampling_space_size: space, percent_of_events: read !== null && space ? round((read / space) * 100, 2) : null };
  });
  for (const s of sampling) notes.push(`GA4 sampled this report: based on ${s.percent_of_events ?? "an unknown share"}% of events for date range ${s.date_range_index}. Figures are estimates.`);
  const thr = !!meta?.subjectToThresholding;
  if (thr) notes.push("GA4 applied thresholding: rows with few users may be withheld (privacy), so totals over rows can be lower than the true total.");
  const other = !!meta?.dataLossFromOtherRow;
  if (other) notes.push("Some rows were grouped by GA4 into '(other)' because of high cardinality. Values in '(other)' cannot be attributed to a specific row.");
  if (meta?.emptyReason) notes.push(`GA4 returned no rows: ${meta.emptyReason}`);
  const h = quota?.tokensPerHour;
  if (h && typeof h.remaining === "number" && typeof h.consumed === "number" && h.remaining < 0.1 * (h.consumed + h.remaining)) notes.push("GA4 hourly quota for this property is low.");
  return { sampled: sampling.length > 0, sampling, subject_to_thresholding: thr, other_row: other, empty_reason: meta?.emptyReason ?? null, notes };
}

// ------------------------------------------------------------------------------------------------ output schemas
export const periodOut = z.object({ start_date: z.string(), end_date: z.string(), label: z.string() }).describe("The exact days used (inclusive), in the property's time zone.");
export const dataQualityOut = z.object({
  sampled: z.boolean(),
  sampling: z.array(z.object({ date_range_index: z.number(), samples_read: z.number().nullable(), sampling_space_size: z.number().nullable(), percent_of_events: z.number().nullable() })),
  subject_to_thresholding: z.boolean(),
  other_row: z.boolean().describe("GA4 grouped some rows into '(other)'."),
  empty_reason: z.string().nullable(),
  notes: z.array(z.string()).describe("Plain-language explanation of each flag that is set."),
});
export const quotaOut = z.object({ tokens_per_day_remaining: z.number().nullable(), tokens_per_hour_remaining: z.number().nullable(), tokens_per_project_per_hour_remaining: z.number().nullable() }).nullable();
export const metricMap = z.record(z.string(), z.number().nullable());
export const reportHeaderShape = {
  property: z.string(),
  period: periodOut,
  time_zone: z.string().nullable(),
  currency_code: z.string().nullable().describe("Monetary metrics are in this currency."),
  data_quality: dataQualityOut,
  quota: quotaOut,
};
export const pageShape = {
  row_count: z.number().int().describe("GA4's count of all rows in the result, independent of the limit."),
  returned: z.number().int(),
  truncated: z.boolean().describe("True when more rows exist than were returned."),
};
export const totalsOut = metricMap.nullable().describe("GA4's totals over all rows of the result (not a sum of the rows shown).");

export interface ReportHeader {
  property: string;
  period: ResolvedPeriod;
  time_zone: string | null;
  currency_code: string | null;
  data_quality: DataQuality;
  quota: QuotaOut | null;
}

// ------------------------------------------------------------------------------------------------ running a report
export interface FixedReport extends ReportHeader {
  rows: ShapedRow[];
  totals: Record<string, number | null> | null;
  row_count: number;
  returned: number;
  truncated: boolean;
  raw: RunReportResponse;
}

/**
 * Runs one runReport page of a fixed-shape query (names are constants: no metadata lookup) and shapes the result.
 * TOTAL aggregation is always requested so totals never sum just the page shown.
 */
export async function runFixedReport(
  ga4: Ga4Client,
  q: { period: PeriodInput; dimensions: string[]; metrics: string[]; dimensionFilter?: FilterExpression; metricFilter?: FilterExpression; orderBys?: OrderBy[]; limit: number },
  now = new Date(),
): Promise<FixedReport> {
  const { period, timeZone, notes } = await reportPeriod(ga4, q.period, now);
  const body: RunReportBody = {
    dateRanges: [{ startDate: period.start_date, endDate: period.end_date }],
    dimensions: q.dimensions.map((name) => ({ name })),
    metrics: q.metrics.map((name) => ({ name })),
    ...(q.dimensionFilter ? { dimensionFilter: q.dimensionFilter } : {}),
    ...(q.metricFilter ? { metricFilter: q.metricFilter } : {}),
    ...(q.orderBys ? { orderBys: q.orderBys } : {}),
    limit: Math.min(q.limit, HARD_ROW_CAP),
    offset: 0,
    metricAggregations: ["TOTAL"],
  };
  const res = await ga4.runReport(body);
  const rows = shapeRows(res);
  const row_count = res.rowCount ?? rows.length;
  return {
    property: ga4.property,
    period,
    time_zone: res.metadata?.timeZone ?? timeZone,
    currency_code: res.metadata?.currencyCode ?? ga4.currencyCode,
    data_quality: dataQuality(res.metadata, res.propertyQuota, [...notes, ...zoneNotes(timeZone, res.metadata?.timeZone)]),
    quota: quotaOf(res.propertyQuota),
    rows,
    totals: totalsOf(res).totals,
    row_count,
    returned: rows.length,
    truncated: rows.length < row_count,
    raw: res,
  };
}

/** Order by one metric, descending. */
export const byMetric = (metricName: string, desc = true): OrderBy => ({ desc, metric: { metricName } });

export interface Ga4ReportRequest {
  dimensions: string[];
  metrics: string[];
  period: PeriodInput;
  /** A second range to compare with; both dates or neither. */
  compare?: { start_date: string; end_date: string };
  dimension_filters?: DimFilterIn[];
  dimension_filter_logic?: "and" | "or";
  metric_filters?: MetricFilterIn[];
  order_by?: { field: string; desc: boolean; numeric: boolean }[];
  limit: number;
  offset?: number;
  include_totals?: boolean;
  keep_empty_rows?: boolean;
}
export interface Ga4ReportResult extends ReportHeader {
  periods: { name: string; start_date: string; end_date: string }[];
  dimensions: string[];
  metrics: string[];
  renamed: { from: string; to: string }[];
  rows: ShapedRow[];
  metric_headers: { name: string; type: string }[];
  totals: Record<string, number | null> | null;
  totals_by_range: Record<string, Record<string, number | null>> | null;
  row_count: number;
  returned: number;
  offset: number;
  truncated: boolean;
  next_offset: number | null;
}

/**
 * A validated generic report: names checked (metadata + checkCompatibility), period resolved in the property's zone, one
 * runReport page (limit ≤ 10,000), shaped with data quality, quota and paging info.
 */
export async function runGa4Report(ga4: Ga4Client, req: Ga4ReportRequest, now = new Date()): Promise<Ga4ReportResult> {
  if (req.limit < 1 || req.limit > HARD_ROW_CAP) throw new ToolError("invalid_argument", `limit must be 1..${HARD_ROW_CAP}.`);
  const { period, timeZone, notes } = await reportPeriod(ga4, req.period, now);
  const ranges = [{ startDate: period.start_date, endDate: period.end_date }];
  if (req.compare) {
    const c = resolvePeriod({ date_range: "LAST_28_DAYS", ...req.compare }, timeZone, now);
    ranges.push({ startDate: c.start_date, endDate: c.end_date });
  }
  const f = await validateFields(ga4, { dimensions: req.dimensions, metrics: req.metrics, dimension_filters: req.dimension_filters, metric_filters: req.metric_filters, order_by: req.order_by });
  const orderBys: OrderBy[] = f.order_by.length
    ? f.order_by.map((o) => (f.metrics.includes(o.field) ? { desc: o.desc, metric: { metricName: o.field } } : { desc: o.desc, dimension: { dimensionName: o.field, ...(o.numeric ? { orderType: "NUMERIC" as const } : {}) } }))
    : [byMetric(f.metrics[0]!)];
  const offset = req.offset ?? 0;
  const dimensionFilter = toDimensionFilter(f.dimension_filters, req.dimension_filter_logic ?? "and");
  const metricFilter = toMetricFilter(f.metric_filters);
  const body: RunReportBody = {
    dateRanges: ranges,
    dimensions: f.dimensions.map((name) => ({ name })),
    metrics: f.metrics.map((name) => ({ name })),
    ...(dimensionFilter ? { dimensionFilter } : {}),
    ...(metricFilter ? { metricFilter } : {}),
    orderBys,
    limit: req.limit,
    offset,
  };
  if (req.include_totals !== false) body.metricAggregations = ["TOTAL"];
  if (req.keep_empty_rows) body.keepEmptyRows = true;
  const res = await ga4.runReport(body);
  const rows = shapeRows(res);
  const row_count = res.rowCount ?? rows.length;
  const more = offset + rows.length < row_count;
  const t = totalsOf(res);
  return {
    property: ga4.property,
    period,
    periods: ranges.map((r, i) => ({ name: `date_range_${i}`, start_date: r.startDate, end_date: r.endDate })),
    time_zone: res.metadata?.timeZone ?? timeZone,
    currency_code: res.metadata?.currencyCode ?? ga4.currencyCode,
    dimensions: f.dimensions,
    metrics: f.metrics,
    renamed: f.renamed,
    rows,
    metric_headers: metricHeadersOf(res),
    totals: t.totals,
    totals_by_range: t.totals_by_range,
    row_count,
    returned: rows.length,
    offset,
    truncated: more,
    next_offset: more ? offset + rows.length : null,
    data_quality: dataQuality(res.metadata, res.propertyQuota, [...notes, ...zoneNotes(timeZone, res.metadata?.timeZone)]),
    quota: quotaOf(res.propertyQuota),
  };
}
