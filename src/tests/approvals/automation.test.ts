import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import * as schema from "../../db/schema";
import { AutomationRulesSchema, DEFAULT_RULES, loadRules, matchRules, saveRules, type AutomationRules } from "../../policy/automation";
import { type ChangeSet, moneyChange, statusChange } from "../../policy/change-set";
import { setPassword, startStack, type Stack } from "../support/helpers";
import { googleHarness, type GoogleHarness } from "../support/harness";

const rules = (o: Partial<{ pause: boolean; budget: Partial<AutomationRules["budget"]>; max: number }> = {}): AutomationRules =>
  AutomationRulesSchema.parse({
    pause: { enabled: !!o.pause },
    budget: { enabled: !!o.budget, max_increase_pct: 10, max_increase_amount: 50, allow_decrease: false, ...o.budget },
    max_auto_per_day: o.max ?? 20,
  });
const cs = (...changes: ChangeSet["changes"]): ChangeSet => ({ currency_code: "USD", time_zone: "UTC", operations: changes.length, changes, risk_reason: "" });
const camp = (id = "1") => ({ resource: "campaign", id });
const budget = (from: number, to: number, id = "1") => moneyChange(camp(id), "daily_budget", from * 1e6, to * 1e6);

describe("matching rules (pure)", () => {
  it("everything is off by default", () => {
    expect(DEFAULT_RULES.pause.enabled).toBe(false);
    expect(DEFAULT_RULES.budget.enabled).toBe(false);
    expect(matchRules(DEFAULT_RULES, "write", cs(statusChange(camp(), "ENABLED", "PAUSED"))).rule).toBeNull();
  });

  it("pause rule covers pauses only", () => {
    expect(matchRules(rules({ pause: true }), "write", cs(statusChange(camp(), "ENABLED", "PAUSED"))).rule).toBe("pause");
    expect(matchRules(rules({ pause: true }), "high_impact", cs(statusChange(camp(), "PAUSED", "ENABLED"))).rule).toBeNull(); // enabling never
  });

  it("budget rule: both the percent and the amount limit apply to an increase, inclusive", () => {
    const r = rules({ budget: { max_increase_pct: 10, max_increase_amount: 50 } });
    expect(matchRules(r, "high_impact", cs(budget(100, 110))).rule).toBe("budget"); // exactly +10% and +10
    expect(matchRules(r, "high_impact", cs(budget(100, 111)))).toMatchObject({ rule: null, why: expect.stringContaining("%") });
    expect(matchRules(r, "high_impact", cs(budget(1000, 1060)))).toMatchObject({ rule: null, why: expect.stringContaining("limit of 50") }); // 6% but +60
    expect(matchRules(r, "write", cs(budget(100, 50))).rule).toBeNull(); // decreases need allow_decrease
    expect(matchRules(rules({ budget: { allow_decrease: true } }), "write", cs(budget(100, 50))).rule).toBe("budget");
  });

  it("a change is automated only if every part is covered", () => {
    const both = rules({ pause: true, budget: {} });
    expect(matchRules(both, "high_impact", cs(statusChange(camp("1"), "ENABLED", "PAUSED"), budget(100, 105, "2"))).rule).toBe("budget+pause");
    expect(matchRules(rules({ pause: true }), "high_impact", cs(statusChange(camp("1"), "ENABLED", "PAUSED"), budget(100, 105, "2"))).rule).toBeNull();
  });

  it("never: bids, renames, removals, bulk, unknown current budget, unknown currency, no change set", () => {
    const all = rules({ pause: true, budget: { max_increase_pct: 100, max_increase_amount: 1e6, allow_decrease: true } });
    expect(matchRules(all, "high_impact", cs(moneyChange(camp(), "cpc_bid", 1e6, 2e6))).rule).toBeNull();
    expect(matchRules(all, "write", cs({ ...camp(), field: "name", before: "a", after: "b", unit: "text", effect: "neutral" })).rule).toBeNull();
    expect(matchRules(all, "destructive", cs(statusChange(camp(), "PAUSED", "REMOVED"))).rule).toBeNull();
    expect(matchRules(all, "destructive", cs(statusChange(camp(), "ENABLED", "PAUSED"))).rule).toBeNull(); // destructive tool, whatever the effect
    expect(matchRules(all, "write", cs(...Array.from({ length: 21 }, (_, i) => statusChange(camp(String(i)), "ENABLED", "PAUSED")))).rule).toBeNull();
    expect(matchRules(all, "high_impact", cs(moneyChange(camp(), "daily_budget", null, 5e6))).rule).toBeNull();
    expect(matchRules(all, "high_impact", { ...cs(budget(100, 101)), currency_code: null }).rule).toBeNull();
    expect(matchRules(all, "write", null).rule).toBeNull();
  });
});

