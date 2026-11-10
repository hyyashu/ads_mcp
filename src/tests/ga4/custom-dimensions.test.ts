import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WriteTool } from "../../mcp/tool";
import { type FakeGa4, type Ga4Harness, fakeGa4, ga4Harness } from "./fake-ga4";

let f: FakeGa4;
let kit: Ga4Harness;

beforeAll(async () => {
  f = fakeGa4();
  kit = await ga4Harness("G4D", f);
});
beforeEach(() => {
  f.reset();
  f.customDimensions = [{ name: "properties/123/customDimensions/1", parameterName: "plan_type", displayName: "Plan type", scope: "EVENT" }];
});
const tool = () => kit.deps.registry.get("create_custom_dimension") as WriteTool;

describe("create_custom_dimension", () => {
  it("plans (write risk, no mutation), executes once, reads back, returns the report name", async () => {
    const r = await kit.run("create_custom_dimension", { parameter_name: "membership", display_name: "Membership", scope: "USER", description: "Tier", disallow_ads_personalization: true });
    expect(r.approval).toMatchObject({ risk: "write", change_set: { changes: [{ resource: "custom_dimension", after: "Membership", effect: "neutral" }] } });
    expect(r.approval!.summary).toBe('Create user-scoped custom dimension "Membership" from user property "membership". Its parameter name and scope cannot be changed later, and it can only be archived, not deleted. Uses 1 of 25 user-scoped dimensions.');
    expect(f.mutations()).toHaveLength(0);
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done).toMatchObject({ status: "executed", result: { parameter_name: "membership", display_name: "Membership", scope: "USER", report_name: "customUser:membership" } });
    expect(f.mutations()).toEqual([expect.objectContaining({ method: "POST", path: "/v1beta/properties/123/customDimensions", body: { parameterName: "membership", displayName: "Membership", scope: "USER", description: "Tier", disallowAdsPersonalization: true } })]);
  });

  it("report names per scope", async () => {
    for (const [scope, name] of [["EVENT", "customEvent:color"], ["ITEM", "customItem:size"]] as const) {
      const p = name.split(":")[1]!;
      const r = await kit.run("create_custom_dimension", { parameter_name: p, display_name: `D ${p}`, scope });
      expect((await kit.approveAs(r.approval!.approval_id, kit.owner)).result).toMatchObject({ report_name: name });
    }
  });

  it("input rules: user names ≤ 24, ads flag only for user scope, name format", async () => {
    expect((await kit.run("create_custom_dimension", { parameter_name: "a".repeat(25), display_name: "X", scope: "USER" })).error!.message).toContain("at most 24");
    expect((await kit.run("create_custom_dimension", { parameter_name: "a".repeat(25), display_name: "X", scope: "EVENT" })).ok).toBe(true);
    expect((await kit.run("create_custom_dimension", { parameter_name: "a", display_name: "X", scope: "EVENT", disallow_ads_personalization: true })).error!.message).toContain("user-scoped dimensions only");
    expect((await kit.run("create_custom_dimension", { parameter_name: "1bad", display_name: "X", scope: "EVENT" })).error).toMatchObject({ code: "invalid_argument" });
    expect((await kit.run("create_custom_dimension", { parameter_name: "a", display_name: "X".repeat(83), scope: "EVENT" })).error).toMatchObject({ code: "invalid_argument" });
  });

  it("refuses a duplicate parameter in the same scope, a duplicate display name, and the Standard limit", async () => {
    expect((await kit.run("create_custom_dimension", { parameter_name: "plan_type", display_name: "Other", scope: "EVENT" })).error!.message).toContain("already exists");
    expect((await kit.run("create_custom_dimension", { parameter_name: "plan_type", display_name: "Plan user", scope: "USER" })).ok).toBe(true); // other scope is fine
    expect((await kit.run("create_custom_dimension", { parameter_name: "x", display_name: "PLAN TYPE", scope: "EVENT" })).error!.message).toContain('named "PLAN TYPE" already exists');
    f.customDimensions = Array.from({ length: 50 }, (_, i) => ({ name: `properties/123/customDimensions/${i}`, parameterName: `p${i}`, displayName: `D${i}`, scope: "EVENT" }));
    expect((await kit.run("create_custom_dimension", { parameter_name: "x", display_name: "X", scope: "EVENT" })).error!.message).toContain("already has 50 event-scoped");
    expect((await kit.run("create_custom_dimension", { parameter_name: "x", display_name: "X", scope: "ITEM" })).ok).toBe(true); // item limit not documented: not enforced
  });

  it("drift is a conflict with nothing sent; a create that does not read back is unknown_outcome; verify", async () => {
    const r = await kit.run("create_custom_dimension", { parameter_name: "color", display_name: "Color", scope: "EVENT" });
    f.customDimensions.push({ name: "properties/123/customDimensions/9", parameterName: "other", displayName: "Other", scope: "EVENT" });
    expect((await kit.approveAs(r.approval!.approval_id, kit.owner)).status).toBe("failed");
    expect(f.mutations()).toHaveLength(0);

    const r2 = await kit.run("create_custom_dimension", { parameter_name: "size", display_name: "Size", scope: "EVENT" });
    f.dropWrites = true;
    expect((await kit.approveAs(r2.approval!.approval_id, kit.owner)).status).toBe("unknown_outcome");
    const args = { account_id: kit.accountId, parameter_name: "size", display_name: "Size", scope: "EVENT" };
    const snap = { keys: ["EVENT|other", "EVENT|plan_type"], names: ["other", "plan type"] };
    expect(await tool().verify(args, await kit.ctx(), { snapshot: snap })).toEqual({ outcome: "not_applied" });
    f.customDimensions.push({ name: "properties/123/customDimensions/10", parameterName: "size", displayName: "Size", scope: "EVENT" });
    expect(await tool().verify(args, await kit.ctx(), { snapshot: snap })).toEqual({ outcome: "applied" });
    f.customDimensions = [];
    expect((await tool().verify(args, await kit.ctx(), { snapshot: snap })).outcome).toBe("indeterminate");
  });
});
