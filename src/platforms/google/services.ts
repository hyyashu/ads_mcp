import type { Db } from "../../db";
import type { GoogleTokenProvider } from "../../auth/token-providers";
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
}

/** Builds platform clients for one authorized account. Handlers never see tokens: they only get these clients. */
export function createServicesFactory(d: ServiceFactoryDeps) {
  return async (o: { tenantId: string; account: { platform: string; externalId: string; loginCustomerId: string | null; connectionId: string } }): Promise<unknown> => {
    if (o.account.platform === "google_ads") {
      if (!d.google) throw new ToolError("unsupported", "Google Ads is not configured on this server.");
      const { tokens, http } = d.google;
      const ads = new GoogleAdsClient({
        http,
        customerId: o.account.externalId.replace(/-/g, ""),
        loginCustomerId: o.account.loginCustomerId?.replace(/-/g, "") ?? null,
        getAccessToken: () => tokens.getAccessToken(o.tenantId, o.account.connectionId),
      });
      return { ads, mutationsSent: () => ads.mutationsSent } satisfies GoogleServices;
    }
    throw new ToolError("unsupported", `Platform ${o.account.platform} is not available yet.`);
  };
}
