import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveAccount } from "../../auth/accounts";
import { type Actor, PlatformOAuth } from "../../auth/platform-oauth";
import { BingTokenProvider, type FetchLike } from "../../auth/token-providers";
import { type Db, schema } from "../../db";
import { credentialAad } from "../../security/crypto";
import { addUser, seedTenant, testCipher, testDb } from "../support/helpers";

/**
 * Connect Bing Webmaster: Bing's own OAuth (authorize + token at www.bing.com/webmasters/oauth), scopes webmaster.read /
 * webmaster.manage, discovery with GetUserSites (verified sites only), local-only disconnect, and token refresh.
 */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
const calls: Call[] = [];
const J = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Behavior {
  scope?: string | null;
  noRefresh?: boolean;
  tokenStatus?: number;
  sitesStatus?: number;
  refreshBody?: Record<string, unknown>;
  refreshStatus?: number;
}
let b: Behavior = {};

const fakeFetch: FetchLike = async (url, init) => {
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const body = String(init?.body ?? "");
  calls.push({ url, method: init?.method ?? "GET", headers, body });
  if (url === "https://www.bing.com/webmasters/oauth/token") {
    const form = new URLSearchParams(body);
    if (form.get("grant_type") === "refresh_token") return J(b.refreshBody ?? { access_token: "bing-access-2", expires_in: 3599, token_type: "Bearer" }, b.refreshStatus ?? 200);
    if (b.tokenStatus) return J({ error: "invalid_grant" }, b.tokenStatus);
    return J({ access_token: "bing-access", token_type: "bearer", expires_in: 3599, ...(b.noRefresh ? {} : { refresh_token: "bing-refresh-secret" }), ...(b.scope ? { scope: b.scope } : {}) });
  }
  if (url.startsWith("https://www.bing.com/webmaster/api.svc/json/GetUserSites")) {
    if (b.sitesStatus) return J({ ErrorCode: 1, Message: "InternalError" }, b.sitesStatus);
    return J({
      d: [
        { __type: "Site:#Microsoft.Bing.Webmaster.Api", Url: "https://www.shop.example/", IsVerified: true, AuthenticationCode: "A1", DnsVerificationCode: "a1.shop.example" },
        { __type: "Site:#Microsoft.Bing.Webmaster.Api", Url: "http://blog.example", IsVerified: true },
        { __type: "Site:#Microsoft.Bing.Webmaster.Api", Url: "https://new.example/", IsVerified: false },
      ],
    });
  }
  return J({ ErrorCode: 11, Message: `unexpected request: ${url}` }, 400);
};

let db: Db;
let owner: Actor;
let member: Actor;
let tenantId: string;
const cipher = testCipher();
let oauth: PlatformOAuth;
const cfg = { publicUrl: "https://mcp.example.com", bing: { clientId: "bing-client", clientSecret: "bing-secret" } };

beforeAll(async () => {
  db = await testDb();
  const t = await seedTenant(db, "BING", "owner");
  tenantId = t.tenant.id;
  owner = { tenantId, userId: t.user.id, role: "owner" };
  member = { tenantId, userId: (await addUser(db, tenantId, "bing-member", "member")).id, role: "member" };
});
beforeEach(() => {
  calls.length = 0;
  b = {};
  oauth = new PlatformOAuth(db, cipher, cfg, { fetch: fakeFetch });
});

const stateFrom = (url: string) => new URL(url).searchParams.get("state")!;
const cb = (state: string) => new URLSearchParams({ state, code: "auth-code" });
const connect = async (access: "read" | "write", who: Actor = owner) => oauth.finish("bing_webmaster", who, cb(stateFrom(await oauth.start("bing_webmaster", who, access))));

