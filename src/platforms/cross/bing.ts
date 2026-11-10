import { z } from "zod";
import { ToolError } from "../../mcp/errors";
import type { OtherAccount, ToolContext } from "../../mcp/tool";
import { type DailyTraffic, getQueryStats, getRankAndTrafficStats, sumByKey } from "../bing/api/traffic";
import { type BingClient, asList, asObject, bingDate, bingDay, bool, num, str } from "../bing/client";
import { BING_READ } from "../bing/scopes";
import type { BingServices } from "../bing/services";
import { idArg, normTerm, ratio, requiredAccount, round } from "./common";

/**
 * The Bing side of the combined search tools (design 2026-11-10 "Bing Webmaster tools", §2): the search_engine choice, the
 * Bing site an ad account is linked to, and the few Bing reads the combined tools need that the shared groundwork does not
 * have. Facts: docs/VERIFICATION.md, "Combined tools: Google / Bing / both (2026-11-10)".
 *
 * GetUrlInfo and GetQueryTrafficStats are read here with minimal parsers; the Bing section modules
 * (src/platforms/bing/api/*.ts) may later offer the same calls, and these can then be replaced by them.
 */

export { BING_READ };

// ------------------------------------------------------------------------------------------------ engine choice
export const SEARCH_ENGINES = ["google", "bing", "both"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];
export const usesGoogle = (e: SearchEngine) => e !== "bing";
export const usesBing = (e: SearchEngine) => e !== "google";

export const searchEngineField = z
  .enum(SEARCH_ENGINES)
  .default("google")
  .describe(
    "Organic search engine to compare with: google (Search Console, the default), bing (Bing Webmaster) or both, shown side by side per engine and never added together. Bing's query data has no date range: it comes in weekly buckets over Bing's own window, so only buckets dated inside the period are used and the output names them.",
  );
export const bingSiteArg = idArg("Bing Webmaster site (only with search_engine bing or both)");

/** The Bing site for this call: none for google; else the named one or the single linked one (same rules and errors as Search Console). */
export async function bingSiteFor(ctx: ToolContext<unknown>, a: { search_engine: SearchEngine; bing_site_account_id?: string }): Promise<OtherAccount<BingServices> | null> {
  if (!usesBing(a.search_engine)) {
    if (a.bing_site_account_id) throw new ToolError("invalid_argument", "bing_site_account_id is only used with search_engine bing or both.", { definite: true });
    return null;
  }
  return requiredAccount<BingServices>(ctx, "bing_webmaster", a.bing_site_account_id, "bing_site_account_id");
}

export const BING_NOTES = [
  "Bing dates are the calendar days Bing stamps on its rows (read in the UTC offset Bing sends); the reference does not name Bing's reporting time zone.",
  "Bing reports only its top queries for a site (GetQueryStats), so a term with no Bing row may still have had Bing impressions.",
  "Google and Bing count impressions and positions differently: their figures are shown side by side and never added together.",
];

// ------------------------------------------------------------------------------------------------ query stats in a period
export interface BingQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  avg_impression_position: number | null;
  avg_click_position: number | null;
}
export const BingQueryOut = z.object({
  query: z.string().describe("Query text as Bing reported it (untrusted text)."),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number().nullable().describe("clicks / impressions over the Bing buckets used."),
  avg_impression_position: z.number().nullable().describe("Bing's average impression position, weighted by impressions across buckets."),
  avg_click_position: z.number().nullable().describe("Bing's average click position, weighted by clicks across buckets."),
});

export const BingWeeksOut = z.object({
  bucket_dates_used: z.array(z.string()).describe("Dates Bing stamped on the buckets whose figures are used (each date inside the period)."),
  bucket_dates_available: z.object({ first: z.string().nullable(), last: z.string().nullable(), count: z.number().int() }).describe("Every bucket date Bing returned (its own window)."),
  has_data_in_period: z.boolean().describe("False when no Bing bucket is dated inside the period: the Bing figures are then null, not zero."),
  note: z.string(),
});
export type BingWeeks = z.infer<typeof BingWeeksOut>;

