import { ToolError } from "../../../mcp/errors";
import { type BingClient, type Row, asList, asObject, bingDate, bool, num, str } from "../client";

/**
 * Index status, URL/content submission and Fetch as Bingbot. Facts: docs/VERIFICATION.md, "Index status, getting pages
 * indexed and Fetch as Bingbot (2026-11-10)". Pages: learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.*
 *
 * - GetUrlInfo(siteUrl, url) GET → UrlInfo {AnchorCount, DiscoveryDate, DocumentSize, HttpStatus, IsPage, LastCrawledDate,
 *   TotalChildUrlCount, Url}. GetUrlTrafficInfo(siteUrl, url) GET → UrlTrafficInfo {Clicks, Impressions, IsPage, Url}.
 *   The reference describes none of these fields and gives no period for the traffic numbers.
 * - GetChildrenUrlInfo(siteUrl, url, page, filterProperties) is WebInvoke POST although it only reads; GetChildrenUrlTrafficInfo
 *   (siteUrl, url, page) is GET. `page` is a UInt16 starting at 0; the reference's own example loops until a page comes back
 *   empty. Page size is not documented.
 * - FilterProperties {CrawlDateFilter, DiscoveredDateFilter, DocFlagsFilters, HttpCodeFilters} are enums sent as numbers (JSON
 *   sample). DocFlagsFilters and HttpCodeFilters are [Flags] (bitwise combinations).
 * - GetUrlSubmissionQuota / GetContentSubmissionQuota GET → {DailyQuota, MonthlyQuota}.
 * - SubmitUrl {siteUrl, url}, SubmitUrlBatch {siteUrl, urlList} ("max ... 500 unless it exceeds the available quota"),
 *   SubmitContent {siteUrl, url, httpMessage, structuredData, dynamicServing}: POST, `{"d": null}`.
 * - FetchUrl {siteUrl, url} POST (no result). GetFetchedUrls(siteUrl) GET → FetchedUrl[] {Date, Expired, Fetched, Url}.
 *   GetFetchedUrlDetails(siteUrl, url) GET → FetchedUrlDetails {Date, Document, Headers, Status, Url} (all strings but Date).
 */

// ------------------------------------------------------------------------------------------------------ url info

export interface UrlInfo {
  url: string;
  isPage: boolean | null;
  /** HTTP status Bing last got for the URL; Bing's samples report 0 for a directory, read here as "none". */
  httpStatus: number | null;
  discoveryDate: string | null;
  lastCrawledDate: string | null;
  documentSize: number | null;
  anchorCount: number | null;
  totalChildUrlCount: number | null;
}
export interface UrlTraffic {
  url: string;
  isPage: boolean | null;
  clicks: number | null;
  impressions: number | null;
}

export const parseUrlInfo = (r: Row): UrlInfo => {
  const status = num(r.HttpStatus);
  return {
    url: str(r.Url) ?? "",
    isPage: bool(r.IsPage),
    httpStatus: status === null || status <= 0 ? null : status,
    discoveryDate: bingDate(r.DiscoveryDate),
    lastCrawledDate: bingDate(r.LastCrawledDate),
    documentSize: num(r.DocumentSize),
    anchorCount: num(r.AnchorCount),
    totalChildUrlCount: num(r.TotalChildUrlCount),
  };
};
export const parseUrlTraffic = (r: Row): UrlTraffic => ({ url: str(r.Url) ?? "", isPage: bool(r.IsPage), clicks: num(r.Clicks), impressions: num(r.Impressions) });

/** A single object result: `{"d": {...}}`; `{"d": null}` is "nothing known" (null). */
function asOne(v: unknown, what: string): Row | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new ToolError("internal", `Bing Webmaster returned ${what} in an unexpected shape.`);
  return asObject(v);
}

/** GetUrlInfo: Bing's index details for one URL (null when Bing answers with no object). */
export async function getUrlInfo(bing: BingClient, url: string): Promise<UrlInfo | null> {
  const r = asOne(await bing.read("GetUrlInfo", { url }), "URL details");
  return r ? parseUrlInfo(r) : null;
}

