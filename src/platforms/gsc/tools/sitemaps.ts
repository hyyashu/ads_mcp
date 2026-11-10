import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import type { WmxSitemap } from "../client";
import { num } from "../client";
import { accountId, gscRead, gscWrite, httpUrl, readBack, requireEditor, withinProperty } from "./common";

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

const sitemapUrl = httpUrl.refine((u) => !u.includes("#"), "no #fragment").describe("Full URL of the sitemap, inside this site.");
const describeSitemap = (s: WmxSitemap) => {
  const n = submittedCount(s);
  const bits = [s.type ? `type ${s.type}` : null, n !== null ? `${n.toLocaleString("en-US")} URLs submitted` : null, s.lastDownloaded ? `last read ${s.lastDownloaded}` : "not read yet", `${num(s.errors) ?? "unknown"} errors`, `${num(s.warnings) ?? "unknown"} warnings`].filter(Boolean);
  return bits.join(", ");
};

// ------------------------------------------------------------------------------------------------ submit_sitemap
// sitemaps.submit: PUT .../sites/{siteUrl}/sitemaps/{feedpath}, no body, scope webmasters. Restricted users cannot submit.
export const submitSitemap = gscWrite({
  name: "submit_sitemap",
  title: "Submit a sitemap",
  risk: "write",
  description:
    "Submits (or resubmits) a sitemap URL for a Search Console site after approval, so Google reads it later. The sitemap must be inside the site. It does not request indexing of any page. The connected user must be an owner or full user of the site.",
  input: z.object({ account_id: accountId, sitemap_url: sitemapUrl }),
  output: z.object({ site_url: z.string(), sitemap_url: z.string(), resubmitted: z.boolean(), last_submitted: z.string().nullable(), is_pending: z.boolean().nullable() }),
  plan: async (a, ctx) => {
    const gsc = ctx.services.gsc;
    if (!withinProperty(gsc.siteUrl, a.sitemap_url)) throw new ToolError("invalid_argument", `${a.sitemap_url} is not inside the Search Console property ${gsc.siteUrl}. Submit it through the site it belongs to.`);
    const level = await requireEditor(gsc, "submit sitemaps");
    const existing = await gsc.getSitemap(a.sitemap_url);
    const summary = existing
      ? `Resubmit sitemap ${a.sitemap_url} to Search Console property ${gsc.siteUrl} (last submitted ${existing.lastSubmitted ?? "unknown"}; ${describeSitemap(existing)}). Google will read it again later. This does not request indexing of any page.`
      : `Submit sitemap ${a.sitemap_url} to Search Console property ${gsc.siteUrl}. Google reads it later; this does not request indexing of any page.`;
    const changes: Change[] = [{ resource: "sitemap", id: a.sitemap_url, name: null, field: "submission", before: existing ? (existing.lastSubmitted ?? "submitted") : null, after: existing ? "resubmitted" : "submitted", unit: "text", effect: "neutral" }];
    // Only what a person changes: Google updates isPending, lastDownloaded and the counts by itself.
    return { summary, changes, snapshot: { site_url: gsc.siteUrl, permission_level: level, existing: existing ? { last_submitted: existing.lastSubmitted ?? null } : null } };
  },
  execute: async (a, ctx, run) => {
    const gsc = ctx.services.gsc;
    await gsc.submitSitemap(a.sitemap_url);
    const got = await readBack(() => gsc.getSitemap(a.sitemap_url));
    if (!got) throw new ToolError("unknown_outcome", "Google accepted the request but the sitemap does not read back yet. Check list_sitemaps before submitting again.");
    return { site_url: gsc.siteUrl, sitemap_url: a.sitemap_url, resubmitted: (run.snapshot as { existing: unknown } | null)?.existing != null, last_submitted: got.lastSubmitted ?? null, is_pending: typeof got.isPending === "boolean" ? got.isPending : null };
  },
  verify: async (a, ctx, run) => {
    const got = await ctx.services.gsc.getSitemap(a.sitemap_url);
    if (!got) return { outcome: "not_applied" };
    const before = (run.snapshot as { existing: { last_submitted: string | null } | null } | null)?.existing;
    if (!before) return { outcome: "applied" };
    return (got.lastSubmitted ?? null) !== before.last_submitted ? { outcome: "applied" } : { outcome: "indeterminate", detail: "the sitemap was already submitted and its submission time did not change" };
  },
});

// ------------------------------------------------------------------------------------------------ delete_sitemap
// sitemaps.delete: DELETE .../sites/{siteUrl}/sitemaps/{feedpath}, no body, scope webmasters.
export const deleteSitemap = gscWrite({
  name: "delete_sitemap",
  title: "Remove a sitemap",
  risk: "destructive",
  description:
    "Removes a submitted sitemap from a Search Console site's sitemap list after approval by a person. The sitemap file on the website is not changed. Only sitemaps in the top-level list can be removed (not ones listed inside a sitemap index). The connected user must be an owner or full user.",
  input: z.object({ account_id: accountId, sitemap_url: sitemapUrl }),
  output: z.object({ site_url: z.string(), sitemap_url: z.string(), removed: z.literal(true) }),
  plan: async (a, ctx) => {
    const gsc = ctx.services.gsc;
    await requireEditor(gsc, "remove sitemaps");
    const sm = (await gsc.listSitemaps()).find((s) => s.path === a.sitemap_url);
    if (!sm) throw new ToolError("not_found", `${a.sitemap_url} is not a sitemap submitted for ${gsc.siteUrl}. Sitemaps listed inside a sitemap index cannot be removed one by one here; use list_sitemaps for the exact URLs.`);
    const summary = `Remove sitemap ${a.sitemap_url} from Search Console property ${gsc.siteUrl} (${describeSitemap(sm)}).${sm.isSitemapsIndex ? " It is a sitemap index covering other sitemaps." : ""} The file on the website is not changed. Google's API docs do not say whether Google stops reading the URLs it lists.`;
    const changes: Change[] = [{ resource: "sitemap", id: a.sitemap_url, name: null, field: "submission", before: sm.lastSubmitted ?? "submitted", after: null, unit: "text", effect: "remove" }];
    return { summary, changes, snapshot: { site_url: gsc.siteUrl, path: sm.path, last_submitted: sm.lastSubmitted ?? null } };
  },
  execute: async (a, ctx) => {
    const gsc = ctx.services.gsc;
    await gsc.deleteSitemap(a.sitemap_url);
    if (await readBack(() => gsc.getSitemap(a.sitemap_url))) throw new ToolError("unknown_outcome", "Google accepted the request but the sitemap still reads back. Check list_sitemaps before trying again.");
    return { site_url: gsc.siteUrl, sitemap_url: a.sitemap_url, removed: true as const };
  },
  verify: async (a, ctx) => ((await ctx.services.gsc.getSitemap(a.sitemap_url)) ? { outcome: "not_applied" } : { outcome: "applied" }),
});
