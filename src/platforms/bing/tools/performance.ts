import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { AnyTool } from "../../../mcp/tool";
import { getPageQueryStats, getQueryPageDetailStats, getQueryPageStats, getQueryTrafficStats } from "../api/performance";
import { type DailyTraffic, type QueryStat, getPageStats, getQueryStats, getRankAndTrafficStats, sumByKey } from "../api/traffic";
import { accountId, bingRead, httpUrl, page, requireWithinSite } from "./common";

/**
 * Search performance tools (facts: docs/VERIFICATION.md, "Search performance and keyword research (2026-11-10)").
 *
 * Honesty rules (design 2026-11-10, anti-goals): the query and page reports take no date range. Bing returns its own window,
 * one row per key and dated bucket ("The data will be updated every week."), so every output names the bucket dates it
 * actually used and never implies exact dates. Clicks and impressions are summed over buckets, impression position is
 * averaged weighted by impressions and click position by clicks, CTR is computed from the sums. Daily site totals
 * (GetRankAndTrafficStats) are real days and can be cut to exact dates.
 */

// ------------------------------------------------------------------------------------------------------------ shared

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, "not a calendar date");
const queryText = z.string().trim().min(1).max(500);
const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const ctrOf = (clicks: number, impressions: number) => (impressions > 0 ? r4(clicks / impressions) : null);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

const BUCKET_NOTE =
  "Bing's query and page reports take no date range: Bing returns its own window in dated buckets (Microsoft: \"The data will be updated every week.\"). The numbers cover exactly the bucket dates listed in coverage, not a calendar period of your choosing.";
const TOP_LIST_NOTE = "Bing reports only its top queries/pages for the site, so sums over these rows are not the site's total traffic (use get_bing_search_performance for daily site totals).";

const Coverage = z
  .object({
    first_bucket: z.string().nullable().describe("Date Bing stamped on the earliest bucket used (YYYY-MM-DD)."),
    last_bucket: z.string().nullable().describe("Date Bing stamped on the latest bucket used."),
    buckets: z.number().describe("How many distinct bucket dates the numbers cover."),
    bucket_dates: z.array(z.string()).describe("Every bucket date used, oldest first."),
  })
  .describe("The Bing buckets these numbers actually cover. Bing chooses the window; it is not a requested date range.");
const coverage = (dates: string[]) => ({ first_bucket: dates[0] ?? null, last_bucket: dates[dates.length - 1] ?? null, buckets: dates.length, bucket_dates: dates });

const Metrics = {
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number().nullable().describe("clicks / impressions over the covered buckets (0-1); null without impressions."),
  avg_impression_position: z.number().nullable().describe("Average position when shown, weighted by impressions across buckets (1 = top). Null when Bing reported none."),
  avg_click_position: z.number().nullable().describe("Average position when clicked, weighted by clicks across buckets. Null without clicks."),
  buckets_present: z.number().describe("In how many of the covered buckets Bing listed this row."),
};
const QueryRow = z.object({ query: z.string().describe("Search query (untrusted text from Bing)."), ...Metrics });
const PageRow = z.object({ page: z.string().describe("Page URL (untrusted text from Bing)."), ...Metrics });
const ListTotals = z.object({ clicks: z.number(), impressions: z.number(), ctr: z.number().nullable() }).describe("Sums over every row that matched the filters (before limit). Not the site's total traffic.");

interface Keyed {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  avg_impression_position: number | null;
  avg_click_position: number | null;
  buckets_present: number;
}

/** Distinct bucket dates in Bing's rows, oldest first. */
const bucketDatesOf = (rows: { date: string | null }[]) => [...new Set(rows.map((r) => r.date).filter((d): d is string => d !== null))].sort();

/** Aggregates rows per key over the given bucket dates (all dated rows when omitted). */
function aggregate(rows: QueryStat[], dates?: Set<string>): { list: Keyed[]; bucketDates: string[]; undated: number } {
  const undated = rows.filter((r) => r.date === null).length;
  const sel = rows.filter((r) => r.date !== null && (!dates || dates.has(r.date)));
  const { totals, bucketDates } = sumByKey(sel);
  const present = new Map<string, Set<string>>();
  for (const r of sel) {
    const s = present.get(r.key) ?? new Set<string>();
    s.add(r.date!);
    present.set(r.key, s);
  }
  const list = [...totals.values()].map((t) => ({
    key: t.key,
    clicks: t.clicks,
    impressions: t.impressions,
    ctr: ctrOf(t.clicks, t.impressions),
    avg_impression_position: r2(t.avgImpressionPosition),
    avg_click_position: r2(t.avgClickPosition),
    buckets_present: present.get(t.key)?.size ?? 0,
  }));
  return { list, bucketDates, undated };
}

