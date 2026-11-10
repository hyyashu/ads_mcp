import { ToolError } from "../../mcp/errors";
import { GoogleApiClient, type GoogleApiClientOptions, tooManyRows } from "../gapi/client";
import { type Discovery, MAX_DISCOVERED } from "../gapi/discovery";

/** Search Console API v3 root (sites, sitemaps, searchAnalytics). URL Inspection lives on searchconsole.googleapis.com/v1. */
export const GSC_API = "https://www.googleapis.com/webmasters/v3";
export const URL_INSPECTION_API = "https://searchconsole.googleapis.com/v1";

/** A site as Search Console names it: a URL-prefix property ("https://example.com/") or a Domain property ("sc-domain:example.com"). */
export const isSiteUrl = (s: string) => /^(https?:\/\/[^\s]+|sc-domain:[^\s/]+)$/.test(s);

// Facts behind the methods below: docs/VERIFICATION.md, "Search Console tools (2026-11-10)".

export type GscPermission = "siteFullUser" | "siteOwner" | "siteRestrictedUser" | "siteUnverifiedUser" | (string & {});
export interface GscSite {
  siteUrl: string;
  permissionLevel: GscPermission;
}
export interface SaFilter {
  dimension: string;
  operator: string;
  expression: string;
}
/** searchAnalytics.query body without rowLimit/startRow (the client sets those while paging). */
export interface SaRequest {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  type?: string;
  dimensionFilterGroups?: { groupType: "and"; filters: SaFilter[] }[];
  aggregationType?: string;
  dataState?: string;
}
export interface SaRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}
export interface SaResult {
  rows: SaRow[];
  responseAggregationType: string | null;
  firstIncompleteDate: string | null;
  firstIncompleteHour: string | null;
  truncated: boolean;
}
/** WmxSitemap resource. `long` fields may arrive as JSON strings (int64 convention), so both are accepted. */
export interface WmxSitemap {
  path: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  warnings?: string | number;
  errors?: string | number;
  contents?: { type?: string; submitted?: string | number }[];
}

/** rowLimit range of searchAnalytics.query (1 to 25,000). */
export const SA_PAGE_ROWS = 25_000;
/** Google keeps at most 50,000 rows per day per site per search type, so no tool asks for more in one call. */
export const SA_MAX_ROWS = 50_000;
/** Safety stop when Google keeps returning small pages. */
const SA_MAX_PAGES = 60;

/** A number from a JSON number or numeric string; anything else is null. */
export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asArray = (v: unknown, what: string): unknown[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ToolError("internal", `Search Console returned ${what} in an unexpected shape.`);
  return v;
};

/** One Search Console site (connected_account.external_id = siteUrl exactly as the API returned it). */
export class GscClient extends GoogleApiClient {
  constructor(o: GoogleApiClientOptions & { siteUrl: string }) {
    super(o);
    if (!isSiteUrl(o.siteUrl)) throw new ToolError("internal", "Not a Search Console site URL.");
    this.siteUrl = o.siteUrl;
  }
  readonly siteUrl: string;

  /** `.../sites/{siteUrl}`: the site URL is one path segment, so it is percent-encoded (":" and "/" included). */
  get siteBase(): string {
    return `${GSC_API}/sites/${encodeURIComponent(this.siteUrl)}`;
  }

  /** `.../sites/{siteUrl}/sitemaps/{feedpath}`: the sitemap URL is one path segment, percent-encoded like the site URL. */
  private sitemapUrl(feedpath: string): string {
    return `${this.siteBase}/sitemaps/${encodeURIComponent(feedpath)}`;
  }

  // ------------------------------------------------------------------ sites (connection-wide: the Google user's list)

  /** sites.list: every property the connected Google user can see. No paging is documented. */
  async listSites(): Promise<GscSite[]> {
    const res = await this.read<{ siteEntry?: unknown }>(`${GSC_API}/sites`);
    return asArray(res.siteEntry, "the site list")
      .map(asObject)
      .filter((s) => typeof s.siteUrl === "string")
      .map((s) => ({ siteUrl: s.siteUrl as string, permissionLevel: typeof s.permissionLevel === "string" ? s.permissionLevel : "" }));
  }

  /** A property of the connected user by exact site URL, from sites.list (never sites.get on a foreign URL: 403 vs 404 is ambiguous). */
  async findSite(siteUrl: string): Promise<GscSite | null> {
    return (await this.listSites()).find((s) => s.siteUrl === siteUrl) ?? null;
  }

  /** sites.add: PUT, no request body, empty response. */
  async addSite(siteUrl: string): Promise<void> {
    await this.send("PUT", `${GSC_API}/sites/${encodeURIComponent(siteUrl)}`);
  }

  /** sites.get for this site. */
  async getSite(): Promise<GscSite> {
    const s = asObject(await this.read(this.siteBase));
    return { siteUrl: typeof s.siteUrl === "string" ? s.siteUrl : this.siteUrl, permissionLevel: typeof s.permissionLevel === "string" ? s.permissionLevel : "" };
  }

  /** sites.delete for this site: DELETE, no request body, empty response. */
  async deleteSite(): Promise<void> {
    await this.send("DELETE", this.siteBase);
  }

  // ------------------------------------------------------------------------------------------- search analytics

