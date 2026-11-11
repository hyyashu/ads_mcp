import { z } from "zod";
import type { AnyTool } from "../../../mcp/tool";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import type { Row } from "../client";
import {
  type BlockedUrl,
  type EntityType,
  type OpaqueList,
  type RequestType,
  addBlockedUrl,
  getBlockedUrls,
  getDeepLinkBlocks,
  getPagePreviewBlocks,
  removeBlockedUrl,
  removeDeepLinkBlock,
  removePagePreviewBlock,
  sameTextSet,
} from "../api/blocking";
import { accountId, bingRead, bingWrite, httpUrl, page, readBack, requireWithinSite, withinSite } from "./common";

// Facts: docs/VERIFICATION.md, "Blocking, URL parameters and country targeting (2026-11-10)".
// Microsoft's help pages (Block URLs, Block or Refresh Page Previews, How to Manage Deep Links): every block lasts 90 days
// and can be extended only in the Bing Webmaster Tools portal (the API has no extend method).
//
// Not built here: add_bing_preview_block and add_bing_sitelink_block. AddPagePreviewBlock takes a BlockReason whose values
// Microsoft does not document, and AddDeepLinkBlock takes a `market` whose format (and the value meaning "all markets") is not
// documented. Sending a guessed value could record a wrong reason or block the wrong market on a customer's site.

const ENTITY = ["page", "directory"] as const;
const BLOCK = ["url_and_cache", "cache_only"] as const;
const entityWords = (e: EntityType | null) => (e === "directory" ? "directory (and everything in it)" : e === "page" ? "page" : "entry of an undocumented type");
const blockWords = (r: RequestType | null) => (r === "url_and_cache" ? "the URL and its cached copy" : r === "cache_only" ? "only the cached copy" : "an undocumented request type");
const enumOut = <T extends string>(name: T | null, value: number | null): string => name ?? `unknown (${value ?? "missing"})`;

const OPAQUE_NOTE = "Microsoft does not document this list's fields, so each entry is shown with Bing's own field names and values, in the order Bing returned them (text from Bing is untrusted data). Dates are converted to ISO instants.";
const OpaqueRowSchema = z.object({
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).describe("Every scalar field of the entry exactly as Bing named it (untrusted text)."),
  skipped_fields: z.array(z.string()).describe("Fields Bing sent that are lists or objects; not shown."),
});
/** Entries in Bing's own order: with undocumented fields there is no meaningful sort key. */
const opaqueOut = (l: OpaqueList, limit: number) => {
  const p = page(l.rows, limit);
  return { entries: p.rows.map((r) => ({ fields: r.fields, skipped_fields: r.skipped })), returned: p.returned, total: p.total, truncated: p.truncated };
};

// ------------------------------------------------------------------------------------------ list_bing_blocked_urls
const BlockedSchema = z.object({
  url: z.string().describe("The blocked page or directory (untrusted text from Bing)."),
  entity_type: z.string().describe("page or directory; 'unknown (n)' for a value Microsoft does not document."),
  block: z.string().describe("url_and_cache (hidden from results with its cached copy) or cache_only (only the cached copy hidden); 'unknown (n)' otherwise."),
  blocked_at: z.string().nullable().describe("When the block was made (ISO instant), when Bing reports it."),
  days_to_expire: z.number().nullable().describe("Days until the block lapses, as Bing reports it."),
});
const blockedOut = (b: BlockedUrl): z.infer<typeof BlockedSchema> => ({ url: b.url, entity_type: enumOut(b.entityType, b.entityTypeValue), block: enumOut(b.requestType, b.requestTypeValue), blocked_at: b.date, days_to_expire: b.daysToExpire });