export function weeksOf(allDates: string[], used: string[], p: { start_date: string; end_date: string }, what = "query rows (GetQueryStats)"): BingWeeks {
  const all = [...new Set(allDates)].sort();
  const available = { first: all[0] ?? null, last: all.at(-1) ?? null, count: all.length };
  let note: string;
  if (!all.length) note = `Bing returned no ${what} for this site, so there is no Bing data to compare; nothing is shown as zero.`;
  else if (!used.length)
    note = `No Bing bucket is dated inside ${p.start_date} to ${p.end_date} (Bing's buckets are dated ${available.first} to ${available.last}), so there are no Bing figures for this period; nothing is shown as zero. Choose dates that include one of Bing's bucket dates.`;
  else
    note = `Bing figures are the sum of the ${used.length} bucket(s) dated ${used.join(", ")}: Bing's own weekly buckets (GetQueryStats takes no date range). A bucket is used when its date falls inside ${p.start_date} to ${p.end_date}; the reference does not say which days a bucket covers, so bucket edges do not match the period's exact days and the Bing figures cover about, not exactly, the same days as the other sources.`;
  return { bucket_dates_used: used, bucket_dates_available: available, has_data_in_period: used.length > 0, note };
}

/**
 * Bing's top queries summed over the buckets dated inside the period, merged per normalised query (positions weighted as in
 * sumByKey). `weeks` says which buckets were used.
 */
export async function bingQueries(bing: BingClient, p: { start_date: string; end_date: string }): Promise<{ queries: Map<string, BingQuery>; rows: number; rowsInPeriod: number; weeks: BingWeeks }> {
  const rows = await getQueryStats(bing);
  const display = new Map<string, string>();
  const normed = rows.map((r) => {
    const k = normTerm(r.key);
    if (!display.has(k)) display.set(k, r.key);
    return { ...r, key: k };
  });
  const inPeriod = normed.filter((r) => r.date !== null && r.date >= p.start_date && r.date <= p.end_date);
  const { totals, bucketDates } = sumByKey(normed, { start: p.start_date, end: p.end_date });
  const queries = new Map<string, BingQuery>();
  for (const [k, t] of totals)
    queries.set(k, { query: display.get(k) ?? k, clicks: t.clicks, impressions: t.impressions, ctr: round(ratio(t.clicks, t.impressions)), avg_impression_position: round(t.avgImpressionPosition, 2), avg_click_position: round(t.avgClickPosition, 2) });
  const weeks = weeksOf(rows.map((r) => r.date).filter((d): d is string => d !== null), bucketDates, p);
  return { queries, rows: rows.length, rowsInPeriod: inPeriod.length, weeks };
}

export const bingQuerySource = (b: { rows: number; rowsInPeriod: number; weeks: BingWeeks }) => ({
  source: "bing_webmaster query stats (weekly buckets)",
  rows_read: b.rows,
  complete: true,
  note: `${b.rowsInPeriod} of ${b.rows} rows are in buckets dated inside the period. ${b.weeks.note}`,
});

// ------------------------------------------------------------------------------------------------ GetUrlInfo
export interface BingUrlInfo {
  url: string | null;
  discovery_date: string | null;
  last_crawled_date: string | null;
  http_status: number | null;
  is_page: boolean | null;
  anchor_count: number | null;
  document_size: number | null;
  total_child_url_count: number | null;
}
/** GetUrlInfo(siteUrl, url): "Get index details for single page". GET; the URL is sent as given (see VERIFICATION.md on quoting). */
export async function getUrlInfo(bing: BingClient, url: string): Promise<BingUrlInfo> {
  const d = asObject(await bing.read("GetUrlInfo", { url }));
  return {
    url: str(d.Url),
    discovery_date: bingDate(d.DiscoveryDate),
    last_crawled_date: bingDate(d.LastCrawledDate),
    http_status: num(d.HttpStatus),
    is_page: bool(d.IsPage),
    anchor_count: num(d.AnchorCount),
    document_size: num(d.DocumentSize),
    total_child_url_count: num(d.TotalChildUrlCount),
  };
}