/** GetUrlTrafficInfo: Bing's clicks and impressions for one URL (null when Bing answers with no object). */
export async function getUrlTrafficInfo(bing: BingClient, url: string): Promise<UrlTraffic | null> {
  const r = asOne(await bing.read("GetUrlTrafficInfo", { url }), "URL traffic");
  return r ? parseUrlTraffic(r) : null;
}

// ---------------------------------------------------------------------------------------------- directory index

/** CrawlDateFilter (documented values). */
export const CRAWL_DATE = { any: 0, last_week: 1, last_two_weeks: 2, last_three_weeks: 4 } as const;
/** DiscoveredDateFilter (documented values). */
export const DISCOVERED_DATE = { any: 0, last_week: 1, last_month: 2 } as const;
/** DocFlagsFilters ([Flags]; documented values). */
export const DOC_FLAGS = { blocked_by_robots_txt: 1, malware: 2 } as const;
/** HttpCodeFilters ([Flags]; documented values). */
export const HTTP_CODES = { "2xx": 1, "3xx": 2, "301": 4, "302": 8, "4xx": 16, "5xx": 32, all_others: 64 } as const;

export interface ChildFilters {
  crawlDate: keyof typeof CRAWL_DATE;
  discoveredDate: keyof typeof DISCOVERED_DATE;
  docFlags: (keyof typeof DOC_FLAGS)[];
  httpCodes: (keyof typeof HTTP_CODES)[];
}

/** FilterProperties as the JSON sample sends it: `__type` plus the four enums as numbers; flag lists are OR-ed together. */
export function filterProperties(f: ChildFilters): Record<string, unknown> {
  return {
    __type: "FilterProperties:#Microsoft.Bing.Webmaster.Api",
    CrawlDateFilter: CRAWL_DATE[f.crawlDate],
    DiscoveredDateFilter: DISCOVERED_DATE[f.discoveredDate],
    DocFlagsFilters: f.docFlags.reduce((a, k) => a | DOC_FLAGS[k], 0),
    HttpCodeFilters: f.httpCodes.reduce((a, k) => a | HTTP_CODES[k], 0),
  };
}

/** GetChildrenUrlInfo (POST that only reads): one page (from 0) of the URLs Bing knows under a directory. */
export async function getChildrenUrlInfo(bing: BingClient, url: string, page: number, filters: ChildFilters): Promise<UrlInfo[]> {
  return asList(await bing.readPost("GetChildrenUrlInfo", { url, page, filterProperties: filterProperties(filters) }), "directory details").map(parseUrlInfo);
}

/** GetChildrenUrlTrafficInfo: one page (from 0) of clicks and impressions for the URLs under a directory. No filters. */
export async function getChildrenUrlTrafficInfo(bing: BingClient, url: string, page: number): Promise<UrlTraffic[]> {
  return asList(await bing.read("GetChildrenUrlTrafficInfo", { url, page }), "directory traffic").map(parseUrlTraffic);
}

// --------------------------------------------------------------------------------------------------- quotas

export interface SubmissionQuota {
  daily: number | null;
  monthly: number | null;
}
const parseQuota = (v: unknown, what: string): SubmissionQuota => {
  const r = asOne(v, what) ?? {};
  return { daily: num(r.DailyQuota), monthly: num(r.MonthlyQuota) };
};

/** GetUrlSubmissionQuota: how many more URLs Bing accepts today / this month (see SubmitUrl's remark). */
export async function getUrlSubmissionQuota(bing: BingClient): Promise<SubmissionQuota> {
  return parseQuota(await bing.read("GetUrlSubmissionQuota"), "the URL submission quota");
}

/** GetContentSubmissionQuota: how many more content submissions Bing accepts today / this month (see SubmitContent's remark). */
export async function getContentSubmissionQuota(bing: BingClient): Promise<SubmissionQuota> {
  return parseQuota(await bing.read("GetContentSubmissionQuota"), "the content submission quota");
}