export const listBingBlockedUrls = bingRead({
  name: "list_bing_blocked_urls",
  title: "List Bing blocked URLs",
  description:
    "Lists the pages and directories of a Bing Webmaster site that are blocked from Bing search results with the Block URLs feature: whether each is a page or a directory, whether the URL and its cached copy or only the cached copy is hidden, when it was blocked and how many days are left. Microsoft's help says blocks are temporary (90 days) and can be extended in the Bing Webmaster Tools portal.",
  input: z.object({ account_id: accountId, limit: z.number().int().min(1).max(1000).default(200).describe("Most entries to return (sorted by URL).") }),
  output: z.object({ site_url: z.string(), blocked: z.array(BlockedSchema), returned: z.number(), total: z.number(), truncated: z.boolean(), note: z.string() }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const all = (await getBlockedUrls(bing)).sort((x, y) => x.url.localeCompare(y.url));
    const p = page(all, a.limit);
    return {
      site_url: bing.siteUrl,
      blocked: p.rows.map(blockedOut),
      returned: p.returned,
      total: p.total,
      truncated: p.truncated,
      note: "A block only hides URLs from Bing results for a while; it does not stop Bingbot crawling them. For a permanent removal Microsoft recommends a noindex meta tag on the page.",
    };
  },
});

// ------------------------------------------------------------------------------------------------- block_bing_url
const BlockResult = z.object({ site_url: z.string(), url: z.string(), entity_type: z.string(), block: z.string(), days_to_expire: z.number().nullable(), note: z.string() });

