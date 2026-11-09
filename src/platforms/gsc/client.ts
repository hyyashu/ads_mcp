import { ToolError } from "../../mcp/errors";
import { GoogleApiClient, type GoogleApiClientOptions } from "../gapi/client";
import { type Discovery, MAX_DISCOVERED } from "../gapi/discovery";

/** Search Console API v3 root (sites, sitemaps, searchAnalytics). URL Inspection lives on searchconsole.googleapis.com/v1. */
export const GSC_API = "https://www.googleapis.com/webmasters/v3";
export const URL_INSPECTION_API = "https://searchconsole.googleapis.com/v1";

/** A site as Search Console names it: a URL-prefix property ("https://example.com/") or a Domain property ("sc-domain:example.com"). */
export const isSiteUrl = (s: string) => /^(https?:\/\/[^\s]+|sc-domain:[^\s/]+)$/.test(s);

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