// ----------------------------------------------------------------------------------- through the pipeline
const C = "customers/1234567890";
let state: { campaign: string; ad_group: string; budget: string };
let mutations = 0;
let mutateFails = false;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const fake: FetchLike = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.endsWith("googleAds:search")) {
    if (String(body.query).includes("FROM ad_group")) return J({ results: [{ adGroup: { id: "21", name: "Core", status: state.ad_group, resourceName: `${C}/adGroups/21` } }] });
    return J({ results: [{ campaign: { id: "11", name: "Brand", status: state.campaign, resourceName: `${C}/campaigns/11`, campaignBudget: `${C}/campaignBudgets/11` }, campaignBudget: { amountMicros: state.budget, explicitlyShared: false, resourceName: `${C}/campaignBudgets/11` } }] });
  }
  mutations++;
  if (mutateFails) return J({ error: { code: 500, status: "INTERNAL", message: "boom" } }, 500);
  for (const op of body.mutateOperations ?? []) if (op.campaignBudgetOperation) state.budget = op.campaignBudgetOperation.update.amountMicros;
  for (const op of body.operations ?? []) state[url.includes("adGroups") ? "ad_group" : "campaign"] = op.update.status;
  return J({ results: [{}], mutateOperationResponses: [{}] });
};

let kit: GoogleHarness;
const approval = (id: string) => kit.db.select().from(schema.approvalRequest).where(eq(schema.approvalRequest.id, id)).then((r) => r[0]!);
const setRules = (r: AutomationRules) => saveRules(kit.db, kit.tenantId, r, kit.owner);
// Each test starts with no approvals: identical earlier requests would otherwise be deduplicated, and count toward the cap.
const clearToday = () => kit.db.delete(schema.approvalRequest).where(eq(schema.approvalRequest.tenantId, kit.tenantId));

beforeAll(async () => {
  kit = await googleHarness("AU", fake);
});
beforeEach(async () => {
  state = { campaign: "ENABLED", ad_group: "ENABLED", budget: "100000000" };
  mutations = 0;
  mutateFails = false;
  await setRules(DEFAULT_RULES);
  await clearToday();
});

describe("automation rules through the pipeline", () => {
  it("off by default: a pause waits for a person and nothing is sent", async () => {
    const r = await kit.run("pause_campaign", { campaign_id: "11" });
    expect(r.approval?.status).toBe("pending_approval");
    expect(mutations).toBe(0);
  });

  it("with the pause rule on, a pause is applied, confirmed, and recorded as approved by the rule", async () => {
    await setRules(rules({ pause: true }));
    const r = await kit.run("pause_campaign", { campaign_id: "11" });
    expect(r.ok).toBe(true);
    expect(r.approval).toBeUndefined();
    expect(r.data).toEqual({ campaign_id: "11", status: "PAUSED", previous_status: "ENABLED" });
    expect(r.meta.auto_approval).toMatchObject({ rule: "pause", change_set: { changes: [{ effect: "pause" }] } });
    expect(state.campaign).toBe("PAUSED");
    const row = await approval(r.meta.auto_approval!.approval_id);
    expect(row).toMatchObject({ status: "executed", approvedByRule: "pause", decidedBy: null });
    const events = await kit.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.tenantId, kit.tenantId), eq(schema.auditLog.refId, row.id)));
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["approval.requested", "approval.auto_approved", "approval.executed"]));
  });

  it("resuming is never automated, even with every rule on", async () => {
    await setRules(rules({ pause: true, budget: { max_increase_pct: 100, max_increase_amount: 1e6, allow_decrease: true } }));
    state.campaign = "PAUSED";
    const r = await kit.run("resume_campaign", { campaign_id: "11" });
    expect(r.approval?.status).toBe("pending_approval");
    expect(mutations).toBe(0);
  });

  it("budget increases within limits apply; above them they wait for a person", async () => {
    await setRules(rules({ budget: { max_increase_pct: 10, max_increase_amount: 50 } }));
    const ok = await kit.run("update_campaign", { campaign_id: "11", daily_budget: 110 });
    expect(ok.meta.auto_approval?.rule).toBe("budget");
    expect(state.budget).toBe("110000000");
    const big = await kit.run("update_campaign", { campaign_id: "11", daily_budget: 200 });
    expect(big.approval).toMatchObject({ status: "pending_approval", risk: "high_impact" });
    expect(state.budget).toBe("110000000");
  });

  it("the daily cap holds, also under concurrent requests; over the cap a request just waits for a person", async () => {
    await setRules(rules({ pause: true, max: 1 }));
    const [a, b] = await Promise.all([kit.run("pause_campaign", { campaign_id: "11" }), kit.run("pause_ad_group", { ad_group_id: "21" })]);
    const auto = [a, b].filter((e) => e.meta.auto_approval);
    const waiting = [a, b].filter((e) => e.approval?.status === "pending_approval");
    expect(auto).toHaveLength(1);
    expect(waiting).toHaveLength(1);
    expect(mutations).toBe(1);
  });

  it("a cap of zero automates nothing", async () => {
    await setRules(rules({ pause: true, max: 0 }));
    expect((await kit.run("pause_campaign", { campaign_id: "11" })).approval?.status).toBe("pending_approval");
  });

  it("when an automatic change fails after sending, the caller is told the outcome is unconfirmed, never success", async () => {
    await setRules(rules({ pause: true }));
    mutateFails = true;
    const r = await kit.run("pause_campaign", { campaign_id: "11" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("unknown_outcome");
    expect(r.error?.details).toMatchObject({ status: "unknown_outcome" });
    expect((await approval(String(r.error!.details!.approval_id))).approvedByRule).toBe("pause");
  });

  it("rules are per workspace, and a stored value that no longer validates fails closed", async () => {
    await setRules(rules({ pause: true }));
    const other = await googleHarness("AU2", fake);
    expect((await other.run("pause_campaign", { campaign_id: "11" })).approval?.status).toBe("pending_approval");
    await kit.db.update(schema.tenantPolicy).set({ rules: { pause: { enabled: "yes" } } }).where(eq(schema.tenantPolicy.tenantId, kit.tenantId));
    expect(await loadRules(kit.db, kit.tenantId)).toEqual(DEFAULT_RULES);
  });
});

