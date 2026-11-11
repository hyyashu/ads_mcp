import { type BingClient, asList, bingDay, num } from "../client";
import { type DailyTraffic, type QueryStat, parseQueryStats } from "./traffic";

/**
 * Per-query and per-page search reads (facts: docs/VERIFICATION.md, "Search performance and keyword research (2026-11-10)").
 *
 * - GetQueryPageStats(siteUrl, query) → QueryStats[]: "Get detailed traffic statistics for specific query". Microsoft's sample
 *   shows the query text in `Query`; the tools treat the field as the row's key and say so when it only repeats the query.
 * - GetPageQueryStats(siteUrl, page) → QueryStats[]: "Get detailed traffic statistics for specific site's page" (`Query` = query).
 * - GetQueryPageDetailStats(siteUrl, query, page) → DetailedQueryStats[] {Clicks, Date, Impressions, Position}.
 * - GetQueryTrafficStats(siteUrl, query) → RankAndTrafficStats[] {Clicks, Date, Impressions}: "The data will be updated every
 *   day. Only top-queries will be saved and returned by this method."
 *
 * All are WebGet: string parameters go in the query string. The JSON samples show `query=%22query1%22` (JSON-quoted) while
 * siteUrl is unquoted in the same samples and the XML samples are unquoted; values are sent unquoted like siteUrl.
 */
export interface DetailStat {
  date: string | null;
  clicks: number;
  impressions: number;
  /** DetailedQueryStats.Position (Int32 in the reference); 0 or less is read as "none". */
  position: number | null;
}

/** GetQueryPageStats: rows for one query, one per key (`Query`) and bucket date. */
export async function getQueryPageStats(bing: BingClient, query: string): Promise<QueryStat[]> {
  return parseQueryStats(await bing.read("GetQueryPageStats", { query }), "query page stats");
}

/** GetPageQueryStats: the queries Bing reports for one page, one row per query and bucket date. */
export async function getPageQueryStats(bing: BingClient, page: string): Promise<QueryStat[]> {
  return parseQueryStats(await bing.read("GetPageQueryStats", { page }), "page query stats");
}

/** GetQueryPageDetailStats: one query on one page, one row per bucket date, oldest first. */
export async function getQueryPageDetailStats(bing: BingClient, query: string, page: string): Promise<DetailStat[]> {
  return asList(await bing.read("GetQueryPageDetailStats", { query, page }), "query page detail stats")
    .map((r) => {
      const p = num(r.Position);
      return { date: bingDay(r.Date), clicks: num(r.Clicks) ?? 0, impressions: num(r.Impressions) ?? 0, position: p === null || p <= 0 ? null : p };
    })
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
}

/** GetQueryTrafficStats: clicks and impressions of one (top) query per date Bing returns, oldest first. */
export async function getQueryTrafficStats(bing: BingClient, query: string): Promise<DailyTraffic[]> {
  return asList(await bing.read("GetQueryTrafficStats", { query }), "query traffic stats")
    .map((r) => ({ date: bingDay(r.Date), clicks: num(r.Clicks) ?? 0, impressions: num(r.Impressions) ?? 0 }))
    .filter((r): r is DailyTraffic => r.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}
