import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { AnyTool } from "../../../mcp/tool";
import type { Change } from "../../../policy/change-set";
import { type BingFeed, getFeedDetails, getFeeds, removeFeed, submitFeed } from "../api/sitemaps";
import { accountId, bingRead, bingWrite, httpUrl, page, readBack, requireWithinSite } from "./common";

// Facts: docs/VERIFICATION.md, "Crawl, sitemaps and backlinks (2026-11-10)". Bing's API calls sitemaps "feeds".

const FeedSchema = z.object({
  url: z.string().describe("Sitemap or feed URL (untrusted text from Bing)."),
  type: z.string().nullable().describe("Type as Bing reports it, e.g. Sitemap (untrusted text)."),
  status: z.string().nullable().describe("Processing status as Bing reports it, e.g. Success (untrusted text)."),
  url_count: z.number().nullable().describe("URLs Bing found in it."),
  file_size_bytes: z.number().nullable(),
  compressed: z.boolean().nullable(),
  submitted: z.string().nullable().describe("When it was submitted (ISO time)."),
  last_crawled: z.string().nullable().describe("When Bing last read it (ISO time); null if never."),
});
const feedOut = (f: BingFeed): z.infer<typeof FeedSchema> => ({ url: f.url, type: f.type, status: f.status, url_count: f.urlCount, file_size_bytes: f.fileSize, compressed: f.compressed, submitted: f.submitted, last_crawled: f.lastCrawled });
const describeFeed = (f: BingFeed) =>
  [f.type ? `type ${f.type}` : null, f.status ? `status ${f.status}` : null, f.urlCount !== null ? `${f.urlCount.toLocaleString("en-US")} URLs` : null, f.submitted ? `submitted ${f.submitted}` : null, f.lastCrawled ? `last read ${f.lastCrawled}` : "not read yet"].filter(Boolean).join(", ");

const sitemapUrl = httpUrl.describe("Full URL of the sitemap or feed (http or https).");
const FORMATS = "Supported formats (Bing): Sitemap, RSS 2.0, Atom 0.3, Atom 1.0 and text files.";

