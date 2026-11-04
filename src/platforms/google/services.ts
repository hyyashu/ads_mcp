import type { Db } from "../../db";
import type { GoogleTokenProvider, MetaTokenProvider } from "../../auth/token-providers";
import { MetaAdsClient } from "../meta/client";
import type { MetaGraphHttp } from "../meta/http";
import type { MetaServices } from "../meta/services";
import { ToolError } from "../../mcp/errors";
import { GoogleAdsClient } from "./client";
import type { GoogleAdsHttp } from "./http";

/** What a Google tool handler receives as `ctx.services`. */
export interface GoogleServices {
  ads: GoogleAdsClient;
  /** Changes attempted so far through this account's client. Zero means nothing has reached Google Ads. */
  mutationsSent(): number;
}

export interface ServiceFactoryDeps {
  db: Db;
  google?: { tokens: GoogleTokenProvider; http: GoogleAdsHttp };
  meta?: { tokens: MetaTokenProvider; http: MetaGraphHttp };
}

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
      return { ads, mutationsSent: () => ads.mutationsSent } satisfies GoogleServices;
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
