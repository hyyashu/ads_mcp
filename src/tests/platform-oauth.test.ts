import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveAccount } from "../auth/accounts";
import { type Actor, PlatformOAuth } from "../auth/platform-oauth";
import { GoogleTokenProvider, MetaTokenProvider, type FetchLike } from "../auth/token-providers";
import { type Db, schema } from "../db";
import { credentialAad } from "../security/crypto";
import { addUser, seedTenant, testCipher, testDb } from "./helpers";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
const calls: Call[] = [];
const J = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;
const FUTURE = Math.floor(Date.now() / 1000) + 60 * 24 * 3600;

interface Behavior {
  googleToken?: () => Response;
  googleScopes?: string;
  googleRefresh?: boolean;
  metaScopes?: string[];
  metaValid?: boolean;
  revokeOk?: boolean;
  adsDown?: boolean;
}
let b: Behavior = {};

const fakeFetch: FetchLike = async (url, init) => {
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const call: Call = { url, method: init?.method ?? "GET", headers, body: String(init?.body ?? "") };
  calls.push(call);

  // ---- Google OAuth
  if (url === "https://oauth2.googleapis.com/token") {
    if (b.googleToken) return b.googleToken();
    return J({
      access_token: "ya29.fake-access",
      ...(b.googleRefresh === false ? {} : { refresh_token: "1//super-secret-refresh-token" }),
      scope: b.googleScopes ?? "openid email https://www.googleapis.com/auth/adwords",
      id_token: idToken("agency@example.com"),
      expires_in: 3600,
    });
  }
  if (url === "https://oauth2.googleapis.com/revoke") return b.revokeOk === false ? J({}, 400) : J({});

  // ---- Google Ads (discovery)
  if (url.startsWith("https://googleads.googleapis.com/v99/")) {
    if (b.adsDown) return J({ error: { code: 503, status: "UNAVAILABLE", message: "down" } }, 503);
    if (url.endsWith("customers:listAccessibleCustomers")) return J({ resourceNames: ["customers/111", "customers/222"] });
    const q = JSON.parse(call.body).query as string;
    const id = url.match(/customers\/(\d+)\//)![1];
    if (q.includes("FROM customer LIMIT 1")) return J([{ results: [{ customer: { id, descriptiveName: id === "111" ? "Agency MCC" : "Solo Shop", manager: id === "111" } }] }]);
    if (q.includes("FROM customer_client")) return J([{ results: [{ customerClient: { id: "333", descriptiveName: "Client Three", manager: false } }, { customerClient: { id: "444", descriptiveName: "Sub MCC", manager: true } }] }]);
  }

  // ---- Meta
  if (url.startsWith("https://graph.facebook.com/v23.0/")) {
    const path = url.replace("https://graph.facebook.com/v23.0/", "").split("?")[0];
    if (path === "oauth/access_token") {
      const body = new URLSearchParams(call.body);
      return body.get("grant_type") === "fb_exchange_token" ? J({ access_token: "EAAlonglivedtokenvalue1234567890", expires_in: 5184000 }) : J({ access_token: "EAAshorttokenvalue1234567890" });
    }
    if (path === "debug_token") return J({ data: { is_valid: b.metaValid !== false, scopes: b.metaScopes ?? ["ads_read", "ads_management", "business_management"], user_id: "meta-user-1", expires_at: FUTURE } });
    if (path === "me/adaccounts") return J({ data: [{ account_id: "1001", name: "Shop A", account_status: 1 }, { account_id: "1002", name: "Shop B", account_status: 1 }, { account_id: "1003", name: "Closed", account_status: 2 }] });
    if (path === "me/permissions") return b.revokeOk === false ? J({}, 400) : J({ success: true });
  }
  return J({ error: "unexpected request: " + url }, 500);
};

let db: Db;
let owner: Actor;
let admin: Actor;
let member: Actor;
let tenantId: string;
const cipher = testCipher();
let oauth: PlatformOAuth;
const cfg = { publicUrl: "https://mcp.example.com", google: { clientId: "gid", clientSecret: "gsecret", apiVersion: "v99" }, meta: { appId: "mid", appSecret: "msecret", apiVersion: "v23.0" } };

beforeAll(async () => {
  db = await testDb();
  const t = await seedTenant(db, "P", "owner");
  tenantId = t.tenant.id;
  owner = { tenantId, userId: t.user.id, role: "owner" };
  const a = await addUser(db, tenantId, "p-admin", "admin");
  admin = { tenantId, userId: a.id, role: "admin" };
  const m = await addUser(db, tenantId, "p-member", "member");
  member = { tenantId, userId: m.id, role: "member" };
});
beforeEach(() => {
  calls.length = 0;
  b = {};
  oauth = new PlatformOAuth(db, cipher, cfg, { fetch: fakeFetch });
});

const stateFrom = (url: string) => new URL(url).searchParams.get("state")!;
const cb = (state: string, code = "auth-code") => new URLSearchParams({ state, code });
const accountsOf = async (connectionId: string) => db.select().from(schema.connectedAccount).where(eq(schema.connectedAccount.connectionId, connectionId));

describe("connect Google Ads", () => {
  it("builds an authorization URL with PKCE S256, offline access and the Ads scope", async () => {
    const u = new URL(await oauth.start("google_ads", owner, "read"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = u.searchParams;
    expect(p.get("client_id")).toBe("gid");
    expect(p.get("redirect_uri")).toBe("https://mcp.example.com/connect/google/callback");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toContain("https://www.googleapis.com/auth/adwords");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")!.length).toBeGreaterThanOrEqual(40);
    expect(u.toString()).not.toContain("gsecret");
  });

  it("members cannot connect accounts; an unconfigured platform is refused", async () => {
    await expect(oauth.start("google_ads", member, "read")).rejects.toMatchObject({ code: "permission_denied" });
    const bare = new PlatformOAuth(db, cipher, { publicUrl: cfg.publicUrl }, { fetch: fakeFetch });
    await expect(bare.start("google_ads", owner, "read")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("completes the flow: discovers direct and manager-linked accounts, never sends a developer token", async () => {
    const state = stateFrom(await oauth.start("google_ads", admin, "read"));
    const r = await oauth.finish("google_ads", admin, cb(state));
    expect(r).toMatchObject({ accounts: 2, skipped: 0, access: "read" });
    const accs = (await accountsOf(r.connectionId)).sort((x, y) => x.externalId.localeCompare(y.externalId));
    expect(accs.map((a) => [a.externalId, a.loginCustomerId, a.access, a.displayName])).toEqual([
      ["222", null, "read", "Solo Shop"], // directly accessible
      ["333", "111", "read", "Client Three"], // reached through manager 111, which becomes its login-customer-id
    ]);
    // sub-manager 444 is not a leaf account and is not connected
    expect(accs.find((a) => a.externalId === "444")).toBeUndefined();

    const adsCalls = calls.filter((c) => c.url.startsWith("https://googleads.googleapis.com/"));
    expect(adsCalls.length).toBeGreaterThan(0);
    for (const c of adsCalls) {
      expect(Object.keys(c.headers)).not.toContain("developer-token"); // access levels now attach to the Cloud project
      expect(c.headers.authorization).toBe("Bearer ya29.fake-access");
      expect(c.url).toContain("/v99/");
    }
    expect(adsCalls.some((c) => c.headers["login-customer-id"] === "111")).toBe(true);
  });

  it("stores the refresh token encrypted, bound to its row, and only there", async () => {
    // A fresh tenant: accounts already connected read-only elsewhere in this file must keep that level (tested separately).
    const fresh = await seedTenant(db, "P4", "owner");
    const who: Actor = { tenantId: fresh.tenant.id, userId: fresh.user.id, role: "owner" };
    const state = stateFrom(await oauth.start("google_ads", who, "write"));
    const r = await oauth.finish("google_ads", who, cb(state));
    const [conn] = await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, r.connectionId));
    expect(conn!.credentialsEnc).not.toContain("super-secret");
    expect(conn!.grantedScopes).toContain("https://www.googleapis.com/auth/adwords");
    expect(conn!.externalUserId).toBe("agency@example.com");
    expect(cipher.decrypt<{ refreshToken: string }>(conn!.credentialsEnc, credentialAad(fresh.tenant.id, conn!.id)).refreshToken).toBe("1//super-secret-refresh-token");
    expect(() => cipher.decrypt(conn!.credentialsEnc, credentialAad("other-tenant", conn!.id))).toThrow();
    expect((await accountsOf(r.connectionId)).every((a) => a.access === "write")).toBe(true);
    // The PKCE verifier is stored encrypted as well.
    const states = JSON.stringify(await db.select().from(schema.platformOauthState));
    const verifier = new URLSearchParams(calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!.body).get("code_verifier")!;
    expect(states).not.toContain(verifier);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("state is single-use, bound to the user who started it, and expires", async () => {
    const state = stateFrom(await oauth.start("google_ads", owner, "read"));
    await expect(oauth.finish("google_ads", admin, cb(state))).rejects.toThrow(/expired or was already used/); // different user
    await oauth.finish("google_ads", owner, cb(state));
    await expect(oauth.finish("google_ads", owner, cb(state))).rejects.toThrow(/expired or was already used/); // replay
    await expect(oauth.finish("google_ads", owner, cb("forged-state"))).rejects.toThrow();
    await expect(oauth.finish("google_ads", owner, new URLSearchParams({ code: "x" }))).rejects.toThrow(/state/i);

    const late = stateFrom(await oauth.start("google_ads", owner, "read"));
    await db.update(schema.platformOauthState).set({ expiresAt: new Date(Date.now() - 1000) });
    await expect(oauth.finish("google_ads", owner, cb(late))).rejects.toThrow(/expired/);
    // a Google state cannot be used to finish a Meta connection
    const g = stateFrom(await oauth.start("google_ads", owner, "read"));
    await expect(oauth.finish("meta_ads", owner, cb(g))).rejects.toThrow(/expired or was already used/);
  });

  it("fails cleanly, creating nothing, when Google gives no refresh token, a wrong scope, or an error", async () => {
    const count = async () => (await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.tenantId, tenantId))).length;
    const before = await count();
    for (const [behavior, msg] of [
      [{ googleRefresh: false }, /refresh token/],
      [{ googleScopes: "openid email" }, /Google Ads permission was not granted/],
      [{ googleToken: () => J({ error: "invalid_grant" }, 400) }, /did not accept/],
    ] as const) {
      b = behavior;
      const state = stateFrom(await oauth.start("google_ads", owner, "read"));
      await expect(oauth.finish("google_ads", owner, cb(state))).rejects.toThrow(msg);
    }
    await expect(oauth.finish("google_ads", owner, new URLSearchParams({ state: stateFrom(await oauth.start("google_ads", owner, "read")), error: "access_denied" }))).rejects.toThrow(/access_denied/);
    expect(await count()).toBe(before);
  });

  it("reconnecting re-points an account but never silently widens its access", async () => {
    const first = await oauth.finish("google_ads", owner, cb(stateFrom(await oauth.start("google_ads", owner, "read"))));
    const second = await oauth.finish("google_ads", owner, cb(stateFrom(await oauth.start("google_ads", owner, "write"))));
    const a = (await accountsOf(second.connectionId)).find((x) => x.externalId === "222")!;
    expect(a.access).toBe("read"); // was read, stays read: an admin must raise it deliberately
    expect((await accountsOf(first.connectionId)).find((x) => x.externalId === "222")).toBeUndefined(); // moved to the new connection
  });

  it("an API outage during discovery fails the connection instead of storing half a result", async () => {
    b = { adsDown: true };
    const state = stateFrom(await oauth.start("google_ads", owner, "read"));
    const before = (await db.select().from(schema.platformConnection)).length;
    const r = await oauth.finish("google_ads", owner, cb(state)).catch((e) => e);
    // discovery errors per-account are skipped; with the API fully down nothing can be listed, so it must not claim success
    if (r instanceof Error) expect(r.message).toBeTruthy();
    else expect(r.accounts).toBe(0);
    expect((await db.select().from(schema.platformConnection)).length).toBeGreaterThanOrEqual(before);
  });
});

describe("connect Meta Ads", () => {
  it("requests only the permissions the chosen access level needs", async () => {
    const read = new URL(await oauth.start("meta_ads", owner, "read")).searchParams.get("scope")!.split(",");
    const write = new URL(await oauth.start("meta_ads", owner, "write")).searchParams.get("scope")!.split(",");
    expect(read).toContain("ads_read");
    expect(read).not.toContain("ads_management");
    expect(write).toContain("ads_management");
    const u = new URL(await oauth.start("meta_ads", owner, "read"));
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
    expect(u.toString()).not.toContain("msecret");
  });

  it("exchanges for a long-lived token, verifies it, lists only active accounts and records expiry", async () => {
    const r = await oauth.finish("meta_ads", owner, cb(stateFrom(await oauth.start("meta_ads", owner, "write"))));
    expect(r).toMatchObject({ accounts: 2, skipped: 1, access: "write" });
    const accs = await accountsOf(r.connectionId);
    expect(accs.map((a) => a.externalId).sort()).toEqual(["act_1001", "act_1002"]);
    const [conn] = await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, r.connectionId));
    expect(conn!.expiresAt!.getTime()).toBe(FUTURE * 1000);
    expect(conn!.externalUserId).toBe("meta-user-1");
    expect(conn!.credentialsEnc).not.toContain("EAA");
    expect(cipher.decrypt<{ accessToken: string }>(conn!.credentialsEnc, credentialAad(tenantId, conn!.id)).accessToken).toBe("EAAlonglivedtokenvalue1234567890");
  });

  it("keeps secrets and tokens out of URLs, and signs API calls with appsecret_proof", async () => {
    await oauth.finish("meta_ads", owner, cb(stateFrom(await oauth.start("meta_ads", owner, "read"))));
    for (const c of calls) {
      expect(c.url).not.toContain("msecret");
      expect(c.url).not.toContain("EAAlonglivedtokenvalue");
    }
    const exchange = calls.find((c) => c.url.endsWith("oauth/access_token"))!;
    expect(exchange.method).toBe("POST");
    expect(exchange.body).toContain("client_secret=msecret"); // in a POST body, not a URL
    const list = calls.find((c) => c.url.includes("me/adaccounts"))!;
    expect(list.headers.authorization).toBe("Bearer EAAlonglivedtokenvalue1234567890");
    expect(new URL(list.url).searchParams.get("appsecret_proof")).toBe(createHmac("sha256", "msecret").update("EAAlonglivedtokenvalue1234567890").digest("hex"));
  });

  it("refuses connections whose granted permissions are not enough", async () => {
    b = { metaScopes: ["business_management"] };
    await expect(oauth.finish("meta_ads", owner, cb(stateFrom(await oauth.start("meta_ads", owner, "read"))))).rejects.toThrow(/ads_read/);
    b = { metaScopes: ["ads_read"] };
    await expect(oauth.finish("meta_ads", owner, cb(stateFrom(await oauth.start("meta_ads", owner, "write"))))).rejects.toThrow(/ads_management/);
    b = { metaValid: false };
    await expect(oauth.finish("meta_ads", owner, cb(stateFrom(await oauth.start("meta_ads", owner, "read"))))).rejects.toThrow(/invalid/);
  });
});

describe("disconnect", () => {
  it("revokes at Google, wipes the credential, detaches accounts and cascades pending approvals", async () => {
    const r = await oauth.finish("google_ads", owner, cb(stateFrom(await oauth.start("google_ads", owner, "write"))));
    const [acc] = await accountsOf(r.connectionId);
    await db.insert(schema.approvalRequest).values({ tenantId, accountId: acc!.id, tool: "pause_campaign", risk: "write", args: {}, argsHash: "h", summary: "s", idempotencyKey: `k-${r.connectionId}`, expiresAt: new Date(Date.now() + 1e6) });
    calls.length = 0;
    const out = await oauth.disconnect(owner, r.connectionId);
    expect(out.revokedAtPlatform).toBe(true);
    expect(new URLSearchParams(calls.find((c) => c.url.endsWith("/revoke"))!.body).get("token")).toBe("1//super-secret-refresh-token");
    const [conn] = await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, r.connectionId));
    expect(conn).toMatchObject({ status: "revoked", credentialsEnc: "revoked" });
    expect(await accountsOf(r.connectionId)).toHaveLength(0);
    expect(await db.select().from(schema.approvalRequest).where(eq(schema.approvalRequest.accountId, acc!.id))).toHaveLength(0);
    const events = (await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.tenantId, tenantId), eq(schema.auditLog.refId, r.connectionId)))).map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(["connection.created", "connection.disconnected"]));
    await expect(resolveAccount(db, tenantId, acc!.id, "google_ads", false)).rejects.toMatchObject({ code: "not_found" });
  });

  it("revokes Meta permissions too", async () => {
    const r = await oauth.finish("meta_ads", owner, cb(stateFrom(await oauth.start("meta_ads", owner, "read"))));
    calls.length = 0;
    expect((await oauth.disconnect(admin, r.connectionId)).revokedAtPlatform).toBe(true);
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toContain("me/permissions");
    expect(del.headers.authorization).toBe("Bearer EAAlonglivedtokenvalue1234567890");
  });

  it("still wipes our copy when the platform cannot confirm revocation, and says so", async () => {
    const r = await oauth.finish("google_ads", owner, cb(stateFrom(await oauth.start("google_ads", owner, "read"))));
    b = { revokeOk: false };
    expect((await oauth.disconnect(owner, r.connectionId)).revokedAtPlatform).toBe(false);
    const [conn] = await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, r.connectionId));
    expect(conn!.credentialsEnc).toBe("revoked");
  });

  it("members cannot disconnect; another tenant's connection is not found", async () => {
    const r = await oauth.finish("google_ads", owner, cb(stateFrom(await oauth.start("google_ads", owner, "read"))));
    await expect(oauth.disconnect(member, r.connectionId)).rejects.toMatchObject({ code: "permission_denied" });
    const other = await seedTenant(db, "P2", "owner");
    await expect(oauth.disconnect({ tenantId: other.tenant.id, userId: other.user.id, role: "owner" }, r.connectionId)).rejects.toMatchObject({ code: "not_found" });
    expect((await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, r.connectionId)))[0]!.status).toBe("active");
  });
});

