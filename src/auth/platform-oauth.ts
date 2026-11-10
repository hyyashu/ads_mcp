import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../db";
import { connectedAccount, platformConnection, platformOauthState } from "../db/schema";
import { ToolError } from "../mcp/errors";
import { discoverGa4Properties } from "../platforms/ga4/client";
import { GoogleApiClient } from "../platforms/gapi/client";
import type { Discovery } from "../platforms/gapi/discovery";
import { GoogleApiHttp } from "../platforms/gapi/http";
import { PRODUCT_SCOPES, type ProductPlatform } from "../platforms/gapi/scopes";
import { GoogleAdsHttp } from "../platforms/google/http";
import { discoverGscSites } from "../platforms/gsc/client";
import { discoverGtmContainers } from "../platforms/gtm/client";
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
  // pages_manage_ads: creating ads for a Page (Ad Account promote_pages reference). Connections made before it was added must reconnect.
  write: ["ads_read", "ads_management", "business_management", "pages_show_list", "pages_read_engagement", "pages_manage_ads", "catalog_management", "instagram_basic", "leads_retrieval"],
} as const;

export type Access = "read" | "write";
export type PlatformKey = "google_ads" | "meta_ads" | ProductPlatform;

/**
 * Search Console, GA4 and Tag Manager: each its own Connect button and its own Google grant (own refresh token and
 * platform_connection) on the same Google OAuth client as Ads. No include_granted_scopes, so disconnecting one product
 * never affects another, and each grant asks only for its product's scopes.
 */
