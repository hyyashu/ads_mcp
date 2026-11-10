/**
 * OAuth scopes of the Search Console, GA4 and Tag Manager connections, as each API's reference lists them under
 * "Authorization scopes" (checked 2026-11-10, docs/VERIFICATION.md). One place, used by the Connect flows and the tool
 * declarations, so a tool can never document a scope the connection does not ask for.
 */
const G = (s: string) => `https://www.googleapis.com/auth/${s}`;

export const GSC_READONLY = G("webmasters.readonly");
export const GSC_FULL = G("webmasters");
export const GA4_READONLY = G("analytics.readonly");
export const GA4_EDIT = G("analytics.edit");
export const GTM_READONLY = G("tagmanager.readonly");
export const GTM_EDIT_CONTAINERS = G("tagmanager.edit.containers");
export const GTM_EDIT_VERSIONS = G("tagmanager.edit.containerversions");
export const GTM_PUBLISH = G("tagmanager.publish");

export type ProductPlatform = "google_search_console" | "google_analytics" | "google_tag_manager";

/**
 * What each Connect button asks for. Write connections also hold the read scope where the write scope does not cover
 * reads: the Data API (runReport, getMetadata) accepts analytics.readonly or analytics but not analytics.edit, and
 * tagmanager.publish / edit.containerversions do not cover listing. webmasters covers every Search Console read.
 */
export const PRODUCT_SCOPES: Record<ProductPlatform, { read: string[]; write: string[] }> = {
  google_search_console: { read: [GSC_READONLY], write: [GSC_FULL] },
  google_analytics: { read: [GA4_READONLY], write: [GA4_READONLY, GA4_EDIT] },
  google_tag_manager: { read: [GTM_READONLY], write: [GTM_READONLY, GTM_EDIT_CONTAINERS, GTM_EDIT_VERSIONS, GTM_PUBLISH] },
};