const sortKeyed = (by: "clicks" | "impressions") => (a: Keyed, b: Keyed) =>
  by === "clicks" ? b.clicks - a.clicks || b.impressions - a.impressions || a.key.localeCompare(b.key) : b.impressions - a.impressions || b.clicks - a.clicks || a.key.localeCompare(b.key);

const listTotals = (rows: Keyed[]) => {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  return { clicks, impressions, ctr: ctrOf(clicks, impressions) };
};

const undatedNote = (n: number) => (n > 0 ? [`${n} row(s) from Bing had no readable date and were left out.`] : []);

const listInput = {
  sort_by: z.enum(["clicks", "impressions"]).default("clicks"),
  min_impressions: z.number().int().min(0).max(10_000_000).default(0).describe("Leave out rows with fewer impressions than this over the covered buckets."),
  limit: z.number().int().min(1).max(1000).default(100).describe("Most rows to return; returned/total/truncated say whether more matched."),
};

/** The shared list flow of the top-queries/top-pages style tools. */
function listFlow(rows: QueryStat[], a: { sort_by: "clicks" | "impressions"; min_impressions: number; limit: number; latest_buckets?: number; contains?: string }) {
  const all = bucketDatesOf(rows);
  const dates = a.latest_buckets !== undefined ? all.slice(-a.latest_buckets) : all;
  const { list, bucketDates, undated } = aggregate(rows, new Set(dates));
  const needle = a.contains?.toLowerCase();
  const matched = list.filter((r) => r.impressions >= a.min_impressions && (!needle || r.key.toLowerCase().includes(needle))).sort(sortKeyed(a.sort_by));
  const p = page(matched, a.limit);
  const notes = [BUCKET_NOTE, ...undatedNote(undated)];
  if (a.latest_buckets !== undefined && all.length < a.latest_buckets) notes.push(`Asked for the latest ${a.latest_buckets} bucket(s); Bing returned only ${all.length}.`);
  return { p, bucketDates, matched, notes, available: all.length };
}

// ----------------------------------------------------------------------------------------------- site daily totals