describe("Connect Bing Webmaster", () => {
  it("sends the user to Bing's authorize endpoint with only the documented parameters and the access level's scope", async () => {
    const read = new URL(await oauth.start("bing_webmaster", owner, "read"));
    expect(read.origin + read.pathname).toBe("https://www.bing.com/webmasters/oauth/authorize");
    expect(Object.fromEntries(read.searchParams)).toEqual({ response_type: "code", client_id: "bing-client", redirect_uri: "https://mcp.example.com/connect/bing/callback", scope: "webmaster.read", state: expect.any(String) });
    expect(new URL(await oauth.start("bing_webmaster", owner, "write")).searchParams.get("scope")).toBe("webmaster.manage");
  });

  it("is unavailable without a Bing client, and members cannot connect", async () => {
    const bare = new PlatformOAuth(db, cipher, { publicUrl: cfg.publicUrl }, { fetch: fakeFetch });
    expect(bare.enabled("bing_webmaster")).toBe(false);
    await expect(bare.start("bing_webmaster", owner, "read")).rejects.toMatchObject({ code: "unsupported" });
    await expect(oauth.start("bing_webmaster", member, "read")).rejects.toMatchObject({ code: "permission_denied" });
    // Bing being configured does not enable Google
    expect(oauth.enabled("google_search_console")).toBe(false);
  });

  it("exchanges the code, keeps only the encrypted refresh token, and connects one account per verified site", async () => {
    const r = await connect("write");
    expect(r).toMatchObject({ accounts: 2, skipped: 1, access: "write" });
    const tokenCall = calls.find((c) => c.url === "https://www.bing.com/webmasters/oauth/token")!;
    expect(Object.fromEntries(new URLSearchParams(tokenCall.body))).toEqual({ code: "auth-code", client_id: "bing-client", client_secret: "bing-secret", redirect_uri: "https://mcp.example.com/connect/bing/callback", grant_type: "authorization_code" });
    // the access token travels only in the Authorization header
    const api = calls.filter((c) => c.url.includes("/webmaster/api.svc/json/"));
    expect(api).toHaveLength(1);
    expect(api[0]!.headers.authorization).toBe("Bearer bing-access");
    expect(api[0]!.url).toBe("https://www.bing.com/webmaster/api.svc/json/GetUserSites");

    const [conn] = await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, r.connectionId));
    expect(conn).toMatchObject({ platform: "bing_webmaster", status: "active", grantedScopes: ["webmaster.manage"], externalUserId: null });
    expect(conn!.credentialsEnc).not.toContain("bing-refresh");
    expect(cipher.decrypt<{ refreshToken: string }>(conn!.credentialsEnc, credentialAad(tenantId, conn!.id)).refreshToken).toBe("bing-refresh-secret");
    const accs = (await db.select().from(schema.connectedAccount).where(eq(schema.connectedAccount.connectionId, r.connectionId))).map((a) => [a.platform, a.externalId, a.access]).sort();
    expect(accs).toEqual([
      ["bing_webmaster", "http://blog.example", "write"],
      ["bing_webmaster", "https://www.shop.example/", "write"],
    ]);
    // tools can name a site by its URL exactly as Bing returned it
    expect((await resolveAccount(db, tenantId, "http://blog.example", "bing_webmaster", false)).externalId).toBe("http://blog.example");
  });

  it("checks a returned scope list, refuses without a refresh token, and stores nothing when discovery fails", async () => {
    const fresh = await seedTenant(db, "BING2", "owner");
    const who: Actor = { tenantId: fresh.tenant.id, userId: fresh.user.id, role: "owner" };
    b = { scope: "webmaster.read" };
    await expect(connect("write", who)).rejects.toThrow(/not granted \(webmaster.manage\)/);
    b = { scope: "Webmaster.Manage" }; // case differs between Bing's pages: compared without case
    await expect(connect("write", who)).resolves.toMatchObject({ accounts: 2 });

    const other = await seedTenant(db, "BING3", "owner");
    const them: Actor = { tenantId: other.tenant.id, userId: other.user.id, role: "owner" };
    b = { noRefresh: true };
    await expect(connect("read", them)).rejects.toThrow(/did not return a refresh token/);
    b = { tokenStatus: 400 };
    await expect(connect("read", them)).rejects.toMatchObject({ code: "permission_denied" });
    b = { sitesStatus: 500 };
    await expect(connect("read", them)).rejects.toMatchObject({ code: "transient" });
    expect(await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.tenantId, other.tenant.id))).toHaveLength(0);
  });

  it("disconnect wipes the credentials and accounts locally (Bing documents no revoke endpoint)", async () => {
    const r = await connect("read");
    calls.length = 0;
    expect(await oauth.disconnect(owner, r.connectionId)).toEqual({ revokedAtPlatform: false });
    expect(calls).toHaveLength(0);
    const [conn] = await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, r.connectionId));
    expect(conn).toMatchObject({ status: "revoked", credentialsEnc: "revoked" });
    expect(await db.select().from(schema.connectedAccount).where(eq(schema.connectedAccount.connectionId, r.connectionId))).toHaveLength(0);
  });
});

describe("BingTokenProvider", () => {
  const provider = (now = () => 1_000_000) => new BingTokenProvider({ db, cipher, clientId: "bing-client", clientSecret: "bing-secret", fetch: fakeFetch, now });

  it("refreshes with the stored refresh token, caches per tenant and connection, and refreshes again near expiry", async () => {
    const { connectionId } = await connect("read");
    let t = 1_000_000;
    const p = provider(() => t);
    calls.length = 0;
    expect(await p.getAccessToken(tenantId, connectionId)).toBe("bing-access-2");
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ client_id: "bing-client", client_secret: "bing-secret", refresh_token: "bing-refresh-secret", grant_type: "refresh_token" });
    await p.getAccessToken(tenantId, connectionId);
    expect(calls).toHaveLength(1);
    t += 3_560_000; // within 60 s of expiry
    await p.getAccessToken(tenantId, connectionId);
    expect(calls).toHaveLength(2);
    // another tenant can never get this connection's token
    const other = await seedTenant(db, "BING4", "owner");
    await expect(p.getAccessToken(other.tenant.id, connectionId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("stores a rotated refresh token", async () => {
    const { connectionId } = await connect("read");
    b = { refreshBody: { access_token: "bing-access-3", refresh_token: "bing-refresh-rotated", expires_in: 3599 } };
    await provider().getAccessToken(tenantId, connectionId);
    const [conn] = await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, connectionId));
    expect(cipher.decrypt<{ refreshToken: string }>(conn!.credentialsEnc, credentialAad(tenantId, connectionId)).refreshToken).toBe("bing-refresh-rotated");
  });

  it("invalid_grant marks the connection for reconnecting", async () => {
    const { connectionId } = await connect("read");
    b = { refreshBody: { error: "invalid_grant" }, refreshStatus: 400 };
    await expect(provider().getAccessToken(tenantId, connectionId)).rejects.toMatchObject({ code: "auth_expired" });
    const [conn] = await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, connectionId));
    expect(conn!.status).toBe("needs_reauth");
  });
});