// ------------------------------------------------------------------------------------------------ GetQueryTrafficStats
/** GetQueryTrafficStats(siteUrl, query): RankAndTrafficStats rows {Date, Clicks, Impressions} for one top query, oldest first. */
export async function getQueryTrafficStats(bing: BingClient, query: string): Promise<DailyTraffic[]> {
  return asList(await bing.read("GetQueryTrafficStats", { query }), "query traffic stats")
    .map((r) => ({ date: bingDay(r.Date), clicks: num(r.Clicks) ?? 0, impressions: num(r.Impressions) ?? 0 }))
    .filter((r): r is DailyTraffic => r.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ------------------------------------------------------------------------------------------------ brand trend on Bing
export const BING_BRAND_QUERY_CAP = 20;

export const BingSeriesRow = z.object({
  bucket_start: z.string(),
  bucket_end: z.string(),
  bing_days_with_data: z.number().int().describe("Days of this bucket with a Bing site-traffic row. 0 means Bing has no data for these days: the figures are null, not zero."),
  branded_clicks: z.number().nullable(),
  branded_impressions: z.number().nullable(),
  all_clicks: z.number().nullable(),
  all_impressions: z.number().nullable(),
  branded_share_of_clicks: z.number().nullable(),
});
type SeriesRow = z.infer<typeof BingSeriesRow>;
export const BingBrandQueryOut = z.object({ query: z.string().describe("Untrusted text from Bing."), clicks_in_bing_window: z.number(), impressions_in_bing_window: z.number(), traffic_rows: z.number().int() });

export interface BingBrandResult {
  branded_queries: z.infer<typeof BingBrandQueryOut>[];
  branded_queries_found: number;
  series: SeriesRow[];
  summary: { first_half_avg_branded_clicks: number | null; second_half_avg_branded_clicks: number | null; change: number | null };
  sources: { source: string; rows_read: number; complete: boolean; note: string | null }[];
  notes: string[];
}

/**
 * Branded search on Bing per bucket. Bing has no query filter on its site-wide traffic (GetRankAndTrafficStats), so branded
 * traffic is built from the queries: Bing's top queries (GetQueryStats, its whole window) whose normalised text contains a brand
 * term are found, and each one's traffic over time is read with GetQueryTrafficStats (at most BING_BRAND_QUERY_CAP queries, by
 * impressions). Site-wide clicks per day come from GetRankAndTrafficStats.
 */
export async function bingBrandTrend(bing: BingClient, terms: string[], buckets: { start: string; end: string }[]): Promise<BingBrandResult> {
  const needles = [...new Set(terms.map(normTerm))];
  const [top, site] = await Promise.all([getQueryStats(bing), getRankAndTrafficStats(bing)]);
  const found = new Map<string, { query: string; clicks: number; impressions: number }>();
  for (const r of top) {
    if (!needles.some((n) => normTerm(r.key).includes(n))) continue;
    const q = found.get(r.key) ?? { query: r.key, clicks: 0, impressions: 0 };
    q.clicks += r.clicks;
    q.impressions += r.impressions;
    found.set(r.key, q);
  }
  const matched = [...found.values()].sort((x, y) => y.impressions - x.impressions || x.query.localeCompare(y.query));
  const used = matched.slice(0, BING_BRAND_QUERY_CAP);
  // One query at a time: Bing throttles per user (ThrottleUser) and documents no rate, so the calls are not fanned out.
  const traffic: DailyTraffic[][] = [];
  for (const q of used) traffic.push(await getQueryTrafficStats(bing, q.query));

  const idx = (d: string) => buckets.findIndex((b) => d >= b.start && d <= b.end);
  const series: SeriesRow[] = buckets.map((b) => ({ bucket_start: b.start, bucket_end: b.end, bing_days_with_data: 0, branded_clicks: null, branded_impressions: null, all_clicks: null, all_impressions: null, branded_share_of_clicks: null }));
  const days = buckets.map(() => new Set<string>());
  for (const r of site) {
    const i = idx(r.date);
    if (i < 0) continue;
    const s = series[i]!;
    days[i]!.add(r.date);
    s.all_clicks = (s.all_clicks ?? 0) + r.clicks;
    s.all_impressions = (s.all_impressions ?? 0) + r.impressions;
  }
  const brandedRowsIn = buckets.map(() => 0);
  for (const rows of traffic)
    for (const r of rows) {
      const i = idx(r.date);
      if (i < 0) continue;
      const s = series[i]!;
      brandedRowsIn[i]!++;
      s.branded_clicks = (s.branded_clicks ?? 0) + r.clicks;
      s.branded_impressions = (s.branded_impressions ?? 0) + r.impressions;
    }
  for (const [i, s] of series.entries()) {
    s.bing_days_with_data = days[i]!.size;
    // With branded queries found, a bucket Bing has data for but no branded row in reads as 0 branded (those queries had no
    // traffic row there); a bucket without any Bing data stays null.
    if (used.length && s.branded_clicks === null && s.bing_days_with_data > 0) (s.branded_clicks = 0), (s.branded_impressions = 0);
    s.branded_share_of_clicks = s.branded_clicks !== null && s.all_clicks !== null ? round(ratio(s.branded_clicks, s.all_clicks)) : null;
  }
  const half = Math.floor(series.length / 2);
  const avg = (xs: SeriesRow[]) => {
    const v = xs.map((x) => x.branded_clicks).filter((x): x is number => x !== null);
    return v.length ? round(v.reduce((s, x) => s + x, 0) / v.length, 2) : null;
  };
  const first = half ? avg(series.slice(0, half)) : null;
  const second = half ? avg(series.slice(series.length - half)) : null;

  const siteDates = site.map((r) => r.date);
  const inPeriod = siteDates.filter((d) => idx(d) >= 0);
  const notes: string[] = [];
  if (!matched.length)
    notes.push(`None of Bing's top queries for this site contains a brand term, so Bing branded traffic is unknown (null), not zero: Bing reports traffic only for its top queries.`);
  if (!inPeriod.length) notes.push(siteDates.length ? `Bing's site traffic is dated ${siteDates[0]} to ${siteDates.at(-1)}: no day falls inside the period, so the Bing figures are null.` : "Bing returned no site traffic rows (GetRankAndTrafficStats), so the Bing figures are null.");
  notes.push(
    "Bing branded figures add the traffic of Bing's top queries that contain a brand term (GetQueryTrafficStats: \"Only top-queries will be saved and returned by this method\"); less frequent branded queries are missing, so branded traffic is undercounted.",
    "Bing's site-wide clicks and impressions include all verticals (Web, Chat, News, Images, Videos, Knowledge Panel, from 24 March 2023, per GetRankAndTrafficStats); the reference does not say whether per-query traffic does, so the branded share is approximate.",
    "The reference does not state the date granularity of GetQueryTrafficStats rows; each row is counted in the bucket containing the date Bing stamped on it.",
  );
  return {
    branded_queries: used.map((q, i) => ({ query: q.query, clicks_in_bing_window: q.clicks, impressions_in_bing_window: q.impressions, traffic_rows: traffic[i]!.length })),
    branded_queries_found: matched.length,
    series,
    summary: { first_half_avg_branded_clicks: first, second_half_avg_branded_clicks: second, change: first !== null && second !== null ? round(ratio(second - first, first)) : null },
    sources: [
      { source: "bing_webmaster top queries (to find branded queries)", rows_read: top.length, complete: true, note: `${matched.length} of Bing's top queries contain a brand term.` },
      {
        source: "bing_webmaster query traffic (per branded query)",
        rows_read: traffic.reduce((s, t) => s + t.length, 0),
        complete: used.length === matched.length,
        note: used.length === matched.length ? null : `Only the ${BING_BRAND_QUERY_CAP} branded queries with the most impressions were read; ${matched.length - used.length} more were not, so branded traffic is undercounted.`,
      },
      { source: "bing_webmaster site traffic (daily)", rows_read: site.length, complete: true, note: `${inPeriod.length} of these days are inside the period.` },
    ],
    notes,
  };
}
