import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { appUser, oauthAccessToken, oauthAuthCode, oauthClient, oauthRefreshToken } from "../db/schema";
import { sha256 } from "../security/canonical";
import type { AuthContext, Authenticator, Role } from "./context";
import { bearerToken } from "./context";
import { assertSafeHttpsUrl, safeFetchJson } from "./ssrf";

/**
 * MCP-client OAuth: this server is the OAuth resource server AND authorization server for MCP clients
 * (Claude, ChatGPT, Cursor, ...). It is completely separate from the Google/Meta OAuth used to connect ad accounts.
 *
 * Implemented from the MCP authorization model of the 2025 revisions (RFC 9728 protected resource metadata,
 * RFC 8414 server metadata, PKCE S256 required, RFC 8707 resource binding, public clients, Client ID Metadata
 * Documents and RFC 7591 dynamic registration, rotating refresh tokens, no token passthrough). It has NOT been
 * checked against the latest published revision: the spec site was unreachable from the build environment.
 */

export const SCOPES_SUPPORTED = ["ads:read", "ads:write"] as const;
/** What a role may grant to an MCP client. Approval is never grantable to a client: only humans approve, in a browser session. */
export const roleScopes = (role: Role): string[] => (role === "member" ? ["ads:read"] : ["ads:read", "ads:write"]);

export const TTL = { code: 120_000, access: 3600_000, refresh: 30 * 24 * 3600_000, clientMetadata: 3600_000 } as const;
const BASE64URL = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * True when a Client ID Metadata Document allows public-client auth ("none"), which is all this server supports
 * (and all it advertises, so the client picks it). ChatGPT's document prefers private_key_jwt but lists "none" in
 * token_endpoint_auth_methods_supported. Documents that only allow confidential methods are refused.
 */
function supportsPublicAuth(doc: Record<string, unknown>): boolean {
  const method = doc.token_endpoint_auth_method;
  if (method === undefined || method === "none") return true;
  const supported = doc.token_endpoint_auth_methods_supported;
  return Array.isArray(supported) && supported.includes("none");
}

export class OAuthError extends Error {
  constructor(
    public error: "invalid_request" | "invalid_client" | "invalid_grant" | "unauthorized_client" | "unsupported_grant_type" | "invalid_scope" | "invalid_client_metadata" | "invalid_redirect_uri" | "server_error",
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const rand = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

// ---------------------------------------------------------------- redirect URIs ----
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORBIDDEN_SCHEMES = new Set(["javascript", "data", "vbscript", "file", "blob", "about", "ftp"]);

export function validateRedirectUri(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "is not a valid URL";
  }
  if (u.hash) return "must not contain a fragment";
  if (u.username || u.password) return "must not contain credentials";
  const scheme = u.protocol.slice(0, -1);
  if (scheme === "https") return null;
  if (scheme === "http") return LOOPBACK.has(u.hostname) ? null : "http is only allowed for loopback addresses";
  if (FORBIDDEN_SCHEMES.has(scheme)) return `scheme ${scheme}: is not allowed`;
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) ? null : "has an invalid scheme"; // private-use schemes for native apps (RFC 8252)
}

/** Exact match, except loopback redirects may vary their port (RFC 8252 section 7.3). */
export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (r.protocol !== "http:" || !LOOPBACK.has(r.hostname)) return false;
  return registered.some((x) => {
    try {
      const u = new URL(x);
      return u.protocol === "http:" && u.hostname === r.hostname && u.pathname === r.pathname && u.search === r.search;
    } catch {
      return false;
    }
  });
}

export interface ServerConfig {
  /** Canonical origin of this server, e.g. https://mcp.example.com (no trailing slash). Used as issuer. */
  issuer: string;
  /** Canonical MCP resource identifier (RFC 8707): the /mcp URL. Access tokens are bound to it. */
  resource: string;
}

