import { type BingClient, asList, bingDay, num, str } from "../client";

/**
 * Search traffic reads shared by the performance tools and the combined (Google/Bing) tools.
 *
 * - GetRankAndTrafficStats(siteUrl) → RankAndTrafficStats[] {Date, Clicks, Impressions}. "The data will be updated every day.
 *   The traffic data includes Impressions and Clicks from all verticals i.e. Web, Chat, News, Images, Videos and Knowledge
 *   Panel from March 24th, 2023 onwards."
 * - GetQueryStats(siteUrl) / GetPageStats(siteUrl) → QueryStats[] {Query, Date, Impressions, Clicks, AvgImpressionPosition,
 *   AvgClickPosition}. For GetPageStats, `Query` holds the page URL. "The data will be updated every week." Neither method takes
 *   a date range: Bing returns its own window, one row per (query or page, Date bucket).
 *
 * Positions: Bing reports an average impression position and an average click position; -1 or 0 is read as "none".
 */
export interface DailyTraffic {
  date: string;
  clicks: number;
  impressions: number;
}
export interface QueryStat {
  /** The query text (GetQueryStats) or the page URL (GetPageStats). */
  key: string;
  /** Calendar day Bing stamped on the bucket (YYYY-MM-DD in the offset Bing sent). */
  date: string | null;
  clicks: number;
  impressions: number;
  avgImpressionPosition: number | null;
  avgClickPosition: number | null;
}

const pos = (v: unknown): number | null => {
  const n = num(v);
  return n === null || n <= 0 ? null : n;
};

export const parseQueryStats = (d: unknown, what: string): QueryStat[] =>
  asList(d, what)
    .map((r) => ({ key: str(r.Query) ?? "", date: bingDay(r.Date), clicks: num(r.Clicks) ?? 0, impressions: num(r.Impressions) ?? 0, avgImpressionPosition: pos(r.AvgImpressionPosition), avgClickPosition: pos(r.AvgClickPosition) }))
    .filter((r) => r.key !== "");

/** GetRankAndTrafficStats: daily clicks and impressions for the whole site, oldest first. */
export async function getRankAndTrafficStats(bing: BingClient): Promise<DailyTraffic[]> {
  return asList(await bing.read("GetRankAndTrafficStats"), "traffic stats")
    .map((r) => ({ date: bingDay(r.Date), clicks: num(r.Clicks) ?? 0, impressions: num(r.Impressions) ?? 0 }))
    .filter((r): r is DailyTraffic => r.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** GetQueryStats: the top queries Bing reports for the site, one row per query and weekly bucket. */
export async function getQueryStats(bing: BingClient): Promise<QueryStat[]> {
  return parseQueryStats(await bing.read("GetQueryStats"), "query stats");
}

/** GetPageStats: the top pages Bing reports for the site, one row per page and weekly bucket (key = page URL). */
export async function getPageStats(bing: BingClient): Promise<QueryStat[]> {
  return parseQueryStats(await bing.read("GetPageStats"), "page stats");
}

/**
 * Sums buckets per key over [start, end] (inclusive, by the bucket's date). Impression position is averaged weighted by
 * impressions, click position by clicks. Returns also which bucket dates were used, so callers can say exactly what period
 * the numbers cover (Bing's buckets rarely line up with an arbitrary date range).
 */
export function sumByKey(rows: QueryStat[], range?: { start: string; end: string }): { totals: Map<string, Omit<QueryStat, "date">>; bucketDates: string[] } {
  const totals = new Map<string, Omit<QueryStat, "date"> & { ipw: number; cpw: number }>();
  const dates = new Set<string>();
  for (const r of rows) {
    if (range && (!r.date || r.date < range.start || r.date > range.end)) continue;
    if (r.date) dates.add(r.date);
    const t = totals.get(r.key) ?? { key: r.key, clicks: 0, impressions: 0, avgImpressionPosition: null, avgClickPosition: null, ipw: 0, cpw: 0 };
    t.clicks += r.clicks;
    t.impressions += r.impressions;
    if (r.avgImpressionPosition !== null && r.impressions > 0) {
      t.avgImpressionPosition = ((t.avgImpressionPosition ?? 0) * t.ipw + r.avgImpressionPosition * r.impressions) / (t.ipw + r.impressions);
      t.ipw += r.impressions;
    }
    if (r.avgClickPosition !== null && r.clicks > 0) {
      t.avgClickPosition = ((t.avgClickPosition ?? 0) * t.cpw + r.avgClickPosition * r.clicks) / (t.cpw + r.clicks);
      t.cpw += r.clicks;
    }
    totals.set(r.key, t);
  }
  const out = new Map<string, Omit<QueryStat, "date">>();
  for (const [k, { ipw: _i, cpw: _c, ...v }] of totals) out.set(k, v);
  return { totals: out, bucketDates: [...dates].sort() };
}