export const blockBingUrl = bingWrite({
  name: "block_bing_url",
  title: "Block a URL from Bing results",
  risk: "destructive",
  description:
    "After approval by a person, blocks a page or a whole directory of a Bing Webmaster site from appearing in Bing search results (block: url_and_cache hides the URL and its cached copy; cache_only hides only the cached copy). Microsoft's help: the block is temporary, lasts 90 days and must be extended in the Bing Webmaster Tools portal; it does not stop Bingbot crawling; for a permanent removal use a noindex meta tag. A directory URL must end with '/'. Refuses a URL outside the site or one that is already blocked.",
  input: z.object({
    account_id: accountId,
    url: httpUrl.describe("The page, or the directory (ending with '/'), to block. Must be inside the site."),
    entity_type: z.enum(ENTITY).describe("page: this exact URL. directory: the directory and everything in it."),
    block: z.enum(BLOCK).describe("url_and_cache: hide the URL and its cached copy from results (Bing's FullRemoval). cache_only: hide only the cached copy (Bing's CacheOnly)."),
  }),
  output: BlockResult,
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    requireWithinSite(bing.siteUrl, a.url, "URL");
    if (a.entity_type === "directory" && !new URL(a.url).pathname.endsWith("/")) throw new ToolError("invalid_argument", `A directory URL must end with '/', e.g. ${a.url}/.`, { definite: true });
    if (a.entity_type === "directory" && new URL(a.url).search) throw new ToolError("invalid_argument", "A directory URL cannot have a query string.", { definite: true });
    const all = await getBlockedUrls(bing);
    const same = all.find((b) => b.url === a.url);
    if (same)
      throw new ToolError("invalid_argument", `${a.url} is already blocked on Bing (${entityWords(same.entityType)}, ${blockWords(same.requestType)}${same.daysToExpire !== null ? `, ${same.daysToExpire} days left` : ""}). Nothing to add; to change the block, unblock it first with unblock_bing_url.`, {
        definite: true,
      });
    const covering = all.filter((b) => b.entityType === "directory" && b.url !== a.url && withinSite(b.url, a.url)).map((b) => b.url);
    const root = a.entity_type === "directory" && new URL(a.url).pathname === "/";
    const what = a.entity_type === "directory" ? `the directory ${a.url} and every page in it` : `the page ${a.url}`;
    const effect =
      a.block === "url_and_cache"
        ? `${what} will disappear from Bing search results (with the cached copy) for 90 days`
        : `the cached copy of ${what} will no longer be shown by Bing for 90 days; the URL itself stays in results`;
    const summary = [
      `Block on Bing (site ${bing.siteUrl}): ${effect}.`,
      root ? "This is the site's root directory: the WHOLE SITE disappears from Bing results." : null,
      "Per Microsoft's help the block is temporary: it lapses after 90 days unless someone extends it in the Bing Webmaster Tools portal. It does not stop Bingbot crawling, and the page stays on the website; use a noindex meta tag for a permanent removal.",
      covering.length ? `Already covered by blocked directory ${covering.join(", ")}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const changes: Change[] = [{ resource: "bing_blocked_url", id: a.url, name: null, field: "blocked", before: null, after: `${a.entity_type}, ${a.block}`, unit: "text", effect: "remove" }];
    return { summary, changes, snapshot: { site_url: bing.siteUrl, url: a.url, blocked: false, covered_by: covering } };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    await addBlockedUrl(bing, { url: a.url, entityType: a.entity_type, requestType: a.block });
    const got = (await readBack(() => getBlockedUrls(bing))).find((b) => b.url === a.url && b.entityType === a.entity_type && b.requestType === a.block);
    if (!got) throw new ToolError("unknown_outcome", "Bing accepted the request but the block does not appear in the blocked URL list. Check list_bing_blocked_urls before trying again.");
    return { site_url: bing.siteUrl, url: got.url, entity_type: a.entity_type, block: a.block, days_to_expire: got.daysToExpire, note: "Blocked. It lapses after 90 days unless extended in the Bing Webmaster Tools portal." };
  },
  verify: async (a, ctx) => ((await getBlockedUrls(ctx.services.bing)).some((b) => b.url === a.url && b.entityType === a.entity_type && b.requestType === a.block) ? { outcome: "applied" } : { outcome: "not_applied" }),
});

// ----------------------------------------------------------------------------------------------- unblock_bing_url
const findBlocks = (all: BlockedUrl[], a: { url: string; entity_type?: EntityType; block?: RequestType }) =>
  all.filter((b) => b.url === a.url && (a.entity_type === undefined || b.entityType === a.entity_type) && (a.block === undefined || b.requestType === a.block));
const sameRow = (b: BlockedUrl, raw: Row) => b.url === raw.Url && b.raw.EntityType === raw.EntityType && b.raw.RequestType === raw.RequestType;

export const unblockBingUrl = bingWrite({
  name: "unblock_bing_url",
  title: "Unblock a URL on Bing",
  risk: "destructive",
  description:
    "After approval by a person, lifts a Block URLs entry of a Bing Webmaster site, so Bing may show the page or directory (and its cached copy) in search results again if it is still indexed. The URL must match an entry of list_bing_blocked_urls exactly; give entity_type and block too when the same URL has more than one entry. The stored entry is sent back to Bing unchanged.",
  input: z.object({
    account_id: accountId,
    url: httpUrl.describe("The blocked URL exactly as list_bing_blocked_urls shows it."),
    entity_type: z.enum(ENTITY).optional().describe("Only needed when the URL has several entries."),
    block: z.enum(BLOCK).optional().describe("Only needed when the URL has several entries."),
  }),
  output: z.object({ site_url: z.string(), url: z.string(), unblocked: z.literal(true), note: z.string() }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    const hits = findBlocks(await getBlockedUrls(bing), a);
    if (!hits.length) throw new ToolError("not_found", `${a.url} is not in the blocked URL list of ${bing.siteUrl}. Use list_bing_blocked_urls for the exact URLs.`, { definite: true });
    if (hits.length > 1) throw new ToolError("invalid_argument", `${a.url} has ${hits.length} block entries; say which one with entity_type and block.`, { definite: true });
    const b = hits[0]!;
    const summary = `Lift Bing's block on ${b.entityType === "directory" ? `the directory ${b.url} (and everything in it)` : b.url} (it hides ${blockWords(b.requestType)}${b.daysToExpire !== null ? `; ${b.daysToExpire} days left` : ""}). Bing may show it in search results again if it is still indexed and not marked noindex; changes can take time to show.`;
    const changes: Change[] = [{ resource: "bing_blocked_url", id: b.url, name: null, field: "blocked", before: `${enumOut(b.entityType, b.entityTypeValue)}, ${enumOut(b.requestType, b.requestTypeValue)}`, after: null, unit: "text", effect: "remove" }];
    return { summary, changes, snapshot: { site_url: bing.siteUrl, stored: b.raw } };
  },
  execute: async (_a, ctx, run) => {
    const bing = ctx.services.bing;
    const stored = (run.snapshot as { stored: Row }).stored;
    await removeBlockedUrl(bing, stored);
    if ((await readBack(() => getBlockedUrls(bing))).some((b) => sameRow(b, stored))) throw new ToolError("unknown_outcome", "Bing accepted the request but the block is still listed. Check list_bing_blocked_urls before trying again.");
    return { site_url: bing.siteUrl, url: stored.Url as string, unblocked: true as const, note: "Unblocked. Bing may take time to show the URL in results again." };
  },
  verify: async (_a, ctx, run) => {
    const stored = (run.snapshot as { stored?: Row } | null)?.stored;
    if (!stored) return { outcome: "indeterminate", detail: "no stored block entry to compare with" };
    return (await getBlockedUrls(ctx.services.bing)).some((b) => sameRow(b, stored)) ? { outcome: "not_applied" } : { outcome: "applied" };
  },
});

