import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { schema, type Db } from "../db";
import { ToolError } from "../mcp/errors";
import { ApprovalService } from "../security/approvals";
import { addUser, seedAccount, seedTenant, testDb } from "./helpers";

let db: Db;
let now = new Date("2026-11-02T12:00:00Z");
let svc: ApprovalService;
let t1: Awaited<ReturnType<typeof seedTenant>>;
let acc1: Awaited<ReturnType<typeof seedAccount>>;

const base = () => ({ tenantId: t1.tenant.id, accountId: acc1.id, tool: "pause_campaign", risk: "write" as const, args: { campaign_id: "1" }, summary: "Pause 1", snapshot: { s: 1 }, requestedBy: t1.user.id });
const asAdmin = (u = t1.user) => ({ userId: u.id, role: "admin" as const });

beforeAll(async () => {
  db = await testDb();
});

beforeEach(async () => {
  now = new Date("2026-11-02T12:00:00Z");
  svc = new ApprovalService(db, { now: () => now, ttlMs: 3600_000, dedupeWindowMs: 600_000, stuckAfterMs: 600_000 });
  t1 = await seedTenant(db, "t1", "owner");
  acc1 = await seedAccount(db, t1.tenant.id, "google_ads");
});

describe("approval requests", () => {
  it("creates a pending request with an expiry and a state snapshot", async () => {
    const { row, deduplicated } = await svc.request(base());
    expect(deduplicated).toBe(false);
    expect(row.status).toBe("pending");
    expect(row.expiresAt.getTime()).toBe(now.getTime() + 3600_000);
    expect(row.planSnapshot).toEqual({ s: 1 });
  });

  it("is idempotent: the same change requested twice is one request", async () => {
    const a = await svc.request(base());
    const b = await svc.request({ ...base(), args: { campaign_id: "1" } });
    expect(b.deduplicated).toBe(true);
    expect(b.row.id).toBe(a.row.id);
    const c = await svc.request({ ...base(), args: { campaign_id: "2" } });
    expect(c.row.id).not.toBe(a.row.id);
  });

  it("does not treat another tenant's identical change as a duplicate", async () => {
    const t2 = await seedTenant(db, "t2", "owner");
    const acc2 = await seedAccount(db, t2.tenant.id, "google_ads");
    const a = await svc.request(base());
    const b = await svc.request({ ...base(), tenantId: t2.tenant.id, accountId: acc2.id, requestedBy: t2.user.id });
    expect(b.row.id).not.toBe(a.row.id);
  });
});

