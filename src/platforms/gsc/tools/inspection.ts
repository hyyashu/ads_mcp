import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { accountId, gscRead, httpUrl, withinProperty } from "./common";

// urlInspection.index.inspect: POST searchconsole.googleapis.com/v1/urlInspection/index:inspect, body {inspectionUrl, siteUrl,
// languageCode?}. Reports Google's indexed version only. mobileUsabilityResult is deprecated and never read.
// Quota: 2,000 per day and 600 per minute per site.

const VERDICT: Record<string, string> = {
  PASS: "Valid: the URL is on Google (indexed).",
  PARTIAL: "Partly valid (Google reserves this value; it is not normally used).",
  FAIL: "Error: the URL is not on Google because of a problem (see coverage state).",
  NEUTRAL: "Excluded from the index (see coverage state).",
  VERDICT_UNSPECIFIED: "Google gave no verdict.",
};
const ROBOTS: Record<string, string> = { ALLOWED: "robots.txt allows crawling.", DISALLOWED: "robots.txt blocks crawling of this URL.", ROBOTS_TXT_STATE_UNSPECIFIED: "robots.txt state unknown (the page may not have been fetched)." };
const INDEXING: Record<string, string> = {
  INDEXING_ALLOWED: "Indexing is allowed.",
  BLOCKED_BY_META_TAG: "A noindex meta tag blocks indexing.",
  BLOCKED_BY_HTTP_HEADER: "A noindex X-Robots-Tag HTTP header blocks indexing.",
  BLOCKED_BY_ROBOTS_TXT: "robots.txt blocks indexing (Google reserves this value).",
  INDEXING_STATE_UNSPECIFIED: "Indexing state unknown.",
};
const FETCH: Record<string, string> = {
  SUCCESSFUL: "Google fetched the page successfully.",
  SOFT_404: "Google treated the page as a soft 404 (looks like an error page).",
  BLOCKED_ROBOTS_TXT: "robots.txt blocked the fetch.",
  NOT_FOUND: "The page returned 404 Not Found.",
  ACCESS_DENIED: "The page returned 401 Unauthorized.",
  SERVER_ERROR: "The page returned a server error (5xx).",
  REDIRECT_ERROR: "Redirect error.",
  ACCESS_FORBIDDEN: "The page returned 403 Forbidden.",
  BLOCKED_4XX: "The page returned a 4xx error.",
  INTERNAL_CRAWL_ERROR: "Google had an internal crawl error.",
  INVALID_URL: "Invalid URL.",
  PAGE_FETCH_STATE_UNSPECIFIED: "Fetch state unknown (the page may not have been fetched).",
};
const AMP_INDEXING: Record<string, string> = { AMP_INDEXING_ALLOWED: "AMP indexing is allowed.", BLOCKED_DUE_TO_NOINDEX: "The AMP page is blocked by noindex.", BLOCKED_DUE_TO_EXPIRED_UNAVAILABLE_AFTER: "The AMP page expired (unavailable_after).", AMP_INDEXING_STATE_UNSPECIFIED: "AMP indexing state unknown." };

const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const issues = (v: unknown) => (Array.isArray(v) ? v : []).map((i) => ({ message: s(o(i).issueMessage), severity: s(o(i).severity) }));
const explain = (label: string, table: Record<string, string>, v: string | null, out: string[]) => {
  if (v === null) return;
  out.push(`${label}: ${table[v] ?? `Google returned ${v}, which this server does not recognise.`}`);
};

const LIST_CAP = 20;
const ITEM_CAP = 50;
const Issue = z.object({ message: z.string().nullable(), severity: z.string().nullable() });

