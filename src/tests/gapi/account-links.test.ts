import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { GoogleTokenProvider } from "../../auth/token-providers";
import { type Db, schema } from "../../db";
import { loadInventory } from "../../inventory";
import { type PipelineDeps, runTool } from "../../mcp/pipeline";
import { ToolRegistry } from "../../mcp/registry";
import type { OtherAccount, ReadTool } from "../../mcp/tool";
import { allTools } from "../../platforms";
import type { Ga4Services } from "../../platforms/ga4/services";
import { GoogleApiHttp } from "../../platforms/gapi/http";
import { GoogleAdsHttp } from "../../platforms/google/http";
import type { GscServices } from "../../platforms/gsc/services";
import { createServicesFactory } from "../../platforms/services";
import { ApprovalService } from "../../security/approvals";
import { RateLimiter } from "../../security/rate-limit";
import { addUser, harness, seedAccount, seedTenant, setPassword, startStack, testDb, type Stack } from "../support/helpers";

/**
 * Links between accounts (table account_link): the tool-context helpers combined tools use (ctx.linked, ctx.accountFor),
 * the get_property_links tool, and the Connections page that manages them. Every path must stay inside one workspace.
 */
const link = async (db: Db, tenantId: string, x: string, y: string) => {
  const [a, b] = x < y ? [x, y] : [y, x];
  await db.insert(schema.accountLink).values({ tenantId, accountAId: a, accountBId: b });
};

/** What a probe tool saw through the context helpers. */
interface Seen {
  linkedGsc: OtherAccount<GscServices>[];
  linkedGa4: OtherAccount<Ga4Services>[];
  explicit?: OtherAccount<Ga4Services>;
}