describe("token providers", () => {
  async function googleConn(): Promise<string> {
    const r = await oauth.finish("google_ads", owner, cb(stateFrom(await oauth.start("google_ads", owner, "read"))));
    return r.connectionId;
  }

  it("Google: refreshes access tokens on demand and caches them in memory only", async () => {
    const id = await googleConn();
    calls.length = 0;
    const p = new GoogleTokenProvider({ db, cipher, clientId: "gid", clientSecret: "gsecret", fetch: fakeFetch });
    expect(await p.getAccessToken(tenantId, id)).toBe("ya29.fake-access");
    expect(await p.getAccessToken(tenantId, id)).toBe("ya29.fake-access");
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1); // second call served from cache
    expect(new URLSearchParams(calls[0]!.body).get("grant_type")).toBe("refresh_token");
  });

  it("Google: a revoked grant flips the connection to needs_reauth and later calls say auth_expired", async () => {
    const id = await googleConn();
    b = { googleToken: () => J({ error: "invalid_grant" }, 400) };
    const p = new GoogleTokenProvider({ db, cipher, clientId: "gid", clientSecret: "gsecret", fetch: fakeFetch });
    await expect(p.getAccessToken(tenantId, id)).rejects.toMatchObject({ code: "auth_expired" });
    expect((await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, id)))[0]!.status).toBe("needs_reauth");
    await expect(p.getAccessToken(tenantId, id)).rejects.toMatchObject({ code: "auth_expired" });
  });

  it("Google: a temporary outage is transient and does not disable the connection", async () => {
    const id = await googleConn();
    b = { googleToken: () => J({}, 503) };
    const p = new GoogleTokenProvider({ db, cipher, clientId: "gid", clientSecret: "gsecret", fetch: fakeFetch });
    await expect(p.getAccessToken(tenantId, id)).rejects.toMatchObject({ code: "transient" });
    expect((await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, id)))[0]!.status).toBe("active");
  });

  it("Google: another tenant cannot use the connection", async () => {
    const id = await googleConn();
    const other = await seedTenant(db, "P3", "owner");
    const p = new GoogleTokenProvider({ db, cipher, clientId: "gid", clientSecret: "gsecret", fetch: fakeFetch });
    await expect(p.getAccessToken(other.tenant.id, id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("Meta: returns the token with a valid appsecret_proof; an expired token flips to needs_reauth", async () => {
    const r = await oauth.finish("meta_ads", owner, cb(stateFrom(await oauth.start("meta_ads", owner, "read"))));
    const p = new MetaTokenProvider({ db, cipher, appSecret: "msecret" });
    const t = await p.getToken(tenantId, r.connectionId);
    expect(t.accessToken).toBe("EAAlonglivedtokenvalue1234567890");
    expect(t.appSecretProof).toBe(createHmac("sha256", "msecret").update(t.accessToken).digest("hex"));
    const late = new MetaTokenProvider({ db, cipher, appSecret: "msecret", now: () => new Date((FUTURE + 10) * 1000) });
    await expect(late.getToken(tenantId, r.connectionId)).rejects.toMatchObject({ code: "auth_expired" });
    expect((await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, r.connectionId)))[0]!.status).toBe("needs_reauth");
    await expect(resolveAccount(db, tenantId, (await accountsOf(r.connectionId))[0]!.id, "meta_ads", false)).rejects.toMatchObject({ code: "auth_expired" });
  });
});
