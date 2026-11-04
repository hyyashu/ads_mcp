import type { Db } from "../../db";
import type { GoogleTokenProvider, MetaTokenProvider } from "../../auth/token-providers";
import { MetaAdsClient } from "../meta/client";
import type { MetaGraphHttp } from "../meta/http";
import type { MetaServices } from "../meta/services";
import { safeFetchBytes } from "../../auth/ssrf";
import { ToolError } from "../../mcp/errors";
import { GoogleAdsClient } from "./client";
import { type ImageFetcher, fetchImageSafely } from "./media";
import type { YouTubeClient } from "./youtube";
import type { GoogleAdsHttp } from "./http";

/** What a Google tool handler receives as `ctx.services`. */
export interface GoogleServices {
  ads: GoogleAdsClient;
  /** Changes attempted so far through this account's client. Zero means nothing has reached Google Ads. */
  mutationsSent(): number;
  /** Downloads an image for an image asset (SSRF-safe in production; injectable for tests). */
  fetchImage: ImageFetcher;
  /** YouTube Data API client; absent when YOUTUBE_API_KEY is not configured. */
  youtube?: YouTubeClient;
  /** Fetches a public web page (SSRF-safe, text/html, 512 KB) for reading its title and description. */
  fetchPage: (url: string) => Promise<string>;
}

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