// ----------------------------------------------------------------------------------- settings page
describe("automation settings page", () => {
  let stack: Stack;
  let ownerEmail: string, adminEmail: string;
  beforeAll(async () => {
    stack = await startStack({ ...kit, registry: kit.deps.registry, calls: {} } as never);
    const users = await kit.db.select().from(schema.appUser).where(eq(schema.appUser.tenantId, kit.tenantId));
    for (const u of users) await setPassword(kit.db, u.id);
    ownerEmail = users.find((u) => u.id === kit.owner)!.email;
    adminEmail = users.find((u) => u.id === kit.second)!.email;
  });
  afterAll(() => stack.close());

  const post = (cookie: string, fields: Record<string, string>) =>
    fetch(`${stack.base}/settings/automation`, { method: "POST", redirect: "manual", headers: { cookie, origin: stack.base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

  it("an owner saves rules with a CSRF token; the page then shows them", async () => {
    const cookie = await stack.login(ownerEmail);
    const csrf = await stack.csrfFor(cookie, "/settings/automation", 'action="/settings/automation"');
    const res = await post(cookie, { csrf, pause: "1", budget: "1", max_increase_pct: "15", max_increase_amount: "25", max_auto_per_day: "5" });
    expect(res.status).toBe(303);
    expect(await loadRules(kit.db, kit.tenantId)).toEqual({ pause: { enabled: true }, budget: { enabled: true, max_increase_pct: 15, max_increase_amount: 25, allow_decrease: false }, max_auto_per_day: 5 });
    const html = await (await fetch(`${stack.base}/settings/automation`, { headers: { cookie } })).text();
    expect(html).toContain('name="pause" value="1" checked');
    expect(html).toContain('value="15"');
  });

  it("refuses without CSRF, from another origin, for an admin, and for out-of-range values", async () => {
    const cookie = await stack.login(ownerEmail);
    expect((await post(cookie, { pause: "1" })).status).toBe(403);
    const csrf = await stack.csrfFor(cookie, "/settings/automation", 'action="/settings/automation"');
    const cross = await fetch(`${stack.base}/settings/automation`, { method: "POST", redirect: "manual", headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, pause: "1" }) });
    expect(cross.status).toBe(403);
    const bad = await post(cookie, { csrf, budget: "1", max_increase_pct: "500", max_increase_amount: "1", max_auto_per_day: "1" });
    expect(decodeURIComponent(bad.headers.get("location") ?? "")).toContain("Not saved");

    await setRules(DEFAULT_RULES);
    const adminCookie = await stack.login(adminEmail);
    const adminHtml = await (await fetch(`${stack.base}/settings/automation`, { headers: { cookie: adminCookie } })).text();
    expect(adminHtml).toContain("Only an owner can change these rules.");
    const adminCsrf = await stack.csrfFor(adminCookie, "/settings/automation", 'action="/settings/automation"');
    expect((await post(adminCookie, { csrf: adminCsrf, pause: "1", max_auto_per_day: "5" })).status).toBe(403);
    expect((await loadRules(kit.db, kit.tenantId)).pause.enabled).toBe(false);
  });

  it("no MCP tool can change automation rules", () => {
    const names = kit.deps.registry.list().map((t) => t.name);
    // get/update_asset_automation_settings are Google Ads campaign settings (Google generating assets), not approval automation.
    expect(names.filter((n) => /(?<!asset_)automation|tenant_policy|auto_approv/i.test(n))).toEqual([]);
  });
});
