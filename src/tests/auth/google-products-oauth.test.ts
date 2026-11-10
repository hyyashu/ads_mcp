import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveAccount } from "../../auth/accounts";
import { type Actor, PlatformOAuth } from "../../auth/platform-oauth";
import type { FetchLike } from "../../auth/token-providers";
import { type Db, schema } from "../../db";
import { credentialAad } from "../../security/crypto";
import { addUser, seedTenant, testCipher, testDb } from "../support/helpers";

/**
 * Connect flows for Search Console, GA4 and Tag Manager: one Google grant per product on the Ads OAuth client, the granted
 * scopes checked on the token response, discovery creating one account per site / property / container, and disconnect.
 */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
const calls: Call[] = [];
const J = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const AUTH = "https://www.googleapis.com/auth/";
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;

interface Behavior {
  scopes?: string;
  revokeOk?: boolean;
  /** Status for every product API call (simulates an outage or a refusal). */
  apiStatus?: number;
  /** Property ids whose properties.get answers 403. */
  deniedProperties?: string[];
}
let b: Behavior = {};

const fakeFetch: FetchLike = async (url, init) => {
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  calls.push({ url, method: init?.method ?? "GET", headers, body: String(init?.body ?? "") });
  if (url === "https://oauth2.googleapis.com/token") {
    return J({ access_token: "ya29.product-access", refresh_token: "1//product-refresh-token-secret", scope: b.scopes ?? "openid email", id_token: idToken("seo@example.com"), expires_in: 3600 });
  }
  if (url === "https://oauth2.googleapis.com/revoke") return b.revokeOk === false ? J({}, 400) : J({});
  if (b.apiStatus) return J({ error: { code: b.apiStatus, status: b.apiStatus >= 500 ? "UNAVAILABLE" : "PERMISSION_DENIED", message: "nope" } }, b.apiStatus);

  const u = new URL(url);
  // ---- Search Console: sites.list (siteEntry: siteUrl, permissionLevel)
  if (u.href === "https://www.googleapis.com/webmasters/v3/sites") {
    return J({ siteEntry: [{ siteUrl: "https://shop.example/", permissionLevel: "siteOwner" }, { siteUrl: "sc-domain:shop.example", permissionLevel: "siteFullUser" }, { siteUrl: "https://blog.example/", permissionLevel: "siteUnverifiedUser" }] });
  }
  // ---- GA4 Admin: accountSummaries.list (two pages) and properties.get
  if (u.origin + u.pathname === "https://analyticsadmin.googleapis.com/v1beta/accountSummaries") {
    expect(u.searchParams.get("pageSize")).toBe("200");
    return u.searchParams.get("pageToken") === "p2"
      ? J({ accountSummaries: [{ name: "accountSummaries/2", account: "accounts/2", displayName: "Second Co", propertySummaries: [{ property: "properties/300", displayName: "Old" }] }] })
      : J({ accountSummaries: [{ name: "accountSummaries/1", account: "accounts/1", displayName: "Shop Co", propertySummaries: [{ property: "properties/100", displayName: "Shop GA4" }, { property: "properties/200", displayName: "App GA4" }] }], nextPageToken: "p2" });
  }
  const prop = u.pathname.match(/^\/v1beta\/properties\/(\d+)$/);
  if (u.hostname === "analyticsadmin.googleapis.com" && prop) {
    if (b.deniedProperties?.includes(prop[1]!)) return J({ error: { code: 403, status: "PERMISSION_DENIED", message: "no access" } }, 403);
    const units: Record<string, { currencyCode?: string; timeZone?: string }> = { "100": { currencyCode: "EUR", timeZone: "Europe/Berlin" }, "200": { currencyCode: "USD", timeZone: "America/Los_Angeles" }, "300": {} };
    return J({ name: `properties/${prop[1]}`, displayName: prop[1] === "100" ? "Shop GA4" : `P${prop[1]}`, ...units[prop[1]!] });
  }
  // ---- Tag Manager: accounts.list, then containers.list per account
  if (u.href === "https://tagmanager.googleapis.com/tagmanager/v2/accounts") return J({ account: [{ path: "accounts/1", accountId: "1", name: "Shop" }, { path: "accounts/9", accountId: "9", name: "Locked" }] });
  if (u.href === "https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers") return J({ container: [{ path: "accounts/1/containers/2", containerId: "2", name: "www", publicId: "GTM-ABC123" }] });
  if (u.href === "https://tagmanager.googleapis.com/tagmanager/v2/accounts/9/containers") return J({ error: { code: 403, status: "PERMISSION_DENIED", message: "no" } }, 403);
  return J({ error: { message: `unexpected request: ${url}` } }, 500);
};

