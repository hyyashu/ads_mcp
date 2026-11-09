import { readText } from "../mcp/http";
import { AutomationRulesSchema, autoApprovedToday, loadRules, saveRules } from "../policy/automation";
import type { ChangeSet } from "../policy/change-set";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Role } from "../auth/context";
import { OAuthError, type OAuthServer } from "../auth/oauth-server";
import { verifyPassword } from "../auth/passwords";
import { CONNECT_SLUGS, PLATFORM_LABELS, type PlatformKey, type PlatformOAuth } from "../auth/platform-oauth";
import { clearCookie, createSession, csrfToken, destroySession, getSession, sessionCookie, verifyCsrf, type WebSession } from "../auth/web-session";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import { accountLink, appUser, approvalRequest, connectedAccount, platformConnection } from "../db/schema";
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
const PLATFORM_BY_SLUG = Object.fromEntries(Object.entries(CONNECT_SLUGS).map(([p, slug]) => [slug, p])) as Record<string, PlatformKey>;
const SLUG_RE = Object.values(CONNECT_SLUGS).join("|");
const START_RE = new RegExp(`^/connect/(${SLUG_RE})/start$`);
const CALLBACK_RE = new RegExp(`^/connect/(${SLUG_RE})/callback$`);
const label = (platform: string) => PLATFORM_LABELS[platform as PlatformKey] ?? platform;


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
    return `<p class="muted"><a href="/connections">Connections</a> · <a href="/approvals">Approvals</a> · <a href="/settings/automation">Automation</a> · signed in as ${esc(role)} · <form method="post" action="/logout" style="display:inline">${"{LOGOUT}"}<button>Sign out</button></form></p>`;
  }

  private navFor(s: WebSession) {
    return this.nav(s.role).replace("{LOGOUT}", hidden("csrf", csrfToken(s, "logout")));
  }

  private async session(req: IncomingMessage): Promise<WebSession | null> {
    return getSession(this.d.db, req.headers.cookie);
  }

  /**
   * The checks every state-changing form POST needs: a signed-in session, a same-origin request and a valid CSRF token for
   * `purpose`. Writes the refusal itself (401, or a redirect to sign-in when `loginRedirect` is set; 403) and returns null.
   */
  private async formPost(req: IncomingMessage, res: ServerResponse, purpose: string, loginRedirect?: string): Promise<{ s: WebSession; form: URLSearchParams } | null> {
    const s = await this.session(req);
    if (!s) {
      if (loginRedirect) this.toLogin(res, new URL(loginRedirect, "http://x"));
      else this.html(res, 401, page("Sign in required", flash("Your session expired.", true)));
      return null;
    }
    const form = await this.readForm(req);
    if (!this.sameOrigin(req) || !verifyCsrf(s, purpose, form.get("csrf") ?? undefined)) {
      this.html(res, 403, page("Refused", flash("Invalid or cross-site request.", true)));
      return null;
    }
    return { s, form };
  }

  /** The platform connection service, or a clear error when the server has no Google or Meta OAuth configured. */
  private get platform() {
    if (!this.d.platform) throw new ToolError("unsupported", "Connections are not configured on this server.");
    return this.d.platform;
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
    if (path === "/settings/automation" && method === "GET") return this.automationPage(req, res, url);
    if (path === "/settings/automation" && method === "POST") return this.saveAutomation(req, res);
    const start = path.match(START_RE);
    if (start && method === "POST") return this.connectStart(req, res, PLATFORM_BY_SLUG[start[1]!]!);
    const cb = path.match(CALLBACK_RE);
    if (cb && method === "GET") return this.connectCallback(req, res, url, PLATFORM_BY_SLUG[cb[1]!]!);
    const disc = path.match(/^\/connections\/([\w-]+)\/disconnect$/);
    if (disc && method === "POST") return this.disconnect(req, res, disc[1]!);
    if (path === "/connections/links" && method === "POST") return this.addLink(req, res);
    const unlink = path.match(/^\/connections\/links\/([\w-]+)\/remove$/);
    if (unlink && method === "POST") return this.removeLink(req, res, unlink[1]!);
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
      // Owners and admins choose: read only, or read and propose changes (pre-selected). Members only ever get read.
      const offerChoice = canWrite && check.scopes.includes("ads:write");
      const access = offerChoice
        ? `<fieldset class="card"><legend>Access</legend>
<label><input type="radio" name="access" value="write" checked> <strong>Read and propose changes</strong> <span class="muted">Every change waits for your approval at Approvals.</span></label>
<label><input type="radio" name="access" value="read"> <strong>Read only</strong> <span class="muted">View accounts, campaigns and reports. No changes.</span></label></fieldset>`
        : `<ul><li>Read your connected ad accounts</li></ul>`;
      this.html(
        res,
        200,
        page(
          "Authorize access",
          `<div class="card"><p><strong>${esc(check.client.name)}</strong> wants to connect to your ads workspace.</p>
<p class="muted">It will be sent back to <code>${esc(host)}</code>. Only continue if you started this from that app.</p>
<p class="muted">It can never approve changes. Approvals happen only here, in your browser.</p>
<form method="post" action="/authorize">
${access}
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
        // "read" narrows the grant to ads:read. Anything else keeps what was requested; issueCode still caps it by role,
        // so a forged access=write cannot give a member, or a client that did not ask for it, write access.
        const granted = form.get("access") === "read" ? ["ads:read"] : check.scopes;
        const { code } = await this.d.oauth.issueCode({ client: check.client, redirectUri: check.redirectUri, codeChallenge: check.codeChallenge, scopes: granted, user: { id: s.userId, tenantId: s.tenantId, role: s.role } });
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
  // (changeTable renders the structured before/after so approvers see exact values, units and why the risk is what it is)
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
    const card = (r: (typeof rows)[number]) => `<div class="card"><div class="muted">${esc(r.platform)} · ${esc(r.name || r.ext)} · ${esc(r.a.tool)} · risk: <strong>${esc(r.a.risk)}</strong></div><p>${esc(r.a.summary)}</p>${changeTable(r.a.changeSet as ChangeSet | null, r.a.risk)}${
      canDecide
        ? `<form method="post" action="/approvals/${esc(r.a.id)}/decision">${hidden("csrf", csrfToken(s, `approval:${r.a.id}`))}<button class="primary" name="decision" value="approve">Approve</button> <button class="danger" name="decision" value="reject">Reject</button></form>${r.a.risk !== "write" ? `<p class="muted">Needs someone other than the requester.</p>` : ""}`
        : `<p class="muted">Only an owner or admin can decide.</p>`
    }</div>`;
    this.html(res, 200, page("Approvals", `${flash(url.searchParams.get("msg"))}<h2>Waiting</h2>${pending.length ? pending.map(card).join("") : `<p class="muted">Nothing is waiting.</p>`}<h2>Recent</h2>${other.map((r) => `<p class="muted">${esc(r.a.tool)} · ${esc(r.a.summary)} · <strong>${esc(r.a.status)}</strong>${r.a.approvedByRule ? ` · applied by rule: ${esc(r.a.approvedByRule)}` : ""}</p>`).join("") || `<p class="muted">Nothing yet.</p>`}`, this.navFor(s)));
    return true;
  }

  private async decide(req: IncomingMessage, res: ServerResponse, id: string) {
    const post = await this.formPost(req, res, `approval:${id}`);
    if (!post) return true;
    const { s, form } = post;
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

  // -------------------------------------------------------------- automation ----
  // Only an owner can change what may happen without a person. Never reachable through an MCP tool or a bearer token.
  private async automationPage(req: IncomingMessage, res: ServerResponse, url: URL) {
    const s = await this.session(req);
    if (!s) return this.toLogin(res, url);
    const r = await loadRules(this.d.db, s.tenantId);
    const used = await autoApprovedToday(this.d.db, s.tenantId);
    const owner = s.role === "owner";
    const dis = owner ? "" : " disabled";
    const box = (name: string, on: boolean, label: string) => `<p><label><input type="checkbox" name="${name}" value="1"${on ? " checked" : ""}${dis}> ${esc(label)}</label></p>`;
    const numIn = (name: string, v: number, label: string, step = "any") => `<p><label>${esc(label)} <input type="number" name="${name}" value="${esc(v)}" min="0" step="${step}"${dis}></label></p>`;
    const body = `${flash(url.searchParams.get("msg"))}
<p class="muted">Everything here is off by default. A rule only applies a change whose current and new values were read live and shown in a change set. Removals, enabling, bid changes and changes to more than 20 items always need a person. Nothing said in a chat counts as an approval.</p>
<form method="post" action="/settings/automation">${hidden("csrf", csrfToken(s, "automation"))}
<h2>Pausing</h2>${box("pause", r.pause.enabled, "Apply pauses (campaigns, ad groups, ads, keywords) without approval")}
<h2>Daily budgets</h2>${box("budget", r.budget.enabled, "Apply daily budget changes within these limits without approval")}
${numIn("max_increase_pct", r.budget.max_increase_pct, "Largest increase, percent")}
${numIn("max_increase_amount", r.budget.max_increase_amount, "Largest increase, in the account's currency")}
${box("allow_decrease", r.budget.allow_decrease, "Also apply budget decreases")}
<h2>Limit</h2>${numIn("max_auto_per_day", r.max_auto_per_day, "Most automatic changes per day (UTC)", "1")}
<p class="muted">Applied automatically today: ${esc(used)}</p>
${owner ? `<button class="primary">Save</button>` : `<p class="muted">Only an owner can change these rules.</p>`}</form>`;
    this.html(res, 200, page("Automation", body, this.navFor(s)));
    return true;
  }

  private async saveAutomation(req: IncomingMessage, res: ServerResponse) {
    const post = await this.formPost(req, res, "automation");
    if (!post) return true;
    const { s, form } = post;
    if (s.role !== "owner") {
      this.html(res, 403, page("Refused", flash("Only an owner can change automation rules.", true)));
      return true;
    }
    const n = (k: string) => Number(form.get(k) ?? "0");
    const parsed = AutomationRulesSchema.safeParse({
      pause: { enabled: form.get("pause") === "1" },
      budget: { enabled: form.get("budget") === "1", max_increase_pct: n("max_increase_pct"), max_increase_amount: n("max_increase_amount"), allow_decrease: form.get("allow_decrease") === "1" },
      max_auto_per_day: n("max_auto_per_day"),
    });
    if (!parsed.success) {
      this.redirect(res, `/settings/automation?msg=${encodeURIComponent("Not saved: " + parsed.error.issues.map((i) => i.path.join(".")).join(", ") + " out of range.")}`);
      return true;
    }
    await saveRules(this.d.db, s.tenantId, parsed.data, s.userId);
    await audit(this.d.db, { tenantId: s.tenantId, userId: s.userId, event: "policy.updated", outcome: JSON.stringify(parsed.data).slice(0, 500) });
    this.redirect(res, `/settings/automation?msg=${encodeURIComponent("Saved.")}`);
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
    const connect = (platform: PlatformKey, hint = "") => {
      const slug = CONNECT_SLUGS[platform];
      const text = `Connect ${PLATFORM_LABELS[platform]}`;
      const enabled = !!this.d.platform?.enabled(platform);
      return enabled && admin
        ? `<form method="post" action="/connect/${slug}/start">${hidden("csrf", csrfToken(s, "connect"))}<button name="access" value="read">${esc(text)} (read-only)</button> <button class="primary" name="access" value="write">${esc(text)} (allow changes)</button></form>${hint ? `<p class="muted">${esc(hint)}</p>` : ""}`
        : `<p class="muted">${esc(text)}: ${enabled ? "only owners and admins can connect." : "not configured on this server."}</p>`;
    };
    // Each Google product is its own grant, asking only for that product's access (see PlatformOAuth).
    const products: [PlatformKey, string][] = [
      ["google_search_console", "Each site you can see in Search Console becomes an account."],
      ["google_analytics", "Each GA4 property becomes an account, with its reporting currency and time zone."],
      ["google_tag_manager", "Each container becomes an account. Allowing changes includes publishing, always after approval."],
    ];
    this.html(
      res,
      200,
      page(
        "Connections",
        `${flash(url.searchParams.get("msg"))}<div class="card">${connect("google_ads")}</div><div class="card">${connect("meta_ads")}</div>${products.map(([p, hint]) => `<div class="card">${connect(p, hint)}</div>`).join("")}
${await this.linksSection(s, accounts, admin)}
<h2>Connected</h2>${conns
          .map((c) => {
            const mine = accounts.filter((a) => a.connectionId === c.id);
            return `<div class="card"><strong>${esc(label(c.platform))}</strong> · ${esc(c.externalUserId ?? "")} · <strong>${esc(c.status)}</strong>${c.expiresAt ? ` · expires ${esc(c.expiresAt.toISOString().slice(0, 10))}` : ""}
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
    const post = await this.formPost(req, res, "connect", "/connections");
    if (!post) return true;
    const { s, form } = post;
    try {
      const access = form.get("access") === "write" ? "write" : "read";
      this.redirect(res, await this.platform.start(platform, { tenantId: s.tenantId, userId: s.userId, role: s.role }, access));
    } catch (e) {
      this.redirect(res, `/connections?msg=${encodeURIComponent(e instanceof ToolError ? e.message : "Could not start the connection.")}`);
    }
    return true;
  }

  private async connectCallback(req: IncomingMessage, res: ServerResponse, url: URL, platform: PlatformKey) {
    const s = await this.session(req);
    if (!s) return this.toLogin(res, url);
    try {
      const r = await this.platform.finish(platform, { tenantId: s.tenantId, userId: s.userId, role: s.role }, url.searchParams);
      this.redirect(res, `/connections?msg=${encodeURIComponent(`Connected ${r.accounts} account(s) with ${r.access} access.${r.skipped ? ` ${r.skipped} skipped.` : ""}`)}`);
    } catch (e) {
      this.redirect(res, `/connections?msg=${encodeURIComponent(e instanceof ToolError ? e.message : "The connection could not be completed.")}`);
    }
    return true;
  }

  private async disconnect(req: IncomingMessage, res: ServerResponse, id: string) {
    const post = await this.formPost(req, res, `disconnect:${id}`);
    if (!post) return true;
    const { s } = post;
    try {
      const r = await this.platform.disconnect({ tenantId: s.tenantId, userId: s.userId, role: s.role }, id);
      this.redirect(res, `/connections?msg=${encodeURIComponent(r.revokedAtPlatform ? "Disconnected and revoked at the platform." : "Disconnected. The platform could not confirm revocation: remove this app in your account settings too.")}`);
    } catch (e) {
      this.redirect(res, `/connections?msg=${encodeURIComponent(e instanceof ToolError ? e.message : "Could not disconnect.")}`);
    }
    return true;
  }

  // ------------------------------------------------------------------- links ----
  /**
   * Links between two accounts of this workspace (an ad account and its Search Console site, GA4 property or Tag Manager
   * container), used by the combined tools. Everyone sees them; only owners and admins change them.
   */
  private async linksSection(s: WebSession, accounts: (typeof connectedAccount.$inferSelect)[], admin: boolean): Promise<string> {
    const links = await this.d.db.select().from(accountLink).where(eq(accountLink.tenantId, s.tenantId)).orderBy(accountLink.createdAt);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const name = (id: string) => {
      const a = byId.get(id);
      return a ? `${esc(label(a.platform))}: ${esc(a.displayName || a.externalId)} <span class="muted">${esc(a.externalId)}</span>` : `<span class="muted">unavailable account</span>`;
    };
    const rows = links
      .map((l) => `<li>${name(l.accountAId)} ↔ ${name(l.accountBId)}${admin ? ` <form method="post" action="/connections/links/${esc(l.id)}/remove" style="display:inline">${hidden("csrf", csrfToken(s, `unlink:${l.id}`))}<button class="danger">Remove link</button></form>` : ""}</li>`)
      .join("");
    const sorted = [...accounts].sort((x, y) => label(x.platform).localeCompare(label(y.platform)) || (x.displayName || x.externalId).localeCompare(y.displayName || y.externalId));
    const options = sorted.map((a) => `<option value="${esc(a.id)}">${esc(label(a.platform))}: ${esc(a.displayName || a.externalId)} (${esc(a.externalId)})</option>`).join("");
    const form =
      admin && accounts.length >= 2
        ? `<form method="post" action="/connections/links">${hidden("csrf", csrfToken(s, "link"))}<select name="account_a">${options}</select> ↔ <select name="account_b">${options}</select> <button class="primary">Link</button></form>`
        : admin
          ? `<p class="muted">Connect at least two accounts to link them.</p>`
          : "";
    return `<h2>Links</h2><div class="card"><p class="muted">Link an ad account to its Search Console site, GA4 property and Tag Manager container, so tools that combine them know which belong together.</p>${rows ? `<ul>${rows}</ul>` : `<p class="muted">No links yet.</p>`}${form}</div>`;
  }

  private async addLink(req: IncomingMessage, res: ServerResponse) {
    const post = await this.formPost(req, res, "link");
    if (!post) return true;
    const { s, form } = post;
    const back = (msg: string) => (this.redirect(res, `/connections?msg=${encodeURIComponent(msg)}`), true);
    if (s.role !== "owner" && s.role !== "admin") return back("Only owners and admins can link accounts.");
    const a = form.get("account_a") ?? "";
    const b = form.get("account_b") ?? "";
    if (!a || !b || a === b) return back("Choose two different accounts to link.");
    // Both must be accounts of THIS workspace: an id from another workspace is refused like an unknown one.
    const found = await this.d.db.select({ id: connectedAccount.id, platform: connectedAccount.platform }).from(connectedAccount).where(and(eq(connectedAccount.tenantId, s.tenantId), inArray(connectedAccount.id, [a, b])));
    if (found.length !== 2) return back("One of those accounts was not found in this workspace.");
    if (found[0]!.platform === found[1]!.platform) return back("Link accounts of different products (for example an ad account and its GA4 property).");
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const inserted = await this.d.db.insert(accountLink).values({ tenantId: s.tenantId, accountAId: lo, accountBId: hi }).onConflictDoNothing().returning({ id: accountLink.id });
    if (!inserted.length) return back("Those accounts are already linked.");
    await audit(this.d.db, { tenantId: s.tenantId, userId: s.userId, event: "account_link.created", refId: inserted[0]!.id });
    return back("Linked.");
  }

  private async removeLink(req: IncomingMessage, res: ServerResponse, id: string) {
    const post = await this.formPost(req, res, `unlink:${id}`);
    if (!post) return true;
    const { s } = post;
    const back = (msg: string) => (this.redirect(res, `/connections?msg=${encodeURIComponent(msg)}`), true);
    if (s.role !== "owner" && s.role !== "admin") return back("Only owners and admins can remove links.");
    const gone = await this.d.db.delete(accountLink).where(and(eq(accountLink.id, id), eq(accountLink.tenantId, s.tenantId))).returning({ id: accountLink.id });
    if (!gone.length) return back("No such link.");
    await audit(this.d.db, { tenantId: s.tenantId, userId: s.userId, event: "account_link.removed", refId: id });
    return back("Link removed.");
  }
}

/** Before/after table for an approval's change set. Every value is escaped: names come from the ad platform. */
function changeTable(cs: ChangeSet | null, risk = "write"): string {
  if (!cs?.changes?.length) return "";
  const fmt = (v: unknown, unit: string) => (v === null || v === undefined ? "unset" : unit === "currency" && cs.currency_code ? `${v} ${cs.currency_code}` : String(v));
  // A destructive change (e.g. a Tag Manager publish) shows its whole diff, up to 300 rows; others show 50.
  const shown = cs.changes.slice(0, risk === "destructive" ? 300 : 50);
  const rows = shown
    .map((c) => `<tr><td>${esc(c.resource)} ${esc(c.name ?? c.id)}</td><td>${esc(c.field)}</td><td>${esc(fmt(c.before, c.unit))}</td><td>${esc(fmt(c.after, c.unit))}</td><td>${esc(c.effect.replace(/_/g, " "))}</td></tr>`)
    .join("");
  const more = cs.changes.length > shown.length ? `<p class="muted">and ${cs.changes.length - shown.length} more</p>` : "";
  return `<table class="changes"><tr><th>Item</th><th>Setting</th><th>Now</th><th>After</th><th>Effect</th></tr>${rows}</table>${more}<p class="muted">Risk: ${esc(cs.risk_reason)}</p>`;
}

/** Exported for tests only. */
export const changeTableForTest = changeTable;
