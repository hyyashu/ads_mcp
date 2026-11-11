import { safeFetchBytes } from "../auth/ssrf";
import type { BingTokenProvider, GoogleTokenProvider, MetaTokenProvider } from "../auth/token-providers";
import type { Db } from "../db";
import { ToolError } from "../mcp/errors";
import type { Limiter } from "../security/rate-limit";
import { BingClient } from "./bing/client";
import type { BingHttp } from "./bing/http";
import type { BingServices } from "./bing/services";
import { GoogleAdsClient } from "./google/client";
import type { GoogleAdsHttp } from "./google/http";
import { type ImageFetcher, fetchImageSafely } from "./google/media";
import type { GoogleServices } from "./google/services";
import type { YouTubeClient } from "./google/youtube";
import { Ga4Client } from "./ga4/client";
import type { Ga4Services } from "./ga4/services";
import type { GoogleApiHttp } from "./gapi/http";
import { GscClient } from "./gsc/client";
import type { GscServices } from "./gsc/services";
import { GtmClient } from "./gtm/client";
import type { GtmServices } from "./gtm/services";
import { MetaAdsClient } from "./meta/client";
import type { MetaGraphHttp } from "./meta/http";
import type { MetaServices } from "./meta/services";

export interface ServiceFactoryDeps {
  db: Db;
  google?: { tokens: GoogleTokenProvider; http: GoogleAdsHttp };
  meta?: { tokens: MetaTokenProvider; http: MetaGraphHttp };
  /** Search Console, GA4 and Tag Manager: the same Google OAuth client (token provider) as Ads, one shared transport. */
  /** gtmLimiter: Tag Manager's quota is per Cloud project (25 requests per 100 s, Tag Manager "Limits and quotas"), shared by
   * every tenant, so one limiter for the whole server keeps a busy tenant from failing everyone's calls at Google. */
  gapi?: { tokens: Pick<GoogleTokenProvider, "getAccessToken">; http: GoogleApiHttp; gtmLimiter?: Limiter };
  /** Bing Webmaster Tools: its own OAuth client and token provider. */
  bing?: { tokens: Pick<BingTokenProvider, "getAccessToken">; http: BingHttp };
  fetchImage?: ImageFetcher;
  youtube?: YouTubeClient;
  fetchPage?: (url: string) => Promise<string>;
}

/** Production page fetcher: https only, public hosts, no redirects, HTML only, 512 KB. */
export const fetchPageSafely = async (url: string): Promise<string> => {
  try {
    return (await safeFetchBytes(url, { accept: "text/html", contentTypes: ["text/html", "application/xhtml+xml"], maxBytes: 512 * 1024, timeoutMs: 10_000, userAgent: "ads-mcp-page-reader" })).bytes.toString("utf8");
  } catch (e) {
    throw new ToolError("invalid_argument", `The page could not be read: ${(e as Error).message}`);
  }
};

/** Meta image download: https only, public hosts, no redirects, PNG/JPEG/GIF only. The 30 MB cap is this server's download
 * limit, not a Meta spec. */
export const fetchMetaImageSafely: ImageFetcher = async (url) => {
  try {
    return (await safeFetchBytes(url, { accept: "image/png,image/jpeg,image/gif", contentTypes: ["image/png", "image/jpeg", "image/gif"], maxBytes: 30 * 1024 * 1024, timeoutMs: 20_000, userAgent: "ads-mcp-image-fetcher" })).bytes;
  } catch (e) {
    throw new ToolError("invalid_argument", `The image could not be downloaded: ${(e as Error).message}`);
  }
};

