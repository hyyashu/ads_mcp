import { STATUS_CODES } from "node:http";
import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { AnyTool } from "../../../mcp/tool";
import type { Change } from "../../../policy/change-set";
import {
  CRAWL_DATE,
  DISCOVERED_DATE,
  DOC_FLAGS,
  DYNAMIC_SERVING,
  HTTP_CODES,
  MAX_CONTENT_BYTES,
  MAX_URL_BATCH,
  type SubmissionQuota,
  type UrlInfo,
  type UrlTraffic,
  getChildrenUrlInfo,
  getChildrenUrlTrafficInfo,
  getContentSubmissionQuota,
  getUrlInfo,
  getUrlSubmissionQuota,
  getUrlTrafficInfo,
  quotaLeft,
  submitContent,
  submitUrls,
} from "../api/indexing";
import { accountId, bingRead, bingWrite, httpUrl, page, requireWithinSite } from "./common";

// Facts: docs/VERIFICATION.md, "Index status, getting pages indexed and Fetch as Bingbot (2026-11-10)".

const untrusted = "(untrusted text from Bing)";
const pageUrl = httpUrl.describe("Full URL of a page inside this Bing site, e.g. https://www.example.com/products/shoes.");

const UrlFields = {
  is_page: z.boolean().nullable().describe("true for a page, false for a directory (a path that has URLs under it), as Bing classifies it."),
  http_status: z.number().nullable().describe("HTTP status code Bing got the last time it crawled the URL (200, 301, 404, ...); null when Bing reports none (Bing reports 0 for directories)."),
  discovery_date: z.string().nullable().describe("When Bing first found the URL (ISO 8601)."),
  last_crawled_date: z.string().nullable().describe("When Bingbot last crawled the URL (ISO 8601); null when Bing reports none."),
  document_size: z.number().nullable().describe("Size of the document as Bing reports it. The reference does not state the unit; 0 for directories in Bing's samples."),
  anchor_count: z.number().nullable().describe("Bing's AnchorCount for the URL: by its name, the number of links (anchors) Bing found pointing to it. The reference does not describe it."),
  total_child_url_count: z.number().nullable().describe("How many URLs Bing knows under this URL (for a directory); see get_bing_directory_index."),
  clicks: z.number().nullable().describe("Clicks from Bing search results to this URL. Bing does not document which period this covers."),
  impressions: z.number().nullable().describe("Times this URL was shown in Bing search results. Bing does not document which period this covers."),
};
const urlFields = (i: UrlInfo | null, t: UrlTraffic | null) => ({
  is_page: i?.isPage ?? t?.isPage ?? null,
  http_status: i?.httpStatus ?? null,
  discovery_date: i?.discoveryDate ?? null,
  last_crawled_date: i?.lastCrawledDate ?? null,
  document_size: i?.documentSize ?? null,
  anchor_count: i?.anchorCount ?? null,
  total_child_url_count: i?.totalChildUrlCount ?? null,
  clicks: t?.clicks ?? null,
  impressions: t?.impressions ?? null,
});

const FIELD_NOTES = [
  "Microsoft's reference lists these fields without describing them; the explanations here follow the field names and Bing's samples.",
  "Clicks and impressions have no documented period. Do not set them beside a dated Google or ads figure as if they covered the same dates.",
  "A URL Bing knows (has a discovery or crawl date) is not necessarily shown in results; Bing's API has no 'indexed' verdict like Google's URL inspection.",
];

