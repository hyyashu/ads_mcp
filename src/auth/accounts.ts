import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { connectedAccount, platformConnection } from "../db/schema";
import type { Platform } from "../inventory";
import { ToolError } from "../mcp/errors";
import type { ResolvedAccount } from "../mcp/tool";

/**
 * Resolves the caller-supplied account_id to an account THIS TENANT may use. A foreign or unknown id
 * is reported as not_found, so ids of other tenants cannot be probed.
 */
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
      connectionId: connectedAccount.connectionId,
      connStatus: platformConnection.status,
    })
    .from(connectedAccount)
    .innerJoin(platformConnection, eq(platformConnection.id, connectedAccount.connectionId))
    .where(and(eq(connectedAccount.id, accountId), eq(connectedAccount.tenantId, tenantId)));

  if (!row || row.platform !== platform) throw new ToolError("not_found", "No such connected account for this tool's platform.");
  if (row.connStatus !== "active") {
    throw new ToolError("auth_expired", "The connection for this account was revoked or expired. Reconnect it, then retry.");
  }
  if (needWrite && row.access !== "write") {
    throw new ToolError("permission_denied", "This account is connected read-only. Reconnect it with write access to make changes.");
  }
  return { id: row.id, platform, externalId: row.externalId, loginCustomerId: row.loginCustomerId, access: row.access as "read" | "write", connectionId: row.connectionId };
}
