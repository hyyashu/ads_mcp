import type { IncomingMessage, ServerResponse } from "node:http";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Role } from "../auth/context";
import { OAuthError, type OAuthServer } from "../auth/oauth-server";
import { verifyPassword } from "../auth/passwords";
import type { PlatformKey, PlatformOAuth } from "../auth/platform-oauth";
import { clearCookie, createSession, csrfToken, destroySession, getSession, sessionCookie, verifyCsrf, type WebSession } from "../auth/web-session";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { appUser, approvalRequest, connectedAccount, platformConnection } from "../db/schema";
import { ToolError } from "../mcp/errors";
import { type PipelineDeps, createExecutor } from "../mcp/pipeline";
import { audit } from "../security/audit";
import type { ApprovalService } from "../security/approvals";
import type { Limiter } from "../security/rate-limit";
import { logger } from "../obs/logger";
import { SECURITY_HEADERS, esc, flash, hidden, page } from "./html";

export interface WebDeps {
  db: Db;
  config: AppConfig;
  oauth: OAuthServer;
  platform: PlatformOAuth | null;
  approvals: ApprovalService;
  pipeline: PipelineDeps;
  /** login: per IP+email. loginAccount: per email across all IPs, so rotating addresses does not reset an account's budget. */
  limiters: { login: Limiter; loginAccount: Limiter; register: Limiter; token: Limiter };
}

