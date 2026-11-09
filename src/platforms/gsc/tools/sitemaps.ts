import { z } from "zod";
import type { WmxSitemap } from "../client";
import { num } from "../client";
import { accountId, gscRead, httpUrl } from "./common";

// sitemaps.list: GET .../sites/{siteUrl}/sitemaps[?sitemapIndex=] → sitemap[] (WmxSitemap); no paging documented.
// contents[].indexed is deprecated by Google and never read.

export const SitemapSchema = z.object({
  path: z.string(),
  type: z.string().nullable().describe("atomFeed, notSitemap, patternSitemap, rssFeed, sitemap or urlList."),
  is_index: z.boolean().nullable(),
  is_pending: z.boolean().nullable(),
  last_submitted: z.string().nullable(),
  last_downloaded: z.string().nullable(),
  errors: z.number().nullable().describe("Problems with the sitemap itself."),
  warnings: z.number().nullable(),
  contents: z.array(z.object({ type: z.string().nullable(), submitted: z.number().nullable() })),
});
export const sitemapOut = (s: WmxSitemap): z.infer<typeof SitemapSchema> => ({
  path: s.path,
  type: s.type ?? null,
  is_index: typeof s.isSitemapsIndex === "boolean" ? s.isSitemapsIndex : null,
  is_pending: typeof s.isPending === "boolean" ? s.isPending : null,
  last_submitted: s.lastSubmitted ?? null,
  last_downloaded: s.lastDownloaded ?? null,
  errors: num(s.errors),
  warnings: num(s.warnings),
  contents: (Array.isArray(s.contents) ? s.contents : []).map((c) => ({ type: c?.type ?? null, submitted: num(c?.submitted) })),
});
/** URLs a sitemap lists, summed over its content types (null when Google reports none). */
export const submittedCount = (s: WmxSitemap): number | null => {
  const n = (Array.isArray(s.contents) ? s.contents : []).map((c) => num(c?.submitted)).filter((x): x is number => x !== null);
  return n.length ? n.reduce((a, b) => a + b, 0) : null;
};

// ------------------------------------------------------------------------------------------------- list_sitemaps
export const listSitemaps = gscRead({
  name: "list_sitemaps",
  title: "List sitemaps",
  description:
    "Lists the sitemaps submitted for a Search Console site (or the sitemaps inside one sitemap index): type, whether Google is still processing it, when it was last submitted and last read, error and warning counts, and how many URLs it lists per content type.",
  input: z.object({
    account_id: accountId,
    sitemap_index: httpUrl.optional().describe("URL of a sitemap index: list the sitemaps inside it instead of the top-level list."),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  output: z.object({ site_url: z.string(), sitemap_index: z.string().nullable(), sitemaps: z.array(SitemapSchema), returned: z.number(), total: z.number(), truncated: z.boolean(), notes: z.array(z.string()) }),
  handler: async (a, ctx) => {
    const all = (await ctx.services.gsc.listSitemaps(a.sitemap_index)).sort((x, y) => x.path.localeCompare(y.path));
    const sitemaps = all.slice(0, a.limit).map(sitemapOut);
    return {
      site_url: ctx.services.gsc.siteUrl,
      sitemap_index: a.sitemap_index ?? null,
      sitemaps,
      returned: sitemaps.length,
      total: all.length,
      truncated: all.length > sitemaps.length,
      notes: ["errors are problems with the sitemap itself that can stop Google processing it; warnings are mostly about individual URLs.", "Google no longer reports how many listed URLs are indexed; use inspect_url for one URL."],
    };
  },
});