// ---------------------------------------------------------------------------------------------- inspect_bing_url
// GetUrlInfo(siteUrl, url) + GetUrlTrafficInfo(siteUrl, url): both GET.
export const inspectBingUrl = bingRead({
  name: "inspect_bing_url",
  title: "Inspect a URL in Bing",
  description:
    "Shows what Bing knows about one URL of a Bing Webmaster site: whether it is a page or a directory, the HTTP status Bing last got, when Bing discovered and last crawled it, document size, how many links point to it, how many URLs are under it, and its Bing clicks and impressions (Bing does not say for which period). The URL must be inside the site. Read-only.",
  input: z.object({ account_id: accountId, url: pageUrl }),
  output: z.object({
    site_url: z.string(),
    url: z.string().describe("The URL asked about."),
    bing_url: z.string().nullable().describe(`The URL as Bing names it ${untrusted}.`),
    known_to_bing: z.boolean().describe("false when Bing returned no index details for the URL."),
    ...UrlFields,
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    requireWithinSite(bing.siteUrl, a.url);
    const [info, traffic] = await Promise.all([getUrlInfo(bing, a.url), getUrlTrafficInfo(bing, a.url)]);
    const known = info !== null && (info.url !== "" || info.discoveryDate !== null || info.lastCrawledDate !== null);
    return {
      site_url: bing.siteUrl,
      url: a.url,
      bing_url: info?.url || traffic?.url || null,
      known_to_bing: known,
      ...urlFields(info, traffic),
      notes: known ? FIELD_NOTES : ["Bing returned no index details for this URL: it may not have discovered it yet. submit_bing_urls asks Bing to crawl it.", ...FIELD_NOTES.slice(1)],
    };
  },
});

// -------------------------------------------------------------------------------------- get_bing_directory_index
// GetChildrenUrlInfo (POST, filterProperties) + GetChildrenUrlTrafficInfo (GET), both paged by `page` from 0. Page size and
// whether the two methods page the same way are not documented.
const MAX_PAGES = 10;
export const getBingDirectoryIndex = bingRead({
  name: "get_bing_directory_index",
  title: "Bing index of a directory",
  description:
    "Lists the URLs Bing knows under one directory of a Bing Webmaster site (pages and sub-directories), each with HTTP status, discovery and last crawl dates, size, links pointing to it, child count, and Bing clicks and impressions. Bing pages this list (page 0, 1, ...; page size not documented); the tool reads up to max_pages pages from `page` and says when more may exist and which page to ask for next. Optional filters (crawl date, discovery date, robots.txt-blocked or malware, HTTP status class) narrow the index details; Bing's traffic list takes no filters. Read-only.",
  input: z.object({
    account_id: accountId,
    directory_url: httpUrl.describe("URL of a directory inside this Bing site, e.g. https://www.example.com/blog/ or the site URL itself."),
    page: z.number().int().min(0).max(65_535).default(0).describe("First page to read (Bing counts from 0)."),
    max_pages: z.number().int().min(1).max(MAX_PAGES).default(1).describe(`How many pages to read from \`page\` (at most ${MAX_PAGES}).`),
    crawl_date: z.enum(Object.keys(CRAWL_DATE) as [keyof typeof CRAWL_DATE, ...(keyof typeof CRAWL_DATE)[]]).default("any").describe("Only URLs Bing crawled in this recent window."),
    discovered_date: z.enum(Object.keys(DISCOVERED_DATE) as [keyof typeof DISCOVERED_DATE, ...(keyof typeof DISCOVERED_DATE)[]]).default("any").describe("Only URLs Bing discovered in this recent window."),
    doc_flags: z
      .array(z.enum(Object.keys(DOC_FLAGS) as [keyof typeof DOC_FLAGS, ...(keyof typeof DOC_FLAGS)[]]))
      .max(2)
      .default([])
      .describe("Only URLs Bing flagged this way (robots.txt blocks them, or malware). Empty = any."),
    http_codes: z
      .array(z.enum(Object.keys(HTTP_CODES) as [keyof typeof HTTP_CODES, ...(keyof typeof HTTP_CODES)[]]))
      .max(7)
      .default([])
      .describe("Only URLs whose last HTTP status is in one of these classes. Empty = any."),
    limit: z.number().int().min(1).max(1000).default(200).describe("At most this many URLs are returned."),
  }),
  output: z.object({
    site_url: z.string(),
    directory_url: z.string(),
    total_child_url_count: z.number().nullable().describe("How many URLs Bing says it knows under the directory (all of them, without filters)."),
    first_page: z.number(),
    pages_read: z.number(),
    next_page: z.number().nullable().describe("Page to ask for next when more may exist; null when the last page read was empty (the end)."),
    children: z.array(z.object({ url: z.string().describe(`URL as Bing names it ${untrusted}.`), ...UrlFields })),
    returned: z.number(),
    total: z.number().describe("URLs read from the pages read (before `limit`)."),
    truncated: z.boolean().describe("true when more URLs were read than returned, or when more pages may exist after the ones read."),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    requireWithinSite(bing.siteUrl, a.directory_url, "directory");
    const filters = { crawlDate: a.crawl_date, discoveredDate: a.discovered_date, docFlags: [...new Set(a.doc_flags)], httpCodes: [...new Set(a.http_codes)] };
    const dir = await getUrlInfo(bing, a.directory_url);
    const rows: UrlInfo[] = [];
    const traffic = new Map<string, UrlTraffic>();
    let pagesRead = 0;
    let reachedEnd = false;
    const last = Math.min(65_535, a.page + a.max_pages - 1);
    for (let p = a.page; p <= last; p++) {
      const got = await getChildrenUrlInfo(bing, a.directory_url, p, filters);
      pagesRead++;
      if (got.length === 0) {
        reachedEnd = true;
        break;
      }
      rows.push(...got);
      for (const t of await getChildrenUrlTrafficInfo(bing, a.directory_url, p)) if (t.url) traffic.set(t.url, t);
    }
    const lastRead = a.page + pagesRead - 1;
    const more = !reachedEnd && lastRead < 65_535;
    const pg = page(rows, a.limit);
    const filtered = a.crawl_date !== "any" || a.discovered_date !== "any" || filters.docFlags.length > 0 || filters.httpCodes.length > 0;
    const notes = [
      more ? `More URLs may exist: ask again with page ${lastRead + 1}.` : "The last page read was empty: this is the end of Bing's list.",
      "Traffic comes from Bing's separate traffic list for the same page numbers; Bing does not document that both lists page alike, so clicks and impressions are null for URLs not found there.",
      ...(filtered ? ["Filters narrow the index details only; total_child_url_count is unfiltered."] : []),
      ...FIELD_NOTES,
    ];
    return {
      site_url: bing.siteUrl,
      directory_url: a.directory_url,
      total_child_url_count: dir?.totalChildUrlCount ?? null,
      first_page: a.page,
      pages_read: pagesRead,
      next_page: more ? lastRead + 1 : null,
      children: pg.rows.map((r) => ({ url: r.url, ...urlFields(r, traffic.get(r.url) ?? null) })),
      returned: pg.returned,
      total: pg.total,
      truncated: pg.truncated || more,
      notes,
    };
  },
});

// ------------------------------------------------------------------------------------- get_bing_submission_quota
const QuotaSchema = z.object({
  daily_remaining: z.number().nullable().describe("How many more Bing accepts today (Bing's DailyQuota)."),
  monthly_remaining: z.number().nullable().describe("How many more Bing accepts this month (Bing's MonthlyQuota)."),
});
const quotaOut = (q: SubmissionQuota) => ({ daily_remaining: q.daily, monthly_remaining: q.monthly });
const QUOTA_NOTE =
  "Microsoft's reference does not describe DailyQuota and MonthlyQuota; its SubmitUrl and SubmitContent remarks say to call these methods 'to determine how many urls can be submitted', so they are read as what is left. Bing does not document when the counts reset.";

export const getBingSubmissionQuota = bingRead({
  name: "get_bing_submission_quota",
  title: "Bing submission quota",
  description:
    "Shows how many more URLs (submit_bing_urls) and page contents (submit_bing_content) Bing will accept for a Bing Webmaster site today and this month. Read-only.",
  input: z.object({ account_id: accountId }),
  output: z.object({ site_url: z.string(), url_submission: QuotaSchema, content_submission: QuotaSchema, notes: z.array(z.string()) }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const [u, c] = await Promise.all([getUrlSubmissionQuota(bing), getContentSubmissionQuota(bing)]);
    return { site_url: bing.siteUrl, url_submission: quotaOut(u), content_submission: quotaOut(c), notes: [QUOTA_NOTE, `One URL batch holds at most ${MAX_URL_BATCH} URLs.`] };
  },
});

/** Refuses when Bing reports no quota or not enough left for `n` submissions. Runs in plan(), so again right before sending. */
function requireQuota(q: SubmissionQuota, n: number, what: string): void {
  const left = quotaLeft(q);
  if (left === null) throw new ToolError("internal", `Bing did not report the remaining ${what} quota, so nothing was queued.`);
  if (left < n) {
    throw new ToolError("quota_exceeded", `Bing allows ${q.daily ?? "unknown"} more ${what}s today and ${q.monthly ?? "unknown"} this month; this needs ${n}. ${left > 0 ? `Submit at most ${left}.` : "Try again after the quota resets."} Nothing was sent.`, {
      retryable: false,
      definite: true,
      details: { daily_remaining: q.daily, monthly_remaining: q.monthly, needed: n },
    });
  }
}
const quotaText = (q: SubmissionQuota) => `${q.daily ?? "unknown"} left today, ${q.monthly ?? "unknown"} this month`;
/** Quota after a sent change: informative only (Bing's success response is the confirmation), so a failed read is null. */
async function quotaAfter(read: () => Promise<SubmissionQuota>): Promise<SubmissionQuota | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}
const NO_READBACK = "Bing's API has no way to read back a submission (no submission list or status), so whether it was received cannot be checked. Its success response is the only confirmation. Check Bing Webmaster Tools before submitting again.";

// --------------------------------------------------------------------------------------------- submit_bing_urls
/** De-duplicates by parsed URL, keeping the first spelling given. */
function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const k = new URL(u).href;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}
const listText = (urls: string[], max = 5) => `${urls.slice(0, max).join(", ")}${urls.length > max ? ` and ${urls.length - max} more` : ""}`;

