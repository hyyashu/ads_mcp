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
  /** Reads the account's reporting units live. Used once to backfill accounts connected before units were stored. */
  describeAccount(): Promise<AccountUnits>;
}

/** Reporting units of an ad account, as the platform reports them. Null when the platform did not say. */
export interface AccountUnits {
  currencyCode: string | null;
  timeZone: string | null;
}

export interface ServiceFactoryDeps {
  db: Db;
  google?: { tokens: GoogleTokenProvider; http: GoogleAdsHttp };
}

/** Builds platform clients for one authorized account. Handlers never see tokens: they only get these clients. */
export function createServicesFactory(d: ServiceFactoryDeps) {
  return async (o: { tenantId: string; account: { platform: string; externalId: string; loginCustomerId: string | null; connectionId: string }; signal?: AbortSignal }): Promise<unknown> => {
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
      const describeAccount = async (): Promise<AccountUnits> => {
        const [row] = await ads.query("SELECT customer.currency_code, customer.time_zone FROM customer LIMIT 1", { maxRows: 1 });
        const c = row?.customer as { currencyCode?: string; timeZone?: string } | undefined;
        return { currencyCode: c?.currencyCode ?? null, timeZone: c?.timeZone ?? null };
      };
      return { ads, mutationsSent: () => ads.mutationsSent, describeAccount } satisfies GoogleServices;
    }
    throw new ToolError("unsupported", `Platform ${o.account.platform} is not available yet.`);
  };
}