export const getBingSearchPerformance = bingRead({
  name: "get_bing_search_performance",
  title: "Bing search performance (daily)",
  description:
    "Daily Bing clicks and impressions for the whole site, from Bing's GetRankAndTrafficStats (all verticals: Web, Chat, News, Images, Videos and Knowledge Panel from 2023-03-24 on; Bing updates it daily). Bing takes no date range and returns its own window: the output reports the first and last day Bing returned, and start_date/end_date only cut Bing's rows to exact days. Days inside the range that Bing did not return are counted in missing_days, not filled with zero. Daily rows are newest first. No positions: Bing's daily report has none.",
  input: z.object({
    account_id: accountId,
    start_date: ymd.optional().describe("Keep days on or after this date (YYYY-MM-DD, the day as Bing stamps it)."),
    end_date: ymd.optional().describe("Keep days on or before this date."),
    limit: z.number().int().min(1).max(1000).default(90).describe("Most daily rows to return (newest first). Totals always cover every day in the range."),
  }),
  output: z.object({
    site_url: z.string(),
    bing_first_day: z.string().nullable().describe("Earliest day Bing returned for the site (before any range filter)."),
    bing_last_day: z.string().nullable().describe("Latest day Bing returned."),
    bing_days: z.number().describe("Days Bing returned in all."),
    start_date: z.string().nullable(),
    end_date: z.string().nullable(),
    first_day: z.string().nullable().describe("Earliest day with data inside the range."),
    last_day: z.string().nullable().describe("Latest day with data inside the range."),
    days_with_data: z.number(),
    missing_days: z.number().describe("Calendar days between first_day and last_day that Bing did not return."),
    totals: z.object({ clicks: z.number(), impressions: z.number(), ctr: z.number().nullable() }),
    daily: z.array(z.object({ date: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number().nullable() })),
    returned: z.number(),
    total: z.number(),
    truncated: z.boolean(),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    if (a.start_date && a.end_date && a.start_date > a.end_date) throw new ToolError("invalid_argument", `start_date ${a.start_date} is after end_date ${a.end_date}.`, { definite: true });
    const all = await getRankAndTrafficStats(bing);
    const inRange = all.filter((d) => (!a.start_date || d.date >= a.start_date) && (!a.end_date || d.date <= a.end_date));
    const notes: string[] = [];
    if (all.length === 0) notes.push("Bing returned no daily traffic for this site (new, unverified for long enough, or no Bing traffic yet).");
    else if (inRange.length === 0)
      throw new ToolError("invalid_argument", `Bing has no days between ${a.start_date ?? "the start"} and ${a.end_date ?? "the end"} for this site. Bing's data covers ${all[0]!.date} to ${all[all.length - 1]!.date}.`, { definite: true });
    const first = inRange[0]?.date ?? null;
    const last = inRange[inRange.length - 1]?.date ?? null;
    const clicks = inRange.reduce((s, d) => s + d.clicks, 0);
    const impressions = inRange.reduce((s, d) => s + d.impressions, 0);
    const missing = first && last ? daysBetween(first, last) - new Set(inRange.map((d) => d.date)).size : 0;
    if (missing > 0) notes.push(`${missing} day(s) between ${first} and ${last} were not returned by Bing; they are left out, not counted as zero.`);
    if ((a.start_date && first && first > a.start_date) || (a.end_date && last && last < a.end_date)) notes.push(`Bing's data inside the range runs from ${first} to ${last}, narrower than the requested range.`);
    notes.push("Bing's daily totals include all verticals (Web, Chat, News, Images, Videos, Knowledge Panel) from 2023-03-24 on.");
    const p = page([...inRange].reverse(), a.limit);
    return {
      site_url: bing.siteUrl,
      bing_first_day: all[0]?.date ?? null,
      bing_last_day: all[all.length - 1]?.date ?? null,
      bing_days: all.length,
      start_date: a.start_date ?? null,
      end_date: a.end_date ?? null,
      first_day: first,
      last_day: last,
      days_with_data: inRange.length,
      missing_days: missing,
      totals: { clicks, impressions, ctr: ctrOf(clicks, impressions) },
      daily: p.rows.map((d) => ({ ...d, ctr: ctrOf(d.clicks, d.impressions) })),
      returned: p.returned,
      total: p.total,
      truncated: p.truncated,
      notes,
    };
  },
});

// ------------------------------------------------------------------------------------------------ top queries/pages

const latestBuckets = z.number().int().min(1).max(104).optional().describe("Use only Bing's latest N buckets (whole buckets). Default: every bucket Bing returned.");
const contains = z.string().trim().min(1).max(200).optional().describe("Keep only rows whose text contains this (case-insensitive).");

export const getBingTopQueries = bingRead({
  name: "get_bing_top_queries",
  title: "Bing top queries",
  description:
    "The top Bing search queries for the site (GetQueryStats) with clicks, impressions, CTR and average impression and click position, summed over Bing's dated buckets. Bing takes no date range and updates these weekly: coverage lists the exact bucket dates used. latest_buckets keeps only Bing's most recent N buckets. Bing reports only its top queries, so the sums are not the site's total traffic.",
  input: z.object({ account_id: accountId, latest_buckets: latestBuckets, contains, ...listInput }),
  output: z.object({ site_url: z.string(), coverage: Coverage, queries: z.array(QueryRow), returned: z.number(), total: z.number(), truncated: z.boolean(), listed_totals: ListTotals, notes: z.array(z.string()) }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const f = listFlow(await getQueryStats(bing), a);
    return {
      site_url: bing.siteUrl,
      coverage: coverage(f.bucketDates),
      queries: f.p.rows.map(({ key, ...m }) => ({ query: key, ...m })),
      returned: f.p.returned,
      total: f.p.total,
      truncated: f.p.truncated,
      listed_totals: listTotals(f.matched),
      notes: [...f.notes, TOP_LIST_NOTE],
    };
  },
});

export const getBingTopPages = bingRead({
  name: "get_bing_top_pages",
  title: "Bing top pages",
  description:
    "The site's top pages in Bing search (GetPageStats) with clicks, impressions, CTR and average impression and click position, summed over Bing's dated buckets. Bing takes no date range and updates these weekly: coverage lists the exact bucket dates used. latest_buckets keeps only Bing's most recent N buckets. Bing reports only its top pages, so the sums are not the site's total traffic.",
  input: z.object({ account_id: accountId, latest_buckets: latestBuckets, contains: contains.describe("Keep only page URLs containing this (case-insensitive)."), ...listInput }),
  output: z.object({ site_url: z.string(), coverage: Coverage, pages: z.array(PageRow), returned: z.number(), total: z.number(), truncated: z.boolean(), listed_totals: ListTotals, notes: z.array(z.string()) }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const f = listFlow(await getPageStats(bing), a);
    return {
      site_url: bing.siteUrl,
      coverage: coverage(f.bucketDates),
      pages: f.p.rows.map(({ key, ...m }) => ({ page: key, ...m })),
      returned: f.p.returned,
      total: f.p.total,
      truncated: f.p.truncated,
      listed_totals: listTotals(f.matched),
      notes: [...f.notes, TOP_LIST_NOTE],
    };
  },
});

// ----------------------------------------------------------------------------------------- one query / one page

const ByBucket = z.array(z.object({ date: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number().nullable() })).describe("Clicks and impressions per bucket date, summed over every row Bing returned for it, oldest first.");
const byBucket = (rows: QueryStat[]) => {
  const m = new Map<string, { clicks: number; impressions: number }>();
  for (const r of rows) {
    if (!r.date) continue;
    const t = m.get(r.date) ?? { clicks: 0, impressions: 0 };
    t.clicks += r.clicks;
    t.impressions += r.impressions;
    m.set(r.date, t);
  }
  return [...m.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([date, t]) => ({ date, ...t, ctr: ctrOf(t.clicks, t.impressions) }));
};
const norm = (s: string) => s.trim().toLowerCase();

export const getBingQueryPages = bingRead({
  name: "get_bing_query_pages",
  title: "Bing pages for a query",
  description:
    "Which of the site's pages Bing showed for one search query (GetQueryPageStats), with clicks, impressions, CTR and positions summed over Bing's dated buckets (no date range; Bing updates weekly; coverage lists the bucket dates). Also returns the query's clicks and impressions per bucket. Microsoft's sample response labels each row with the query text rather than a page: when Bing does that, pages is empty and rows_keyed_by_query is true, and only the per-bucket totals are meaningful.",
  input: z.object({ account_id: accountId, query: queryText.describe("The search query, as Bing reports it (e.g. from get_bing_top_queries)."), ...listInput }),
  output: z.object({
    site_url: z.string(),
    query: z.string(),
    coverage: Coverage,
    rows_keyed_by_query: z.boolean().describe("True when every row Bing returned is labelled with the query itself instead of a page URL."),
    pages: z.array(PageRow),
    returned: z.number(),
    total: z.number(),
    truncated: z.boolean(),
    by_bucket: ByBucket,
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const rows = await getQueryPageStats(bing, a.query);
    const keyedByQuery = rows.length > 0 && rows.every((r) => norm(r.key) === norm(a.query));
    const f = listFlow(keyedByQuery ? [] : rows, a);
    const dates = bucketDatesOf(rows);
    const notes = [BUCKET_NOTE, ...undatedNote(rows.filter((r) => r.date === null).length)];
    if (rows.length === 0) notes.push("Bing returned no rows for this query. It may be outside Bing's top queries for the site, or spelled differently than Bing records it (see get_bing_top_queries).");
    if (keyedByQuery) notes.push("Bing labelled every row with the query itself rather than a page URL, so no per-page split is available; by_bucket holds the query's totals per bucket.");
    return {
      site_url: bing.siteUrl,
      query: a.query,
      coverage: coverage(dates),
      rows_keyed_by_query: keyedByQuery,
      pages: f.p.rows.map(({ key, ...m }) => ({ page: key, ...m })),
      returned: f.p.returned,
      total: f.p.total,
      truncated: f.p.truncated,
      by_bucket: byBucket(rows),
      notes,
    };
  },
});

export const getBingPageQueries = bingRead({
  name: "get_bing_page_queries",
  title: "Bing queries for a page",
  description:
    "The Bing search queries one page of the site was shown for (GetPageQueryStats, the page goes in Bing's `page` parameter), with clicks, impressions, CTR and positions summed over Bing's dated buckets (no date range; Bing updates weekly; coverage lists the bucket dates). The page must be inside this site and match the URL exactly as Bing records it (see get_bing_top_pages).",
  input: z.object({ account_id: accountId, page: httpUrl.describe("Absolute page URL inside this site, exactly as Bing records it."), ...listInput }),
  output: z.object({ site_url: z.string(), page: z.string(), coverage: Coverage, queries: z.array(QueryRow), returned: z.number(), total: z.number(), truncated: z.boolean(), by_bucket: ByBucket, notes: z.array(z.string()) }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    requireWithinSite(bing.siteUrl, a.page, "page");
    const rows = await getPageQueryStats(bing, a.page);
    const f = listFlow(rows, a);
    if (rows.length === 0) f.notes.push("Bing returned no queries for this exact URL. Check get_bing_top_pages for the URL as Bing records it (trailing slash, http vs https).");
    return {
      site_url: bing.siteUrl,
      page: a.page,
      coverage: coverage(f.bucketDates),
      queries: f.p.rows.map(({ key, ...m }) => ({ query: key, ...m })),
      returned: f.p.returned,
      total: f.p.total,
      truncated: f.p.truncated,
      by_bucket: byBucket(rows),
      notes: f.notes,
    };
  },
});

export const getBingQueryPageDetail = bingRead({
  name: "get_bing_query_page_detail",
  title: "Bing query on one page, by bucket",
  description:
    "Bucket-by-bucket clicks, impressions, CTR and position of one query on one page of the site (GetQueryPageDetailStats). Bing takes no date range and updates weekly; rows are the dated buckets Bing returned, oldest first, and totals sum them (position averaged weighted by impressions). The page must be inside this site.",
  input: z.object({ account_id: accountId, query: queryText.describe("The search query, as Bing reports it."), page: httpUrl.describe("Absolute page URL inside this site, exactly as Bing records it.") }),
  output: z.object({
    site_url: z.string(),
    query: z.string(),
    page: z.string(),
    coverage: Coverage,
    rows: z.array(z.object({ date: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number().nullable(), position: z.number().nullable().describe("Bing's position for the bucket (1 = top); null when none.") })),
    totals: z.object({ clicks: z.number(), impressions: z.number(), ctr: z.number().nullable(), avg_position: z.number().nullable().describe("Weighted by impressions across buckets.") }),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    requireWithinSite(bing.siteUrl, a.page, "page");
    const all = await getQueryPageDetailStats(bing, a.query, a.page);
    const rows = all.filter((r): r is typeof r & { date: string } => r.date !== null);
    const clicks = rows.reduce((s, r) => s + r.clicks, 0);
    const impressions = rows.reduce((s, r) => s + r.impressions, 0);
    let w = 0;
    let pos = 0;
    for (const r of rows) if (r.position !== null && r.impressions > 0) (pos += r.position * r.impressions), (w += r.impressions);
    const notes = [BUCKET_NOTE, ...undatedNote(all.length - rows.length)];
    if (rows.length === 0) notes.push("Bing returned no data for this query on this page.");
    return {
      site_url: bing.siteUrl,
      query: a.query,
      page: a.page,
      coverage: coverage(bucketDatesOf(rows)),
      rows: rows.map((r) => ({ date: r.date, clicks: r.clicks, impressions: r.impressions, ctr: ctrOf(r.clicks, r.impressions), position: r.position })),
      totals: { clicks, impressions, ctr: ctrOf(clicks, impressions), avg_position: w > 0 ? r2(pos / w) : null },
      notes,
    };
  },
});

export const getBingQueryTrend = bingRead({
  name: "get_bing_query_trend",
  title: "Bing query trend",
  description:
    "Clicks and impressions of one search query for the site over time (GetQueryTrafficStats), one row per date Bing returns, oldest first. Microsoft: \"The data will be updated every day. Only top-queries will be saved and returned by this method.\" A query outside Bing's top queries returns no rows. Bing takes no date range: first_date/last_date say what Bing returned.",
  input: z.object({ account_id: accountId, query: queryText.describe("The search query, as Bing reports it (e.g. from get_bing_top_queries).") }),
  output: z.object({
    site_url: z.string(),
    query: z.string(),
    first_date: z.string().nullable(),
    last_date: z.string().nullable(),
    dates: z.number().describe("How many dated rows Bing returned."),
    rows: z.array(z.object({ date: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number().nullable() })),
    totals: z.object({ clicks: z.number(), impressions: z.number(), ctr: z.number().nullable() }),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const rows = await getQueryTrafficStats(bing, a.query);
    const clicks = rows.reduce((s, r) => s + r.clicks, 0);
    const impressions = rows.reduce((s, r) => s + r.impressions, 0);
    const notes = ["Rows are the dates Bing returned for this query (Bing's own window, no date range); dates Bing did not return are absent, not zero."];
    if (rows.length === 0) notes.push("Bing returned no data: Bing keeps this report only for its top queries, so this query may be outside them or spelled differently (see get_bing_top_queries).");
    return {
      site_url: bing.siteUrl,
      query: a.query,
      first_date: rows[0]?.date ?? null,
      last_date: rows[rows.length - 1]?.date ?? null,
      dates: rows.length,
      rows: rows.map((r) => ({ ...r, ctr: ctrOf(r.clicks, r.impressions) })),
      totals: { clicks, impressions, ctr: ctrOf(clicks, impressions) },
      notes,
    };
  },
});

// --------------------------------------------------------------------------------------------- compare two periods

const Totals = z.object({ clicks: z.number(), impressions: z.number(), ctr: z.number().nullable(), avg_impression_position: z.number().nullable(), avg_click_position: z.number().nullable() });
const PeriodOut = z.object({
  requested_start: z.string().nullable().describe("The date range asked for (null for a named comparison)."),
  requested_end: z.string().nullable(),
  basis: z.enum(["buckets", "days"]).describe("buckets: whole Bing buckets whose date falls in the range; days: exact days of Bing's daily site totals."),
  first_date: z.string().nullable().describe("First bucket date (or day) actually used."),
  last_date: z.string().nullable().describe("Last bucket date (or day) actually used."),
  count: z.number().describe("Buckets (basis buckets) or days with data (basis days) used."),
  bucket_dates: z.array(z.string()).describe("Every bucket date used (basis buckets); empty for days."),
  missing_days: z.number().nullable().describe("Days in the period Bing did not return (basis days); null for buckets."),
  totals: Totals,
});
const Mover = z.object({
  key: z.string().describe("Query or page URL (untrusted text from Bing)."),
  status: z.enum(["both", "new", "lost"]).describe("new/lost: absent from Bing's top list in the other period, which may mean below Bing's cut-off rather than zero."),
  clicks_current: z.number(),
  clicks_previous: z.number(),
  clicks_change: z.number(),
  impressions_current: z.number(),
  impressions_previous: z.number(),
  impressions_change: z.number(),
  position_current: z.number().nullable().describe("Average impression position in the current period."),
  position_previous: z.number().nullable(),
  position_change: z.number().nullable().describe("current minus previous: negative means it moved up."),
});
type MoverT = z.infer<typeof Mover>;
type PeriodT = z.infer<typeof PeriodOut>;

const totalsOf = (rows: QueryStat[]) => {
  const { totals } = sumByKey(rows.map((r) => ({ ...r, key: "" })));
  const t = totals.get("") ?? { clicks: 0, impressions: 0, avgImpressionPosition: null, avgClickPosition: null };
  return { clicks: t.clicks, impressions: t.impressions, ctr: ctrOf(t.clicks, t.impressions), avg_impression_position: r2(t.avgImpressionPosition), avg_click_position: r2(t.avgClickPosition) };
};
const diff = (a: number | null, b: number | null, d: number) => (a === null || b === null ? null : Math.round((a - b) * 10 ** d) / 10 ** d);

function bucketPeriods(rows: QueryStat[], a: { weeks: number; explicit: null | { cs: string; ce: string; ps: string; pe: string } }) {
  const all = bucketDatesOf(rows);
  const span = all.length ? `Bing returned ${all.length} bucket(s) dated ${all[0]} to ${all[all.length - 1]}.` : "Bing returned no buckets for this site.";
  let cur: string[];
  let prev: string[];
  if (a.explicit) {
    const { cs, ce, ps, pe } = a.explicit;
    cur = all.filter((d) => d >= cs && d <= ce);
    prev = all.filter((d) => d >= ps && d <= pe);
    if (!cur.length) throw new ToolError("invalid_argument", `No Bing bucket is dated between ${cs} and ${ce} (current period). ${span}`, { definite: true });
    if (!prev.length) throw new ToolError("invalid_argument", `No Bing bucket is dated between ${ps} and ${pe} (previous period). ${span}`, { definite: true });
  } else {
    if (all.length < 2 * a.weeks) throw new ToolError("invalid_argument", `Comparing the latest ${a.weeks} bucket(s) with the ${a.weeks} before needs ${2 * a.weeks} buckets. ${span} Use weeks of at most ${Math.floor(all.length / 2)}${all.length < 2 ? " (not enough data to compare)" : ""}.`, { definite: true });
    cur = all.slice(-a.weeks);
    prev = all.slice(-2 * a.weeks, -a.weeks);
  }
  return { cur, prev };
}

export const compareBingSearchPeriods = bingRead({
  name: "compare_bing_search_periods",
  title: "Compare Bing search periods",
  description:
    "Compares two periods of the site's Bing search data. dimension query or page (GetQueryStats / GetPageStats): periods are whole Bing buckets (Bing updates weekly and takes no date range), each period uses the buckets whose date falls inside it, and the output lists exactly which bucket dates were used; returns risers, fallers, new and lost keys with the change in clicks, impressions and position. dimension site_totals (GetRankAndTrafficStats): exact days of Bing's daily site totals. Give all four dates (current and previous ranges) or none; with none, the latest `weeks` buckets are compared with the `weeks` before (site_totals: the latest weeks×7 days Bing returned vs the weeks×7 days before). Query/page totals are sums over Bing's top list, not the site's total traffic.",
  input: z.object({
    account_id: accountId,
    dimension: z.enum(["query", "page", "site_totals"]).default("query"),
    weeks: z.number().int().min(1).max(26).default(4).describe("Named comparison when no dates are given: the latest N Bing buckets vs the N before (site_totals: latest N×7 days vs the N×7 days before)."),
    current_start_date: ymd.optional().describe("Current period start, YYYY-MM-DD (give all four dates or none)."),
    current_end_date: ymd.optional(),
    previous_start_date: ymd.optional(),
    previous_end_date: ymd.optional().describe("Must be before current_start_date."),
    min_impressions: z.number().int().min(0).max(10_000_000).default(0).describe("Leave out keys with fewer impressions than this in both periods."),
    limit: z.number().int().min(1).max(200).default(25).describe("Most keys per list (risers, fallers, new, lost)."),
  }),
  output: z.object({
    site_url: z.string(),
    dimension: z.string(),
    current: PeriodOut,
    previous: PeriodOut,
    equal_length: z.boolean().describe("Whether both periods cover the same number of buckets (or days)."),
    totals_change: z.object({ clicks: z.number(), impressions: z.number(), ctr: z.number().nullable(), avg_impression_position: z.number().nullable() }),
    risers: z.array(Mover),
    fallers: z.array(Mover),
    new: z.array(Mover),
    lost: z.array(Mover),
    counts: z.object({ risers: z.number(), fallers: z.number(), new: z.number(), lost: z.number() }).describe("How many keys each list has before limit."),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const dates = [a.current_start_date, a.current_end_date, a.previous_start_date, a.previous_end_date];
    const given = dates.filter((d) => d !== undefined).length;
    if (given !== 0 && given !== 4) throw new ToolError("invalid_argument", "Give all four dates (current_start_date, current_end_date, previous_start_date, previous_end_date) or none for the named comparison.", { definite: true });
    const explicit = given === 4 ? { cs: a.current_start_date!, ce: a.current_end_date!, ps: a.previous_start_date!, pe: a.previous_end_date! } : null;
    if (explicit) {
      if (explicit.cs > explicit.ce) throw new ToolError("invalid_argument", `current_start_date ${explicit.cs} is after current_end_date ${explicit.ce}.`, { definite: true });
      if (explicit.ps > explicit.pe) throw new ToolError("invalid_argument", `previous_start_date ${explicit.ps} is after previous_end_date ${explicit.pe}.`, { definite: true });
      if (explicit.pe >= explicit.cs) throw new ToolError("invalid_argument", `The previous period (${explicit.ps} to ${explicit.pe}) must end before the current one starts (${explicit.cs}).`, { definite: true });
    }
    const notes: string[] = [];
    const noMovers = { risers: [], fallers: [], new: [], lost: [], counts: { risers: 0, fallers: 0, new: 0, lost: 0 } };

    if (a.dimension === "site_totals") {
      const daily = await getRankAndTrafficStats(bing);
      if (!daily.length) throw new ToolError("invalid_argument", "Bing returned no daily traffic for this site, so there is nothing to compare.", { definite: true });
      const span = `Bing's daily data covers ${daily[0]!.date} to ${daily[daily.length - 1]!.date}.`;
      const len = a.weeks * 7;
      const last = daily[daily.length - 1]!.date;
      const [cs, ce, ps, pe] = explicit ? [explicit.cs, explicit.ce, explicit.ps, explicit.pe] : [addDays(last, -(len - 1)), last, addDays(last, -(2 * len - 1)), addDays(last, -len)];
      const side = (s: string, e: string, label: string): PeriodT => {
        const rows = daily.filter((d: DailyTraffic) => d.date >= s && d.date <= e);
        if (!rows.length) throw new ToolError("invalid_argument", `Bing has no days between ${s} and ${e} (${label} period). ${span}`, { definite: true });
        const clicks = rows.reduce((x, d) => x + d.clicks, 0);
        const impressions = rows.reduce((x, d) => x + d.impressions, 0);
        return {
          requested_start: explicit ? s : null,
          requested_end: explicit ? e : null,
          basis: "days",
          first_date: rows[0]!.date,
          last_date: rows[rows.length - 1]!.date,
          count: rows.length,
          bucket_dates: [],
          missing_days: daysBetween(s, e) - rows.length,
          totals: { clicks, impressions, ctr: ctrOf(clicks, impressions), avg_impression_position: null, avg_click_position: null },
        };
      };
      const current = side(cs, ce, "current");
      const previous = side(ps, pe, "previous");
      if (!explicit) notes.push(`Named comparison: ${cs} to ${ce} vs ${ps} to ${pe}, ending on the latest day Bing returned (${last}).`);
      if (current.missing_days || previous.missing_days) notes.push(`Bing did not return every day (${current.missing_days} missing in the current period, ${previous.missing_days} in the previous); missing days are left out, not counted as zero.`);
      const equal = daysBetween(cs, ce) === daysBetween(ps, pe);
      if (!equal) notes.push(`The periods differ in length (${daysBetween(cs, ce)} vs ${daysBetween(ps, pe)} days), so raw changes are not like for like.`);
      notes.push("Daily site totals have no position data.");
      return {
        site_url: bing.siteUrl,
        dimension: a.dimension,
        current,
        previous,
        equal_length: equal,
        totals_change: { clicks: current.totals.clicks - previous.totals.clicks, impressions: current.totals.impressions - previous.totals.impressions, ctr: diff(current.totals.ctr, previous.totals.ctr, 4), avg_impression_position: null },
        ...noMovers,
        notes,
      };
    }

    const rows = a.dimension === "query" ? await getQueryStats(bing) : await getPageStats(bing);
    const { cur, prev } = bucketPeriods(rows, { weeks: a.weeks, explicit });
    const pick = (ds: string[]) => {
      const set = new Set(ds);
      return rows.filter((r) => r.date !== null && set.has(r.date));
    };
    const cRows = pick(cur);
    const pRows = pick(prev);
    const side = (ds: string[], rs: QueryStat[], s: string | null, e: string | null): PeriodT => ({
      requested_start: s,
      requested_end: e,
      basis: "buckets",
      first_date: ds[0] ?? null,
      last_date: ds[ds.length - 1] ?? null,
      count: ds.length,
      bucket_dates: ds,
      missing_days: null,
      totals: totalsOf(rs),
    });
    const current = side(cur, cRows, explicit?.cs ?? null, explicit?.ce ?? null);
    const previous = side(prev, pRows, explicit?.ps ?? null, explicit?.pe ?? null);

    const c = new Map(aggregate(cRows).list.map((k) => [k.key, k]));
    const p = new Map(aggregate(pRows).list.map((k) => [k.key, k]));
    const movers: MoverT[] = [];
    for (const key of new Set([...c.keys(), ...p.keys()])) {
      const x = c.get(key);
      const y = p.get(key);
      if (Math.max(x?.impressions ?? 0, y?.impressions ?? 0) < a.min_impressions) continue;
      const xc = { clicks: x?.clicks ?? 0, impressions: x?.impressions ?? 0 };
      const yc = { clicks: y?.clicks ?? 0, impressions: y?.impressions ?? 0 };
      movers.push({
        key,
        status: x && y ? "both" : x ? "new" : "lost",
        clicks_current: xc.clicks,
        clicks_previous: yc.clicks,
        clicks_change: xc.clicks - yc.clicks,
        impressions_current: xc.impressions,
        impressions_previous: yc.impressions,
        impressions_change: xc.impressions - yc.impressions,
        position_current: x?.avg_impression_position ?? null,
        position_previous: y?.avg_impression_position ?? null,
        position_change: x && y ? diff(x.avg_impression_position, y.avg_impression_position, 2) : null,
      });
    }
    const up = (m: MoverT) => m.clicks_change > 0 || (m.clicks_change === 0 && m.impressions_change > 0);
    const down = (m: MoverT) => m.clicks_change < 0 || (m.clicks_change === 0 && m.impressions_change < 0);
    const byChange = (s: 1 | -1) => (m: MoverT, n: MoverT) => s * (n.clicks_change - m.clicks_change) || s * (n.impressions_change - m.impressions_change) || m.key.localeCompare(n.key);
    const risers = movers.filter((m) => m.status === "both" && up(m)).sort(byChange(1));
    const fallers = movers.filter((m) => m.status === "both" && down(m)).sort(byChange(-1));
    const added = movers.filter((m) => m.status === "new").sort((m, n) => n.clicks_current - m.clicks_current || n.impressions_current - m.impressions_current || m.key.localeCompare(n.key));
    const lost = movers.filter((m) => m.status === "lost").sort((m, n) => n.clicks_previous - m.clicks_previous || n.impressions_previous - m.impressions_previous || m.key.localeCompare(n.key));

    notes.push(BUCKET_NOTE);
    notes.push(`Current period: ${cur.length} bucket(s) dated ${cur[0]} to ${cur[cur.length - 1]}. Previous period: ${prev.length} bucket(s) dated ${prev[0]} to ${prev[prev.length - 1]}.`);
    if (explicit) notes.push("Each period uses the whole buckets whose date falls inside the requested range; a bucket's data may extend outside the range.");
    const equal = cur.length === prev.length;
    if (!equal) notes.push(`The periods cover different numbers of buckets (${cur.length} vs ${prev.length}), so raw changes are not like for like.`);
    notes.push(TOP_LIST_NOTE);
    notes.push("new/lost mean the key is absent from Bing's top list in the other period; it may have been just below Bing's cut-off rather than at zero.");
    notes.push("position_change is current minus previous average impression position: negative means the key moved up.");
    return {
      site_url: bing.siteUrl,
      dimension: a.dimension,
      current,
      previous,
      equal_length: equal,
      totals_change: {
        clicks: current.totals.clicks - previous.totals.clicks,
        impressions: current.totals.impressions - previous.totals.impressions,
        ctr: diff(current.totals.ctr, previous.totals.ctr, 4),
        avg_impression_position: diff(current.totals.avg_impression_position, previous.totals.avg_impression_position, 2),
      },
      risers: risers.slice(0, a.limit),
      fallers: fallers.slice(0, a.limit),
      new: added.slice(0, a.limit),
      lost: lost.slice(0, a.limit),
      counts: { risers: risers.length, fallers: fallers.length, new: added.length, lost: lost.length },
      notes,
    };
  },
});

export const performanceTools: AnyTool[] = [getBingSearchPerformance, getBingTopQueries, getBingTopPages, getBingQueryPages, getBingPageQueries, getBingQueryPageDetail, getBingQueryTrend, compareBingSearchPeriods];
