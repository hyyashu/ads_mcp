import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { connectedAccount, platformConnection, platformOauthState } from "../db/schema";
import { ToolError } from "../mcp/errors";
import { GoogleAdsHttp } from "../platforms/google/http";
import { audit } from "../security/audit";
import { sha256 } from "../security/canonical";
import { type CredentialCipher, credentialAad } from "../security/crypto";
import type { Role } from "./context";
import type { FetchLike } from "./token-providers";

/**
 * Connecting ad accounts: OAuth with Google and Meta. This is completely separate from the OAuth MCP clients use
 * to reach this server (oauth-server.ts). Credentials are encrypted with a key bound to the connection row.
 */
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

/** Each Meta permission beyond ads_read needs App Review before non-developer users can grant it. */
export const META_SCOPES = {
  read: ["ads_read", "business_management", "pages_show_list", "pages_read_engagement", "catalog_management", "instagram_basic", "leads_retrieval"],
  write: ["ads_read", "ads_management", "business_management", "pages_show_list", "pages_read_engagement", "catalog_management", "instagram_basic", "leads_retrieval"],
} as const;

export type Access = "read" | "write";
export type PlatformKey = "google_ads" | "meta_ads";
const STATE_TTL_MS = 10 * 60_000;
const MAX_ACCOUNTS = 500;

export interface PlatformOAuthConfig {
  publicUrl: string;
  google?: { clientId: string; clientSecret: string; apiVersion: string };
  meta?: { appId: string; appSecret: string; apiVersion: string };
}

export interface Actor {
  tenantId: string;
  userId: string;
  role: Role;
}

export interface FinishResult {
  connectionId: string;
  accounts: number;
  skipped: number;
  access: Access;
}

const b64u = (b: Buffer) => b.toString("base64url");

export class PlatformOAuth {
  private f: FetchLike;
  private now: () => Date;

  private onRevoked?: (connectionId: string) => void;

  constructor(
    private db: Db,
    private cipher: CredentialCipher,
    private cfg: PlatformOAuthConfig,
    /** onRevoked: called after a connection is disconnected, so in-memory caches (e.g. Google access tokens) are cleared. */
    opts: { fetch?: FetchLike; now?: () => Date; onRevoked?: (connectionId: string) => void } = {},
  ) {
    this.f = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.onRevoked = opts.onRevoked;
  }

  enabled(platform: PlatformKey) {
    return platform === "google_ads" ? !!this.cfg.google : !!this.cfg.meta;
  }

  private redirectUri(platform: PlatformKey) {
    return `${this.cfg.publicUrl}/connect/${platform === "google_ads" ? "google" : "meta"}/callback`;
  }

  private assertCanConnect(actor: Actor, access: Access) {
    if (actor.role === "member") throw new ToolError("permission_denied", "Only owners and admins can connect ad accounts.");
    if (access === "write" && actor.role !== "owner" && actor.role !== "admin") throw new ToolError("permission_denied", "Only owners and admins can grant write access.");
  }

