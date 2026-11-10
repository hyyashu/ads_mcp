import { type BingClient, asList, asObject, bingDay, num, str } from "../client";

/**
 * Bing keyword research (facts: docs/VERIFICATION.md, "Search performance and keyword research (2026-11-10)").
 *
 * - GetKeyword(q, country, language, startDate, endDate) → Keyword {Query, Impressions, BroadImpressions} ("Get keyword
 *   impressions for selected period").
 * - GetKeywordStats(q, country, language) → KeywordStats[] {Query, Date, Impressions, BroadImpressions} ("Get keyword historical
 *   statistics").
 * - GetRelatedKeywords(q, country, language, startDate, endDate) → Keyword[].
 *
 * None of them takes siteUrl: the numbers are Bing-wide search demand, not this site's traffic. All are WebGet. Microsoft
 * documents neither the country/language formats nor how a DateTime is written in a GET query string (no sample exists for
 * these methods). Dates are sent as ISO 8601 days (YYYY-MM-DD), the form a WCF query-string DateTime reads; country and
 * language are sent exactly as given.
 */
export interface KeywordParams {
  q: string;
  country: string;
  language: string;
}
export interface KeywordRange extends KeywordParams {
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD */
  endDate: string;
}
export interface KeywordVolume {
  query: string;
  impressions: number | null;
  broadImpressions: number | null;
}
export interface KeywordHistoryRow extends KeywordVolume {
  date: string | null;
}

const parseKeyword = (r: Record<string, unknown>): KeywordVolume => ({ query: str(r.Query) ?? "", impressions: num(r.Impressions), broadImpressions: num(r.BroadImpressions) });

const params = (p: KeywordParams) => ({ q: p.q, country: p.country, language: p.language });
const rangeParams = (p: KeywordRange) => ({ ...params(p), startDate: p.startDate, endDate: p.endDate });

/** GetKeyword: one keyword's impressions over a period. Null when Bing answers `{"d": null}` (no data). */
export async function getKeyword(bing: BingClient, p: KeywordRange): Promise<KeywordVolume | null> {
  const d = await bing.read("GetKeyword", rangeParams(p), { site: false });
  if (d === undefined || d === null) return null;
  return parseKeyword(asObject(d));
}

/** GetKeywordStats: the keyword's history, one row per date Bing returns, oldest first. */
export async function getKeywordStats(bing: BingClient, p: KeywordParams): Promise<KeywordHistoryRow[]> {
  return asList(await bing.read("GetKeywordStats", params(p), { site: false }), "keyword stats")
    .map((r) => ({ ...parseKeyword(r), date: bingDay(r.Date) }))
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
}

/** GetRelatedKeywords: keywords related to q, with their impressions over the period. */
export async function getRelatedKeywords(bing: BingClient, p: KeywordRange): Promise<KeywordVolume[]> {
  return asList(await bing.read("GetRelatedKeywords", rangeParams(p), { site: false }), "related keywords")
    .map(parseKeyword)
    .filter((k) => k.query !== "");
}