export const submitBingUrls = bingWrite({
  name: "submit_bing_urls",
  title: "Submit URLs to Bing",
  risk: "write",
  description:
    "Asks Bing to crawl up to 500 URLs of a Bing Webmaster site, after approval by a person (SubmitUrl for one URL, SubmitUrlBatch for several). Every URL must be inside the site; duplicates are removed. It never submits more than Bing's remaining daily and monthly URL quota (see get_bing_submission_quota): too many is refused before anything is sent. Nothing on the website changes; Bing crawls the URLs later and decides itself whether to index them. A submission cannot be read back afterwards.",
  input: z.object({ account_id: accountId, urls: z.array(pageUrl).min(1).max(MAX_URL_BATCH).describe(`URLs to submit (1 to ${MAX_URL_BATCH}), all inside this site.`) }),
  output: z.object({
    site_url: z.string(),
    submitted_urls: z.array(z.string()),
    count: z.number(),
    method: z.enum(["SubmitUrl", "SubmitUrlBatch"]),
    quota_after: QuotaSchema.nullable().describe("URL quota read right after submitting; null when that read failed."),
    notes: z.array(z.string()),
  }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    for (const u of a.urls) requireWithinSite(bing.siteUrl, u);
    const urls = uniqueUrls(a.urls);
    const q = await getUrlSubmissionQuota(bing);
    requireQuota(q, urls.length, "URL submission");
    const dupes = a.urls.length - urls.length;
    const summary =
      `Submit ${urls.length === 1 ? "1 URL" : `${urls.length} URLs`} of Bing site ${bing.siteUrl} for crawling: ${listText(urls)}.` +
      `${dupes > 0 ? ` ${dupes} duplicate${dupes === 1 ? " was" : "s were"} removed.` : ""}` +
      ` Bing crawls them later and decides itself whether to index them; nothing on the website changes. Uses ${urls.length} of the URL submission quota (${quotaText(q)}).`;
    const changes: Change[] = urls.map((u) => ({ resource: "url_submission", id: u, name: null, field: "submission", before: null, after: "submitted", unit: "text", effect: "neutral" }));
    // The quota is checked, not snapshotted: it changes by itself (other submissions, resets), and plan() runs again right
    // before sending, so too little quota at approval time is refused then with nothing sent.
    return { summary, changes, snapshot: { site_url: bing.siteUrl, urls } };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    const urls = uniqueUrls(a.urls);
    const method = await submitUrls(bing, urls);
    const q = await quotaAfter(() => getUrlSubmissionQuota(bing));
    return {
      site_url: bing.siteUrl,
      submitted_urls: urls,
      count: urls.length,
      method,
      quota_after: q ? quotaOut(q) : null,
      notes: ["Bing accepted the submission. It crawls the URLs later; there is no API to follow a submitted URL's progress, so use inspect_bing_url in a few days.", NO_READBACK],
    };
  },
  verify: async () => ({ outcome: "indeterminate", detail: "Bing offers no read-back of URL submissions, and the quota is not a reliable signal (it also changes with other submissions and resets)." }),
});