const PRODUCTS: Record<ProductPlatform, { slug: string; label: string; discover: (api: GoogleApiClient) => Promise<Discovery> }> = {
  google_search_console: { slug: "gsc", label: "Search Console", discover: discoverGscSites },
  google_analytics: { slug: "ga4", label: "Google Analytics", discover: discoverGa4Properties },
  google_tag_manager: { slug: "gtm", label: "Tag Manager", discover: discoverGtmContainers },
};
export const isProduct = (p: string): p is ProductPlatform => Object.hasOwn(PRODUCTS, p);
/** URL slug of each platform's /connect/{slug}/start and /callback routes. */
export const CONNECT_SLUGS: Record<PlatformKey, string> = { google_ads: "google", meta_ads: "meta", google_search_console: "gsc", google_analytics: "ga4", google_tag_manager: "gtm" };
/** Names shown on the Connections page. */
export const PLATFORM_LABELS: Record<PlatformKey, string> = { google_ads: "Google Ads", meta_ads: "Meta Ads", google_search_console: "Search Console", google_analytics: "Google Analytics", google_tag_manager: "Tag Manager" };
const STATE_TTL_MS = 10 * 60_000;
const MAX_ACCOUNTS = 500;
/** Meta ad account fields read at connect time. `currency` and `timezone_name` are the reporting units of every insight. */
const META_ACCOUNT_FIELDS = "account_id,name,account_status,currency,timezone_name";

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
    return platform === "meta_ads" ? !!this.cfg.meta : !!this.cfg.google;
  }

  private redirectUri(platform: PlatformKey) {
    return `${this.cfg.publicUrl}/connect/${CONNECT_SLUGS[platform]}/callback`;
  }

  private assertCanConnect(actor: Actor, access: Access) {
    if (actor.role === "member") throw new ToolError("permission_denied", "Only owners and admins can connect ad accounts.");
    if (access === "write" && actor.role !== "owner" && actor.role !== "admin") throw new ToolError("permission_denied", "Only owners and admins can grant write access.");
  }

  /** Creates single-use state (bound to this user) and returns the URL to send the browser to. */
  async start(platform: PlatformKey, actor: Actor, access: Access): Promise<string> {
    if (!this.enabled(platform)) throw new ToolError("unsupported", `${platform === "meta_ads" ? "Meta" : "Google"} connections are not configured on this server.`);
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

    if (platform !== "meta_ads") {
      const g = this.cfg.google!;
      const scopes = platform === "google_ads" ? [GOOGLE_ADS_SCOPE] : PRODUCT_SCOPES[platform][access];
      const q = new URLSearchParams({
        client_id: g.clientId,
        redirect_uri: this.redirectUri(platform),
        response_type: "code",
        scope: `${scopes.join(" ")} openid email`,
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
    if (platform === "meta_ads") return this.finishMeta(actor, code, access);
    return platform === "google_ads" ? this.finishGoogle(actor, code, verifier, access) : this.finishGoogleProduct(platform, actor, code, verifier, access);
  }

  // ------------------------------------------------------------------ Google ----
  /**
   * Authorization code -> tokens, shared by every Google connection. Google may grant fewer scopes than requested (the
   * consent screen lets users untick them), so `granted` is the token response's own `scope` list, never the request.
   */
  private async googleTokens(platform: PlatformKey, code: string, verifier: string) {
    const g = this.cfg.google!;
    const res = await this.f("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: this.redirectUri(platform), grant_type: "authorization_code", code_verifier: verifier }),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; id_token?: string };
    if (!res.ok || !tok.access_token) throw new ToolError("permission_denied", "Google did not accept the authorization. Start again.");
    if (!tok.refresh_token) throw new ToolError("invalid_argument", "Google did not return a refresh token. Remove this app's access in your Google account settings, then connect again.");
    const granted = (tok.scope ?? "").split(" ").filter(Boolean);
    // The id_token arrives straight from Google's token endpoint over TLS, so reading its email claim is safe for display.
    let email: string | undefined;
    try {
      email = JSON.parse(Buffer.from((tok.id_token ?? "").split(".")[1] ?? "", "base64url").toString("utf8")).email;
    } catch {
      /* optional */
    }
    return { accessToken: tok.access_token, refreshToken: tok.refresh_token, granted, email };
  }

  private async saveGoogleConnection(actor: Actor, platform: PlatformKey, t: { refreshToken: string; granted: string[]; email?: string }, access: Access, accounts: Parameters<PlatformOAuth["saveAccounts"]>[4]) {
    const connectionId = randomUUID();
    await this.db.insert(platformConnection).values({
      id: connectionId,
      tenantId: actor.tenantId,
      userId: actor.userId,
      platform,
      credentialsEnc: this.cipher.encrypt({ refreshToken: t.refreshToken }, credentialAad(actor.tenantId, connectionId)).enc,
      keyVersion: this.cipher.activeVersion,
      grantedScopes: t.granted,
      externalUserId: t.email ?? null,
      status: "active",
    });
    await this.saveAccounts(actor.tenantId, connectionId, platform, access, accounts);
    await audit(this.db, { tenantId: actor.tenantId, userId: actor.userId, event: "connection.created", refId: connectionId, outcome: platform });
    return connectionId;
  }

  /**
   * Search Console, GA4 or Tag Manager. Every scope the chosen access level needs must have been granted (checked on the
   * token response, as for Ads); then discovery lists the sites, properties or containers before anything is stored, so a
   * failed discovery leaves no half connection behind.
   */
  private async finishGoogleProduct(platform: ProductPlatform, actor: Actor, code: string, verifier: string, access: Access): Promise<FinishResult> {
    const t = await this.googleTokens(platform, code, verifier);
    const missing = PRODUCT_SCOPES[platform][access].filter((sc) => !t.granted.includes(sc));
    if (missing.length) throw new ToolError("permission_denied", `The ${PRODUCTS[platform].label} permission${missing.length > 1 ? "s were" : " was"} not granted (${missing.map((m) => m.replace("https://www.googleapis.com/auth/", "")).join(", ")}). Connect again and allow ${missing.length > 1 ? "them" : "it"}.`);
    const api = new GoogleApiClient({ http: new GoogleApiHttp({ fetch: this.f }), getAccessToken: async () => t.accessToken, signal: AbortSignal.timeout(60_000) });
    const found = await PRODUCTS[platform].discover(api);
    const connectionId = await this.saveGoogleConnection(actor, platform, t, access, found.accounts);
    return { connectionId, accounts: found.accounts.length, skipped: found.skipped, access };
  }

  private async finishGoogle(actor: Actor, code: string, verifier: string, access: Access): Promise<FinishResult> {
    const g = this.cfg.google!;
    const t = await this.googleTokens("google_ads", code, verifier);
    if (!t.granted.includes(GOOGLE_ADS_SCOPE)) throw new ToolError("permission_denied", "The Google Ads permission was not granted.");

    const http = new GoogleAdsHttp({ apiVersion: g.apiVersion, fetch: this.f });
    const discovered = await this.discoverGoogleAccounts(http, t.accessToken);
    const connectionId = await this.saveGoogleConnection(actor, "google_ads", t, access, discovered.accounts);
    return { connectionId, accounts: discovered.accounts.length, skipped: discovered.skipped, access };
  }

  /** Accounts the user can reach directly, plus every non-manager client below any manager account. */
  private async discoverGoogleAccounts(http: GoogleAdsHttp, accessToken: string) {
    const list = await http.call<{ resourceNames?: string[] }>({ accessToken, path: "customers:listAccessibleCustomers", method: "GET", idempotent: true });
    const roots = (list.resourceNames ?? []).map((r) => r.replace("customers/", ""));
    const out = new Map<string, { externalId: string; displayName: string; loginCustomerId: string | null; currencyCode: string | null; timeZone: string | null }>();
    let skipped = 0;

    for (const id of roots) {
      try {
        const rows = await this.gaql(http, accessToken, id, null, "SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code, customer.time_zone FROM customer LIMIT 1");
        const me = rows[0]?.customer as { descriptiveName?: string; manager?: boolean; currencyCode?: string; timeZone?: string } | undefined;
        if (!me?.manager) {
          out.set(id, { externalId: id, displayName: me?.descriptiveName ?? "", loginCustomerId: null, currencyCode: me?.currencyCode ?? null, timeZone: me?.timeZone ?? null });
          continue;
        }
        const kids = await this.gaql(
          http,
          accessToken,
          id,
          id,
          "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.currency_code, customer_client.time_zone FROM customer_client WHERE customer_client.level > 0 AND customer_client.status = 'ENABLED' AND customer_client.hidden = FALSE",
        );
        for (const k of kids) {
          const c = k.customerClient as { id?: string; descriptiveName?: string; manager?: boolean; currencyCode?: string; timeZone?: string };
          if (c?.id && !c.manager && !out.has(c.id)) {
            out.set(c.id, { externalId: c.id, displayName: c.descriptiveName ?? "", loginCustomerId: id, currencyCode: c.currencyCode ?? null, timeZone: c.timeZone ?? null });
          }
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

    const accounts: { externalId: string; displayName: string; loginCustomerId: null; currencyCode: string | null; timeZone: string | null }[] = [];
    let skipped = 0;
    let next: string | null = "me/adaccounts";
    let params: Record<string, string> = { fields: META_ACCOUNT_FIELDS, limit: "100" };
    while (next && accounts.length < MAX_ACCOUNTS) {
      const page = await get(next, params);
      if (!page.ok) throw new ToolError("permission_denied", "Meta would not list your ad accounts.");
      for (const a of (page.body.data ?? []) as { account_id: string; name?: string; account_status?: number; currency?: string; timezone_name?: string }[]) {
        if (a.account_status === 1) {
          accounts.push({ externalId: `act_${a.account_id}`, displayName: a.name ?? "", loginCustomerId: null, currencyCode: a.currency ?? null, timeZone: a.timezone_name ?? null });
        }
        else skipped++; // disabled / unsettled / closed accounts
      }
      const after = page.body.paging?.cursors?.after as string | undefined;
      next = page.body.paging?.next && after ? "me/adaccounts" : null;
      params = { fields: META_ACCOUNT_FIELDS, limit: "100", ...(after ? { after } : {}) };
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
  private async saveAccounts(tenantId: string, connectionId: string, platform: PlatformKey, access: Access, accounts: { externalId: string; displayName: string; loginCustomerId: string | null; currencyCode: string | null; timeZone: string | null }[]) {
    for (const a of accounts) {
      // Reconnecting an account re-points it at the new connection but never silently widens its access level.
      await this.db
        .insert(connectedAccount)
        .values({ tenantId, connectionId, platform, externalId: a.externalId, displayName: a.displayName, loginCustomerId: a.loginCustomerId, access, currencyCode: a.currencyCode, timeZone: a.timeZone })
        .onConflictDoUpdate({
          target: [connectedAccount.tenantId, connectedAccount.platform, connectedAccount.externalId],
          // Units refresh on reconnect; a value the platform did not report this time keeps what we had.
          set: {
            connectionId,
            displayName: a.displayName,
            loginCustomerId: a.loginCustomerId,
            currencyCode: sql`coalesce(excluded.currency_code, ${connectedAccount.currencyCode})`,
            timeZone: sql`coalesce(excluded.time_zone, ${connectedAccount.timeZone})`,
          },
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
        // Every Google connection (Ads, Search Console, GA4, Tag Manager) is its own grant: revoking its refresh token ends
        // only that grant (no include_granted_scopes, so the others are untouched).
        if ((c.platform === "google_ads" || isProduct(c.platform)) && creds.refreshToken) {
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
