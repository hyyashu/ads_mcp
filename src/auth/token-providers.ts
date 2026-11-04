import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { platformConnection } from "../db/schema";
import { ToolError } from "../mcp/errors";
import { type CredentialCipher, credentialAad } from "../security/crypto";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface Loaded {
  id: string;
  status: string;
  expiresAt: Date | null;
  enc: string;
}

async function load(db: Db, tenantId: string, connectionId: string): Promise<Loaded> {
  const [c] = await db
    .select({ id: platformConnection.id, status: platformConnection.status, expiresAt: platformConnection.expiresAt, enc: platformConnection.credentialsEnc })
    .from(platformConnection)
    .where(and(eq(platformConnection.id, connectionId), eq(platformConnection.tenantId, tenantId)));
  if (!c) throw new ToolError("not_found", "No such connection.");
  if (c.status !== "active") throw new ToolError("auth_expired", "This connection was revoked or needs to be reconnected.");
  return c;
}

export async function markNeedsReauth(db: Db, tenantId: string, connectionId: string) {
  await db.update(platformConnection).set({ status: "needs_reauth" }).where(and(eq(platformConnection.id, connectionId), eq(platformConnection.tenantId, tenantId), eq(platformConnection.status, "active")));
}

/**
 * Google: exchanges the stored refresh token for short-lived access tokens, cached in memory only
 * (never persisted). A revoked or expired grant (`invalid_grant`) flips the connection to needs_reauth.
 */
export class GoogleTokenProvider {
  private cache = new Map<string, { token: string; exp: number }>();

  constructor(
    private o: { db: Db; cipher: CredentialCipher; clientId: string; clientSecret: string; fetch?: FetchLike; now?: () => number },
  ) {}

  async getAccessToken(tenantId: string, connectionId: string): Promise<string> {
    const now = (this.o.now ?? Date.now)();
    // Keyed by tenant AND connection: a cached token must never be returned to a different tenant.
    const cacheKey = `${tenantId}:${connectionId}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.exp - 60_000 > now) return hit.token;

    const conn = await load(this.o.db, tenantId, connectionId);
    const { refreshToken } = this.o.cipher.decrypt<{ refreshToken: string }>(conn.enc, credentialAad(tenantId, connectionId));
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.o.clientId, client_secret: this.o.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ToolError("transient", "Could not reach Google to refresh credentials.");
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      if (body.error === "invalid_grant" || body.error === "unauthorized_client") {
        await markNeedsReauth(this.o.db, tenantId, connectionId);
        this.forget(connectionId);
        throw new ToolError("auth_expired", "Google access was revoked or expired. Reconnect the Google Ads account.");
      }
      throw new ToolError(res.status >= 500 ? "transient" : "auth_expired", "Google refused to refresh credentials.");
    }
    this.cache.set(cacheKey, { token: body.access_token, exp: now + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  /** Drops cached tokens for a connection (call on disconnect and when it needs re-authentication). */
  forget(connectionId: string) {
    for (const k of this.cache.keys()) if (k.endsWith(`:${connectionId}`)) this.cache.delete(k);
  }
}

/** Meta: long-lived user tokens expire and cannot be refreshed. Expiry flips the connection to needs_reauth. */
export class MetaTokenProvider {
  constructor(private o: { db: Db; cipher: CredentialCipher; appSecret: string; now?: () => Date }) {}

  async getToken(tenantId: string, connectionId: string): Promise<{ accessToken: string; appSecretProof: string }> {
    const conn = await load(this.o.db, tenantId, connectionId);
    const now = (this.o.now ?? (() => new Date()))();
    if (conn.expiresAt && conn.expiresAt <= now) {
      await markNeedsReauth(this.o.db, tenantId, connectionId);
      throw new ToolError("auth_expired", "The Meta access token expired. Reconnect the Meta Ads account.");
    }
    const { accessToken } = this.o.cipher.decrypt<{ accessToken: string }>(conn.enc, credentialAad(tenantId, connectionId));
    // appsecret_proof ties each call to our app secret, so a leaked token alone is not enough to call the API.
    return { accessToken, appSecretProof: createHmac("sha256", this.o.appSecret).update(accessToken).digest("hex") };
  }
}