  /**
   * searchAnalytics.query, paged with startRow (rowLimit at most 25,000 per request) until an empty page or one row past
   * maxRows. Rows are never dropped silently: past maxRows it refuses with `unsupported` (row_cap) unless `partial`, in
   * which case it returns the first maxRows rows with `truncated: true`. Every request only reads (retried like a read).
   */
  async searchAnalytics(req: SaRequest, o: { maxRows: number; startRow?: number; partial?: boolean }): Promise<SaResult> {
    if (!Number.isInteger(o.maxRows) || o.maxRows < 1 || o.maxRows > SA_MAX_ROWS) throw new ToolError("internal", "Search Analytics row limit out of range.");
    const url = `${this.siteBase}/searchAnalytics/query`;
    const rows: SaRow[] = [];
    let start = o.startRow ?? 0;
    let aggregation: string | null = null;
    let incompleteDate: string | null = null;
    let incompleteHour: string | null = null;
    let pages = 0;
    let more = false;
    for (;;) {
      const rowLimit = Math.min(SA_PAGE_ROWS, o.maxRows + 1 - rows.length);
      const res = asObject(await this.query(url, { ...req, rowLimit, startRow: start }));
      if (pages === 0) {
        aggregation = typeof res.responseAggregationType === "string" ? res.responseAggregationType : null;
        const meta = asObject(res.metadata);
        incompleteDate = typeof meta.first_incomplete_date === "string" ? meta.first_incomplete_date : null;
        incompleteHour = typeof meta.first_incomplete_hour === "string" ? meta.first_incomplete_hour : null;
      }
      pages++;
      const got = asArray(res.rows, "search analytics rows").map(asObject);
      for (const r of got) {
        rows.push({
          keys: asArray(r.keys, "row keys").map((k) => String(k)),
          clicks: num(r.clicks) ?? 0,
          impressions: num(r.impressions) ?? 0,
          ctr: num(r.ctr),
          position: num(r.position),
        });
      }
      if (got.length === 0 || rows.length > o.maxRows) break;
      if (pages >= SA_MAX_PAGES) {
        more = true; // Google kept answering with small pages: whether more rows exist is unknown, so say so
        break;
      }
      start += got.length;
    }
    const truncated = rows.length > o.maxRows || more;
    if (truncated && !o.partial) throw tooManyRows(o.maxRows, "Search Console rows");
    return { rows: rows.slice(0, o.maxRows), responseAggregationType: aggregation, firstIncompleteDate: incompleteDate, firstIncompleteHour: incompleteHour, truncated };
  }

  // ------------------------------------------------------------------------------------------------- sitemaps

  /** sitemaps.list for this site (optionally the sitemaps inside one index). No paging is documented. */
  async listSitemaps(sitemapIndex?: string): Promise<WmxSitemap[]> {
    const res = await this.read<{ sitemap?: unknown }>(`${this.siteBase}/sitemaps`, sitemapIndex ? { sitemapIndex } : undefined);
    return asArray(res.sitemap, "the sitemap list")
      .map(asObject)
      .filter((s) => typeof s.path === "string") as unknown as WmxSitemap[];
  }

  /** sitemaps.get; null when Google answers 404. */
  async getSitemap(feedpath: string): Promise<WmxSitemap | null> {
    try {
      const s = asObject(await this.read(this.sitemapUrl(feedpath)));
      return typeof s.path === "string" ? (s as unknown as WmxSitemap) : null;
    } catch (e) {
      if (e instanceof ToolError && e.code === "not_found") return null;
      throw e;
    }
  }

  /** sitemaps.submit: PUT, no request body, empty response. */
  async submitSitemap(feedpath: string): Promise<void> {
    await this.send("PUT", this.sitemapUrl(feedpath));
  }

  /** sitemaps.delete: DELETE, no request body, empty response. */
  async deleteSitemap(feedpath: string): Promise<void> {
    await this.send("DELETE", this.sitemapUrl(feedpath));
  }

  // ---------------------------------------------------------------------------------------------- URL Inspection

  /** urlInspection.index.inspect (a POST that only reads). Returns `inspectionResult` ({} when absent). */
  async inspectUrl(inspectionUrl: string, languageCode?: string): Promise<Record<string, unknown>> {
    const res = asObject(await this.query(`${URL_INSPECTION_API}/urlInspection/index:inspect`, { inspectionUrl, siteUrl: this.siteUrl, ...(languageCode ? { languageCode } : {}) }));
    return asObject(res.inspectionResult);
  }
}

/** Sites resource (developers.google.com/webmaster-tools/v1/sites): siteUrl and permissionLevel. */
interface SiteEntry {
  siteUrl?: string;
  permissionLevel?: string;
}

/**
 * Connect-time discovery: GET webmasters/v3/sites (no paging documented). A site the user has only as
 * `siteUnverifiedUser` gives no data access, so it is skipped rather than connected.
 */
export async function discoverGscSites(api: GoogleApiClient): Promise<Discovery> {
  const res = await api.read<{ siteEntry?: SiteEntry[] }>(`${GSC_API}/sites`);
  let skipped = 0;
  const accounts: Discovery["accounts"] = [];
  for (const s of res.siteEntry ?? []) {
    if (!s.siteUrl || !isSiteUrl(s.siteUrl) || s.permissionLevel === "siteUnverifiedUser") {
      skipped++;
      continue;
    }
    if (accounts.length >= MAX_DISCOVERED) {
      skipped++;
      continue;
    }
    accounts.push({ externalId: s.siteUrl, displayName: s.siteUrl, loginCustomerId: null, currencyCode: null, timeZone: null });
  }
  return { accounts, skipped };
}
