import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteTool } from "../../mcp/tool";
import { type FakeGa4, type Ga4Harness, fakeGa4, ga4Harness, reportOf } from "./fake-ga4";

let f: FakeGa4;
let kit: Ga4Harness;

beforeAll(async () => {
  f = fakeGa4();
  kit = await ga4Harness("G4U", f);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T11:30:00Z"));
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  f.reset();
  f.audiences = [{ name: "properties/123/audiences/1", displayName: "Purchasers", membershipDurationDays: 30 }];
  f.report = () => reportOf(["eventName"], ["eventCount", "keyEvents"], [[["add_to_cart"], ["900", "0"]], [["begin_checkout"], ["300", "0"]]]);
});
const ev = (eventName: string) => ({ eventFilter: { eventName } });
const base = { description: "Remarketing", membership_duration_days: 30 };

describe("create_ga4_audience (v1alpha)", () => {
  it("any: one INCLUDE clause with an andGroup of one orGroup; exclusion clause and mode; v1alpha URL; read back", async () => {
    const r = await kit.run("create_ga4_audience", { ...base, display_name: "Cart abandoners", include_events: ["add_to_cart", "begin_checkout"], exclude_events: ["purchase"] });
    expect(r.approval).toMatchObject({ risk: "write", change_set: { changes: [{ resource: "audience", after: "Cart abandoners", effect: "neutral" }] } });
    expect(r.approval!.summary).toBe(
      'Create audience "Cart abandoners" (Google\'s alpha API): users who triggered add_to_cart or begin_checkout across all sessions, excluding users who triggered purchase (temporarily), membership 30 days. The definition and duration cannot be changed after creation. purchase was not recorded in the last 28 days.',
    );
    expect(f.mutations()).toHaveLength(0);
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done).toMatchObject({ status: "executed", result: { api_version: "v1alpha", display_name: "Cart abandoners", membership_duration_days: 30 } });
    const [post] = f.mutations();
    expect(post!.path).toBe("/v1alpha/properties/123/audiences");
    expect(post!.body).toEqual({
      displayName: "Cart abandoners",
      description: "Remarketing",
      membershipDurationDays: 30,
      filterClauses: [
        { clauseType: "INCLUDE", simpleFilter: { scope: "AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS", filterExpression: { andGroup: { expressions: [{ orGroup: { expressions: [ev("add_to_cart"), ev("begin_checkout")] } }] } } } },
        { clauseType: "EXCLUDE", simpleFilter: { scope: "AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS", filterExpression: { andGroup: { expressions: [{ orGroup: { expressions: [ev("purchase")] } }] } } } },
      ],
      exclusionDurationMode: "EXCLUDE_TEMPORARILY",
    });
  });

  it("all: one orGroup per event; no exclusion means no exclusion mode; permanent exclusion", async () => {
    const r = await kit.run("create_ga4_audience", { ...base, display_name: "Engaged", include_events: ["add_to_cart", "begin_checkout"], include_logic: "all" });
    expect(r.approval!.summary).toContain("users who triggered all of add_to_cart and begin_checkout across all sessions, membership 30 days.");
    await kit.approveAs(r.approval!.approval_id, kit.owner);
    const body = f.mutations()[0]!.body;
    expect(body.filterClauses).toEqual([{ clauseType: "INCLUDE", simpleFilter: { scope: "AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS", filterExpression: { andGroup: { expressions: [{ orGroup: { expressions: [ev("add_to_cart")] } }, { orGroup: { expressions: [ev("begin_checkout")] } }] } } } }]);
    expect(body).not.toHaveProperty("exclusionDurationMode");
    const p = await kit.run("create_ga4_audience", { ...base, display_name: "Never buyers", include_events: ["add_to_cart"], exclude_events: ["purchase", "refund"], exclusion: "permanently" });
    expect(p.approval!.summary).toContain("excluding users who triggered purchase or refund (permanently)");
    await kit.approveAs(p.approval!.approval_id, kit.owner);
    expect(f.mutations()[1]!.body.exclusionDurationMode).toBe("EXCLUDE_PERMANENTLY");
  });

  it("refuses a duplicate name, the Standard limit, overlapping include/exclude, durations over 540", async () => {
    expect((await kit.run("create_ga4_audience", { ...base, display_name: "PURCHASERS", include_events: ["purchase"] })).error!.message).toContain("already exists");
    expect((await kit.run("create_ga4_audience", { ...base, display_name: "X", include_events: ["a"], exclude_events: ["a"] })).error!.message).toContain("both included and excluded");
    expect((await kit.run("create_ga4_audience", { ...base, membership_duration_days: 541, display_name: "X", include_events: ["a"] })).error).toMatchObject({ code: "invalid_argument" });
    f.audiences = Array.from({ length: 100 }, (_, i) => ({ name: `properties/123/audiences/${i}`, displayName: `A${i}` }));
    expect((await kit.run("create_ga4_audience", { ...base, display_name: "X", include_events: ["a"] })).error!.message).toContain("already has 100 audiences");
    expect(f.mutations()).toHaveLength(0);
  });

  it("drift is a conflict; a create that does not read back is unknown_outcome; verify", async () => {
    const r = await kit.run("create_ga4_audience", { ...base, display_name: "Drift", include_events: ["add_to_cart"] });
    f.audiences.push({ name: "properties/123/audiences/7", displayName: "New one" });
    expect((await kit.approveAs(r.approval!.approval_id, kit.owner)).status).toBe("failed");
    expect(f.mutations()).toHaveLength(0);
    const r2 = await kit.run("create_ga4_audience", { ...base, display_name: "Ghost", include_events: ["add_to_cart"] });
    f.dropWrites = true;
    expect((await kit.approveAs(r2.approval!.approval_id, kit.owner)).status).toBe("unknown_outcome");
    const tool = kit.deps.registry.get("create_ga4_audience") as WriteTool;
    const args = { account_id: kit.accountId, display_name: "Ghost" };
    const snap = { names: ["new one", "purchasers"] };
    expect(await tool.verify(args, await kit.ctx(), { snapshot: snap })).toEqual({ outcome: "not_applied" });
    f.audiences.push({ name: "properties/123/audiences/8", displayName: "ghost" });
    expect(await tool.verify(args, await kit.ctx(), { snapshot: snap })).toEqual({ outcome: "applied" });
    f.audiences = [];
    expect((await tool.verify(args, await kit.ctx(), { snapshot: snap })).outcome).toBe("indeterminate");
  });
});