  /** Creates single-use state (bound to this user) and returns the URL to send the browser to. */
  async start(platform: PlatformKey, actor: Actor, access: Access): Promise<string> {
    if (!this.enabled(platform)) throw new ToolError("unsupported", `${platform === "google_ads" ? "Google" : "Meta"} connections are not configured on this server.`);
    this.assertCanConnect(actor, access);

    const state = b64u(randomBytes(32));
    const verifier = b64u(randomBytes(48));
    const stateHash = sha256(state);
    await this.db.insert(platformOauthState).values({
      stateHash,
      tenantId: actor.tenantId,
      userId: actor.userId,
      platform,
      verifierEnc: this.cipher.encrypt({ verifier }, `state|${actor.tenantId}|${actor.userId}|${stateHash}`).enc,
      access,
      expiresAt: new Date(this.now().getTime() + STATE_TTL_MS),
    });

    if (platform === "google_ads") {
      const g = this.cfg.google!;
      const q = new URLSearchParams({
        client_id: g.clientId,
        redirect_uri: this.redirectUri(platform),
        response_type: "code",
        scope: `${GOOGLE_ADS_SCOPE} openid email`,
        access_type: "offline", // needed for a refresh token
        prompt: "consent", // Google only returns a refresh token on explicit consent
        state,
        code_challenge: b64u(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    }
    const m = this.cfg.meta!;
    const q = new URLSearchParams({
      client_id: m.appId,
      redirect_uri: this.redirectUri(platform),
      response_type: "code",
      state,
      scope: META_SCOPES[access].join(","),
    });
    return `https://www.facebook.com/${m.apiVersion}/dialog/oauth?${q}`;
  }

  /** Consumes the state exactly once, only for the same user/tenant/platform that started the flow. */
  private async consumeState(platform: PlatformKey, actor: Actor, state: string | null) {
    if (!state) throw new ToolError("invalid_argument", "Missing state.");
    const stateHash = sha256(state);
    const [row] = await this.db
      .update(platformOauthState)
      .set({ usedAt: this.now() })
      .where(
        and(
          eq(platformOauthState.stateHash, stateHash),
          eq(platformOauthState.tenantId, actor.tenantId),
          eq(platformOauthState.userId, actor.userId),
          eq(platformOauthState.platform, platform),
          isNull(platformOauthState.usedAt),
          gt(platformOauthState.expiresAt, this.now()),
        ),
      )
      .returning();
    if (!row) throw new ToolError("invalid_argument", "This connection attempt expired or was already used. Start again.");
    const { verifier } = this.cipher.decrypt<{ verifier: string }>(row.verifierEnc, `state|${actor.tenantId}|${actor.userId}|${stateHash}`);
    return { verifier, access: row.access as Access };
  }

  async finish(platform: PlatformKey, actor: Actor, q: URLSearchParams): Promise<FinishResult> {
    if (q.get("error")) throw new ToolError("permission_denied", `The platform reported: ${q.get("error")}. Nothing was connected.`);
    const { verifier, access } = await this.consumeState(platform, actor, q.get("state"));
    const code = q.get("code");
    if (!code) throw new ToolError("invalid_argument", "Missing authorization code.");
    this.assertCanConnect(actor, access);
    return platform === "google_ads" ? this.finishGoogle(actor, code, verifier, access) : this.finishMeta(actor, code, access);
  }

  // ------------------------------------------------------------------ Google ----
  private async finishGoogle(actor: Actor, code: string, verifier: string, access: Access): Promise<FinishResult> {
    const g = this.cfg.google!;
    const res = await this.f("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: this.redirectUri("google_ads"), grant_type: "authorization_code", code_verifier: verifier }),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; id_token?: string };
    if (!res.ok || !tok.access_token) throw new ToolError("permission_denied", "Google did not accept the authorization. Start again.");
    if (!tok.refresh_token) throw new ToolError("invalid_argument", "Google did not return a refresh token. Remove this app's access in your Google account settings, then connect again.");
    const granted = (tok.scope ?? "").split(" ").filter(Boolean);
    if (!granted.includes(GOOGLE_ADS_SCOPE)) throw new ToolError("permission_denied", "The Google Ads permission was not granted.");

    // The id_token arrives straight from Google's token endpoint over TLS, so reading its email claim is safe for display.
    let email: string | undefined;
    try {
      email = JSON.parse(Buffer.from((tok.id_token ?? "").split(".")[1] ?? "", "base64url").toString("utf8")).email;
    } catch {
      /* optional */
    }

    const http = new GoogleAdsHttp({ apiVersion: g.apiVersion, fetch: this.f });
    const discovered = await this.discoverGoogleAccounts(http, tok.access_token);

    const connectionId = randomUUID();
    await this.db.insert(platformConnection).values({
      id: connectionId,
      tenantId: actor.tenantId,
      userId: actor.userId,
      platform: "google_ads",
      credentialsEnc: this.cipher.encrypt({ refreshToken: tok.refresh_token }, credentialAad(actor.tenantId, connectionId)).enc,
      keyVersion: this.cipher.activeVersion,
      grantedScopes: granted,
      externalUserId: email ?? null,
      status: "active",
    });
    await this.saveAccounts(actor.tenantId, connectionId, "google_ads", access, discovered.accounts);
    await audit(this.db, { tenantId: actor.tenantId, userId: actor.userId, event: "connection.created", refId: connectionId, outcome: "google_ads" });
    return { connectionId, accounts: discovered.accounts.length, skipped: discovered.skipped, access };
  }

  /** Accounts the user can reach directly, plus every non-manager client below any manager account. */
  private async discoverGoogleAccounts(http: GoogleAdsHttp, accessToken: string) {
    const list = await http.call<{ resourceNames?: string[] }>({ accessToken, path: "customers:listAccessibleCustomers", method: "GET", idempotent: true });
    const roots = (list.resourceNames ?? []).map((r) => r.replace("customers/", ""));
    const out = new Map<string, { externalId: string; displayName: string; loginCustomerId: string | null }>();
    let skipped = 0;

    for (const id of roots) {
      try {
        const rows = await this.gaql(http, accessToken, id, null, "SELECT customer.id, customer.descriptive_name, customer.manager FROM customer LIMIT 1");
        const me = rows[0]?.customer as { descriptiveName?: string; manager?: boolean } | undefined;
        if (!me?.manager) {
          out.set(id, { externalId: id, displayName: me?.descriptiveName ?? "", loginCustomerId: null });
          continue;
        }
        const kids = await this.gaql(
          http,
          accessToken,
          id,
          id,
          "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager FROM customer_client WHERE customer_client.level > 0 AND customer_client.status = 'ENABLED' AND customer_client.hidden = FALSE",
        );
        for (const k of kids) {
          const c = k.customerClient as { id?: string; descriptiveName?: string; manager?: boolean };
          if (c?.id && !c.manager && !out.has(c.id)) out.set(c.id, { externalId: c.id, displayName: c.descriptiveName ?? "", loginCustomerId: id });
        }
      } catch {
        skipped++; // cancelled/suspended/no-access accounts are skipped, not fatal
      }
      if (out.size >= MAX_ACCOUNTS) break;
    }
    return { accounts: [...out.values()].slice(0, MAX_ACCOUNTS), skipped };
  }

  private async gaql(http: GoogleAdsHttp, accessToken: string, customerId: string, loginCustomerId: string | null, query: string) {
    const chunks = await http.call<{ results?: Record<string, unknown>[] }[]>({ accessToken, path: `customers/${customerId}/googleAds:searchStream`, body: { query }, loginCustomerId, idempotent: true });
    return (Array.isArray(chunks) ? chunks : []).flatMap((c) => c.results ?? []);
  }

  // -------------------------------------------------------------------- Meta ----
  private async finishMeta(actor: Actor, code: string, access: Access): Promise<FinishResult> {
    const m = this.cfg.meta!;
    const base = `https://graph.facebook.com/${m.apiVersion}`;
    const post = async (path: string, params: Record<string, string>) => {
      const res = await this.f(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(10_000) });
      return { ok: res.ok, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    const short = await post("oauth/access_token", { client_id: m.appId, client_secret: m.appSecret, redirect_uri: this.redirectUri("meta_ads"), code });
    if (!short.ok || !short.body.access_token) throw new ToolError("permission_denied", "Meta did not accept the authorization. Start again.");
    // Exchange for a long-lived token (about 60 days). Meta has no refresh token: users reconnect when it expires.
    const long = await post("oauth/access_token", { grant_type: "fb_exchange_token", client_id: m.appId, client_secret: m.appSecret, fb_exchange_token: short.body.access_token });
    const token: string = long.ok && long.body.access_token ? long.body.access_token : short.body.access_token;

    const proof = createHmac("sha256", m.appSecret).update(token).digest("hex");
    const get = async (path: string, params: Record<string, string> = {}) => {
      const qs = new URLSearchParams({ ...params, appsecret_proof: proof });
      const res = await this.f(`${base}/${path}?${qs}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      return { ok: res.ok, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };

    // debug_token is authenticated with the app (id|secret) and tells us the real scopes, user and expiry.
    // The inspected token travels in a POST body, never in the URL, so it cannot end up in proxy or APM logs.
    // (Graph API accepts POST for this endpoint as far as documented; confirm on the first live run.)
    const dbg = await this.f(`${base}/debug_token`, { method: "POST", headers: { authorization: `Bearer ${m.appId}|${m.appSecret}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ input_token: token }), signal: AbortSignal.timeout(10_000) });
    const info = ((await dbg.json().catch(() => ({}))) as { data?: { is_valid?: boolean; scopes?: string[]; user_id?: string; expires_at?: number } }).data;
    if (!info?.is_valid) throw new ToolError("permission_denied", "Meta reported the token as invalid.");
    if (!(info.scopes ?? []).includes("ads_read")) throw new ToolError("permission_denied", "The ads_read permission was not granted.");
    if (access === "write" && !(info.scopes ?? []).includes("ads_management")) throw new ToolError("permission_denied", "Write access needs the ads_management permission, which was not granted.");

    const accounts: { externalId: string; displayName: string; loginCustomerId: null }[] = [];
    let skipped = 0;
    let next: string | null = "me/adaccounts";
    let params: Record<string, string> = { fields: "account_id,name,account_status", limit: "100" };
    while (next && accounts.length < MAX_ACCOUNTS) {
      const page = await get(next, params);
      if (!page.ok) throw new ToolError("permission_denied", "Meta would not list your ad accounts.");
      for (const a of (page.body.data ?? []) as { account_id: string; name?: string; account_status?: number }[]) {
        if (a.account_status === 1) accounts.push({ externalId: `act_${a.account_id}`, displayName: a.name ?? "", loginCustomerId: null });
        else skipped++; // disabled / unsettled / closed accounts
      }
      const after = page.body.paging?.cursors?.after as string | undefined;
      next = page.body.paging?.next && after ? "me/adaccounts" : null;
      params = { fields: "account_id,name,account_status", limit: "100", ...(after ? { after } : {}) };
    }

    const connectionId = randomUUID();
    const expiresAt = info.expires_at && info.expires_at > 0 ? new Date(info.expires_at * 1000) : null;
    await this.db.insert(platformConnection).values({
      id: connectionId,
      tenantId: actor.tenantId,
      userId: actor.userId,
      platform: "meta_ads",
      credentialsEnc: this.cipher.encrypt({ accessToken: token }, credentialAad(actor.tenantId, connectionId)).enc,
      keyVersion: this.cipher.activeVersion,
      grantedScopes: info.scopes ?? [],
      externalUserId: info.user_id ?? null,
      expiresAt,
      status: "active",
    });
    await this.saveAccounts(actor.tenantId, connectionId, "meta_ads", access, accounts);
    await audit(this.db, { tenantId: actor.tenantId, userId: actor.userId, event: "connection.created", refId: connectionId, outcome: "meta_ads" });
    return { connectionId, accounts: accounts.length, skipped, access };
  }

  // ------------------------------------------------------------------ shared ----
  private async saveAccounts(tenantId: string, connectionId: string, platform: PlatformKey, access: Access, accounts: { externalId: string; displayName: string; loginCustomerId: string | null }[]) {
    for (const a of accounts) {
      // Reconnecting an account re-points it at the new connection but never silently widens its access level.
      await this.db
        .insert(connectedAccount)
        .values({ tenantId, connectionId, platform, externalId: a.externalId, displayName: a.displayName, loginCustomerId: a.loginCustomerId, access })
        .onConflictDoUpdate({
          target: [connectedAccount.tenantId, connectedAccount.platform, connectedAccount.externalId],
          set: { connectionId, displayName: a.displayName, loginCustomerId: a.loginCustomerId },
        });
    }
  }

  /** Revoke at the platform (best effort), then always wipe our copy and detach every account. */
  async disconnect(actor: Actor, connectionId: string): Promise<{ revokedAtPlatform: boolean }> {
    if (actor.role === "member") throw new ToolError("permission_denied", "Only owners and admins can disconnect accounts.");
    const [c] = await this.db
      .select()
      .from(platformConnection)
      .where(and(eq(platformConnection.id, connectionId), eq(platformConnection.tenantId, actor.tenantId)));
    if (!c) throw new ToolError("not_found", "No such connection.");

    let revoked = false;
    if (c.status !== "revoked") {
      try {
        const creds = this.cipher.decrypt<{ refreshToken?: string; accessToken?: string }>(c.credentialsEnc, credentialAad(actor.tenantId, connectionId));
        if (c.platform === "google_ads" && creds.refreshToken) {
          const r = await this.f("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: creds.refreshToken }), signal: AbortSignal.timeout(10_000) });
          revoked = r.ok;
        } else if (c.platform === "meta_ads" && creds.accessToken && this.cfg.meta) {
          const proof = createHmac("sha256", this.cfg.meta.appSecret).update(creds.accessToken).digest("hex");
          const r = await this.f(`https://graph.facebook.com/${this.cfg.meta.apiVersion}/me/permissions?${new URLSearchParams({ appsecret_proof: proof })}`, { method: "DELETE", headers: { authorization: `Bearer ${creds.accessToken}` }, signal: AbortSignal.timeout(10_000) });
          revoked = r.ok;
        }
      } catch {
        /* the platform may be unreachable or the token already dead: we still remove it from our side */
      }
    }
    await this.db.update(platformConnection).set({ status: "revoked", credentialsEnc: "revoked", revokedAt: this.now() }).where(eq(platformConnection.id, connectionId));
    await this.db.delete(connectedAccount).where(and(eq(connectedAccount.connectionId, connectionId), eq(connectedAccount.tenantId, actor.tenantId)));
    this.onRevoked?.(connectionId);
    await audit(this.db, { tenantId: actor.tenantId, userId: actor.userId, event: "connection.disconnected", refId: connectionId, outcome: revoked ? "revoked_at_platform" : "local_only" });
    return { revokedAtPlatform: revoked };
  }
}
