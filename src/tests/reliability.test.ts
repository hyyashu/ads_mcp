import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Db, schema } from "../db";
import { ToolError } from "../mcp/errors";
import { createVerifier } from "../mcp/pipeline";
import { GoogleAdsHttp, mapGoogleError } from "../platforms/google/http";
import { ApprovalService } from "../security/approvals";
import { DbRateLimiter } from "../security/rate-limit-db";
import { harness, seedAccount, seedTenant, testDb, type Harness } from "./helpers";

// ------------------------------------------------------------------ shared rate limiter ----
describe("database-backed rate limiter (shared across instances)", () => {
  let db: Db;
  let clock = new Date("2026-11-02T12:00:00Z");
  const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
  beforeAll(async () => {
    db = await testDb();
  });
  beforeEach(() => {
    clock = new Date("2026-11-02T12:00:00Z");
  });
  const lim = (ns: string, cap = 3, rate = 1) => new DbRateLimiter(db, { namespace: ns, capacity: cap, refillPerSecond: rate, now: () => clock });

  it("allows a burst, refuses with a retry hint, then refills", async () => {
    const l = lim("a");
    expect([(await l.take("k")).ok, (await l.take("k")).ok, (await l.take("k")).ok]).toEqual([true, true, true]);
    const denied = await l.take("k");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryAfterSeconds).toBe(1);
    advance(2000);
    expect((await l.take("k")).ok).toBe(true);
    expect((await l.take("k")).ok).toBe(true);
    expect((await l.take("k")).ok).toBe(false);
  });

  it("never lets concurrent callers exceed the capacity", async () => {
    const l = lim("conc", 5, 0.0001);
    const results = await Promise.all(Array.from({ length: 25 }, () => l.take("k")));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
  });

  it("two limiter instances share one budget (multi-instance deployments)", async () => {
    const a = lim("shared", 4, 0.0001);
    const b = lim("shared", 4, 0.0001);
    const results = [];
    for (let i = 0; i < 6; i++) results.push((await (i % 2 ? a : b).take("tenant-1")).ok);
    expect(results.filter(Boolean)).toHaveLength(4);
  });

  it("uses the database clock by default (the production path: no injected time)", async () => {
    const l = new DbRateLimiter(db, { namespace: "dbclock", capacity: 2, refillPerSecond: 0.0001 });
    expect([(await l.take("k")).ok, (await l.take("k")).ok, (await l.take("k")).ok]).toEqual([true, true, false]);
    const results = await Promise.all(Array.from({ length: 10 }, () => new DbRateLimiter(db, { namespace: "dbclock2", capacity: 3, refillPerSecond: 0.0001 }).take("k")));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });

  it("keeps keys and namespaces separate, supports cost > 1, and caps refill at capacity", async () => {
    const l = lim("sep", 3, 10);
    expect((await l.take("x", 3)).ok).toBe(true);
    expect((await l.take("x")).ok).toBe(false);
    expect((await l.take("y")).ok).toBe(true);
    expect((await lim("other", 3, 10).take("x", 3)).ok).toBe(true);
    advance(3_600_000);
    expect((await l.take("x", 3)).ok).toBe(true); // refilled, but only to capacity
    expect((await l.take("x")).ok).toBe(false);
  });

  it("sweep removes idle buckets only", async () => {
    const l = new DbRateLimiter(db, { namespace: "sweep", capacity: 3, refillPerSecond: 1 });
    await l.take("a");
    await db.execute(`UPDATE rate_limit_bucket SET updated_at = now() - interval '2 hours' WHERE key = 'sweep:a'` as never).catch(async () => {
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`UPDATE rate_limit_bucket SET updated_at = now() - interval '2 hours' WHERE key = 'sweep:a'`);
    });
    await l.take("fresh");
    await l.sweep(3600);
    const keys = (await db.select().from(schema.rateLimitBucket)).map((r) => r.key);
    expect(keys).not.toContain("sweep:a");
    expect(keys).toContain("sweep:fresh");
  });
});

