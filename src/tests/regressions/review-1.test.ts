/**
 * Regression tests for the 2026-11-04 code review. Each block reproduces one finding's failure scenario.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiTokenAuthenticator, issueApiToken } from "../../auth/api-token";
import { PlatformOAuth } from "../../auth/platform-oauth";
import { safeFetchJson, safeLookup } from "../../auth/ssrf";
import { type FetchLike, GoogleTokenProvider } from "../../auth/token-providers";
import { type Db, schema } from "../../db";
import { ToolError } from "../../mcp/errors";
import { GoogleAdsClient } from "../../platforms/google/client";
import { GoogleAdsHttp } from "../../platforms/google/http";
import { ApprovalService } from "../../security/approvals";
import { sha256 } from "../../security/canonical";
import { credentialAad } from "../../security/crypto";
import { RateLimiter } from "../../security/rate-limit";
import { harness, seedAccount, seedTenant, setPassword, startStack, testCipher, testDb } from "../support/helpers";
import { googleHarness } from "../support/harness";

const J = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Req = { path: string; query: string; body: Record<string, unknown> };
const fakeGoogle = (handle: (r: Req) => unknown): FetchLike => async (url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  const r = handle({ path: url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, ""), query: String(body.query ?? ""), body });
  return r instanceof Response ? r : J(r);
};

// ------------------------------------------------------------------------------------------------ finding 1
describe("1. SSRF-safe lookup works with Node's all:true lookups", () => {
  const lookup = safeLookup(async () => ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]);
  const call = (opts: unknown) => new Promise<unknown[]>((res) => lookup("x.example.com", opts as never, (...args) => res(args)));

  it("answers an array of {address, family} when Node asks for all addresses", async () => {
    const [err, list] = await call({ all: true, hints: 32 });
    expect(err).toBeNull();
    expect(list).toEqual([{ address: "93.184.215.14", family: 4 }, { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 }]);
  });

  it("answers a single address and family otherwise", async () => {
    expect(await call({})).toEqual([null, "93.184.215.14", 4]);
    expect(await call(4)).toEqual([null, "93.184.215.14", 4]);
  });

  it("still refuses private addresses in both modes", async () => {
    const bad = safeLookup(async () => ["8.8.8.8", "169.254.169.254"]);
    for (const opts of [{ all: true }, {}]) {
      const [err] = await new Promise<unknown[]>((res) => bad("x.example.com", opts as never, (...a) => res(a)));
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("a real https request no longer fails with ERR_INVALID_IP_ADDRESS (the original bug)", async () => {
    const e = await safeFetchJson("https://client.example.com/metadata.json", { resolve: async () => ["93.184.215.14"], timeoutMs: 1500 }).catch((x: unknown) => x as Error & { code?: string });
    // Whatever the network does here (refused, timed out, TLS), it must get past address handling.
    expect((e as { code?: string }).code).not.toBe("ERR_INVALID_IP_ADDRESS");
    expect(String((e as Error).message)).not.toMatch(/Invalid IP address/);
  });
});

// ------------------------------------------------------------------------------------------- findings 2 and 3
describe("2-3. approval requests under concurrency", () => {
  let db: Db;
  let base: { tenantId: string; accountId: string; tool: string; risk: "write"; args: unknown; summary: string; requestedBy: string };
  beforeAll(async () => {
    db = await testDb();
    const t = await seedTenant(db, "RF", "owner");
    const acc = await seedAccount(db, t.tenant.id, "google_ads");
    base = { tenantId: t.tenant.id, accountId: acc.id, tool: "pause_campaign", risk: "write", args: { campaign_id: "1" }, summary: "Pause 1", requestedBy: t.user.id };
  });

  it("2. superseding never overwrites a request an approver claimed meanwhile", async () => {
    const plain = new ApprovalService(db);
    const first = await plain.request({ ...base, args: { campaign_id: "race" }, snapshot: { status: "ENABLED" } });
    // A concurrent approver claims the row between our read and our update.
    const racing = new ApprovalService(db, {
      afterExistingRead: async (tx) => {
        await tx.update(schema.approvalRequest).set({ status: "executing", executingSince: new Date() }).where(eq(schema.approvalRequest.id, first.row.id));
      },
    });
    await expect(racing.request({ ...base, args: { campaign_id: "race" }, snapshot: { status: "PAUSED" } })).rejects.toMatchObject({ code: "conflict" });
    const [row] = await db.select().from(schema.approvalRequest).where(eq(schema.approvalRequest.id, first.row.id));
    // The simulated claim ran inside our transaction, so the refusal rolled it back too. What matters: the row was never
    // overwritten to "expired" with its key freed, and no second request for the same change was queued.
    expect(row!.status).not.toBe("expired");
    expect(row!.idempotencyKey).toBe(first.row.idempotencyKey);
    const sameKey = await db.select().from(schema.approvalRequest).where(eq(schema.approvalRequest.idempotencyKey, row!.idempotencyKey));
    expect(sameKey).toHaveLength(1); // no second request queued for the same change
  });

  it("2. superseding still works when nothing races", async () => {
    const svc = new ApprovalService(db);
    const a = await svc.request({ ...base, args: { campaign_id: "calm" }, snapshot: { s: 1 } });
    const b = await svc.request({ ...base, args: { campaign_id: "calm" }, snapshot: { s: 2 } });
    expect(b.deduplicated).toBe(false);
    expect((await svc.get(base.tenantId, a.row.id))!.status).toBe("expired");
  });

  it("3. an identical request inserted concurrently is returned, not a database error", async () => {
    const args = { campaign_id: "dup" };
    const key = sha256(`${base.tenantId}|${base.accountId}|${base.tool}|${sha256(JSON.stringify(args))}`);
    let winnerId = "";
    const svc = new ApprovalService(db, {
      afterExistingRead: async (tx, k) => {
        // Another request with the same idempotency key commits first.
        const [w] = await tx.insert(schema.approvalRequest).values({ ...base, args, argsHash: "x", idempotencyKey: k, expiresAt: new Date(Date.now() + 3_600_000) }).returning();
        winnerId = w!.id;
      },
    });
    const out = await svc.request({ ...base, args, snapshot: null });
    expect(out.deduplicated).toBe(true);
    expect(out.row.id).toBe(winnerId);
    void key;
  });
});

// ------------------------------------------------------------------------------------------------ finding 4
describe("4. a token failure is not counted as a sent change", () => {
  const httpOk = new GoogleAdsHttp({ apiVersion: "v99", sleep: async () => {}, fetch: async () => J({ results: [{}] }) });
  const httpDown = new GoogleAdsHttp({ apiVersion: "v99", sleep: async () => {}, fetch: async () => { throw new Error("reset"); } });

  it("credentials failing before the send leaves mutationsSent at 0", async () => {
    const c = new GoogleAdsClient({ http: httpOk, customerId: "1", loginCustomerId: null, getAccessToken: async () => { throw new ToolError("transient", "token endpoint down"); } });
    await expect(c.mutate("campaigns", [{ update: {} }])).rejects.toMatchObject({ code: "transient" });
    expect(c.mutationsSent).toBe(0);
    await expect(c.mutateBatch([{ campaignOperation: {} }])).rejects.toMatchObject({ code: "transient" });
    expect(c.mutationsSent).toBe(0);
  });

  it("a failure after the send still counts (outcome unknown)", async () => {
    const c = new GoogleAdsClient({ http: httpDown, customerId: "1", loginCustomerId: null, getAccessToken: async () => "tok" });
    await expect(c.mutate("campaigns", [{ update: {} }])).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(c.mutationsSent).toBe(1);
  });

  it("validate-only requests never count", async () => {
    const c = new GoogleAdsClient({ http: httpOk, customerId: "1", loginCustomerId: null, getAccessToken: async () => "tok" });
    await c.mutate("campaigns", [{ update: {} }], { validateOnly: true });
    expect(c.mutationsSent).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ finding 5
describe("5. Google token cache is tenant-scoped and cleared on disconnect", () => {
  it("another tenant never gets a cached token, and disconnect evicts it", async () => {
    const db = await testDb();
    const cipher = testCipher();
    const a = await seedTenant(db, "TA", "owner");
    const b = await seedTenant(db, "TB", "owner");
    const connId = randomUUID();
    await db.insert(schema.platformConnection).values({ id: connId, tenantId: a.tenant.id, platform: "google_ads", credentialsEnc: cipher.encrypt({ refreshToken: "1//r" }, credentialAad(a.tenant.id, connId)).enc, status: "active" });
    let tokenCalls = 0;
    const fetchFake: FetchLike = async (url) => (url.endsWith("/token") ? (tokenCalls++, J({ access_token: "ya29.cached", expires_in: 3600 })) : J({}));
    const tokens = new GoogleTokenProvider({ db, cipher, clientId: "c", clientSecret: "s", fetch: fetchFake });

    expect(await tokens.getAccessToken(a.tenant.id, connId)).toBe("ya29.cached");
    await expect(tokens.getAccessToken(b.tenant.id, connId)).rejects.toMatchObject({ code: "not_found" }); // cache hit must not bypass the tenant check
    expect(await tokens.getAccessToken(a.tenant.id, connId)).toBe("ya29.cached");
    expect(tokenCalls).toBe(1);

    const platform = new PlatformOAuth(db, cipher, { publicUrl: "https://mcp.example.com", google: { clientId: "c", clientSecret: "s", apiVersion: "v99" } }, { fetch: fetchFake, onRevoked: (id) => tokens.forget(id) });
    await platform.disconnect({ tenantId: a.tenant.id, userId: a.user.id, role: "owner" }, connId);
    await expect(tokens.getAccessToken(a.tenant.id, connId)).rejects.toMatchObject({ code: "auth_expired" }); // evicted, and the connection is revoked
  });
});

// ------------------------------------------------------------------------------------------------ finding 6
describe("6. performance totals cover every matching row, not just the returned page", () => {
  const camp = (id: number, cost: number) => ({ campaign: { id: String(id), name: `C${id}`, status: "ENABLED" }, metrics: { impressions: "100", clicks: "10", costMicros: String(cost * 1e6), conversions: 1, conversionsValue: 20 } });
  const all = [camp(1, 60), camp(2, 50), camp(3, 40), camp(4, 30), camp(5, 20), camp(6, 10)];

  it("get_campaign_performance: truncated page, totals over all six campaigns", async () => {
    const queries: string[] = [];
    const h = await googleHarness("tot", fakeGoogle((r) => (queries.push(r.query), { results: r.query.includes("ORDER BY") ? all.slice(0, 4) : all })));
    const env = await h.run("get_campaign_performance", { limit: 3 });
    const d = env.data as { campaigns: unknown[]; totals: { cost: number; conversions: number }; totals_scope: string; truncated: boolean };
    expect(d.campaigns).toHaveLength(3);
    expect(d.truncated).toBe(true);
    expect(d.totals.cost).toBe(210); // all six, not the 150 of the three shown
    expect(d.totals.conversions).toBe(6);
    expect(d.totals_scope).toBe("all_matching");
    expect(queries).toHaveLength(2);
  });

  it("no extra query when nothing was truncated", async () => {
    const queries: string[] = [];
    const h = await googleHarness("tot2", fakeGoogle((r) => (queries.push(r.query), { results: all.slice(0, 2) })));
    const d = (await h.run("get_campaign_performance", { limit: 10 })).data as { totals: { cost: number }; totals_scope: string };
    expect(d.totals.cost).toBe(110);
    expect(d.totals_scope).toBe("all_matching");
    expect(queries).toHaveLength(1);
  });

  it("get_ad_performance: same rule", async () => {
    const ad = (id: number, cost: number) => ({ adGroup: { id: "9" }, adGroupAd: { ad: { id: String(id) }, status: "ENABLED" }, metrics: { impressions: "10", clicks: "1", costMicros: String(cost * 1e6), conversions: 0, conversionsValue: 0 } });
    const ads = [ad(1, 5), ad(2, 4), ad(3, 3)];
    const h = await googleHarness("tot3", fakeGoogle((r) => ({ results: r.query.includes("ORDER BY") ? ads.slice(0, 2) : ads })));
    const d = (await h.run("get_ad_performance", { limit: 1 })).data as { totals: { cost: number }; totals_scope: string };
    expect(d.totals.cost).toBe(12);
    expect(d.totals_scope).toBe("all_matching");
  });
});

// ------------------------------------------------------------------------------------------------ finding 7
describe("7. login is throttled per account, not only per IP", () => {
  it("rotating source IPs does not reset an account's login budget", async () => {
    const h = await harness();
    const t = await seedTenant(h.db, "LG", "owner");
    await setPassword(h.db, t.user.id);
    const st = await startStack(h, { limiters: { loginAccount: new RateLimiter(3, 0.0001) } });
    st.config.trustProxy = true;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${st.base}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: st.base, "x-forwarded-for": `203.0.113.${i + 1}` }, body: new URLSearchParams({ email: t.user.email, password: "wrong-wrong-wrong", next: "/" }) });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 3)).toEqual([303, 303, 303]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    // Even the right password is refused while the account is throttled.
    const ok = await fetch(`${st.base}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: st.base, "x-forwarded-for": "198.51.100.7" }, body: new URLSearchParams({ email: t.user.email, password: "correct horse battery staple", next: "/" }) });
    expect(ok.status).toBe(429);
    await st.close();
  });
});

// ------------------------------------------------------------------------------------------------ finding 8
describe("8. ad edits survive Google's URL normalization", () => {
  it("a final URL stored with a trailing slash and lower-case host is confirmed as applied", async () => {
    const ad = {
      adGroup: { id: "55" },
      adGroupAd: {
        status: "PAUSED",
        ad: {
          id: "77", type: "RESPONSIVE_SEARCH_AD", resourceName: "customers/1234567890/ads/77", finalUrls: ["https://old.example.com/"],
          responsiveSearchAd: { headlines: [{ text: "A" }, { text: "B" }, { text: "C" }], descriptions: [{ text: "D1" }, { text: "D2" }] },
        },
      },
    };
    const h = await googleHarness("url", fakeGoogle((r) => {
      if (r.path.endsWith("ads:mutate")) {
        if (!r.body.validateOnly) {
          const op = (r.body.operations as { update: { finalUrls?: string[] } }[])[0]!;
          if (op.update.finalUrls) ad.adGroupAd.ad.finalUrls = op.update.finalUrls.map((u) => new URL(u).href); // Google normalizes
        }
        return { results: [{}] };
      }
      return { results: [ad] };
    }));
    const env = await h.run("update_ad_content", { ad_group_id: "55", ad_id: "77", final_urls: ["https://Shop.Example.com"] });
    expect(env.approval?.status).toBe("pending_approval");
    const done = await h.approveAs(env.approval!.approval_id, h.owner);
    expect(done.status).toBe("executed"); // before the fix: unknown_outcome
    expect(ad.adGroupAd.ad.finalUrls).toEqual(["https://shop.example.com/"]);
  });
});

// ------------------------------------------------------------------------------------------------ finding 9
describe("9. API token use is recorded at most once a minute", () => {
  it("skips the write for calls within a minute, then records again", async () => {
    const db = await testDb();
    const t = await seedTenant(db, "AT", "owner");
    const { token, id } = await issueApiToken(db, { tenantId: t.tenant.id, userId: t.user.id, label: "x", scopes: ["ads:read"] });
    let now = new Date("2026-11-04T10:00:00Z");
    const auth = new ApiTokenAuthenticator(db, () => now);
    const last = async () => (await db.select().from(schema.apiToken).where(eq(schema.apiToken.id, id)))[0]!.lastUsedAt!.toISOString();
    const hdr = { authorization: `Bearer ${token}` };
    await auth.authenticate(hdr);
    expect(await last()).toBe("2026-11-04T10:00:00.000Z");
    now = new Date("2026-11-04T10:00:30Z");
    expect(await auth.authenticate(hdr)).not.toBeNull();
    expect(await last()).toBe("2026-11-04T10:00:00.000Z"); // no write
    now = new Date("2026-11-04T10:01:31Z");
    await auth.authenticate(hdr);
    expect(await last()).toBe("2026-11-04T10:01:31.000Z");
  });
});

// ----------------------------------------------------------------------------------------------- finding 10
describe("10. keyword checks are complete or refused", () => {
  const kw = (i: number) => ({ adGroupCriterion: { criterionId: String(i), keyword: { text: `kw ${i}`, matchType: "EXACT" }, status: "ENABLED" } });

  it("removal reads exactly the requested criteria, so ids beyond 5,000 are found", async () => {
    const queries: string[] = [];
    const h = await googleHarness("kwrm", fakeGoogle((r) => {
      queries.push(r.query);
      if (r.query.includes("FROM ad_group ")) return { results: [{ adGroup: { id: "55", status: "ENABLED" } }] };
      if (r.query.includes("FROM ad_group_criterion")) return { results: r.query.includes("criterion_id IN (7777)") ? [kw(7777)] : [] };
      return { results: [] };
    }));
    const env = await h.run("remove_keywords", { ad_group_id: "55", criterion_ids: ["7777"] });
    expect(env.approval?.status).toBe("pending_approval");
    expect(queries.some((q) => q.includes("ad_group_criterion.criterion_id IN (7777)"))).toBe(true);
  });

  it("adding to an ad group with 10,000+ keywords is refused instead of checking duplicates partially", async () => {
    const big = Array.from({ length: 10_000 }, (_, i) => kw(i + 1));
    const h = await googleHarness("kwadd", fakeGoogle((r) => {
      if (r.query.includes("FROM ad_group ")) return { results: [{ adGroup: { id: "55", status: "ENABLED" } }] };
      if (r.query.includes("FROM ad_group_criterion")) return { results: big };
      return { results: [] };
    }));
    const env = await h.run("add_keywords", { ad_group_id: "55", keywords: [{ text: "new one", match_type: "EXACT" }] });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("unsupported");
    expect(await h.db.select().from(schema.approvalRequest)).toHaveLength(0); // nothing queued
  });
});