describe("decisions", () => {
  it("approve executes exactly once and records the result", async () => {
    const { row } = await svc.request(base());
    let runs = 0;
    const done = await svc.decide({ tenantId: row.tenantId, approvalId: row.id, decider: asAdmin(), decision: "approve", execute: async () => (runs++, { ok: 1 }) });
    expect(done.status).toBe("executed");
    expect(done.result).toEqual({ ok: 1 });
    expect(done.decidedBy).toBe(t1.user.id);
    await expect(svc.decide({ tenantId: row.tenantId, approvalId: row.id, decider: asAdmin(), decision: "approve", execute: async () => (runs++, {}) })).rejects.toMatchObject({ code: "conflict" });
    expect(runs).toBe(1);
  });

  it("concurrent approvals execute once", async () => {
    const { row } = await svc.request(base());
    let runs = 0;
    const go = () => svc.decide({ tenantId: row.tenantId, approvalId: row.id, decider: asAdmin(), decision: "approve", execute: async () => (runs++, await new Promise((r) => setTimeout(r, 30)), {}) }).then(() => "ok", (e: ToolError) => e.code);
    const results = await Promise.all([go(), go(), go()]);
    expect(runs).toBe(1);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
  });

  it("reject never executes", async () => {
    const { row } = await svc.request(base());
    let runs = 0;
    const done = await svc.decide({ tenantId: row.tenantId, approvalId: row.id, decider: asAdmin(), decision: "reject", execute: async () => (runs++, {}) });
    expect(done.status).toBe("rejected");
    expect(runs).toBe(0);
  });

  it("members cannot decide", async () => {
    const { row } = await svc.request(base());
    const member = await addUser(db, t1.tenant.id, "m", "member");
    await expect(svc.decide({ tenantId: row.tenantId, approvalId: row.id, decider: { userId: member.id, role: "member" }, decision: "approve", execute: async () => ({}) })).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("high-impact and destructive changes need a different approver than the requester", async () => {
    for (const risk of ["high_impact", "destructive"] as const) {
      const { row } = await svc.request({ ...base(), risk, args: { campaign_id: risk } });
      await expect(svc.decide({ tenantId: row.tenantId, approvalId: row.id, decider: asAdmin(t1.user), decision: "approve", execute: async () => ({}) })).rejects.toMatchObject({ code: "permission_denied" });
      const other = await addUser(db, t1.tenant.id, `admin-${risk}`, "admin");
      const done = await svc.decide({ tenantId: row.tenantId, approvalId: row.id, decider: asAdmin(other), decision: "approve", execute: async () => ({}) });
      expect(done.status).toBe("executed");
    }
  });

  it("another tenant cannot see or decide the request", async () => {
    const { row } = await svc.request(base());
    const t2 = await seedTenant(db, "t2", "owner");
    await expect(svc.decide({ tenantId: t2.tenant.id, approvalId: row.id, decider: asAdmin(t2.user), decision: "approve", execute: async () => ({}) })).rejects.toMatchObject({ code: "not_found" });
    expect(await svc.get(t2.tenant.id, row.id)).toBeNull();
    expect((await svc.get(t1.tenant.id, row.id))?.status).toBe("pending");
  });

  it("an expired request cannot be approved", async () => {
    const { row } = await svc.request(base());
    now = new Date(now.getTime() + 2 * 3600_000);
    let runs = 0;
    await expect(svc.decide({ tenantId: row.tenantId, approvalId: row.id, decider: asAdmin(), decision: "approve", execute: async () => (runs++, {}) })).rejects.toMatchObject({ code: "conflict" });
    expect(runs).toBe(0);
    expect((await svc.get(row.tenantId, row.id))?.status).toBe("expired");
  });
});

describe("failure handling", () => {
  it("a definite platform rejection is 'failed' (no change was made)", async () => {
    const { row } = await svc.request(base());
    const done = await svc.decide({ tenantId: row.tenantId, approvalId: row.id, decider: asAdmin(), decision: "approve", execute: async () => { throw new ToolError("platform_permission_denied", "no access"); } });
    expect(done.status).toBe("failed");
  });

  it("an ambiguous failure is 'unknown_outcome', and the same change cannot be silently retried", async () => {
    const { row } = await svc.request(base());
    const done = await svc.decide({ tenantId: row.tenantId, approvalId: row.id, decider: asAdmin(), decision: "approve", execute: async () => { throw new ToolError("transient", "connection reset after send"); } });
    expect(done.status).toBe("unknown_outcome");
    await expect(svc.request(base())).rejects.toMatchObject({ code: "conflict" });
  });

  it("an unexpected exception is treated as unknown_outcome, never as success", async () => {
    const { row } = await svc.request(base());
    const done = await svc.decide({ tenantId: row.tenantId, approvalId: row.id, decider: asAdmin(), decision: "approve", execute: async () => { throw new Error("boom"); } });
    expect(done.status).toBe("unknown_outcome");
  });

  it("a request stuck 'executing' after a crash becomes unknown_outcome, not a retry", async () => {
    const { row } = await svc.request(base());
    await db.update(schema.approvalRequest).set({ status: "executing", executingSince: new Date(now.getTime() - 20 * 60_000) }).where(eq(schema.approvalRequest.id, row.id));
    expect(await svc.recoverStuck()).toBe(1);
    expect((await svc.get(row.tenantId, row.id))?.status).toBe("unknown_outcome");
    expect(await svc.recoverStuck()).toBe(0);
  });
});

describe("re-requesting", () => {
  it("a rejected change can be requested again", async () => {
    const a = await svc.request(base());
    await svc.decide({ tenantId: a.row.tenantId, approvalId: a.row.id, decider: asAdmin(), decision: "reject", execute: async () => ({}) });
    const b = await svc.request(base());
    expect(b.deduplicated).toBe(false);
    expect(b.row.id).not.toBe(a.row.id);
  });

  it("an executed change is deduplicated inside the window but can legitimately repeat later (pause, resume, pause)", async () => {
    const a = await svc.request(base());
    await svc.decide({ tenantId: a.row.tenantId, approvalId: a.row.id, decider: asAdmin(), decision: "approve", execute: async () => ({}) });
    expect((await svc.request(base())).deduplicated).toBe(true);
    now = new Date(now.getTime() + 30 * 60_000);
    const later = await svc.request(base());
    expect(later.deduplicated).toBe(false);
    expect(later.row.id).not.toBe(a.row.id);
  });
});