// ----------------------------------------------------------------- unknown-outcome reconciliation ----
describe("reconciling unknown mutation outcomes before any retry", () => {
  let h: Harness;
  let now = new Date("2026-11-02T12:00:00Z");
  let svc: ApprovalService;
  let t: Awaited<ReturnType<typeof seedTenant>>;
  let acc: Awaited<ReturnType<typeof seedAccount>>;

  beforeAll(async () => {
    h = await harness();
  });
  beforeEach(async () => {
    now = new Date("2026-11-02T12:00:00Z");
    svc = new ApprovalService(h.db, { now: () => now, ttlMs: 3_600_000, dedupeWindowMs: 600_000, stuckAfterMs: 600_000 });
    t = await seedTenant(h.db, "R", "owner");
    acc = await seedAccount(h.db, t.tenant.id, "google_ads");
    h.calls.execute = 0;
    h.calls.verify = 0;
  });

  const unknown = async (campaign: string) => {
    const { row } = await svc.request({ tenantId: t.tenant.id, accountId: acc.id, tool: "pause_campaign", risk: "write", args: { account_id: acc.id, campaign_id: campaign }, summary: "s", snapshot: { s: 1 }, requestedBy: t.user.id });
    const done = await svc.decide({ tenantId: t.tenant.id, approvalId: row.id, decider: { userId: t.user.id, role: "admin" }, decision: "approve", execute: async () => { throw new ToolError("transient", "connection dropped after send"); } });
    expect(done.status).toBe("unknown_outcome");
    return row;
  };
  const status = async (id: string) => (await svc.get(t.tenant.id, id))?.status;
  const later = (ms: number) => (now = new Date(now.getTime() + ms));

  it("applied: the platform shows the change landed, so it is recorded as executed (and not re-sent)", async () => {
    const row = await unknown("c1");
    later(120_000);
    const tally = await svc.reconcileUnknown(async () => ({ outcome: "applied" }));
    expect(tally.applied).toBeGreaterThanOrEqual(1);
    expect(await status(row.id)).toBe("executed");
    expect((await svc.get(t.tenant.id, row.id))?.result).toMatchObject({ reconcile: { outcome: "applied", checks: 1 } });
    expect(h.calls.execute).toBe(0);
  });

  it("not applied: freed for a NEW human approval, never retried automatically", async () => {
    const row = await unknown("c2");
    later(120_000);
    await svc.reconcileUnknown(async () => ({ outcome: "not_applied" }));
    expect(await status(row.id)).toBe("not_applied");
    expect(h.calls.execute).toBe(0);
    const again = await svc.request({ tenantId: t.tenant.id, accountId: acc.id, tool: "pause_campaign", risk: "write", args: { account_id: acc.id, campaign_id: "c2" }, summary: "s", snapshot: { s: 1 }, requestedBy: t.user.id });
    expect(again.deduplicated).toBe(false);
    expect(again.row.status).toBe("pending"); // waits for a person: nothing auto-approved
  });

  it("indeterminate: stays unknown and keeps blocking an identical request", async () => {
    const row = await unknown("c3");
    later(120_000);
    const tally = await svc.reconcileUnknown(async () => ({ outcome: "indeterminate" }));
    expect(tally.indeterminate).toBeGreaterThanOrEqual(1);
    expect(await status(row.id)).toBe("unknown_outcome");
    await expect(svc.request({ tenantId: t.tenant.id, accountId: acc.id, tool: "pause_campaign", risk: "write", args: { account_id: acc.id, campaign_id: "c3" }, summary: "s", snapshot: { s: 1 }, requestedBy: t.user.id })).rejects.toMatchObject({ code: "conflict" });
  });

  it("a verifier that throws leaves the request unknown", async () => {
    const row = await unknown("c4");
    later(120_000);
    await svc.reconcileUnknown(async () => {
      throw new Error("platform down");
    });
    expect(await status(row.id)).toBe("unknown_outcome");
  });

  it("does not check too early, backs off between checks, and gives up after the maximum", async () => {
    const row = await unknown("c5");
    let checks = 0;
    const verify = async (r: { id: string }) => {
      if (r.id === row.id) checks++; // other tests leave unknown rows in this shared database
      return { outcome: "indeterminate" as const };
    };
    await svc.reconcileUnknown(verify); // too soon after the decision
    expect(checks).toBe(0);
    later(61_000);
    await svc.reconcileUnknown(verify);
    expect(checks).toBe(1);
    later(30_000);
    await svc.reconcileUnknown(verify); // inside the backoff window
    expect(checks).toBe(1);
    for (let i = 0; i < 40; i++) {
      later(7 * 3_600_000);
      await svc.reconcileUnknown(verify);
    }
    expect(checks).toBe(20); // MAX_CHECKS, then left for manual review
    expect(await status(row.id)).toBe("unknown_outcome");
  });

  it("crash recovery end to end: stuck 'executing' -> unknown -> verified against platform state through the real tool", async () => {
    const { row } = await svc.request({ tenantId: t.tenant.id, accountId: acc.id, tool: "pause_campaign", risk: "write", args: { account_id: acc.id, campaign_id: "c6" }, summary: "s", snapshot: { s: 1 }, requestedBy: t.user.id });
    await h.db.update(schema.approvalRequest).set({ status: "executing", executingSince: new Date(now.getTime() - 20 * 60_000), decidedAt: new Date(now.getTime() - 20 * 60_000) }).where(eq(schema.approvalRequest.id, row.id));
    expect(await svc.recoverStuck()).toBe(1);
    expect(await status(row.id)).toBe("unknown_outcome");
    h.calls.verifyOutcome = "applied";
    const verifier = createVerifier(h.deps);
    later(120_000);
    await svc.reconcileUnknown((r) => verifier(r));
    expect(h.calls.verify).toBeGreaterThanOrEqual(1);
    expect(h.calls.execute).toBe(0); // verification only reads: nothing was re-sent
    expect(await status(row.id)).toBe("executed");
  });

  it("an ambiguous failure during approval is recorded and later reconciled", async () => {
    const row = await unknown("c7");
    expect((await svc.get(t.tenant.id, row.id))?.result).toMatchObject({ error: { code: "transient" } });
    later(120_000);
    h.calls.verifyOutcome = "not_applied";
    await svc.reconcileUnknown((r) => createVerifier(h.deps)(r));
    expect(await status(row.id)).toBe("not_applied");
  });
});

