import { type BingClient, type Row, asList, bingDate, num } from "../client";

/**
 * Blocking: blocked URLs, page-preview blocks and deep link (sitelink) blocks. Facts: docs/VERIFICATION.md, "Blocking, URL
 * parameters and country targeting (2026-11-10)".
 *
 * - GetBlockedUrls(siteUrl) GET → BlockedUrl[] {Date, DaysToExpire, EntityType, RequestType, Url}.
 *   BlockedUrlEntityType: Page 0, Directory 1. BlockedUrlRequestType: CacheOnly 0, FullRemoval 1 (the portal labels
 *   FullRemoval "URL and cache").
 * - AddBlockedUrl / RemoveBlockedUrl(siteUrl, blockedUrl: BlockedUrl) POST, answer {"d": null}. The JSON samples send
 *   `{"__type": "BlockedUrl:#Microsoft.Bing.Webmaster.Api", "Date": "/Date(-62135568000000-0800)/", "EntityType", "RequestType",
 *   "Url"}`.
 * - GetActivePagePreviewBlocks(siteUrl) GET → PagePreview[]; RemovePagePreviewBlock(siteUrl, url) POST.
 * - GetDeepLinkBlocks(siteUrl) GET → DeepLinkBlock[]; RemoveDeepLinkBlock(siteUrl, market, searchUrl, deepLinkUrl) POST.
 *   PagePreview and DeepLinkBlock (Microsoft.Bing.Webmaster.Shared.DataContracts) have no reference page, so their rows are
 *   read generically (`OpaqueRow`): every scalar field exactly as Bing names it, nothing assumed about which field is which.
 */

/** BlockedUrlEntityType values as documented. */
export const ENTITY_TYPES = { page: 0, directory: 1 } as const;
/** BlockedUrlRequestType values as documented: CacheOnly 0, FullRemoval 1. */
export const REQUEST_TYPES = { cache_only: 0, url_and_cache: 1 } as const;
export type EntityType = keyof typeof ENTITY_TYPES;
export type RequestType = keyof typeof REQUEST_TYPES;

/** The Date the AddBlockedUrl JSON sample sends (DateTime.MinValue as Bing's own sample renders it). */
export const SAMPLE_UNSET_DATE = "/Date(-62135568000000-0800)/";

const nameOf = <T extends Record<string, number>>(map: T, v: unknown): keyof T | null => {
  const n = num(v);
  const hit = Object.entries(map).find(([, x]) => x === n);
  return hit ? (hit[0] as keyof T) : null;
};

export interface BlockedUrl {
  url: string;
  entityType: EntityType | null;
  requestType: RequestType | null;
  /** The raw enum numbers, kept so an undocumented value is reported instead of hidden. */
  entityTypeValue: number | null;
  requestTypeValue: number | null;
  /** When the block was made (null when Bing sends no date or DateTime.MinValue). */
  date: string | null;
  daysToExpire: number | null;
  /** The row exactly as Bing returned it: RemoveBlockedUrl gets it back unchanged. */
  raw: Row;
}

export function parseBlockedUrls(d: unknown): BlockedUrl[] {
  return asList(d, "the blocked URL list")
    .filter((r) => typeof r.Url === "string" && r.Url !== "")
    .map((r) => ({
      url: r.Url as string,
      entityType: nameOf(ENTITY_TYPES, r.EntityType),
      requestType: nameOf(REQUEST_TYPES, r.RequestType),
      entityTypeValue: num(r.EntityType),
      requestTypeValue: num(r.RequestType),
      date: bingDate(r.Date),
      daysToExpire: num(r.DaysToExpire),
      raw: r,
    }));
}

/** GetBlockedUrls: the site's blocked pages and directories. */
export async function getBlockedUrls(bing: BingClient): Promise<BlockedUrl[]> {
  return parseBlockedUrls(await bing.read("GetBlockedUrls"));
}