/** The smaller of the daily and monthly allowance; null when Bing reported neither. */
export const quotaLeft = (q: SubmissionQuota): number | null => {
  const v = [q.daily, q.monthly].filter((x): x is number => x !== null);
  return v.length ? Math.min(...v) : null;
};

// --------------------------------------------------------------------------------------------------- submissions

/** SubmitUrl for one URL, SubmitUrlBatch for several (at most 500 per the reference). Sent once, never retried. */
export async function submitUrls(bing: BingClient, urls: string[]): Promise<"SubmitUrl" | "SubmitUrlBatch"> {
  if (urls.length === 0 || urls.length > MAX_URL_BATCH) throw new ToolError("internal", "Refused a URL submission outside 1 to 500 URLs.");
  if (urls.length === 1) {
    await bing.send("SubmitUrl", { url: urls[0] });
    return "SubmitUrl";
  }
  await bing.send("SubmitUrlBatch", { urlList: urls });
  return "SubmitUrlBatch";
}
export const MAX_URL_BATCH = 500;

/** SubmitContent's documented limit: "up to 10MB payload uncompressed for the content per request". */
export const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

/** dynamicServing values as the reference lists them: {none = 0, PC-laptop = 1, mobile = 2, AMP = 3, tablet = 4, non-visual browser = 5}. */
export const DYNAMIC_SERVING = { none: 0, pc_laptop: 1, mobile: 2, amp: 3, tablet: 4, non_visual_browser: 5 } as const;

export interface ContentSubmission {
  url: string;
  /** The whole HTTP response (status line, headers, empty line, body), base64-encoded, as the reference requires. */
  httpMessage: string;
  /** Base64 structured data (typically JSON-LD), or "" for none. */
  structuredData: string;
  dynamicServing: number;
}

/** SubmitContent: one page's HTTP response sent to Bing. Sent once, never retried. */
export async function submitContent(bing: BingClient, c: ContentSubmission): Promise<void> {
  await bing.send("SubmitContent", { url: c.url, httpMessage: c.httpMessage, structuredData: c.structuredData, dynamicServing: c.dynamicServing });
}

// --------------------------------------------------------------------------------------------- fetch as Bingbot

export interface FetchedUrl {
  url: string;
  date: string | null;
  fetched: boolean | null;
  expired: boolean | null;
}
export interface FetchedUrlDetails {
  url: string;
  date: string | null;
  status: string | null;
  headers: string | null;
  document: string | null;
}

/** FetchUrl: asks Bingbot to fetch one URL of the site. Sent once, never retried. */
export async function fetchUrl(bing: BingClient, url: string): Promise<void> {
  await bing.send("FetchUrl", { url });
}

/** GetFetchedUrls: the URLs fetched (or waiting to be fetched) with Fetch as Bingbot for the site. */
export async function getFetchedUrls(bing: BingClient): Promise<FetchedUrl[]> {
  return asList(await bing.read("GetFetchedUrls"), "the fetched URL list")
    .map((r) => ({ url: str(r.Url) ?? "", date: bingDate(r.Date), fetched: bool(r.Fetched), expired: bool(r.Expired) }))
    .filter((r) => r.url !== "");
}

/** GetFetchedUrlDetails: what Bingbot got for one fetched URL (null when Bing answers with no object). */
export async function getFetchedUrlDetails(bing: BingClient, url: string): Promise<FetchedUrlDetails | null> {
  const r = asOne(await bing.read("GetFetchedUrlDetails", { url }), "fetched URL details");
  if (!r) return null;
  return { url: str(r.Url) ?? url, date: bingDate(r.Date), status: str(r.Status), headers: str(r.Headers), document: str(r.Document) };
}

/** Same URL for matching Bing's list against a request: exact, or equal after URL parsing (host case, default port, empty path). */
export function sameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}