describe("ctx.linked and ctx.accountFor", () => {
  let db: Db;
  let deps: PipelineDeps;
  let seen: Seen;
  let tA: string, uA: string, tB: string;
  let ads: string, site: string, site2: string, prop: string, unlinkedProp: string, foreignProp: string, revokedSite: string, adsWithRevoked: string;
  let explicitArg: string | undefined;

  beforeAll(async () => {
    db = await testDb();
    const a = await seedTenant(db, "LA", "owner");
    tA = a.tenant.id;
    uA = a.user.id;
    tB = (await seedTenant(db, "LB", "owner")).tenant.id;
    ads = (await seedAccount(db, tA, "google_ads")).id;
    site = (await seedAccount(db, tA, "google_search_console", "read", "active", "https://b-shop.example/", null)).id;
    site2 = (await seedAccount(db, tA, "google_search_console", "read", "active", "sc-domain:a-shop.example", null)).id;
    prop = (await seedAccount(db, tA, "google_analytics", "read", "active", "properties/100", { currencyCode: "EUR", timeZone: "Europe/Berlin" })).id;
    unlinkedProp = (await seedAccount(db, tA, "google_analytics", "read", "active", "properties/200")).id;
    foreignProp = (await seedAccount(db, tB, "google_analytics", "write", "active", "properties/999")).id;
    adsWithRevoked = (await seedAccount(db, tA, "google_ads", "read", "active", "2223334444")).id;
    revokedSite = (await seedAccount(db, tA, "google_search_console", "read", "needs_reauth", "https://old.example/")).id;
    await link(db, tA, ads, site);
    await link(db, tA, site2, ads);
    await link(db, tA, ads, prop);
    await link(db, tA, adsWithRevoked, revokedSite);
    // Another workspace links its own property to an id it guessed from ours: the FK allows it, the tenant filter must not.
    await db.insert(schema.accountLink).values({ tenantId: tB, accountAId: ads < foreignProp ? ads : foreignProp, accountBId: ads < foreignProp ? foreignProp : ads });

    // A probe registered under a real inventory name: it records what the helpers return.
    const probe: ReadTool = {
      kind: "read",
      name: "analyze_paid_organic_overlap",
      platform: "google_ads",
      title: "probe",
      description: "Test probe that reads linked accounts through the tool context helpers.",
      input: z.object({ account_id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      permissions: { scope: "ads:read", platformPermissions: ["https://www.googleapis.com/auth/adwords"] },
      handler: async (_a, ctx) => {
        seen = { linkedGsc: await ctx.linked<GscServices>("google_search_console"), linkedGa4: await ctx.linked<Ga4Services>("google_analytics") };
        if (explicitArg) seen.explicit = await ctx.accountFor<Ga4Services>("google_analytics", explicitArg);
        return { ok: true };
      },
    };
    const http = new GoogleApiHttp({ fetch: async () => new Response("{}") });
    deps = {
      db,
      registry: new ToolRegistry(loadInventory()).register(probe),
      approvals: new ApprovalService(db),
      tenantLimiter: new RateLimiter(1000, 1000),
      accountLimiter: new RateLimiter(1000, 1000),
      createServices: createServicesFactory({
        db,
        google: { tokens: { getAccessToken: async () => "tok" } as unknown as GoogleTokenProvider, http: new GoogleAdsHttp({ apiVersion: "v99", fetch: async () => new Response("{}") }) },
        gapi: { tokens: { getAccessToken: async () => "tok" } as unknown as GoogleTokenProvider, http },
      }),
    };
  });

  const run = (accountId: string, explicit?: string) => {
    explicitArg = explicit;
    return runTool(deps, deps.registry.get("analyze_paid_organic_overlap")!, { account_id: accountId }, { tenantId: tA, userId: uA, role: "owner", scopes: ["ads:read"] });
  };

  it("returns the linked accounts of the asked platform, with services built for each, in a stable order", async () => {
    const env = await run(ads);
    expect(env.ok).toBe(true);
    expect(seen.linkedGsc.map((x) => x.account.externalId)).toEqual(["https://b-shop.example/", "sc-domain:a-shop.example"].sort((x, y) => x.localeCompare(y)));
    expect(seen.linkedGsc.map((x) => x.services.gsc.siteUrl)).toEqual(seen.linkedGsc.map((x) => x.account.externalId));
    expect(seen.linkedGa4).toHaveLength(1); // the unlinked property and the other workspace's property are not there
    const [p] = seen.linkedGa4;
    expect(p!.account).toMatchObject({ id: prop, platform: "google_analytics", externalId: "properties/100", currencyCode: "EUR", timeZone: "Europe/Berlin", access: "read" });
    expect(p!.services.ga4).toMatchObject({ property: "properties/100", currencyCode: "EUR", timeZone: "Europe/Berlin" });
    expect(p!.services.mutationsSent()).toBe(0);
    expect(JSON.stringify(p!.account)).not.toContain("connectionId"); // nothing a handler could use to reach credentials
  });

  it("is empty when nothing is linked, and links work from either end", async () => {
    explicitArg = undefined;
    const fresh = (await seedAccount(db, tA, "google_ads", "read", "active", "9998887777")).id;
    await run(fresh);
    expect(seen.linkedGsc).toEqual([]);
    expect(seen.linkedGa4).toEqual([]);
  });

  it("a linked account whose connection needs reauthorization fails clearly instead of being left out", async () => {
    const env = await run(adsWithRevoked);
    expect(env.error).toMatchObject({ code: "auth_expired" });
    expect(env.error!.message).toContain("old.example");
  });

  it("accountFor resolves an explicit id or platform id within the workspace and platform only", async () => {
    await run(ads, "properties/200");
    expect(seen.explicit!.account.id).toBe(unlinkedProp);
    await run(ads, "200");
    expect(seen.explicit!.services.ga4.property).toBe("properties/200");
    await run(ads, unlinkedProp);
    expect(seen.explicit!.account.externalId).toBe("properties/200");
    // another workspace's property, by our id or its platform id, is not_found (never a different error that would confirm it exists)
    for (const foreign of [foreignProp, "properties/999", "999"]) expect((await run(ads, foreign)).error, foreign).toMatchObject({ code: "not_found" });
    // an account of this workspace on another platform is not_found too
    expect((await run(ads, site)).error).toMatchObject({ code: "not_found" });
  });
});

// ------------------------------------------------------------------------------------------------ get_property_links
describe("get_property_links", () => {
  it("lists this workspace's links with both accounts, ad account first, and nothing from other workspaces", async () => {
    const db = await testDb();
    const a = await seedTenant(db, "GL", "owner");
    const b = await seedTenant(db, "GL2", "owner");
    const ads = await seedAccount(db, a.tenant.id, "google_ads");
    const meta = await seedAccount(db, a.tenant.id, "meta_ads");
    const prop = await seedAccount(db, a.tenant.id, "google_analytics");
    const gtm = await seedAccount(db, a.tenant.id, "google_tag_manager");
    const theirs = await seedAccount(db, b.tenant.id, "google_search_console");
    const theirAds = await seedAccount(db, b.tenant.id, "google_ads");
    await link(db, a.tenant.id, prop.id, ads.id);
    await link(db, a.tenant.id, meta.id, prop.id);
    await link(db, a.tenant.id, gtm.id, ads.id);
    await link(db, b.tenant.id, theirs.id, theirAds.id);
    const deps: PipelineDeps = { db, registry: new ToolRegistry(loadInventory()).registerAll(allTools()), approvals: new ApprovalService(db), tenantLimiter: new RateLimiter(100, 100), accountLimiter: new RateLimiter(100, 100), createServices: async () => ({}) };
    const tool = deps.registry.get("get_property_links")!;
    expect(tool.accountScope).toBe("none"); // workspace-level, like list_accounts: no account_id

    const env = await runTool(deps, tool, {}, { tenantId: a.tenant.id, userId: a.user.id, role: "member", scopes: ["ads:read"] });
    expect(env.ok).toBe(true);
    const links = (env.data as { links: { accounts: { account_id: string; platform: string; external_id: string; name: string; status: string }[] }[] }).links;
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.accounts.map((x) => x.platform))).toEqual(expect.arrayContaining([["google_ads", "google_analytics"], ["google_ads", "google_tag_manager"], ["meta_ads", "google_analytics"]]));
    const adsToProp = links.find((l) => l.accounts[0]!.account_id === ads.id && l.accounts[1]!.platform === "google_analytics")!;
    expect(adsToProp.accounts).toEqual([
      { account_id: ads.id, platform: "google_ads", external_id: "1234567890", name: "", status: "active" },
      { account_id: prop.id, platform: "google_analytics", external_id: "properties/123", name: "", status: "active" },
    ]);
    expect(JSON.stringify(links)).not.toContain(theirs.id);
    expect(env.meta.account).toBeUndefined();

    const other = await runTool(deps, tool, {}, { tenantId: b.tenant.id, userId: b.user.id, role: "owner", scopes: ["ads:read"] });
    expect((other.data as { links: unknown[] }).links).toHaveLength(1);
    // disconnecting an account removes its links (cascade)
    await db.delete(schema.connectedAccount).where(eq(schema.connectedAccount.id, gtm.id));
    expect(((await runTool(deps, tool, {}, { tenantId: a.tenant.id, userId: a.user.id, role: "owner", scopes: ["ads:read"] })).data as { links: unknown[] }).links).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------------ Connections page
describe("links on the Connections page", () => {
  let stack: Stack;
  let h: Awaited<ReturnType<typeof harness>>;
  let tenantId: string, otherTenant: string;
  let ownerEmail: string, memberEmail: string;
  let ads: string, prop: string, ads2: string, foreign: string;

  beforeAll(async () => {
    h = await harness();
    const t = await seedTenant(h.db, "LW", "owner");
    tenantId = t.tenant.id;
    const member = await addUser(h.db, tenantId, "lw-member", "member");
    for (const u of [t.user, member]) await setPassword(h.db, u.id);
    ownerEmail = t.user.email;
    memberEmail = member.email;
    ads = (await seedAccount(h.db, tenantId, "google_ads")).id;
    ads2 = (await seedAccount(h.db, tenantId, "google_ads", "read", "active", "5556667777")).id;
    prop = (await seedAccount(h.db, tenantId, "google_analytics")).id;
    otherTenant = (await seedTenant(h.db, "LW2", "owner")).tenant.id;
    foreign = (await seedAccount(h.db, otherTenant, "google_analytics", "write", "active", "properties/555")).id;
    stack = await startStack(h, { platformCfg: { google: { clientId: "gid", clientSecret: "gs", apiVersion: "v99" } } });
  });
  afterAll(() => stack.close());

  const post = (cookie: string, path: string, fields: Record<string, string>, origin = stack.base) =>
    fetch(`${stack.base}${path}`, { method: "POST", redirect: "manual", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  const msg = (res: Response) => decodeURIComponent(res.headers.get("location") ?? "");
  const links = () => h.db.select().from(schema.accountLink).where(eq(schema.accountLink.tenantId, tenantId));

  it("shows the three product Connect buttons, each with read and write choices", async () => {
    const cookie = await stack.login(ownerEmail);
    const html = await (await fetch(`${stack.base}/connections`, { headers: { cookie } })).text();
    for (const [slug, label] of [["gsc", "Search Console"], ["ga4", "Google Analytics"], ["gtm", "Tag Manager"]]) {
      expect(html).toContain(`action="/connect/${slug}/start"`);
      expect(html).toContain(`Connect ${label} (read-only)`);
      expect(html).toContain(`Connect ${label} (allow changes)`);
    }
    const start = await post(cookie, "/connect/ga4/start", { csrf: await stack.csrfFor(cookie, "/connections", "/connect/ga4/start"), access: "write" });
    const google = new URL(start.headers.get("location")!);
    expect(google.hostname).toBe("accounts.google.com");
    expect(google.searchParams.get("redirect_uri")).toBe(`${stack.base}/connect/ga4/callback`);
    expect(google.searchParams.get("scope")).toContain("analytics.edit");
  });

  it("an owner links two accounts with a CSRF token; the pair is stored once, ordered, and shown", async () => {
    const cookie = await stack.login(ownerEmail);
    const csrf = await stack.csrfFor(cookie, "/connections", 'action="/connections/links"');
    expect(msg(await post(cookie, "/connections/links", { csrf, account_a: prop, account_b: ads }))).toContain("Linked.");
    expect(msg(await post(cookie, "/connections/links", { csrf, account_a: ads, account_b: prop }))).toContain("already linked");
    const rows = await links();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountAId < rows[0]!.accountBId).toBe(true);
    const html = await (await fetch(`${stack.base}/connections`, { headers: { cookie } })).text();
    expect(html).toContain(`/connections/links/${rows[0]!.id}/remove`);
    expect(html).toContain("properties/123");
  });

  it("refuses without CSRF, from another origin, for members, for the same account, for two of one product, and for another workspace's account", async () => {
    const cookie = await stack.login(ownerEmail);
    const before = (await links()).length;
    expect((await post(cookie, "/connections/links", { account_a: ads2, account_b: prop })).status).toBe(403);
    const csrf = await stack.csrfFor(cookie, "/connections", 'action="/connections/links"');
    expect((await post(cookie, "/connections/links", { csrf, account_a: ads2, account_b: prop }, "https://evil.example")).status).toBe(403);
    expect(msg(await post(cookie, "/connections/links", { csrf, account_a: ads2, account_b: ads2 }))).toContain("two different accounts");
    expect(msg(await post(cookie, "/connections/links", { csrf, account_a: ads2, account_b: ads }))).toContain("different products");
    expect(msg(await post(cookie, "/connections/links", { csrf, account_a: ads2, account_b: foreign }))).toContain("not found in this workspace");
    expect(await h.db.select().from(schema.accountLink).where(and(eq(schema.accountLink.tenantId, tenantId)))).toHaveLength(before);

    const memberCookie = await stack.login(memberEmail);
    const memberHtml = await (await fetch(`${stack.base}/connections`, { headers: { cookie: memberCookie } })).text();
    expect(memberHtml).not.toContain('action="/connections/links"');
    // even with a valid CSRF token for its own session, a member cannot link
    const { getSession, csrfToken } = await import("../../auth/web-session");
    const memberCsrf = csrfToken((await getSession(h.db, memberCookie))!, "link");
    expect(msg(await post(memberCookie, "/connections/links", { csrf: memberCsrf, account_a: ads2, account_b: prop }))).toContain("Only owners and admins");
    expect((await links()).length).toBe(before);
  });

  it("removing needs the link's own CSRF token and cannot reach another workspace's link", async () => {
    const cookie = await stack.login(ownerEmail);
    // another workspace's link, by id
    const theirAds = (await seedAccount(h.db, otherTenant, "google_ads")).id;
    const [x, y] = theirAds < foreign ? [theirAds, foreign] : [foreign, theirAds];
    const [theirs] = await h.db.insert(schema.accountLink).values({ tenantId: otherTenant, accountAId: x, accountBId: y }).returning();
    const { getSession, csrfToken } = await import("../../auth/web-session");
    const session = (await getSession(h.db, cookie))!;
    expect(msg(await post(cookie, `/connections/links/${theirs!.id}/remove`, { csrf: csrfToken(session, `unlink:${theirs!.id}`) }))).toContain("No such link");
    expect(await h.db.select().from(schema.accountLink).where(eq(schema.accountLink.id, theirs!.id))).toHaveLength(1);

    const [mine] = await links();
    expect((await post(cookie, `/connections/links/${mine!.id}/remove`, { csrf: csrfToken(session, "link") })).status).toBe(403); // token for another purpose
    const csrf = await stack.csrfFor(cookie, "/connections", `/connections/links/${mine!.id}/remove`);
    expect(msg(await post(cookie, `/connections/links/${mine!.id}/remove`, { csrf }))).toContain("Link removed.");
    expect(await links()).toHaveLength(0);
  });
});