// ----------------------------------------------------------------------------------------- list_bing_preview_blocks
export const listBingPreviewBlocks = bingRead({
  name: "list_bing_preview_blocks",
  title: "List Bing page preview blocks",
  description:
    "Lists the active page preview blocks of a Bing Webmaster site: pages whose preview image (the screenshot Bing may show with a search result) Bing was asked not to show. Microsoft's help says such blocks last 90 days. Microsoft does not document the fields of this list, so each entry is returned with Bing's own field names.",
  input: z.object({ account_id: accountId, limit: z.number().int().min(1).max(1000).default(200) }),
  output: z.object({ site_url: z.string(), entries: z.array(OpaqueRowSchema), returned: z.number(), total: z.number(), truncated: z.boolean(), note: z.string() }),
  handler: async (a, ctx) => ({ site_url: ctx.services.bing.siteUrl, ...opaqueOut(await getPagePreviewBlocks(ctx.services.bing), a.limit), note: OPAQUE_NOTE }),
});

// ---------------------------------------------------------------------------------------- remove_bing_preview_block
const previewHits = (l: OpaqueList, url: string) => l.texts.filter((t) => t.includes(url)).length;

export const removeBingPreviewBlock = bingWrite({
  name: "remove_bing_preview_block",
  title: "Remove a Bing page preview block",
  risk: "destructive",
  description:
    "After approval by a person, removes the page preview block of one URL of a Bing Webmaster site, so Bing may again show that page's preview image (a screenshot) with its search result. The URL must appear exactly in an entry of list_bing_preview_blocks.",
  input: z.object({ account_id: accountId, url: httpUrl.describe("The blocked URL exactly as list_bing_preview_blocks shows it. Must be inside the site.") }),
  output: z.object({ site_url: z.string(), url: z.string(), removed: z.literal(true) }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    requireWithinSite(bing.siteUrl, a.url, "URL");
    const l = await getPagePreviewBlocks(bing);
    const n = previewHits(l, a.url);
    if (!n) throw new ToolError("not_found", `${a.url} has no active page preview block on ${bing.siteUrl}. Use list_bing_preview_blocks for the exact URLs.`, { definite: true });
    const changes: Change[] = [{ resource: "bing_preview_block", id: a.url, name: null, field: "preview_blocked", before: "blocked", after: null, unit: "text", effect: "remove" }];
    return {
      summary: `Remove the page preview block on ${a.url} (site ${bing.siteUrl}). Bing may again show the stored preview image (a screenshot of the page) with its search results; if the page still shows something that must not be public, fix the page first. Changes can take time to show.`,
      changes,
      snapshot: { site_url: bing.siteUrl, url: a.url, entries: n },
    };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    await removePagePreviewBlock(bing, a.url);
    if (previewHits(await readBack(() => getPagePreviewBlocks(bing)), a.url)) throw new ToolError("unknown_outcome", "Bing accepted the request but the preview block is still listed. Check list_bing_preview_blocks before trying again.");
    return { site_url: bing.siteUrl, url: a.url, removed: true as const };
  },
  verify: async (a, ctx) => (previewHits(await getPagePreviewBlocks(ctx.services.bing), a.url) ? { outcome: "not_applied" } : { outcome: "applied" }),
});