const PUBLIC_CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version", "access-control-max-age": "600" };
const CORS_PATHS = new Set(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/register", "/token", "/revoke"]);
const PLATFORM_BY_SLUG: Record<string, PlatformKey> = { google: "google_ads", meta: "meta_ads" };

async function readText(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new ToolError("invalid_argument", "Request body too large.");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class WebRoutes {
  constructor(private d: WebDeps) {}

  // ----------------------------------------------------------------- helpers ----
  private ip(req: IncomingMessage): string {
    if (this.d.config.trustProxy) {
      const f = req.headers["x-forwarded-for"];
      const first = (Array.isArray(f) ? f[0] : f)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  private html(res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...headers });
    res.end(JSON.stringify(body));
  }

  private redirect(res: ServerResponse, location: string, cookie?: string) {
    res.writeHead(303, { location, "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) });
    res.end();
  }

  /** Browsers always send Origin on form POSTs. Anything else (or a foreign origin) is refused. */
  private sameOrigin(req: IncomingMessage): boolean {
    return req.headers.origin === this.d.config.issuer;
  }

  private safeNext(next: string | null | undefined): string {
    return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
  }

  private nav(role: Role) {
    return `<p class="muted"><a href="/connections">Connections</a> · <a href="/approvals">Approvals</a> · signed in as ${esc(role)} · <form method="post" action="/logout" style="display:inline">${"{LOGOUT}"}<button>Sign out</button></form></p>`;
  }

  private navFor(s: WebSession) {
    return this.nav(s.role).replace("{LOGOUT}", hidden("csrf", csrfToken(s, "logout")));
  }

  private async session(req: IncomingMessage): Promise<WebSession | null> {
    return getSession(this.d.db, req.headers.cookie);
  }

  private async readForm(req: IncomingMessage) {
    return new URLSearchParams(await readText(req, 20_000));
  }

  // ----------------------------------------------------------------- router ----
  /** Returns true when the request was handled here. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (CORS_PATHS.has(path)) {
      if (method === "OPTIONS") {
        res.writeHead(204, PUBLIC_CORS);
        res.end();
        return true;
      }
    }

    // ---- discovery ----
    if ((path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") && method === "GET") {
      this.json(res, 200, this.d.oauth.protectedResourceMetadata(), PUBLIC_CORS);
      return true;
    }
    if (path === "/.well-known/oauth-authorization-server" && method === "GET") {
      this.json(res, 200, this.d.oauth.authorizationServerMetadata(), PUBLIC_CORS);
      return true;
    }

    // ---- OAuth for MCP clients ----
    if (path === "/register" && method === "POST") return this.register(req, res);
    if (path === "/token" && method === "POST") return this.token(req, res);
    if (path === "/revoke" && method === "POST") return this.revoke(req, res);
    if (path === "/authorize") return this.authorize(req, res, url);

    // ---- human web pages ----
    if (path === "/login") return this.login(req, res, url);
    if (path === "/logout" && method === "POST") return this.logout(req, res);
    if (path === "/approvals" && method === "GET") return this.approvalsPage(req, res, url);
    const dec = path.match(/^\/approvals\/([\w-]+)\/decision$/);
    if (dec && method === "POST") return this.decide(req, res, dec[1]!);
    if (path === "/connections" && method === "GET") return this.connectionsPage(req, res, url);
    const start = path.match(/^\/connect\/(google|meta)\/start$/);
    if (start && method === "POST") return this.connectStart(req, res, PLATFORM_BY_SLUG[start[1]!]!);
    const cb = path.match(/^\/connect\/(google|meta)\/callback$/);
    if (cb && method === "GET") return this.connectCallback(req, res, url, PLATFORM_BY_SLUG[cb[1]!]!);
    const disc = path.match(/^\/connections\/([\w-]+)\/disconnect$/);
    if (disc && method === "POST") return this.disconnect(req, res, disc[1]!);
    if (path === "/" && method === "GET") {
      const s = await this.session(req);
      this.html(res, 200, page("ads-mcp", `<p>MCP endpoint: <code>${esc(this.d.config.resource)}</code></p>${s ? "" : `<p><a href="/login">Sign in</a></p>`}`, s ? this.navFor(s) : ""));
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ OAuth endpoints ----
  private async register(req: IncomingMessage, res: ServerResponse) {
    const lim = await this.d.limiters.register.take(this.ip(req));
    if (!lim.ok) return this.oauthError(res, new OAuthError("invalid_request", "too many registrations", 429), { "retry-after": String(lim.retryAfterSeconds) });
    try {
      const text = await readText(req, 20_000);
      const out = await this.d.oauth.registerClient(text ? JSON.parse(text) : {});
      this.json(res, 201, out, PUBLIC_CORS);
    } catch (e) {
      if (e instanceof SyntaxError) this.oauthError(res, new OAuthError("invalid_client_metadata", "invalid JSON"));
      else this.oauthError(res, e);
    }
    return true;
  }

  private oauthError(res: ServerResponse, e: unknown, extra: Record<string, string> = {}) {
    if (e instanceof OAuthError) this.json(res, e.status, { error: e.error, error_description: e.message }, { ...PUBLIC_CORS, ...extra });
    else if (e instanceof ToolError) this.json(res, 400, { error: "invalid_request", error_description: e.message }, { ...PUBLIC_CORS, ...extra });
    else {
      logger.error("oauth.unhandled", { error: e });
      this.json(res, 500, { error: "server_error" }, { ...PUBLIC_CORS, ...extra });
    }
    return true;
  }

  private async token(req: IncomingMessage, res: ServerResponse) {
    const lim = await this.d.limiters.token.take(this.ip(req));
    if (!lim.ok) return this.oauthError(res, new OAuthError("invalid_request", "rate limited", 429), { "retry-after": String(lim.retryAfterSeconds) });
    try {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) throw new OAuthError("invalid_request", "content-type must be application/x-www-form-urlencoded");
      this.json(res, 200, await this.d.oauth.token(await this.readForm(req)), PUBLIC_CORS);
    } catch (e) {
      this.oauthError(res, e);
    }
    return true;
  }

  private async revoke(req: IncomingMessage, res: ServerResponse) {
    try {
      const p = await this.readForm(req);
      const token = p.get("token");
      if (token) await this.d.oauth.revoke(token, p.get("client_id"));
      this.json(res, 200, {}, PUBLIC_CORS);
    } catch (e) {
      this.oauthError(res, e);
    }
    return true;
  }

  // ------------------------------------------------------------ authorize + consent ----
  private async authorize(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? "GET";
    const s = await this.session(req);

    if (method === "GET") {
      if (!s) {
        this.redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
        return true;
      }
      const check = await this.d.oauth.checkAuthorize(url.searchParams);
      if (check.kind === "page_error") {
        this.html(res, 400, page("Cannot continue", flash(check.message, true)));
        return true;
      }
      if (check.kind === "redirect_error") {
        this.redirect(res, this.errorRedirect(check.redirectUri, check.error, check.description, check.state));
        return true;
      }
      const params = url.searchParams;
      const host = (() => {
        try {
          return new URL(check.redirectUri).host || new URL(check.redirectUri).protocol;
        } catch {
          return check.redirectUri;
        }
      })();
      const canWrite = s.role !== "member";
      const scopeText = check.scopes.map((x) => (x === "ads:read" ? "Read your connected ad accounts" : "Propose changes (every change still needs your approval)")).filter((_, i) => canWrite || check.scopes[i] === "ads:read");
      this.html(
        res,
        200,
        page(
          "Authorize access",
          `<div class="card"><p><strong>${esc(check.client.name)}</strong> wants to connect to your ads workspace.</p>
<p class="muted">It will be sent back to <code>${esc(host)}</code>. Only continue if you started this from that app.</p>
<ul>${scopeText.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
<p class="muted">It can never approve changes. Approvals happen only here, in your browser.</p>
<form method="post" action="/authorize">
${["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"].map((k) => (params.get(k) !== null ? hidden(k, params.get(k)!) : "")).join("")}
${hidden("csrf", csrfToken(s, "consent"))}
<div class="row"><button class="primary" name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></div></form></div>`,
          this.navFor(s),
        ),
      );
      return true;
    }

    if (method === "POST") {
      if (!this.sameOrigin(req)) {
        this.html(res, 403, page("Refused", flash("Cross-site request blocked.", true)));
        return true;
      }
      if (!s) {
        this.html(res, 401, page("Sign in required", flash("Your session expired. Start again from the app.", true)));
        return true;
      }
      const form = await this.readForm(req);
      if (!verifyCsrf(s, "consent", form.get("csrf") ?? undefined)) {
        this.html(res, 403, page("Refused", flash("Invalid form token. Go back and try again.", true)));
        return true;
      }
      // Never trust the hidden fields: validate the whole request again.
      const check = await this.d.oauth.checkAuthorize(form);
      if (check.kind === "page_error") {
        this.html(res, 400, page("Cannot continue", flash(check.message, true)));
        return true;
      }
      if (check.kind === "redirect_error") {
        this.redirect(res, this.errorRedirect(check.redirectUri, check.error, check.description, check.state));
        return true;
      }
      if (form.get("decision") !== "allow") {
        this.redirect(res, this.errorRedirect(check.redirectUri, "access_denied", "The user denied the request", check.state));
        return true;
      }
      try {
        const { code } = await this.d.oauth.issueCode({ client: check.client, redirectUri: check.redirectUri, codeChallenge: check.codeChallenge, scopes: check.scopes, user: { id: s.userId, tenantId: s.tenantId, role: s.role } });
        await audit(this.d.db, { tenantId: s.tenantId, userId: s.userId, event: "oauth.consent", refId: check.client.clientId, outcome: "granted" });
        const target = new URL(check.redirectUri);
        target.searchParams.set("code", code);
        if (check.state) target.searchParams.set("state", check.state);
        target.searchParams.set("iss", this.d.config.issuer);
        this.redirect(res, target.toString());
      } catch (e) {
        const err = e instanceof OAuthError ? e : new OAuthError("server_error", "failed");
        this.redirect(res, this.errorRedirect(check.redirectUri, err.error, err.message, check.state));
      }
      return true;
    }
    return false;
  }

  private errorRedirect(redirectUri: string, error: string, description: string, state?: string) {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    u.searchParams.set("iss", this.d.config.issuer);
    return u.toString();
  }

  // ------------------------------------------------------------------- login ----
  private async login(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? "GET";
    if (method === "GET") {
      const next = this.safeNext(url.searchParams.get("next"));
      this.html(res, 200, page("Sign in", `${flash(url.searchParams.get("error"), true)}<form method="post" action="/login">${hidden("next", next)}<label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">Sign in</button></form>`));
      return true;
    }
    if (method !== "POST") return false;
    if (!this.sameOrigin(req)) {
      this.html(res, 403, page("Refused", flash("Cross-site request blocked.", true)));
      return true;
    }
    const form = await this.readForm(req);
    const email = (form.get("email") ?? "").trim().toLowerCase();
    const next = this.safeNext(form.get("next"));
    const perIp = await this.d.limiters.login.take(`${this.ip(req)}|${email}`);
    const perAccount = perIp.ok ? await this.d.limiters.loginAccount.take(email) : perIp;
    const lim = perIp.ok ? perAccount : perIp;
    if (!lim.ok) {
      this.html(res, 429, page("Too many attempts", flash(`Try again in ${lim.retryAfterSeconds} seconds.`, true)), { "retry-after": String(lim.retryAfterSeconds) });
      return true;
    }
    const [user] = await this.d.db.select().from(appUser).where(eq(appUser.email, email));
    const ok = await verifyPassword(form.get("password") ?? "", user?.passwordHash ?? null);
    if (!user || !ok) {
      this.redirect(res, `/login?error=${encodeURIComponent("Wrong email or password.")}&next=${encodeURIComponent(next)}`);
      return true;
    }
    const { token, maxAgeSeconds } = await createSession(this.d.db, { tenantId: user.tenantId, userId: user.id });
    await audit(this.d.db, { tenantId: user.tenantId, userId: user.id, event: "web.login" });
    this.redirect(res, next, sessionCookie(token, maxAgeSeconds, this.d.config.secureCookies));
    return true;
  }

  private async logout(req: IncomingMessage, res: ServerResponse) {
    const s = await this.session(req);
    const form = await this.readForm(req);
    if (s && this.sameOrigin(req) && verifyCsrf(s, "logout", form.get("csrf") ?? undefined)) await destroySession(this.d.db, req.headers.cookie);
    this.redirect(res, "/login", clearCookie(this.d.config.secureCookies));
    return true;
  }

  // --------------------------------------------------------------- approvals ----
  private async approvalsPage(req: IncomingMessage, res: ServerResponse, url: URL) {
    const s = await this.session(req);
    if (!s) return this.toLogin(res, url);
    const rows = await this.d.db
      .select({ a: approvalRequest, name: connectedAccount.displayName, ext: connectedAccount.externalId, platform: connectedAccount.platform })
      .from(approvalRequest)
      .innerJoin(connectedAccount, eq(connectedAccount.id, approvalRequest.accountId))
      .where(eq(approvalRequest.tenantId, s.tenantId))
      .orderBy(desc(approvalRequest.createdAt))
      .limit(40);
    const canDecide = s.role === "owner" || s.role === "admin";
    const pending = rows.filter((r) => r.a.status === "pending" && r.a.expiresAt > new Date());
    const other = rows.filter((r) => !pending.includes(r)).slice(0, 15);
    const card = (r: (typeof rows)[number]) => `<div class="card"><div class="muted">${esc(r.platform)} · ${esc(r.name || r.ext)} · ${esc(r.a.tool)} · risk: <strong>${esc(r.a.risk)}</strong></div><p>${esc(r.a.summary)}</p>${
      canDecide
        ? `<form method="post" action="/approvals/${esc(r.a.id)}/decision">${hidden("csrf", csrfToken(s, `approval:${r.a.id}`))}<button class="primary" name="decision" value="approve">Approve</button> <button class="danger" name="decision" value="reject">Reject</button></form>${r.a.risk !== "write" ? `<p class="muted">Needs someone other than the requester.</p>` : ""}`
        : `<p class="muted">Only an owner or admin can decide.</p>`
    }</div>`;
    this.html(res, 200, page("Approvals", `${flash(url.searchParams.get("msg"))}<h2>Waiting</h2>${pending.length ? pending.map(card).join("") : `<p class="muted">Nothing is waiting.</p>`}<h2>Recent</h2>${other.map((r) => `<p class="muted">${esc(r.a.tool)} · ${esc(r.a.summary)} · <strong>${esc(r.a.status)}</strong></p>`).join("") || `<p class="muted">Nothing yet.</p>`}`, this.navFor(s)));
    return true;
  }

  private async decide(req: IncomingMessage, res: ServerResponse, id: string) {
    const s = await this.session(req);
    if (!s) {
      this.html(res, 401, page("Sign in required", flash("Your session expired.", true)));
      return true;
    }
    const form = await this.readForm(req);
    if (!this.sameOrigin(req) || !verifyCsrf(s, `approval:${id}`, form.get("csrf") ?? undefined)) {
      this.html(res, 403, page("Refused", flash("Invalid or cross-site request.", true)));
      return true;
    }
    const decision = form.get("decision");
    if (decision !== "approve" && decision !== "reject") {
      this.html(res, 400, page("Refused", flash("Unknown decision.", true)));
      return true;
    }
    try {
      const row = await this.d.approvals.decide({ tenantId: s.tenantId, approvalId: id, decider: { userId: s.userId, role: s.role }, decision, execute: createExecutor(this.d.pipeline) });
      this.redirect(res, `/approvals?msg=${encodeURIComponent(`Request ${row.status}.`)}`);
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : "Could not record the decision.";
      this.redirect(res, `/approvals?msg=${encodeURIComponent(msg)}`);
    }
    return true;
  }

  // ------------------------------------------------------------- connections ----
  private toLogin(res: ServerResponse, url: URL) {
    this.redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    return true;
  }

  private async connectionsPage(req: IncomingMessage, res: ServerResponse, url: URL) {
    const s = await this.session(req);
    if (!s) return this.toLogin(res, url);
    const conns = await this.d.db.select().from(platformConnection).where(and(eq(platformConnection.tenantId, s.tenantId), ne(platformConnection.status, "revoked"))).orderBy(desc(platformConnection.createdAt));
    const accounts = conns.length ? await this.d.db.select().from(connectedAccount).where(and(eq(connectedAccount.tenantId, s.tenantId), inArray(connectedAccount.connectionId, conns.map((c) => c.id)))) : [];
    const admin = s.role !== "member";
    const connect = (slug: string, label: string, enabled: boolean) =>
      enabled && admin
        ? `<form method="post" action="/connect/${slug}/start">${hidden("csrf", csrfToken(s, "connect"))}<button name="access" value="read">${esc(label)} (read-only)</button> <button class="primary" name="access" value="write">${esc(label)} (allow changes)</button></form>`
        : `<p class="muted">${esc(label)}: ${enabled ? "only owners and admins can connect." : "not configured on this server."}</p>`;
    this.html(
      res,
      200,
      page(
        "Connections",
        `${flash(url.searchParams.get("msg"))}<div class="card">${connect("google", "Connect Google Ads", !!this.d.platform?.enabled("google_ads"))}</div><div class="card">${connect("meta", "Connect Meta Ads", !!this.d.platform?.enabled("meta_ads"))}</div>
<h2>Connected</h2>${conns
          .map((c) => {
            const mine = accounts.filter((a) => a.connectionId === c.id);
            return `<div class="card"><strong>${esc(c.platform)}</strong> · ${esc(c.externalUserId ?? "")} · <strong>${esc(c.status)}</strong>${c.expiresAt ? ` · expires ${esc(c.expiresAt.toISOString().slice(0, 10))}` : ""}
<ul>${mine.slice(0, 30).map((a) => `<li>${esc(a.displayName || a.externalId)} <span class="muted">${esc(a.externalId)} · ${esc(a.access)}</span></li>`).join("")}${mine.length > 30 ? `<li class="muted">and ${mine.length - 30} more</li>` : ""}</ul>
${c.status === "needs_reauth" ? `<p class="err">Access expired or was revoked. Connect again.</p>` : ""}
${admin ? `<form method="post" action="/connections/${esc(c.id)}/disconnect">${hidden("csrf", csrfToken(s, `disconnect:${c.id}`))}<button class="danger">Disconnect and revoke</button></form>` : ""}</div>`;
          })
          .join("") || `<p class="muted">No accounts connected yet.</p>`}`,
        this.navFor(s),
      ),
    );
    return true;
  }

  private async connectStart(req: IncomingMessage, res: ServerResponse, platform: PlatformKey) {
    const s = await this.session(req);
    if (!s) return this.toLogin(res, new URL("/connections", "http://x"));
    const form = await this.readForm(req);
    if (!this.sameOrigin(req) || !verifyCsrf(s, "connect", form.get("csrf") ?? undefined)) {
      this.html(res, 403, page("Refused", flash("Invalid or cross-site request.", true)));
      return true;
    }
    try {
      if (!this.d.platform) throw new ToolError("unsupported", "Connections are not configured on this server.");
      const access = form.get("access") === "write" ? "write" : "read";
      this.redirect(res, await this.d.platform.start(platform, { tenantId: s.tenantId, userId: s.userId, role: s.role }, access));
    } catch (e) {
      this.redirect(res, `/connections?msg=${encodeURIComponent(e instanceof ToolError ? e.message : "Could not start the connection.")}`);
    }
    return true;
  }

  private async connectCallback(req: IncomingMessage, res: ServerResponse, url: URL, platform: PlatformKey) {
    const s = await this.session(req);
    if (!s) return this.toLogin(res, url);
    try {
      if (!this.d.platform) throw new ToolError("unsupported", "Connections are not configured on this server.");
      const r = await this.d.platform.finish(platform, { tenantId: s.tenantId, userId: s.userId, role: s.role }, url.searchParams);
      this.redirect(res, `/connections?msg=${encodeURIComponent(`Connected ${r.accounts} account(s) with ${r.access} access.${r.skipped ? ` ${r.skipped} skipped.` : ""}`)}`);
    } catch (e) {
      this.redirect(res, `/connections?msg=${encodeURIComponent(e instanceof ToolError ? e.message : "The connection could not be completed.")}`);
    }
    return true;
  }

  private async disconnect(req: IncomingMessage, res: ServerResponse, id: string) {
    const s = await this.session(req);
    if (!s) {
      this.html(res, 401, page("Sign in required", flash("Your session expired.", true)));
      return true;
    }
    const form = await this.readForm(req);
    if (!this.sameOrigin(req) || !verifyCsrf(s, `disconnect:${id}`, form.get("csrf") ?? undefined)) {
      this.html(res, 403, page("Refused", flash("Invalid or cross-site request.", true)));
      return true;
    }
    try {
      if (!this.d.platform) throw new ToolError("unsupported", "Connections are not configured on this server.");
      const r = await this.d.platform.disconnect({ tenantId: s.tenantId, userId: s.userId, role: s.role }, id);
      this.redirect(res, `/connections?msg=${encodeURIComponent(r.revokedAtPlatform ? "Disconnected and revoked at the platform." : "Disconnected. The platform could not confirm revocation: remove this app in your account settings too.")}`);
    } catch (e) {
      this.redirect(res, `/connections?msg=${encodeURIComponent(e instanceof ToolError ? e.message : "Could not disconnect.")}`);
    }
    return true;
  }
}
