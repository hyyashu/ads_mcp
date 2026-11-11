import { ToolError } from "../../../mcp/errors";
import { type BingClient, asList, asObject, bingDay, bool, num } from "../client";

/**
 * Crawl reads and the crawl-settings change. Facts: docs/VERIFICATION.md, "Crawl, sitemaps and backlinks (2026-11-10)".
 *
 * - GetCrawlStats(siteUrl) → CrawlStats[] "for the last 6 months"; "The data will be updated every day." Fields (all Int64
 *   except Date): AllOtherCodes, BlockedByRobotsTxt, Code2xx, Code301, Code302, Code4xx, Code5xx, ConnectionTimeout,
 *   ContainsMalware, CrawledPages, CrawlErrors, Date, DnsFailures, InIndex, InLinks. Microsoft gives no field descriptions.
 * - GetCrawlIssues(siteUrl) → UrlWithCrawlIssues[] {HttpCode Int32, InLinks Int64, Issues (CrawlIssues flags), Url}.
 *   "It may take a few days before fixed issue will disappear from this list."
 * - GetCrawlSettings(siteUrl) → CrawlSettings {CrawlBoostAvailable bool, CrawlBoostEnabled bool, CrawlRate byte[]}. The JSON
 *   sample shows a 24-value CrawlRate and an `AjaxEnabled` field that the contract does not list.
 * - SaveCrawlSettings(siteUrl, crawlSettings): WebInvoke POST, answers {"d": null}.
 */

/** UrlWithCrawlIssues.CrawlIssues ([Flags]), values exactly as documented. None (0) has no bit. */
export const CRAWL_ISSUE_FLAGS = [
  ["Code301", 1],
  ["Code302", 2],
  ["Code4xx", 4],
  ["Code5xx", 8],
  ["BlockedByRobotsTxt", 16],
  ["ContainsMalware", 32],
  ["ImportantUrlBlockedByRobotsTxt", 64],
  ["DnsErrors", 128],
  ["TimeOutErrors", 256],
] as const;
export type CrawlIssueName = (typeof CRAWL_ISSUE_FLAGS)[number][0];
export const CRAWL_ISSUE_NAMES = CRAWL_ISSUE_FLAGS.map(([n]) => n) as [CrawlIssueName, ...CrawlIssueName[]];

/**
 * Decodes a CrawlIssues value. JSON carries the number (sample: 32); XML carries names (sample: "ContainsMalware"), and WCF
 * writes several flags as "A, B", so a name string is accepted too. Flags the docs do not name are returned in
 * `unrecognized` ("bit 512" or the name as sent), never dropped silently.
 */
export function decodeCrawlIssues(v: unknown): { issues: CrawlIssueName[]; unrecognized: string[] } {
  if (typeof v === "string" && !/^\s*-?\d+\s*$/.test(v)) {
    const names = v.split(",").map((s) => s.trim()).filter((s) => s && s !== "None");
    return { issues: CRAWL_ISSUE_NAMES.filter((n) => names.includes(n)), unrecognized: names.filter((n) => !(CRAWL_ISSUE_NAMES as string[]).includes(n)).slice(0, 32) };
  }
  const n = num(v);
  if (n === null || !Number.isInteger(n) || n < 0) return { issues: [], unrecognized: v === undefined || v === null ? [] : [String(v).slice(0, 64)] };
  const unrecognized: string[] = [];
  for (let bit = 512; bit <= n && bit > 0 && unrecognized.length < 32; bit *= 2) if (Math.floor(n / bit) % 2 === 1) unrecognized.push(`bit ${bit}`);
  return { issues: CRAWL_ISSUE_FLAGS.filter(([, bit]) => (n & bit) !== 0).map(([name]) => name), unrecognized };
}

export interface CrawlStatsDay {
  date: string;
  crawledPages: number | null;
  crawlErrors: number | null;
  inIndex: number | null;
  inLinks: number | null;
  code2xx: number | null;
  code301: number | null;
  code302: number | null;
  code4xx: number | null;
  code5xx: number | null;
  allOtherCodes: number | null;
  blockedByRobotsTxt: number | null;
  containsMalware: number | null;
  dnsFailures: number | null;
  connectionTimeout: number | null;
}