// ---------------------------------------------------------------------------------------- list_bing_sitelink_blocks
export const listBingSitelinkBlocks = bingRead({
  name: "list_bing_sitelink_blocks",
  title: "List Bing sitelink blocks",
  description:
    "Lists the deep link (sitelink) blocks of a Bing Webmaster site: links Bing was asked not to show below a top-ranked search result of the site, optionally only under one search result URL and in one country/region market. Microsoft's help says such blocks expire 90 days after they are made. Microsoft does not document the fields of this list, so each entry is returned with Bing's own field names.",
  input: z.object({ account_id: accountId, limit: z.number().int().min(1).max(1000).default(200) }),
  output: z.object({ site_url: z.string(), entries: z.array(OpaqueRowSchema), returned: z.number(), total: z.number(), truncated: z.boolean(), note: z.string() }),
  handler: async (a, ctx) => ({ site_url: ctx.services.bing.siteUrl, ...opaqueOut(await getDeepLinkBlocks(ctx.services.bing), a.limit), note: OPAQUE_NOTE }),
});

// --------------------------------------------------------------------------------------- remove_bing_sitelink_block
const optText = (max: number) => z.string().max(max).default("");
const sitelinkKey = (a: { market: string; search_url: string; deep_link_url: string }) => [a.deep_link_url, a.search_url, a.market].filter((s) => s !== "");
const sitelinkHits = (l: OpaqueList, key: string[]) => l.texts.filter((t) => sameTextSet(t, key)).length;

export const removeBingSitelinkBlock = bingWrite({
  name: "remove_bing_sitelink_block",
  title: "Remove a Bing sitelink block",
  risk: "destructive",
  description:
    "After approval by a person, removes one deep link (sitelink) block of a Bing Webmaster site, so Bing may show that link below the site's top search results again. Give deep_link_url, search_url and market with exactly the values the entry shows in list_bing_sitelink_blocks (leave search_url or market empty when the entry has none). The entry's text values must match these exactly, otherwise nothing is sent.",
  input: z.object({
    account_id: accountId,
    deep_link_url: httpUrl.describe("The blocked deep link, exactly as listed. Must be inside the site."),
    search_url: optText(2048).describe("The search result URL the block applies to, exactly as listed; empty when the entry has none."),
    market: optText(32).describe("The market of the block, exactly as listed; empty when the entry has none."),
  }),
  output: z.object({ site_url: z.string(), deep_link_url: z.string(), search_url: z.string(), market: z.string(), removed: z.literal(true) }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    requireWithinSite(bing.siteUrl, a.deep_link_url, "deep link URL");
    const key = sitelinkKey(a);
    const n = sitelinkHits(await getDeepLinkBlocks(bing), key);
    if (!n)
      throw new ToolError("not_found", `No sitelink block of ${bing.siteUrl} has exactly these values (deep link ${a.deep_link_url}, search URL ${a.search_url || "none"}, market ${a.market || "none"}). Copy them from list_bing_sitelink_blocks.`, { definite: true });
    const scope = `${a.search_url ? `under the search result ${a.search_url}` : "under any of the site's top search results"}${a.market ? ` in market ${a.market}` : ""}`;
    const changes: Change[] = [{ resource: "bing_sitelink_block", id: a.deep_link_url, name: null, field: "sitelink_blocked", before: [a.search_url || "any search result", a.market || "any market"].join(", "), after: null, unit: "text", effect: "remove" }];
    return {
      summary: `Remove the sitelink block on ${a.deep_link_url} ${scope} (site ${bing.siteUrl}). Bing may show this link below the site's search results again; changes can take time to show.`,
      changes,
      snapshot: { site_url: bing.siteUrl, key, entries: n },
    };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    await removeDeepLinkBlock(bing, { market: a.market, searchUrl: a.search_url, deepLinkUrl: a.deep_link_url });
    if (sitelinkHits(await readBack(() => getDeepLinkBlocks(bing)), sitelinkKey(a))) throw new ToolError("unknown_outcome", "Bing accepted the request but the sitelink block is still listed. Check list_bing_sitelink_blocks before trying again.");
    return { site_url: bing.siteUrl, deep_link_url: a.deep_link_url, search_url: a.search_url, market: a.market, removed: true as const };
  },
  verify: async (a, ctx) => (sitelinkHits(await getDeepLinkBlocks(ctx.services.bing), sitelinkKey(a)) ? { outcome: "not_applied" } : { outcome: "applied" }),
});

export const blockingTools: AnyTool[] = [listBingBlockedUrls, blockBingUrl, unblockBingUrl, listBingPreviewBlocks, removeBingPreviewBlock, listBingSitelinkBlocks, removeBingSitelinkBlock];
