import { type BingClient, type Row, asList, asObject, num, str } from "../client";

/**
 * Backlinks and connected pages. Facts: docs/VERIFICATION.md, "Crawl, sitemaps and backlinks (2026-11-10)".
 *
 * - GetLinkCounts(siteUrl, page Int16) → LinkCounts {Links: LinkCount[] {Count Int32, Url}, TotalPages Int32}: "Get list of
 *   site pages which has inbound links". Pages are numbered from 0 (the reference example loops `page = 0` while
 *   `++page < TotalPages`; the samples send page=0).
 * - GetUrlLinks(siteUrl, link, page Int16) → LinkDetails {Details: LinkDetail[] {AnchorText, Url}, TotalPages Int32}: "Get
 *   inbound links for specific site url". `link` goes as a plain query value (see VERIFICATION.md).
 * - GetConnectedPages(siteUrl) → List<Microsoft.Bing.Webmaster.Shared.DataContracts.ConnectedSite>. The ConnectedSite
 *   contract has no reference page (404) and no sample, so its field names are unknown: entries are returned field by field.
 * - AddConnectedPage(siteUrl, masterUrl) POST: "Add a page which has link to your website(connected to your website)."
 */
export interface LinkCountRow {
  url: string;
  count: number | null;
}
export interface LinkDetailRow {
  url: string;
  anchorText: string | null;
}
export interface Paged<T> {
  rows: T[];
  totalPages: number | null;
}

const totalPages = (v: unknown): number | null => {
  const n = num(v);
  return n === null || !Number.isInteger(n) || n < 0 ? null : n;
};

/** GetLinkCounts: one page (0-based) of the site's pages that have inbound links, with how many each. */
export async function getLinkCounts(bing: BingClient, page: number): Promise<Paged<LinkCountRow>> {
  const d = asObject(await bing.read("GetLinkCounts", { page }));
  const rows = asList(d.Links, "linked pages")
    .filter((r) => typeof r.Url === "string" && r.Url !== "")
    .map((r) => ({ url: r.Url as string, count: num(r.Count) }));
  return { rows, totalPages: totalPages(d.TotalPages) };
}

/** GetUrlLinks: one page (0-based) of the pages linking to `link`, with anchor text. */
export async function getUrlLinks(bing: BingClient, link: string, page: number): Promise<Paged<LinkDetailRow>> {
  const d = asObject(await bing.read("GetUrlLinks", { link, page }));
  const rows = asList(d.Details, "backlinks")
    .filter((r) => typeof r.Url === "string" && r.Url !== "")
    .map((r) => ({ url: r.Url as string, anchorText: str(r.AnchorText) }));
  return { rows, totalPages: totalPages(d.TotalPages) };
}

export type ConnectedField = string | number | boolean | null;
export interface ConnectedPage {
  /** The first absolute http(s) URL among the entry's values (heuristic: the contract's field names are undocumented). */
  url: string | null;
  /** Every scalar field Bing sent, by Bing's own name (except the `__type` hint). */
  fields: Record<string, ConnectedField>;
}

const MAX_FIELDS = 32;
const MAX_VALUE = 2048;
const isHttpUrl = (s: string) => /^https?:\/\/[^\s]+$/i.test(s);

function connectedPage(r: Row): ConnectedPage {
  const fields: Record<string, ConnectedField> = {};
  let url: string | null = null;
  for (const [k, v] of Object.entries(r)) {
    if (k === "__type" || Object.keys(fields).length >= MAX_FIELDS) continue;
    if (typeof v === "string") {
      fields[k] = v.slice(0, MAX_VALUE);
      if (url === null && isHttpUrl(v)) url = v;
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) fields[k] = v;
  }
  return { url, fields };
}

/** GetConnectedPages. */
export async function getConnectedPages(bing: BingClient): Promise<ConnectedPage[]> {
  return asList(await bing.read("GetConnectedPages"), "connected pages").map(connectedPage);
}

/** A URL compared loosely: scheme and host case-insensitive, one trailing slash ignored. */
export function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const x = new URL(u);
      return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/$/, "")}${x.search}`;
    } catch {
      return u.trim().replace(/\/$/, "");
    }
  };
  return norm(a) === norm(b);
}

/** Whether any string value of a connected-page entry is `url` (field names are undocumented, so every value is checked). */
export const listsUrl = (p: ConnectedPage, url: string): boolean => Object.values(p.fields).some((v) => typeof v === "string" && sameUrl(v, url));

/** AddConnectedPage: one POST, never retried. */
export async function addConnectedPage(bing: BingClient, masterUrl: string): Promise<void> {
  await bing.send("AddConnectedPage", { masterUrl });
}