/** GetCrawlStats: one row per day Bing reports (about the last 6 months), newest first. */
export async function getCrawlStats(bing: BingClient): Promise<CrawlStatsDay[]> {
  return asList(await bing.read("GetCrawlStats"), "crawl stats")
    .map((r) => ({
      date: bingDay(r.Date),
      crawledPages: num(r.CrawledPages),
      crawlErrors: num(r.CrawlErrors),
      inIndex: num(r.InIndex),
      inLinks: num(r.InLinks),
      code2xx: num(r.Code2xx),
      code301: num(r.Code301),
      code302: num(r.Code302),
      code4xx: num(r.Code4xx),
      code5xx: num(r.Code5xx),
      allOtherCodes: num(r.AllOtherCodes),
      blockedByRobotsTxt: num(r.BlockedByRobotsTxt),
      containsMalware: num(r.ContainsMalware),
      dnsFailures: num(r.DnsFailures),
      connectionTimeout: num(r.ConnectionTimeout),
    }))
    .filter((r): r is CrawlStatsDay => r.date !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export interface CrawlIssueUrl {
  url: string;
  httpCode: number | null;
  inLinks: number | null;
  issues: CrawlIssueName[];
  /** Flags Bing set that the documented enum does not name. */
  unrecognized: string[];
}

/** GetCrawlIssues: URLs with crawl issues, flags decoded into the documented names. */
export async function getCrawlIssues(bing: BingClient): Promise<CrawlIssueUrl[]> {
  return asList(await bing.read("GetCrawlIssues"), "crawl issues")
    .filter((r) => typeof r.Url === "string" && r.Url !== "")
    .map((r) => {
      const d = decodeCrawlIssues(r.Issues);
      return { url: r.Url as string, httpCode: num(r.HttpCode), inLinks: num(r.InLinks), issues: d.issues, unrecognized: d.unrecognized };
    });
}

/** Number of hourly values in CrawlRate (the documented JSON samples, GET and SAVE, both carry 24). */
export const CRAWL_RATE_HOURS = 24;

export interface CrawlSettings {
  /** CrawlRate exactly as Bing returned it: index i is the i-th value of Bing's array. */
  crawlRate: number[];
  crawlBoostAvailable: boolean | null;
  crawlBoostEnabled: boolean | null;
  /** AjaxEnabled: in the JSON samples but not in the CrawlSettings contract. Kept only so a save does not reset it. */
  ajaxEnabled: boolean | null;
}

/**
 * CrawlRate is a .NET byte[]: the JSON samples show a number array; WCF's default JSON for byte[] is also a number array. A
 * base64 string (the XML samples' form) is decoded too. Anything else is a shape we do not understand.
 */
function parseCrawlRate(v: unknown): number[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) {
    const out = v.map(num);
    if (out.some((x) => x === null || !Number.isInteger(x) || x < 0 || x > 255)) throw new ToolError("internal", "Bing Webmaster returned crawl rates in an unexpected shape.");
    return out as number[];
  }
  if (typeof v === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(v)) return [...Buffer.from(v, "base64")];
  throw new ToolError("internal", "Bing Webmaster returned crawl rates in an unexpected shape.");
}

/** GetCrawlSettings. */
export async function getCrawlSettings(bing: BingClient): Promise<CrawlSettings> {
  const d = asObject(await bing.read("GetCrawlSettings"));
  return { crawlRate: parseCrawlRate(d.CrawlRate), crawlBoostAvailable: bool(d.CrawlBoostAvailable), crawlBoostEnabled: bool(d.CrawlBoostEnabled), ajaxEnabled: bool(d.AjaxEnabled) };
}

/**
 * SaveCrawlSettings with the whole settings object: the contract's three fields, plus AjaxEnabled only when Bing returned it
 * (so saving does not reset a field Bing still uses), shaped like the documented JSON sample (with its `__type`).
 */
export async function saveCrawlSettings(bing: BingClient, s: CrawlSettings): Promise<void> {
  const crawlSettings: Record<string, unknown> = { __type: "CrawlSettings:#Microsoft.Bing.Webmaster.Api", CrawlRate: s.crawlRate };
  if (s.crawlBoostAvailable !== null) crawlSettings.CrawlBoostAvailable = s.crawlBoostAvailable;
  if (s.crawlBoostEnabled !== null) crawlSettings.CrawlBoostEnabled = s.crawlBoostEnabled;
  if (s.ajaxEnabled !== null) crawlSettings.AjaxEnabled = s.ajaxEnabled;
  await bing.send("SaveCrawlSettings", { crawlSettings });
}