/** Builds platform clients for one authorized account (the platform adapter seam: one branch per platform). Handlers never see tokens: they only get these clients. */
export function createServicesFactory(d: ServiceFactoryDeps) {
  return async (o: { tenantId: string; account: { platform: string; externalId: string; loginCustomerId: string | null; connectionId: string; currencyCode?: string | null; timeZone?: string | null }; signal?: AbortSignal }): Promise<unknown> => {
    if (o.account.platform === "google_ads") {
      if (!d.google) throw new ToolError("unsupported", "Google Ads is not configured on this server.");
      const { tokens, http } = d.google;
      const ads = new GoogleAdsClient({
        http,
        customerId: o.account.externalId.replace(/-/g, ""),
        loginCustomerId: o.account.loginCustomerId?.replace(/-/g, "") ?? null,
        getAccessToken: () => tokens.getAccessToken(o.tenantId, o.account.connectionId),
        signal: o.signal, // cancellation and deadlines reach the upstream requests
      });
      return { ads, mutationsSent: () => ads.mutationsSent, fetchImage: d.fetchImage ?? fetchImageSafely, fetchPage: d.fetchPage ?? fetchPageSafely, ...(d.youtube ? { youtube: d.youtube } : {}) } satisfies GoogleServices;
    }
    if (o.account.platform === "meta_ads") {
      if (!d.meta) throw new ToolError("unsupported", "Meta Ads is not configured on this server.");
      const { tokens, http } = d.meta;
      const meta = new MetaAdsClient({
        http,
        adAccountId: o.account.externalId,
        currency: o.account.currencyCode ?? null,
        getToken: () => tokens.getToken(o.tenantId, o.account.connectionId),
        // Page token: GET /{page-id}?fields=access_token with the user token (Page reference: returned only when the user has a
        // role on the Page). Fetched per call and never cached, logged or returned to a handler.
        getPageToken: async (pageId: string) => {
          const user = await tokens.getToken(o.tenantId, o.account.connectionId);
          const r = await http.call<{ access_token?: string }>({ ...user, path: pageId, params: { fields: "access_token" }, idempotent: true, signal: o.signal });
          if (!r.access_token) throw new ToolError("platform_permission_denied", "Meta returned no Page access token: the connected user needs a role on this Page.");
          return { accessToken: r.access_token, appSecretProof: tokens.proofFor(r.access_token) };
        },
        signal: o.signal,
      });
      return { meta, mutationsSent: () => meta.mutationsSent, fetchImage: d.fetchImage ?? fetchMetaImageSafely } satisfies MetaServices;
    }
    if (o.account.platform === "google_search_console" || o.account.platform === "google_analytics" || o.account.platform === "google_tag_manager") {
      if (!d.gapi) throw new ToolError("unsupported", "Google connections are not configured on this server.");
      const { tokens, http } = d.gapi;
      // Each product connection is its own Google grant: the token is always the one of this account's connection.
      const base = { http, getAccessToken: () => tokens.getAccessToken(o.tenantId, o.account.connectionId), signal: o.signal };
      if (o.account.platform === "google_search_console") {
        const gsc = new GscClient({ ...base, siteUrl: o.account.externalId });
        return { gsc, mutationsSent: () => gsc.mutationsSent } satisfies GscServices;
      }
      if (o.account.platform === "google_analytics") {
        const ga4 = new Ga4Client({ ...base, property: o.account.externalId, currencyCode: o.account.currencyCode ?? null, timeZone: o.account.timeZone ?? null });
        return { ga4, mutationsSent: () => ga4.mutationsSent } satisfies Ga4Services;
      }
      const lim = d.gapi.gtmLimiter;
      const beforeCall = lim
        ? async () => {
            const r = await lim.take("project");
            if (!r.ok) throw new ToolError("quota_exceeded", `Tag Manager's request limit for this server is reached (Google allows 25 requests per 100 seconds per project). Try again in ${r.retryAfterSeconds} seconds. Nothing was sent.`, { retryAfterSeconds: r.retryAfterSeconds, definite: true });
          }
        : undefined;
      const gtm = new GtmClient({ ...base, containerPath: o.account.externalId, ...(beforeCall ? { beforeCall } : {}) });
      return { gtm, mutationsSent: () => gtm.mutationsSent } satisfies GtmServices;
    }
    if (o.account.platform === "bing_webmaster") {
      if (!d.bing) throw new ToolError("unsupported", "Bing Webmaster is not configured on this server.");
      const { tokens, http } = d.bing;
      const bing = new BingClient({ http, siteUrl: o.account.externalId, getAccessToken: () => tokens.getAccessToken(o.tenantId, o.account.connectionId), signal: o.signal });
      return { bing, mutationsSent: () => bing.mutationsSent } satisfies BingServices;
    }
    throw new ToolError("unsupported", `Platform ${o.account.platform} is not available yet.`);
  };
}