// ------------------------------------------------------------------------------------------- submit_bing_content
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/, "an HTTP header name");
const headerValue = z.string().max(2000).regex(/^[^\r\n]*$/, "no line breaks");
const RESERVED_HEADERS = new Set(["content-type", "content-length"]);

/** The HTTP response Bing's reference asks for: status line, headers, empty line (each line ends in CRLF), body; then base64. */
export function buildHttpMessage(a: { html: string; status_code: number; content_type: string; headers: { name: string; value: string }[] }): string {
  const reason = STATUS_CODES[a.status_code] ?? "";
  const lines = [`HTTP/1.1 ${a.status_code}${reason ? ` ${reason}` : ""}`, `Content-Type: ${a.content_type}`, `Content-Length: ${Buffer.byteLength(a.html, "utf8")}`, ...a.headers.map((h) => `${h.name}: ${h.value}`)];
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n${a.html}`, "utf8").toString("base64");
}
const b64 = (s: string | undefined) => (s ? Buffer.from(s, "utf8").toString("base64") : "");

type ContentArgs = { url: string; html: string; status_code: number; content_type: string; headers: { name: string; value: string }[]; structured_data?: string; dynamic_serving: keyof typeof DYNAMIC_SERVING };
function contentPayload(a: ContentArgs) {
  const httpMessage = buildHttpMessage(a);
  const structuredData = b64(a.structured_data);
  return { url: a.url, httpMessage, structuredData, dynamicServing: DYNAMIC_SERVING[a.dynamic_serving], bytes: httpMessage.length + structuredData.length };
}

export const submitBingContent = bingWrite({
  name: "submit_bing_content",
  title: "Submit page content to Bing",
  risk: "write",
  description:
    "Sends the content of one page (the HTML you provide, its HTTP status and content type, optional extra headers, optional JSON-LD structured data) to Bing for a Bing Webmaster site, after approval by a person, so Bing can index it without crawling the page. This server builds the HTTP message Bing expects and base64-encodes it; it never fetches the page itself, so send what the live page serves. The URL must be inside the site, the encoded request must stay under Bing's 10 MB limit, and one submission of Bing's daily and monthly content quota must be left. Nothing on the website changes; Bing decides whether and when the page appears in results. A submission cannot be read back afterwards.",
  input: z.object({
    account_id: accountId,
    url: pageUrl,
    html: z.string().min(1).max(1_000_000).describe("The page body exactly as the site serves it at this URL (usually HTML), at most 1,000,000 characters."),
    status_code: z.number().int().min(200).max(599).default(200).describe("HTTP status the page returns (usually 200)."),
    content_type: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/, "no line breaks")
      .default("text/html; charset=utf-8")
      .describe("Content-Type header the page is served with."),
    headers: z
      .array(z.object({ name: headerName, value: headerValue }))
      .max(30)
      .default([])
      .refine((hs) => hs.every((h) => !RESERVED_HEADERS.has(h.name.toLowerCase())), "Content-Type and Content-Length are set by this tool")
      .describe("Other response headers the page is served with (e.g. Last-Modified, X-Robots-Tag). Optional."),
    structured_data: z.string().min(1).max(200_000).optional().describe("Structured data for the page, typically JSON-LD text. Bing's reference says it is typically used for non-HTML content such as images and PDF files. Optional."),
    dynamic_serving: z
      .enum(Object.keys(DYNAMIC_SERVING) as [keyof typeof DYNAMIC_SERVING, ...(keyof typeof DYNAMIC_SERVING)[]])
      .default("none")
      .describe("Which device this content is served to. Set it only if the site serves different content per device; otherwise leave none."),
  }),
  output: z.object({
    site_url: z.string(),
    url: z.string(),
    status_code: z.number(),
    encoded_bytes: z.number().describe("Size of the base64-encoded content sent to Bing."),
    structured_data: z.boolean(),
    dynamic_serving: z.string(),
    content_quota_after: QuotaSchema.nullable().describe("Content quota read right after submitting; null when that read failed."),
    notes: z.array(z.string()),
  }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    requireWithinSite(bing.siteUrl, a.url);
    const p = contentPayload(a);
    if (p.bytes > MAX_CONTENT_BYTES) throw new ToolError("invalid_argument", `The encoded content is ${p.bytes.toLocaleString("en-US")} bytes; Bing accepts at most 10 MB per request. Nothing was queued.`, { definite: true });
    const q = await getContentSubmissionQuota(bing);
    requireQuota(q, 1, "content submission");
    const kb = Math.max(1, Math.round(Buffer.byteLength(a.html, "utf8") / 1024));
    const extras = [a.headers.length ? `${a.headers.length} more header${a.headers.length === 1 ? "" : "s"}` : null, a.structured_data ? "structured data" : null, a.dynamic_serving !== "none" ? `served to ${a.dynamic_serving.replace(/_/g, " ")} devices` : null].filter(Boolean);
    const summary =
      `Send the content of ${a.url} to Bing (site ${bing.siteUrl}) so Bing can index it without crawling: HTTP ${a.status_code}, ${a.content_type}, about ${kb} KB${extras.length ? `, ${extras.join(", ")}` : ""}.` +
      ` Nothing on the website changes; Bing decides whether and when the page appears in results. Uses 1 of the content submission quota (${quotaText(q)}).`;
    const changes: Change[] = [{ resource: "content_submission", id: a.url, name: null, field: "content", before: null, after: `HTTP ${a.status_code}, ${a.content_type}, ${Buffer.byteLength(a.html, "utf8")} bytes`, unit: "text", effect: "neutral" }];
    return { summary, changes, snapshot: { site_url: bing.siteUrl, url: a.url } };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    const p = contentPayload(a);
    await submitContent(bing, p);
    const q = await quotaAfter(() => getContentSubmissionQuota(bing));
    return {
      site_url: bing.siteUrl,
      url: a.url,
      status_code: a.status_code,
      encoded_bytes: p.bytes,
      structured_data: p.structuredData !== "",
      dynamic_serving: a.dynamic_serving,
      content_quota_after: q ? quotaOut(q) : null,
      notes: ["Bing accepted the content. It decides itself whether and when the page appears in results; use inspect_bing_url later.", NO_READBACK],
    };
  },
  verify: async () => ({ outcome: "indeterminate", detail: "Bing offers no read-back of content submissions, and the quota is not a reliable signal (it also changes with other submissions and resets)." }),
});

export const indexingTools: AnyTool[] = [inspectBingUrl, getBingDirectoryIndex, getBingSubmissionQuota, submitBingUrls, submitBingContent] as AnyTool[];
