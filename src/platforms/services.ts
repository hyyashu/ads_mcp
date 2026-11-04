import { safeFetchBytes } from "../auth/ssrf";
import type { GoogleTokenProvider, MetaTokenProvider } from "../auth/token-providers";
import type { Db } from "../db";
import { ToolError } from "../mcp/errors";
import { GoogleAdsClient } from "./google/client";
import type { GoogleAdsHttp } from "./google/http";
import { type ImageFetcher, fetchImageSafely } from "./google/media";
import type { GoogleServices } from "./google/services";
import type { YouTubeClient } from "./google/youtube";
import { MetaAdsClient } from "./meta/client";
import type { MetaGraphHttp } from "./meta/http";
import type { MetaServices } from "./meta/services";

export interface ServiceFactoryDeps {
  db: Db;
  google?: { tokens: GoogleTokenProvider; http: GoogleAdsHttp };
  meta?: { tokens: MetaTokenProvider; http: MetaGraphHttp };
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

/** Builds platform clients for one authorized account (the platform adapter seam: one branch per platform). Handlers never see tokens: they only get these clients. */
export function createServicesFactory(d: ServiceFactoryDeps) {
  return async (o: { tenantId: string; account: { platform: string; externalId: string; loginCustomerId: string | null; connectionId: string; currencyCode?: string | null }; signal?: AbortSignal }): Promise<unknown> => {
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
        signal: o.signal,
      });
      return { meta, mutationsSent: () => meta.mutationsSent } satisfies MetaServices;
    }
    throw new ToolError("unsupported", `Platform ${o.account.platform} is not available yet.`);
  };
}