export interface OAuthDeps {
  db: Db;
  config: ServerConfig;
  now?: () => Date;
  /** Injectable so tests never touch the network. */
  fetchClientMetadata?: (url: string) => Promise<unknown>;
}

export interface ClientInfo {
  clientId: string;
  name: string;
  redirectUris: string[];
}

export type AuthorizeCheck =
  | { kind: "page_error"; message: string }
  | { kind: "redirect_error"; redirectUri: string; error: string; description: string; state?: string }
  | { kind: "ok"; client: ClientInfo; redirectUri: string; scopes: string[]; codeChallenge: string; state?: string; resource: string };

export class OAuthServer {
  private now: () => Date;
  private fetchMeta: (url: string) => Promise<unknown>;

  constructor(private d: OAuthDeps) {
    this.now = d.now ?? (() => new Date());
    this.fetchMeta = d.fetchClientMetadata ?? ((u) => safeFetchJson(u));
  }

  // -------------------------------------------------------------- discovery ----
  protectedResourceMetadata() {
    return {
      resource: this.d.config.resource,
      authorization_servers: [this.d.config.issuer],
      scopes_supported: [...SCOPES_SUPPORTED],
      bearer_methods_supported: ["header"],
      resource_name: "ads-mcp",
    };
  }

  authorizationServerMetadata() {
    const i = this.d.config.issuer;
    return {
      issuer: i,
      authorization_endpoint: `${i}/authorize`,
      token_endpoint: `${i}/token`,
      registration_endpoint: `${i}/register`,
      revocation_endpoint: `${i}/revoke`,
      scopes_supported: [...SCOPES_SUPPORTED],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  // -------------------------------------------------------------- clients ----
  /** RFC 7591 dynamic registration for public clients. */
  async registerClient(body: unknown): Promise<Record<string, unknown>> {
    const b = (body ?? {}) as Record<string, unknown>;
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string")) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uris must be 1 to 10 strings");
    }
    for (const u of uris as string[]) {
      const problem = validateRedirectUri(u);
      if (problem) throw new OAuthError("invalid_redirect_uri", `redirect URI ${problem}`);
    }
    const method = b.token_endpoint_auth_method ?? "none";
    if (method !== "none") throw new OAuthError("invalid_client_metadata", "only public clients are supported (token_endpoint_auth_method must be none)");
    const grants = (b.grant_types as string[] | undefined) ?? ["authorization_code"];
    if (!Array.isArray(grants) || grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
      throw new OAuthError("invalid_client_metadata", "grant_types may only contain authorization_code and refresh_token");
    }
    const name = typeof b.client_name === "string" && b.client_name.trim() ? b.client_name.trim().slice(0, 100) : "MCP client";
    const clientId = rand("mcpc_");
    await this.d.db.insert(oauthClient).values({ clientId, name, redirectUris: uris as string[], source: "dcr", createdAt: this.now() });
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(this.now().getTime() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: grants,
      response_types: ["code"],
    };
  }