// ---------------------------------------------------------------------------------------------------- inspect_url
export const inspectUrl = gscRead({
  name: "inspect_url",
  title: "Inspect a URL's index status",
  description:
    "Shows whether one URL of the site is in Google's index and why not: verdict, coverage state, robots.txt and noindex state, last crawl, page fetch result, Google's and the declared canonical, sitemaps and referring pages, rich results and AMP. It reports Google's indexed version, not a live test. Each call uses one of the 2,000 inspections Search Console allows per site per day.",
  input: z.object({
    account_id: accountId,
    url: httpUrl.describe("Full URL to inspect; it must belong to the site (account_id)."),
    language_code: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/, "a BCP-47 language code such as en-US").optional().describe("Language of Google's issue messages (BCP-47, default en-US)."),
  }),
  output: z.object({
    url: z.string(),
    site_url: z.string(),
    inspection_result_link: z.string().nullable(),
    verdict: z.string().nullable(),
    coverage_state: z.string().nullable(),
    robots_txt_state: z.string().nullable(),
    indexing_state: z.string().nullable(),
    page_fetch_state: z.string().nullable(),
    last_crawl_time: z.string().nullable(),
    crawled_as: z.string().nullable(),
    google_canonical: z.string().nullable(),
    user_canonical: z.string().nullable(),
    canonical_mismatch: z.boolean().nullable().describe("True when Google chose a different canonical than the page declares; null when either is unknown."),
    sitemaps: z.array(z.string()),
    sitemaps_truncated: z.boolean(),
    referring_urls: z.array(z.string()),
    referring_urls_truncated: z.boolean(),
    rich_results: z.object({ verdict: z.string().nullable(), items: z.array(z.object({ type: z.string().nullable(), name: z.string().nullable(), issues: z.array(Issue) })), truncated: z.boolean() }).nullable(),
    amp: z
      .object({
        amp_url: z.string().nullable(),
        verdict: z.string().nullable(),
        index_status_verdict: z.string().nullable(),
        indexing_state: z.string().nullable(),
        robots_txt_state: z.string().nullable(),
        page_fetch_state: z.string().nullable(),
        last_crawl_time: z.string().nullable(),
        issues: z.array(Issue),
      })
      .nullable(),
    explanation: z.array(z.string()),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const gsc = ctx.services.gsc;
    if (!withinProperty(gsc.siteUrl, a.url)) throw new ToolError("invalid_argument", `${a.url} is not part of the Search Console property ${gsc.siteUrl}. Inspect it through the site it belongs to. Nothing was sent.`);
    let r: Record<string, unknown>;
    try {
      r = await gsc.inspectUrl(a.url, a.language_code);
    } catch (e) {
      if (e instanceof ToolError && e.code === "quota_exceeded") {
        throw new ToolError("quota_exceeded", "Search Console allows 2,000 URL inspections per property per day and 600 per minute; this property has hit one of them. Retry later (the daily limit resets daily; Google does not say at what hour).", e.opts);
      }
      if (e instanceof ToolError && e.code === "platform_permission_denied") throw new ToolError("platform_permission_denied", `The connected Google user has no access to ${gsc.siteUrl} in Search Console, or lost it. ${e.message}`, e.opts);
      throw e;
    }
    const idx = o(r.indexStatusResult);
    const verdict = s(idx.verdict);
    const robots = s(idx.robotsTxtState);
    const indexing = s(idx.indexingState);
    const fetchState = s(idx.pageFetchState);
    const gCanon = s(idx.googleCanonical);
    const uCanon = s(idx.userCanonical);
    const sm = strings(idx.sitemap);
    const refs = strings(idx.referringUrls);
    const explanation: string[] = [];
    explain("Verdict", VERDICT, verdict, explanation);
    if (s(idx.coverageState)) explanation.push(`Coverage: ${s(idx.coverageState)}.`);
    explain("robots.txt", ROBOTS, robots, explanation);
    explain("Indexing", INDEXING, indexing, explanation);
    explain("Fetch", FETCH, fetchState, explanation);
    if (!s(idx.lastCrawlTime) && Object.keys(idx).length) explanation.push("Google has no crawl of this URL on record.");
    const mismatch = gCanon && uCanon ? gCanon !== uCanon : null;
    if (mismatch) explanation.push(`Google chose ${gCanon} as canonical instead of the declared ${uCanon}.`);

    const rich = r.richResultsResult === undefined ? null : o(r.richResultsResult);
    const detected = (rich ? (Array.isArray(rich.detectedItems) ? rich.detectedItems : []) : []).flatMap((d) => (Array.isArray(o(d).items) ? (o(d).items as unknown[]) : [{}]).map((it) => ({ type: s(o(d).richResultType), name: s(o(it).name), issues: issues(o(it).issues) })));
    const ampRaw = r.ampResult === undefined ? null : o(r.ampResult);
    if (ampRaw) explain("AMP indexing", AMP_INDEXING, s(ampRaw.indexingState), explanation);

    return {
      url: a.url,
      site_url: gsc.siteUrl,
      inspection_result_link: s(r.inspectionResultLink),
      verdict,
      coverage_state: s(idx.coverageState),
      robots_txt_state: robots,
      indexing_state: indexing,
      page_fetch_state: fetchState,
      last_crawl_time: s(idx.lastCrawlTime),
      crawled_as: s(idx.crawledAs),
      google_canonical: gCanon,
      user_canonical: uCanon,
      canonical_mismatch: mismatch,
      sitemaps: sm.slice(0, LIST_CAP),
      sitemaps_truncated: sm.length > LIST_CAP,
      referring_urls: refs.slice(0, LIST_CAP),
      referring_urls_truncated: refs.length > LIST_CAP,
      rich_results: rich ? { verdict: s(rich.verdict), items: detected.slice(0, ITEM_CAP), truncated: detected.length > ITEM_CAP } : null,
      amp: ampRaw
        ? {
            amp_url: s(ampRaw.ampUrl),
            verdict: s(ampRaw.verdict),
            index_status_verdict: s(ampRaw.ampIndexStatusVerdict),
            indexing_state: s(ampRaw.indexingState),
            robots_txt_state: s(ampRaw.robotsTxtState),
            page_fetch_state: s(ampRaw.pageFetchState),
            last_crawl_time: s(ampRaw.lastCrawlTime),
            issues: issues(ampRaw.issues),
          }
        : null,
      explanation,
      notes: ["Shows Google's indexed version of the URL, not a live test.", "Each call uses 1 of the 2,000 URL inspections Search Console allows per property per day (and 600 per minute)."],
    };
  },
});