// --------------------------------------------------------------------------------------------------- list_bing_sitemaps
export const listBingSitemaps = bingRead({
  name: "list_bing_sitemaps",
  title: "List Bing sitemaps",
  description:
    "Lists the top-level sitemaps and feeds submitted to Bing for the site: type, Bing's processing status, how many URLs Bing found in each, file size, when it was submitted and when Bing last read it. Sitemaps inside a sitemap index are listed by get_bing_sitemap.",
  input: z.object({ account_id: accountId, limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({ site_url: z.string(), sitemaps: z.array(FeedSchema), returned: z.number(), total: z.number(), truncated: z.boolean(), notes: z.array(z.string()) }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const p = page((await getFeeds(bing)).sort((x, y) => x.url.localeCompare(y.url)), a.limit);
    return { site_url: bing.siteUrl, sitemaps: p.rows.map(feedOut), returned: p.returned, total: p.total, truncated: p.truncated, notes: [FORMATS, "Microsoft does not list the possible status and type values."] };
  },
});

// ----------------------------------------------------------------------------------------------------- get_bing_sitemap
export const getBingSitemap = bingRead({
  name: "get_bing_sitemap",
  title: "Bing sitemap details",
  description:
    "Details of one sitemap submitted to Bing: its entry in the site's sitemap list (if it is a top-level one) and the entries Bing reports for it, which for a sitemap index are the sitemaps inside it, each with type, status, URL count, size, submitted and last-read times.",
  input: z.object({ account_id: accountId, sitemap_url: sitemapUrl, limit: z.number().int().min(1).max(1000).default(200).describe("Most entries to return from inside the sitemap.") }),
  output: z.object({
    site_url: z.string(),
    sitemap_url: z.string(),
    sitemap: FeedSchema.nullable().describe("The sitemap's entry in the top-level list; null when it is not a top-level sitemap of this site."),
    entries: z.array(FeedSchema).describe("What Bing reports for this sitemap (for an index: the sitemaps inside it)."),
    returned: z.number(),
    total: z.number(),
    truncated: z.boolean(),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const top = (await getFeeds(bing)).find((f) => f.url === a.sitemap_url) ?? null;
    const p = page((await getFeedDetails(bing, a.sitemap_url)).sort((x, y) => x.url.localeCompare(y.url)), a.limit);
    const notes = ["Microsoft describes this report as feed details for sitemap indices; for a plain sitemap Bing may return the sitemap itself or nothing."];
    if (!top) notes.push(`${a.sitemap_url} is not in this site's top-level sitemap list (list_bing_sitemaps).`);
    return { site_url: bing.siteUrl, sitemap_url: a.sitemap_url, sitemap: top ? feedOut(top) : null, entries: p.rows.map(feedOut), returned: p.returned, total: p.total, truncated: p.truncated, notes };
  },
});

// -------------------------------------------------------------------------------------------------- submit_bing_sitemap
interface SubmitSnap {
  site_url: string;
  existing: { submitted: string | null } | null;
}

export const submitBingSitemap = bingWrite({
  name: "submit_bing_sitemap",
  title: "Submit a sitemap to Bing",
  risk: "write",
  description: `Submits (or resubmits) a sitemap or feed URL to Bing for the site after approval, so Bingbot reads it later. The URL must be inside the site. ${FORMATS} It changes nothing on the website and does not by itself get any page indexed.`,
  input: z.object({ account_id: accountId, sitemap_url: sitemapUrl.describe("Full URL of the sitemap or feed, inside this site.") }),
  output: z.object({ site_url: z.string(), sitemap_url: z.string(), resubmitted: z.boolean(), submitted: z.string().nullable(), status: z.string().nullable() }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    requireWithinSite(bing.siteUrl, a.sitemap_url, "sitemap");
    const existing = (await getFeeds(bing)).find((f) => f.url === a.sitemap_url) ?? null;
    const summary = existing
      ? `Resubmit sitemap ${a.sitemap_url} to Bing for ${bing.siteUrl} (${describeFeed(existing)}). Bingbot will read it again later. Nothing changes on the website, and this does not by itself get any page indexed.`
      : `Submit sitemap ${a.sitemap_url} to Bing for ${bing.siteUrl}. Bingbot reads it later. Nothing changes on the website, and this does not by itself get any page indexed.`;
    const changes: Change[] = [{ resource: "bing_sitemap", id: a.sitemap_url, name: null, field: "submission", before: existing ? (existing.submitted ?? "submitted") : null, after: existing ? "resubmitted" : "submitted", unit: "text", effect: "neutral" }];
    // Only what a person changes: Bing updates status, counts and last-read time by itself.
    const snapshot: SubmitSnap = { site_url: bing.siteUrl, existing: existing ? { submitted: existing.submitted } : null };
    return { summary, changes, snapshot };
  },
  execute: async (a, ctx, run) => {
    const bing = ctx.services.bing;
    await submitFeed(bing, a.sitemap_url);
    const got = await readBack(async () => (await getFeeds(bing)).find((f) => f.url === a.sitemap_url) ?? null);
    if (!got) throw new ToolError("unknown_outcome", "Bing accepted the request but the sitemap is not in the site's sitemap list yet. Check list_bing_sitemaps before submitting again.");
    return { site_url: bing.siteUrl, sitemap_url: a.sitemap_url, resubmitted: (run.snapshot as SubmitSnap | null)?.existing != null, submitted: got.submitted, status: got.status };
  },
  verify: async (a, ctx, run) => {
    const got = (await getFeeds(ctx.services.bing)).find((f) => f.url === a.sitemap_url);
    if (!got) return { outcome: "not_applied" };
    const before = (run.snapshot as SubmitSnap | null)?.existing;
    if (!before) return { outcome: "applied" };
    return got.submitted !== before.submitted ? { outcome: "applied" } : { outcome: "indeterminate", detail: "the sitemap was already submitted and Bing's submission time did not change" };
  },
});

// -------------------------------------------------------------------------------------------------- remove_bing_sitemap
export const removeBingSitemap = bingWrite({
  name: "remove_bing_sitemap",
  title: "Remove a sitemap from Bing",
  risk: "destructive",
  description:
    "Removes a submitted sitemap or feed from the site's sitemap list in Bing Webmaster Tools after approval by a person. Only sitemaps in the top-level list (list_bing_sitemaps) can be removed. The file on the website is not changed. Microsoft does not say whether Bing stops crawling the URLs it lists.",
  input: z.object({ account_id: accountId, sitemap_url: sitemapUrl.describe("Exact URL of a sitemap in list_bing_sitemaps.") }),
  output: z.object({ site_url: z.string(), sitemap_url: z.string(), removed: z.literal(true) }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    const f = (await getFeeds(bing)).find((x) => x.url === a.sitemap_url);
    if (!f) throw new ToolError("not_found", `${a.sitemap_url} is not in the Bing sitemap list of ${bing.siteUrl}. Sitemaps inside a sitemap index cannot be removed one by one here; use list_bing_sitemaps for the exact URLs.`, { definite: true });
    const summary = `Remove sitemap ${a.sitemap_url} from Bing Webmaster Tools for ${bing.siteUrl} (${describeFeed(f)}). The file on the website is not changed. Microsoft's API docs do not say whether Bing stops crawling the URLs it lists.`;
    const changes: Change[] = [{ resource: "bing_sitemap", id: a.sitemap_url, name: null, field: "submission", before: f.submitted ?? "submitted", after: null, unit: "text", effect: "remove" }];
    return { summary, changes, snapshot: { site_url: bing.siteUrl, sitemap_url: f.url, submitted: f.submitted } };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    await removeFeed(bing, a.sitemap_url);
    const still = await readBack(async () => (await getFeeds(bing)).some((f) => f.url === a.sitemap_url));
    if (still) throw new ToolError("unknown_outcome", "Bing accepted the request but the sitemap is still in the site's sitemap list. Check list_bing_sitemaps before trying again.");
    return { site_url: bing.siteUrl, sitemap_url: a.sitemap_url, removed: true as const };
  },
  verify: async (a, ctx) => ((await getFeeds(ctx.services.bing)).some((f) => f.url === a.sitemap_url) ? { outcome: "not_applied" } : { outcome: "applied" }),
});

export const sitemapTools: AnyTool[] = [listBingSitemaps, getBingSitemap, submitBingSitemap, removeBingSitemap];