/** AddBlockedUrl with a BlockedUrl shaped like the documented JSON sample. */
export async function addBlockedUrl(bing: BingClient, b: { url: string; entityType: EntityType; requestType: RequestType }): Promise<void> {
  await bing.send("AddBlockedUrl", {
    blockedUrl: { __type: "BlockedUrl:#Microsoft.Bing.Webmaster.Api", Date: SAMPLE_UNSET_DATE, EntityType: ENTITY_TYPES[b.entityType], RequestType: REQUEST_TYPES[b.requestType], Url: b.url },
  });
}

/** RemoveBlockedUrl with the stored BlockedUrl exactly as GetBlockedUrls returned it. */
export async function removeBlockedUrl(bing: BingClient, stored: Row): Promise<void> {
  await bing.send("RemoveBlockedUrl", { blockedUrl: stored });
}

// ------------------------------------------------------------------------------- undocumented contracts, read generically

export type Scalar = string | number | boolean | null;

/** A row of an undocumented contract: Bing's own field names, scalar values only, WCF dates as ISO instants. */
export interface OpaqueRow {
  fields: Record<string, Scalar>;
  /** Fields Bing sent that are not scalars (objects or lists), by name: reported, not interpreted. */
  skipped: string[];
}

const WCF = /^\/Date\(-?\d+([+-]\d{4})?\)\/$/;

export function parseOpaque(d: unknown, what: string): OpaqueRow[] {
  return asList(d, what).map((r) => {
    const fields: Record<string, Scalar> = {};
    const skipped: string[] = [];
    for (const [k, v] of Object.entries(r)) {
      if (k === "__type") continue;
      if (typeof v === "string") fields[k] = WCF.test(v) ? bingDate(v) : v;
      else if (typeof v === "number" || typeof v === "boolean" || v === null) fields[k] = v;
      else skipped.push(k);
    }
    return { fields, skipped };
  });
}

/** The non-empty text values of a row that are not dates: what can identify it without knowing its field names. */
export function textValues(r: OpaqueRow, raw?: Row): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(r.fields)) {
    if (typeof v !== "string" || v === "") continue;
    if (raw && typeof raw[k] === "string" && WCF.test(raw[k] as string)) continue;
    out.push(v);
  }
  return out;
}

export interface OpaqueList {
  rows: OpaqueRow[];
  /** Text values per row (dates excluded), in row order. */
  texts: string[][];
}

const opaqueList = (d: unknown, what: string): OpaqueList => {
  const raws = asList(d, what);
  const rows = parseOpaque(raws, what);
  return { rows, texts: rows.map((r, i) => textValues(r, raws[i])) };
};

/** GetActivePagePreviewBlocks (PagePreview has no reference page: rows are generic). */
export async function getPagePreviewBlocks(bing: BingClient): Promise<OpaqueList> {
  return opaqueList(await bing.read("GetActivePagePreviewBlocks"), "the page preview blocks");
}

/** RemovePagePreviewBlock(siteUrl, url). */
export async function removePagePreviewBlock(bing: BingClient, url: string): Promise<void> {
  await bing.send("RemovePagePreviewBlock", { url });
}

/** GetDeepLinkBlocks (DeepLinkBlock has no reference page: rows are generic). */
export async function getDeepLinkBlocks(bing: BingClient): Promise<OpaqueList> {
  return opaqueList(await bing.read("GetDeepLinkBlocks"), "the deep link blocks");
}

/** RemoveDeepLinkBlock(siteUrl, market, searchUrl, deepLinkUrl). */
export async function removeDeepLinkBlock(bing: BingClient, b: { market: string; searchUrl: string; deepLinkUrl: string }): Promise<void> {
  await bing.send("RemoveDeepLinkBlock", { market: b.market, searchUrl: b.searchUrl, deepLinkUrl: b.deepLinkUrl });
}

/** Whether two lists hold the same distinct strings, in any order. */
export const sameTextSet = (a: string[], b: string[]): boolean => {
  const A = new Set(a);
  const B = new Set(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
};
