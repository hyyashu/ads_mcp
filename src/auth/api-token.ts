import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { apiToken, appUser } from "../db/schema";
import { sha256 } from "../security/canonical";
import type { AuthContext, Authenticator, Role } from "./context";

const PREFIX = "adsmcp_";

/** Returns the plaintext token exactly once. Only its SHA-256 hash is stored. */
export async function issueApiToken(
  db: Db,
  o: { tenantId: string; userId: string; label: string; scopes: string[]; expiresAt?: Date },
): Promise<{ token: string; id: string }> {
  const token = PREFIX + randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(apiToken)
    .values({ tenantId: o.tenantId, userId: o.userId, label: o.label, scopes: o.scopes, tokenHash: sha256(token), expiresAt: o.expiresAt ?? null })
    .returning({ id: apiToken.id });
  return { token, id: row!.id };
}

export async function revokeApiToken(db: Db, tenantId: string, tokenId: string) {
  await db.update(apiToken).set({ revokedAt: new Date() }).where(and(eq(apiToken.id, tokenId), eq(apiToken.tenantId, tenantId)));
}

/**
 * Interim bearer-token authenticator (works with Cursor and any client that can send headers).
 * Claude and ChatGPT connectors need OAuth 2.1 with dynamic client registration; that lands with the
 * auth phase and will implement the same Authenticator interface.
 */
export class ApiTokenAuthenticator implements Authenticator {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  async authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthContext | null> {
    const raw = headers.authorization;
    const h = Array.isArray(raw) ? raw[0] : raw;
    const m = h?.match(/^Bearer\s+(\S+)$/i);
    if (!m || !m[1]!.startsWith(PREFIX)) return null;

    const [row] = await this.db
      .select({
        id: apiToken.id,
        tenantId: apiToken.tenantId,
        userId: apiToken.userId,
        scopes: apiToken.scopes,
        expiresAt: apiToken.expiresAt,
        role: appUser.role,
      })
      .from(apiToken)
      .innerJoin(appUser, eq(appUser.id, apiToken.userId))
      .where(and(eq(apiToken.tokenHash, sha256(m[1]!)), isNull(apiToken.revokedAt)));
    if (!row) return null;
    if (row.expiresAt && row.expiresAt <= this.now()) return null;
    await this.db.update(apiToken).set({ lastUsedAt: this.now() }).where(eq(apiToken.id, row.id));
    return { tenantId: row.tenantId, userId: row.userId, role: row.role as Role, scopes: row.scopes, tokenId: row.id };
  }
}
