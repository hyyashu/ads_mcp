import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { connectedAccount, platformConnection } from "../db/schema";
import type { Platform } from "../inventory";
import { ToolError } from "../mcp/errors";
import type { ResolvedAccount } from "../mcp/tool";

/**
 * Resolves the caller-supplied account_id to an account THIS TENANT may use. A foreign or unknown id is reported as
 * not_found, so ids of other tenants cannot be probed.
 *
 * An account can be named by this server's id (from list_accounts) or by the platform's own id: a Google Ads customer id
 * ("488-059-4061" or "4880594061"), a Meta ad account id ("act_123" or "123"), a Search Console site exactly as Search
 * Console returns it ("https://example.com/" or "sc-domain:example.com"), a GA4 property ("properties/123" or "123") or a
 * Tag Manager container path ("accounts/1/containers/2"). Either way the lookup stays scoped to the caller's workspace and
 * platform, and (tenant, platform, external id) is unique, so this cannot reach another workspace's account.
 */
export function externalIdFor(accountId: string, platform: Platform): string | null {
  const raw = accountId.trim();
  switch (platform) {
    case "google_ads":
      return /^\d{3}-?\d{3}-?\d{4}$/.test(raw) ? raw.replace(/-/g, "") : null;
    case "meta_ads":
      return /^(act_)?\d{1,20}$/.test(raw) ? (raw.startsWith("act_") ? raw : `act_${raw}`) : null;
    case "google_search_console":
      // Exactly as stored: a URL-prefix property's trailing slash is part of its identity in Search Console.
      return /^(https?:\/\/\S+|sc-domain:\S+)$/.test(raw) ? raw : null;
    case "google_analytics":
      return /^(properties\/)?\d{1,20}$/.test(raw) ? (raw.startsWith("properties/") ? raw : `properties/${raw}`) : null;
    case "google_tag_manager":
      return /^accounts\/\d{1,20}\/containers\/\d{1,20}$/.test(raw) ? raw : null;
  }
}

function accountMatch(accountId: string, platform: Platform) {
  const external = externalIdFor(accountId, platform);
  return external ? and(eq(connectedAccount.platform, platform), eq(connectedAccount.externalId, external))! : eq(connectedAccount.id, accountId.trim());
}

export async function resolveAccount(
  db: Db,
  tenantId: string,
  accountId: string,
  platform: Platform,
  needWrite: boolean,
): Promise<ResolvedAccount & { connectionId: string }> {
  const [row] = await db
    .select({
      id: connectedAccount.id,
      platform: connectedAccount.platform,
      externalId: connectedAccount.externalId,
      loginCustomerId: connectedAccount.loginCustomerId,
      access: connectedAccount.access,
      currencyCode: connectedAccount.currencyCode,
      timeZone: connectedAccount.timeZone,
      connectionId: connectedAccount.connectionId,
      connStatus: platformConnection.status,
    })
    .from(connectedAccount)
    .innerJoin(platformConnection, eq(platformConnection.id, connectedAccount.connectionId))
    .where(and(accountMatch(accountId, platform), eq(connectedAccount.tenantId, tenantId)));

  if (!row || row.platform !== platform) throw new ToolError("not_found", "No such connected account for this tool's platform.");
  if (row.connStatus !== "active") {
    throw new ToolError("auth_expired", "The connection for this account was revoked or expired. Reconnect it, then retry.");
  }
  if (needWrite && row.access !== "write") {
    throw new ToolError("permission_denied", "This account is connected read-only. Reconnect it with write access to make changes.");
  }
  return { id: row.id, platform, externalId: row.externalId, loginCustomerId: row.loginCustomerId, access: row.access as "read" | "write", currencyCode: row.currencyCode, timeZone: row.timeZone, connectionId: row.connectionId };
}