let db: Db;
let owner: Actor;
let member: Actor;
let tenantId: string;
const cipher = testCipher();
let oauth: PlatformOAuth;
const cfg = { publicUrl: "https://mcp.example.com", google: { clientId: "gid", clientSecret: "gsecret", apiVersion: "v99" } };

beforeAll(async () => {
  db = await testDb();
  const t = await seedTenant(db, "GP", "owner");
  tenantId = t.tenant.id;
  owner = { tenantId, userId: t.user.id, role: "owner" };
  member = { tenantId, userId: (await addUser(db, tenantId, "gp-member", "member")).id, role: "member" };
});
beforeEach(() => {
  calls.length = 0;
  b = {};
  oauth = new PlatformOAuth(db, cipher, cfg, { fetch: fakeFetch });
});

const stateFrom = (url: string) => new URL(url).searchParams.get("state")!;
const cb = (state: string) => new URLSearchParams({ state, code: "auth-code" });
const accountsOf = async (connectionId: string) => (await db.select().from(schema.connectedAccount).where(eq(schema.connectedAccount.connectionId, connectionId))).sort((x, y) => x.externalId.localeCompare(y.externalId));
const scopesOf = async (platform: Parameters<PlatformOAuth["start"]>[0], access: "read" | "write") => new URL(await oauth.start(platform, owner, access)).searchParams.get("scope")!.split(" ");
const connect = async (platform: Parameters<PlatformOAuth["start"]>[0], access: "read" | "write", scopes: string[]) => {
  b.scopes = ["openid", "email", ...scopes.map((s) => AUTH + s)].join(" ");
  return oauth.finish(platform, owner, cb(stateFrom(await oauth.start(platform, owner, access))));
};

describe("Connect buttons ask only for their product's scopes", () => {
  it("each product has its own callback and scope set, with PKCE and offline access, never another product's scopes", async () => {
    expect(await scopesOf("google_search_console", "read")).toEqual([AUTH + "webmasters.readonly", "openid", "email"]);
    expect(await scopesOf("google_search_console", "write")).toEqual([AUTH + "webmasters", "openid", "email"]);
    expect(await scopesOf("google_analytics", "read")).toEqual([AUTH + "analytics.readonly", "openid", "email"]);
    // The Data API takes analytics.readonly (not analytics.edit), so write asks for both.
    expect(await scopesOf("google_analytics", "write")).toEqual([AUTH + "analytics.readonly", AUTH + "analytics.edit", "openid", "email"]);
    expect(await scopesOf("google_tag_manager", "read")).toEqual([AUTH + "tagmanager.readonly", "openid", "email"]);
    expect(await scopesOf("google_tag_manager", "write")).toEqual([AUTH + "tagmanager.readonly", AUTH + "tagmanager.edit.containers", AUTH + "tagmanager.edit.containerversions", AUTH + "tagmanager.publish", "openid", "email"]);
    for (const [platform, slug] of [["google_search_console", "gsc"], ["google_analytics", "ga4"], ["google_tag_manager", "gtm"]] as const) {
      const p = new URL(await oauth.start(platform, owner, "read")).searchParams;
      expect(p.get("redirect_uri")).toBe(`https://mcp.example.com/connect/${slug}/callback`);
      expect(p.get("access_type")).toBe("offline");
      expect(p.get("code_challenge_method")).toBe("S256");
      expect(p.get("include_granted_scopes")).toBeNull(); // separate grants: disconnecting one never affects another
      expect(p.get("scope")).not.toContain("adwords");
    }
  });

  it("members cannot connect; without Google OAuth configured the products are unavailable", async () => {
    await expect(oauth.start("google_analytics", member, "read")).rejects.toMatchObject({ code: "permission_denied" });
    const bare = new PlatformOAuth(db, cipher, { publicUrl: cfg.publicUrl }, { fetch: fakeFetch });
    expect(bare.enabled("google_tag_manager")).toBe(false);
    await expect(bare.start("google_search_console", owner, "read")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("a state started for one product cannot finish another", async () => {
    const s = stateFrom(await oauth.start("google_search_console", owner, "read"));
    await expect(oauth.finish("google_analytics", owner, cb(s))).rejects.toThrow(/expired or was already used/);
  });
});

describe("granted scopes are checked on the callback", () => {
  it("refuses, storing nothing, when the needed scopes were not all granted", async () => {
    const count = async () => (await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.tenantId, tenantId))).length;
    const before = await count();
    await expect(connect("google_search_console", "read", [])).rejects.toThrow(/Search Console permission was not granted \(webmasters.readonly\)/);
    // readonly granted, but write was chosen
    await expect(connect("google_search_console", "write", ["webmasters.readonly"])).rejects.toThrow(/webmasters\)/);
    // analytics.edit alone cannot run reports: write needs analytics.readonly too
    await expect(connect("google_analytics", "write", ["analytics.edit"])).rejects.toThrow(/analytics.readonly/);
    await expect(connect("google_tag_manager", "write", ["tagmanager.readonly", "tagmanager.edit.containers"])).rejects.toThrow(/permissions were not granted \(tagmanager.edit.containerversions, tagmanager.publish\)/);
    // another product's scope is not a substitute
    await expect(connect("google_analytics", "read", ["webmasters.readonly"])).rejects.toMatchObject({ code: "permission_denied" });
    expect(await count()).toBe(before);
  });
});