// ----------------------------------------------------------------------- Google transport ----
describe("Google Ads transport", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const err = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const seen: { url: string; headers: Record<string, string>; method: string }[] = [];
  const make = (responses: (Response | Error)[]) => {
    seen.length = 0;
    let i = 0;
    return new GoogleAdsHttp({
      apiVersion: "v99",
      sleep: async () => {},
      fetch: async (url, init) => {
        seen.push({ url, headers: init!.headers as Record<string, string>, method: init!.method as string });
        const r = responses[Math.min(i++, responses.length - 1)]!;
        if (r instanceof Error) throw r;
        return r;
      },
    });
  };
  const read = { accessToken: "tok", path: "customers/1/googleAds:search", body: { query: "q" }, idempotent: true };
  const write = { accessToken: "tok", path: "customers/1/campaigns:mutate", body: { operations: [] }, idempotent: false };

  it("requires an explicit, well-formed API version (no silent default)", () => {
    expect(() => new GoogleAdsHttp({ apiVersion: "latest" })).toThrow(/GOOGLE_ADS_API_VERSION/);
    expect(() => new GoogleAdsHttp({ apiVersion: "" })).toThrow();
  });

  it("sends bearer auth and login-customer-id but NO developer token", async () => {
    const http = make([ok({ results: [] })]);
    await http.call({ ...read, loginCustomerId: "123-456-7890" });
    expect(seen[0]!.url).toBe("https://googleads.googleapis.com/v99/customers/1/googleAds:search");
    expect(seen[0]!.headers.authorization).toBe("Bearer tok");
    expect(seen[0]!.headers["login-customer-id"]).toBe("1234567890");
    expect(Object.keys(seen[0]!.headers).map((k) => k.toLowerCase())).not.toContain("developer-token");
  });

  it("retries reads on transient failure, with backoff, then succeeds", async () => {
    const http = make([err(503, { error: { status: "UNAVAILABLE", message: "x" } }), new Error("reset"), ok({ results: [1] })]);
    expect(await http.call(read)).toEqual({ results: [1] });
    expect(seen).toHaveLength(3);
  });

  it("gives up on reads after three attempts with a transient, retryable error", async () => {
    const http = make([new Error("reset")]);
    await expect(http.call(read)).rejects.toMatchObject({ code: "transient", opts: { retryable: true } });
    expect(seen).toHaveLength(3);
  });

  it("NEVER retries a mutation: a network failure after sending is an unknown outcome", async () => {
    const http = make([new Error("socket hang up"), ok({})]);
    await expect(http.call(write)).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(seen).toHaveLength(1);
  });

  it("a 5xx on a mutation is an unknown outcome (it may have been applied); on a read it is transient", async () => {
    const body = { error: { status: "INTERNAL", message: "boom" } };
    await expect(make([err(500, body)]).call(write)).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(seen).toHaveLength(1);
    await expect(make([err(500, body), err(500, body), err(500, body)]).call(read)).rejects.toMatchObject({ code: "transient" });
  });

  it("a definite 4xx on a mutation is a definite failure, not an unknown outcome", async () => {
    const e = await make([err(400, { error: { status: "INVALID_ARGUMENT", details: [{ errors: [{ errorCode: { campaignError: "DUPLICATE_CAMPAIGN_NAME" }, message: "Campaign name is duplicated" }] }] } })]).call(write).catch((x: unknown) => x as ToolError);
    expect(e).toMatchObject({ code: "invalid_argument" });
    expect((e as ToolError).message).toContain("duplicated");
  });

  it("maps Google error families to stable codes", () => {
    const f = (status: number, errorCode: Record<string, string> | null, st?: string, extra: object = {}) =>
      mapGoogleError(status, { error: { status: st, details: errorCode ? [{ errors: [{ errorCode, message: "m" }], ...extra }] : [] } }, false).code;
    expect(f(401, null)).toBe("auth_expired");
    expect(f(400, { authenticationError: "OAUTH_TOKEN_EXPIRED" })).toBe("auth_expired");
    expect(f(403, { authorizationError: "USER_PERMISSION_DENIED" })).toBe("platform_permission_denied");
    expect(f(429, { quotaError: "RESOURCE_EXHAUSTED" })).toBe("quota_exceeded");
    expect(f(404, null)).toBe("not_found");
    expect(f(400, { requestError: "RESOURCE_NAME_NOT_FOUND" })).toBe("not_found");
    expect(f(409, { concurrentModificationError: "CONCURRENT_MODIFICATION" })).toBe("conflict");
    expect(f(400, null, "INVALID_ARGUMENT")).toBe("invalid_argument");
    expect(f(418, null)).toBe("internal");
  });

  it("surfaces the retry delay Google asks for", () => {
    const e = mapGoogleError(429, { error: { status: "RESOURCE_EXHAUSTED", details: [{ retryDelay: "17s" }] } }, false);
    expect(e).toMatchObject({ code: "quota_exceeded", opts: { retryAfterSeconds: 17 } });
  });

  it("never leaks tokens from upstream error text", () => {
    const e = mapGoogleError(403, { error: { status: "PERMISSION_DENIED", message: "bad Bearer ya29.A0ARrdaMsecretsecretsecret and 1//0gREFRESHREFRESHREFRESHREFRESH" } }, false);
    expect(e.message).not.toMatch(/ya29|1\/\/0g/);
  });
});