  /** Looks up a registered client, or fetches and caches a Client ID Metadata Document when client_id is an https URL. */
  async resolveClient(clientId: string): Promise<ClientInfo | null> {
    if (!clientId || clientId.length > 2048) return null;
    const [row] = await this.d.db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId));
    const isUrl = clientId.startsWith("https://");
    if (row && !(isUrl && row.source === "cimd" && (!row.fetchedAt || this.now().getTime() - row.fetchedAt.getTime() > TTL.clientMetadata))) {
      return { clientId: row.clientId, name: row.name, redirectUris: row.redirectUris };
    }
    if (!isUrl) return null;

    let doc: Record<string, unknown>;
    try {
      assertSafeHttpsUrl(clientId);
      doc = (await this.fetchMeta(clientId)) as Record<string, unknown>;
    } catch {
      return row ? { clientId: row.clientId, name: row.name, redirectUris: row.redirectUris } : null; // keep serving the last good copy
    }
    const uris = doc.redirect_uris;
    if (
      doc.client_id !== clientId || // the document must name itself exactly
      !Array.isArray(uris) || uris.length === 0 || uris.length > 10 ||
      !uris.every((u) => typeof u === "string" && validateRedirectUri(u) === null) ||
      !supportsPublicAuth(doc) ||
      "client_secret" in doc
    ) {
      return null;
    }
    const name = (typeof doc.client_name === "string" && doc.client_name.trim() ? doc.client_name.trim() : new URL(clientId).hostname).slice(0, 100);
    const now = this.now();
    await this.d.db
      .insert(oauthClient)
      .values({ clientId, name, redirectUris: uris as string[], source: "cimd", fetchedAt: now, createdAt: now })
      .onConflictDoUpdate({ target: oauthClient.clientId, set: { name, redirectUris: uris as string[], fetchedAt: now } });
    return { clientId, name, redirectUris: uris as string[] };
  }

  // -------------------------------------------------------------- authorize ----
  /**
   * Validates an authorization request. Errors found BEFORE the redirect URI is trusted are shown to the user on a
   * page (never redirected); errors after are sent back to the client's redirect URI.
   */
  async checkAuthorize(q: URLSearchParams): Promise<AuthorizeCheck> {
    const client = await this.resolveClient(q.get("client_id") ?? "");
    if (!client) return { kind: "page_error", message: "Unknown or invalid client." };
    const redirectUri = q.get("redirect_uri");
    if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
      return { kind: "page_error", message: "The redirect URI does not match this client's registration." };
    }
    const state = q.get("state") ?? undefined;
    const fail = (error: string, description: string): AuthorizeCheck => ({ kind: "redirect_error", redirectUri, error, description, state });

    if (q.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
    const challenge = q.get("code_challenge");
    if (!challenge || !BASE64URL.test(challenge)) return fail("invalid_request", "a valid PKCE code_challenge is required");
    if (q.get("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");

    const resource = q.get("resource");
    if (resource && resource !== this.d.config.resource) return fail("invalid_target", "resource does not identify this server");

    const requested = (q.get("scope") ?? "").split(/\s+/).filter(Boolean);
    if (requested.some((s) => !(SCOPES_SUPPORTED as readonly string[]).includes(s))) return fail("invalid_scope", "unknown scope requested");
    const scopes = requested.length ? [...new Set(requested)] : ["ads:read"];
    return { kind: "ok", client, redirectUri, scopes, codeChallenge: challenge, state, resource: this.d.config.resource };
  }

  /** Called only after the logged-in user approved. Scopes are cut down to what the user's role allows. */
  async issueCode(o: { client: ClientInfo; redirectUri: string; codeChallenge: string; scopes: string[]; user: { id: string; tenantId: string; role: Role } }): Promise<{ code: string; scopes: string[] }> {
    const allowed = roleScopes(o.user.role);
    const scopes = o.scopes.filter((s) => allowed.includes(s));
    if (scopes.length === 0) throw new OAuthError("invalid_scope", "your role does not permit the requested access");
    const code = rand("mcpac_");
    await this.d.db.insert(oauthAuthCode).values({
      codeHash: sha256(code),
      clientId: o.client.clientId,
      tenantId: o.user.tenantId,
      userId: o.user.id,
      redirectUri: o.redirectUri,
      codeChallenge: o.codeChallenge,
      scopes,
      resource: this.d.config.resource,
      expiresAt: new Date(this.now().getTime() + TTL.code),
      createdAt: this.now(),
    });
    return { code, scopes };
  }

  // -------------------------------------------------------------- token ----
  async token(p: URLSearchParams): Promise<Record<string, unknown>> {
    const grant = p.get("grant_type");
    if (grant === "authorization_code") return this.exchangeCode(p);
    if (grant === "refresh_token") return this.refresh(p);
    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }

  private async exchangeCode(p: URLSearchParams) {
    const code = p.get("code");
    const verifier = p.get("code_verifier");
    const clientId = p.get("client_id");
    const redirectUri = p.get("redirect_uri");
    if (!code || !verifier || !clientId || !redirectUri) throw new OAuthError("invalid_request", "code, code_verifier, client_id and redirect_uri are required");
    if (!BASE64URL.test(verifier)) throw new OAuthError("invalid_grant", "invalid code_verifier");
    const resource = p.get("resource");
    if (resource && resource !== this.d.config.resource) throw new OAuthError("invalid_grant", "resource does not identify this server");

    const codeHash = sha256(code);
    const [row] = await this.d.db.select().from(oauthAuthCode).where(eq(oauthAuthCode.codeHash, codeHash));
    if (!row) throw new OAuthError("invalid_grant", "invalid or expired code");
    if (row.usedAt) {
      // A code presented twice means it leaked: revoke everything issued from it.
      await this.revokeFamily(codeHash);
      throw new OAuthError("invalid_grant", "authorization code already used");
    }
    if (row.expiresAt <= this.now()) throw new OAuthError("invalid_grant", "invalid or expired code");
    if (row.clientId !== clientId || row.redirectUri !== redirectUri) throw new OAuthError("invalid_grant", "code was not issued to this client or redirect URI");

    const computed = createHash("sha256").update(verifier).digest("base64url");
    const a = Buffer.from(computed);
    const b = Buffer.from(row.codeChallenge);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OAuthError("invalid_grant", "PKCE verification failed");

    // Single use, claimed atomically.
    const [claimed] = await this.d.db
      .update(oauthAuthCode)
      .set({ usedAt: this.now() })
      .where(and(eq(oauthAuthCode.codeHash, codeHash), isNull(oauthAuthCode.usedAt)))
      .returning({ codeHash: oauthAuthCode.codeHash });
    if (!claimed) {
      await this.revokeFamily(codeHash);
      throw new OAuthError("invalid_grant", "authorization code already used");
    }

    const user = await this.currentUser(row.userId);
    if (!user) throw new OAuthError("invalid_grant", "user no longer exists");
    const scopes = row.scopes.filter((s) => roleScopes(user.role).includes(s));
    return this.issueTokens({ familyId: codeHash, clientId, tenantId: row.tenantId, userId: row.userId, scopes, resource: row.resource });
  }

  private async refresh(p: URLSearchParams) {
    const raw = p.get("refresh_token");
    const clientId = p.get("client_id");
    if (!raw || !clientId) throw new OAuthError("invalid_request", "refresh_token and client_id are required");
    const [row] = await this.d.db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.tokenHash, sha256(raw)));
    if (!row || row.clientId !== clientId) throw new OAuthError("invalid_grant", "invalid refresh token");
    if (row.revokedAt) throw new OAuthError("invalid_grant", "refresh token revoked");
    if (row.usedAt) {
      await this.revokeFamily(row.familyId); // reuse of a rotated token: assume theft, kill the whole chain
      throw new OAuthError("invalid_grant", "refresh token already used");
    }
    if (row.expiresAt <= this.now()) throw new OAuthError("invalid_grant", "refresh token expired");

    const requested = (p.get("scope") ?? "").split(/\s+/).filter(Boolean);
    if (requested.some((s) => !row.scopes.includes(s))) throw new OAuthError("invalid_scope", "cannot widen scope on refresh");

    const [claimed] = await this.d.db
      .update(oauthRefreshToken)
      .set({ usedAt: this.now() })
      .where(and(eq(oauthRefreshToken.id, row.id), isNull(oauthRefreshToken.usedAt), isNull(oauthRefreshToken.revokedAt)))
      .returning({ id: oauthRefreshToken.id });
    if (!claimed) {
      await this.revokeFamily(row.familyId);
      throw new OAuthError("invalid_grant", "refresh token already used");
    }
    const user = await this.currentUser(row.userId);
    if (!user) throw new OAuthError("invalid_grant", "user no longer exists");
    const base = requested.length ? requested : row.scopes;
    return this.issueTokens({ familyId: row.familyId, clientId, tenantId: row.tenantId, userId: row.userId, scopes: base.filter((s) => roleScopes(user.role).includes(s)), resource: row.resource });
  }

  private async currentUser(userId: string) {
    const [u] = await this.d.db.select({ id: appUser.id, role: appUser.role }).from(appUser).where(eq(appUser.id, userId));
    return u ? { id: u.id, role: u.role as Role } : null;
  }

  private async issueTokens(o: { familyId: string; clientId: string; tenantId: string; userId: string; scopes: string[]; resource: string }) {
    const now = this.now();
    const access = rand("mcpat_");
    const refresh = rand("mcprt_");
    await this.d.db.insert(oauthAccessToken).values({ tokenHash: sha256(access), ...o, expiresAt: new Date(now.getTime() + TTL.access), createdAt: now });
    await this.d.db.insert(oauthRefreshToken).values({ tokenHash: sha256(refresh), ...o, expiresAt: new Date(now.getTime() + TTL.refresh), createdAt: now });
    return { access_token: access, token_type: "Bearer", expires_in: TTL.access / 1000, refresh_token: refresh, scope: o.scopes.join(" ") };
  }

  private async revokeFamily(familyId: string) {
    const now = this.now();
    await this.d.db.update(oauthAccessToken).set({ revokedAt: now }).where(and(eq(oauthAccessToken.familyId, familyId), isNull(oauthAccessToken.revokedAt)));
    await this.d.db.update(oauthRefreshToken).set({ revokedAt: now }).where(and(eq(oauthRefreshToken.familyId, familyId), isNull(oauthRefreshToken.revokedAt)));
  }

  /** RFC 7009. Always succeeds from the caller's point of view. Revoking a refresh token revokes its whole family. */
  async revoke(token: string, clientId: string | null) {
    const h = sha256(token);
    const [rt] = await this.d.db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.tokenHash, h));
    if (rt && (!clientId || rt.clientId === clientId)) return this.revokeFamily(rt.familyId);
    const [at] = await this.d.db.select().from(oauthAccessToken).where(eq(oauthAccessToken.tokenHash, h));
    if (at && (!clientId || at.clientId === clientId)) await this.d.db.update(oauthAccessToken).set({ revokedAt: this.now() }).where(eq(oauthAccessToken.id, at.id));
  }

  /** Revoke every grant a user has given to MCP clients (used on disconnect / offboarding). */
  async revokeAllForUser(userId: string) {
    const now = this.now();
    await this.d.db.update(oauthAccessToken).set({ revokedAt: now }).where(and(eq(oauthAccessToken.userId, userId), isNull(oauthAccessToken.revokedAt)));
    await this.d.db.update(oauthRefreshToken).set({ revokedAt: now }).where(and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revokedAt)));
  }

  // -------------------------------------------------------------- resource server ----
  /** Validates an access token for THIS resource. Tokens issued for any other audience are refused (no token passthrough). */
  async validateAccessToken(token: string): Promise<AuthContext | null> {
    const [row] = await this.d.db.select().from(oauthAccessToken).where(eq(oauthAccessToken.tokenHash, sha256(token)));
    if (!row || row.revokedAt || row.expiresAt <= this.now() || row.resource !== this.d.config.resource) return null;
    const user = await this.currentUser(row.userId);
    if (!user) return null;
    return { tenantId: row.tenantId, userId: row.userId, role: user.role, scopes: row.scopes.filter((s) => roleScopes(user.role).includes(s)), tokenId: row.id };
  }
}

/** Accepts either an OAuth access token (mcpat_) or a personal API token (adsmcp_). */
export class CompositeAuthenticator implements Authenticator {
  constructor(
    private oauth: OAuthServer,
    private pat: Authenticator,
  ) {}
  async authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthContext | null> {
    const tok = bearerToken(headers);
    if (!tok) return null;
    if (tok.startsWith("mcpat_")) return this.oauth.validateAccessToken(tok);
    return this.pat.authenticate(headers);
  }
}