describe("discovery", () => {
  it("Search Console: one account per verified site, external id exactly as the API returned it; unverified sites are skipped", async () => {
    const r = await connect("google_search_console", "read", ["webmasters.readonly"]);
    expect(r).toMatchObject({ accounts: 2, skipped: 1, access: "read" });
    const accs = await accountsOf(r.connectionId);
    expect(accs.map((a) => [a.platform, a.externalId, a.displayName, a.access, a.currencyCode, a.timeZone])).toEqual([
      ["google_search_console", "https://shop.example/", "https://shop.example/", "read", null, null],
      ["google_search_console", "sc-domain:shop.example", "sc-domain:shop.example", "read", null, null],
    ]);
    // the token travels only in the Authorization header
    const api = calls.filter((c) => c.url.includes("googleapis.com/webmasters"));
    expect(api).toHaveLength(1);
    expect(api[0]!.headers.authorization).toBe("Bearer ya29.product-access");
    expect(api[0]!.url).not.toContain("ya29");
    // tools can name a site by its URL
    expect((await resolveAccount(db, tenantId, "sc-domain:shop.example", "google_search_console", false)).id).toBe(accs[1]!.id);
  });

  it("GA4: every property across paged account summaries, with the currency and time zone from properties.get", async () => {
    const r = await connect("google_analytics", "write", ["analytics.readonly", "analytics.edit"]);
    expect(r).toMatchObject({ accounts: 3, skipped: 0, access: "write" });
    const accs = await accountsOf(r.connectionId);
    expect(accs.map((a) => [a.externalId, a.displayName, a.currencyCode, a.timeZone, a.access])).toEqual([
      ["properties/100", "Shop GA4 (Shop Co)", "EUR", "Europe/Berlin", "write"],
      ["properties/200", "P200 (Shop Co)", "USD", "America/Los_Angeles", "write"],
      ["properties/300", "P300 (Second Co)", null, null, "write"], // not reported: stays null, never guessed
    ]);
    const [conn] = await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, r.connectionId));
    expect(conn!.platform).toBe("google_analytics");
    expect(conn!.grantedScopes).toEqual(expect.arrayContaining([AUTH + "analytics.readonly", AUTH + "analytics.edit"]));
    expect(conn!.externalUserId).toBe("seo@example.com");
    expect(conn!.credentialsEnc).not.toContain("product-refresh");
    expect(cipher.decrypt<{ refreshToken: string }>(conn!.credentialsEnc, credentialAad(tenantId, conn!.id)).refreshToken).toBe("1//product-refresh-token-secret");
    // "123" and "properties/123" both name a property
    expect((await resolveAccount(db, tenantId, "200", "google_analytics", true)).externalId).toBe("properties/200");
    expect((await resolveAccount(db, tenantId, "properties/100", "google_analytics", false)).currencyCode).toBe("EUR");
  });

  it("GA4: a property the user cannot read is skipped; an outage fails the connection and stores nothing", async () => {
    const fresh = await seedTenant(db, "GP2", "owner");
    const who: Actor = { tenantId: fresh.tenant.id, userId: fresh.user.id, role: "owner" };
    b = { deniedProperties: ["200"], scopes: `openid ${AUTH}analytics.readonly` };
    const r = await oauth.finish("google_analytics", who, cb(stateFrom(await oauth.start("google_analytics", who, "read"))));
    expect(r).toMatchObject({ accounts: 2, skipped: 1 });

    const other = await seedTenant(db, "GP3", "owner");
    const them: Actor = { tenantId: other.tenant.id, userId: other.user.id, role: "owner" };
    b = { apiStatus: 503, scopes: `openid ${AUTH}analytics.readonly` };
    await expect(oauth.finish("google_analytics", them, cb(stateFrom(await oauth.start("google_analytics", them, "read"))))).rejects.toMatchObject({ code: "transient" });
    expect(await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.tenantId, other.tenant.id))).toHaveLength(0);
    expect(await db.select().from(schema.connectedAccount).where(eq(schema.connectedAccount.tenantId, other.tenant.id))).toHaveLength(0);
  });

  it("Tag Manager: one account per container (path as external id); an account without container access is skipped", async () => {
    const r = await connect("google_tag_manager", "read", ["tagmanager.readonly"]);
    expect(r).toMatchObject({ accounts: 1, skipped: 1 });
    const accs = await accountsOf(r.connectionId);
    expect(accs.map((a) => [a.platform, a.externalId, a.displayName, a.currencyCode])).toEqual([["google_tag_manager", "accounts/1/containers/2", "www (GTM-ABC123) · Shop", null]]);
    expect((await resolveAccount(db, tenantId, "accounts/1/containers/2", "google_tag_manager", false)).id).toBe(accs[0]!.id);
    // a container path never resolves on another platform
    await expect(resolveAccount(db, tenantId, "accounts/1/containers/2", "google_analytics", false)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("disconnect", () => {
  it("revokes the product's own refresh token, wipes it and removes its accounts, leaving other Google connections alone", async () => {
    const gsc = await connect("google_search_console", "read", ["webmasters.readonly"]);
    const gtm = await connect("google_tag_manager", "read", ["tagmanager.readonly"]);
    calls.length = 0;
    expect((await oauth.disconnect(owner, gsc.connectionId)).revokedAtPlatform).toBe(true);
    const revoke = calls.filter((c) => c.url === "https://oauth2.googleapis.com/revoke");
    expect(revoke).toHaveLength(1);
    expect(new URLSearchParams(revoke[0]!.body).get("token")).toBe("1//product-refresh-token-secret");
    const [conn] = await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, gsc.connectionId));
    expect(conn).toMatchObject({ status: "revoked", credentialsEnc: "revoked" });
    expect(await accountsOf(gsc.connectionId)).toHaveLength(0);
    expect(await accountsOf(gtm.connectionId)).toHaveLength(1);
    expect((await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, gtm.connectionId)))[0]!.status).toBe("active");
  });

  it("still wipes our copy when Google cannot confirm the revocation, and says so", async () => {
    const r = await connect("google_analytics", "read", ["analytics.readonly"]);
    b.revokeOk = false;
    expect((await oauth.disconnect(owner, r.connectionId)).revokedAtPlatform).toBe(false);
    expect((await db.select().from(schema.platformConnection).where(eq(schema.platformConnection.id, r.connectionId)))[0]!.credentialsEnc).toBe("revoked");
  });
});
