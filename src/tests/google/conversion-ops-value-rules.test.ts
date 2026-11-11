import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

/** list_conversion_value_rules, create_conversion_value_rule and remove_conversion_value_rule against an in-memory account. */
const C = "customers/1234567890";
const R = (id: string) => `${C}/conversionValueRules/${id}`;
let rules: Map<string, any>;
let sets: Map<string, any>;
let nextId = 900;
let mutates: any[][];
let dropWrites = false;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const GEO = new Set(["2840", "21137"]);
const LISTS = new Set(["555"]);
const INTERESTS = new Set(["80101"]);

const inList = (q: string, field: string) => /IN \(([^)]*)\)/.exec(q.slice(q.indexOf(field)))?.[1]?.split(",").map((x) => x.trim()) ?? [];
const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    if (q.includes("FROM conversion_value_rule_set")) return J({ results: [...sets.values()].map((s) => ({ conversionValueRuleSet: s })) });
    if (q.includes("FROM conversion_value_rule ")) {
      const id = /conversion_value_rule\.id = (\d+)/.exec(q)?.[1];
      const hide = q.includes("status != 'REMOVED'");
      return J({ results: [...rules.values()].filter((r) => (!id || r.id === id) && (!hide || r.status !== "REMOVED")).map((r) => ({ conversionValueRule: r })) });
    }
    if (q.includes("FROM campaign ")) return J({ results: q.includes("campaign.id = 11") ? [{ campaign: { id: "11", name: "Brand", status: "ENABLED" } }] : q.includes("campaign.id = 13") ? [{ campaign: { id: "13", name: "Old", status: "REMOVED" } }] : [] });
    if (q.includes("FROM geo_target_constant")) return J({ results: inList(q, "geo_target_constant.id IN").filter((x) => GEO.has(x)).map((id) => ({ geoTargetConstant: { id, status: "ENABLED" } })) });
    if (q.includes("FROM user_list")) return J({ results: inList(q, "user_list.id IN").filter((x) => LISTS.has(x)).map((id) => ({ userList: { id, name: "Buyers" } })) });
    if (q.includes("FROM user_interest")) return J({ results: inList(q, "user_interest.user_interest_id IN").filter((x) => INTERESTS.has(x)).map((id) => ({ userInterest: { userInterestId: id, name: "Travel" } })) });
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    if (dropWrites) return J({ mutateOperationResponses: [] });
    const temps = new Map<string, string>();
    const real = (rn: string) => temps.get(rn) ?? rn;
    const nextRules = new Map([...rules].map(([k, v]) => [k, structuredClone(v)]));
    const nextSets = new Map([...sets].map(([k, v]) => [k, structuredClone(v)]));
    for (const op of body.mutateOperations) {
      const r = op.conversionValueRuleOperation;
      const s = op.conversionValueRuleSetOperation;
      if (r?.create) {
        const id = String(nextId++);
        const { resourceName, ...rest } = r.create;
        temps.set(resourceName, R(id));
        nextRules.set(id, { id, ownerCustomer: C, ...rest });
      } else if (r?.remove) {
        // Google refuses to remove a rule that an enabled or paused set still uses.
        if ([...nextSets.values()].some((x) => x.conversionValueRules.includes(r.remove))) return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: "rule in use" } }, 400);
        nextRules.get(r.remove.split("/").pop())!.status = "REMOVED";
      } else if (s?.create) {
        const id = String(nextId++);
        nextSets.set(id, { id, ownerCustomer: C, status: "ENABLED", ...s.create, conversionValueRules: s.create.conversionValueRules.map(real) });
      } else if (s?.update) {
        const cur = nextSets.get(s.update.resourceName.split("/").pop())!;
        for (const f of s.updateMask.split(",")) {
          if (f === "conversion_value_rules") cur.conversionValueRules = s.update.conversionValueRules.map(real);
          if (f === "dimensions") cur.dimensions = s.update.dimensions;
        }
      } else if (s?.remove) nextSets.delete(s.remove.split("/").pop());
    }
    if ([...nextSets.values()].some((x) => !x.conversionValueRules.length)) return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: "empty set" } }, 400);
    rules = nextRules;
    sets = nextSets;
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("VR", fake);
});
beforeEach(() => {
  rules = new Map([
    ["501", { id: "501", status: "ENABLED", ownerCustomer: C, action: { operation: "MULTIPLY", value: 1.5 }, deviceCondition: { deviceTypes: ["MOBILE"] } }],
    ["502", { id: "502", status: "PAUSED", ownerCustomer: C, action: { operation: "ADD", value: 10 }, geoLocationCondition: { geoTargetConstants: ["geoTargetConstants/2840"], geoMatchType: "LOCATION_OF_PRESENCE" } }],
    ["503", { id: "503", status: "ENABLED", ownerCustomer: C, action: { operation: "MULTIPLY", value: 2 }, audienceCondition: { userLists: [`${C}/userLists/555`] } }],
    ["504", { id: "504", status: "REMOVED", ownerCustomer: C, action: { operation: "ADD", value: 1 }, deviceCondition: { deviceTypes: ["TABLET"] } }],
  ]);
  sets = new Map([
    ["601", { id: "601", status: "ENABLED", ownerCustomer: C, attachmentType: "CUSTOMER", dimensions: ["DEVICE"], conversionValueRules: [R("501")] }],
    ["602", { id: "602", status: "ENABLED", ownerCustomer: C, attachmentType: "CAMPAIGN", campaign: `${C}/campaigns/11`, dimensions: ["GEO_LOCATION", "AUDIENCE"], conversionValueRules: [R("502"), R("503")] }],
  ]);
  mutates = [];
  dropWrites = false;
  nextId = 900;
});
const data = async (name: string, args: Record<string, unknown>) => {
  const r = await kit.run(name, args);
  if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data as any;
};
const err = async (name: string, args: Record<string, unknown>) => (await kit.run(name, args)).error;
const approve = (id: string) => kit.approveAs(id, kit.second);

describe("list_conversion_value_rules", () => {
  it("lists rules with conditions and their rule set, and the rule sets", async () => {
    const d = await data("list_conversion_value_rules", {});
    expect(d.rules.map((r: any) => [r.rule_id, r.status, r.rule_set_id])).toEqual([["501", "ENABLED", "601"], ["502", "PAUSED", "602"], ["503", "ENABLED", "602"]]);
    expect(d.rules[1]).toMatchObject({ operation: "ADD", value: 10, device_types: [], geo: { location_ids: ["2840"], match_type: "LOCATION_OF_PRESENCE", excluded_location_ids: [], excluded_match_type: null }, audience: null, itinerary: false, owner_customer_id: "1234567890" });
    expect(d.rules[2].audience).toEqual({ user_list_ids: ["555"], user_interest_ids: [] });
    expect(d.rule_sets).toEqual([
      { rule_set_id: "601", status: "ENABLED", owner_customer_id: "1234567890", attachment_type: "CUSTOMER", campaign_id: null, conversion_action_categories: [], dimensions: ["DEVICE"], rule_ids: ["501"] },
      { rule_set_id: "602", status: "ENABLED", owner_customer_id: "1234567890", attachment_type: "CAMPAIGN", campaign_id: "11", conversion_action_categories: [], dimensions: ["GEO_LOCATION", "AUDIENCE"], rule_ids: ["502", "503"] },
    ]);
    expect((await data("list_conversion_value_rules", { include_removed: true })).rules.map((r: any) => r.rule_id)).toContain("504");
  });
});

describe("create_conversion_value_rule", () => {
  it("joins the account rule set, widening its dimensions, in one atomic request", async () => {
    const r = await kit.run("create_conversion_value_rule", { operation: "ADD", value: 25, geo: { location_ids: ["21137", "2840"], excluded_location_ids: ["2840"] } });
    expect(r.approval).toMatchObject({ risk: "high_impact", change_set: { changes: [{ resource: "conversion_value_rule", effect: "create" }, { resource: "conversion_value_rule_set", id: "601", before: "1 rule(s)", after: "2 rule(s)" }] } });
    expect(r.approval!.summary).toBe("Create a conversion value rule: add 25 when location ANY 21137,2840 excluding 2840. It joins the existing rule set 601 of the account as rule 2 of 2 (the first matching rule applies), which then also allows GEO_LOCATION conditions.");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      { conversionValueRuleOperation: { create: { resourceName: `${C}/conversionValueRules/-1`, action: { operation: "ADD", value: 25 }, status: "ENABLED", geoLocationCondition: { geoTargetConstants: ["geoTargetConstants/2840", "geoTargetConstants/21137"], geoMatchType: "ANY", excludedGeoTargetConstants: ["geoTargetConstants/2840"], excludedGeoMatchType: "ANY" } } } },
      { conversionValueRuleSetOperation: { update: { resourceName: `${C}/conversionValueRuleSets/601`, conversionValueRules: [R("501"), `${C}/conversionValueRules/-1`], dimensions: ["DEVICE", "GEO_LOCATION"] }, updateMask: "conversion_value_rules,dimensions" } },
    ]);
    expect(done.result).toEqual({ rule_id: "900", status: "ENABLED", rule_set: { rule_set_id: "601", created: false, attachment_type: "CUSTOMER", campaign_id: null, position: 2 }, applies: true });
    expect((await err("create_conversion_value_rule", { operation: "ADD", value: 25, geo: { location_ids: ["2840", "21137"], excluded_location_ids: ["2840"] } }))?.message).toContain("Nothing would change: rule 900");
  });

  it("creates the account rule set when there is none, and a campaign rule set for a campaign", async () => {
    sets.delete("601");
    const r = await kit.run("create_conversion_value_rule", { operation: "MULTIPLY", value: 1.2, device_types: ["TABLET", "DESKTOP"], audience: { user_interest_ids: ["80101"] } });
    expect(r.approval!.summary).toContain("multiply by 1.2 when device TABLET/DESKTOP and audience interest 80101. A new rule set for the account is created to hold it.");
    const done = await approve(r.approval!.approval_id);
    expect(mutates[0]).toEqual([
      { conversionValueRuleOperation: { create: { resourceName: `${C}/conversionValueRules/-1`, action: { operation: "MULTIPLY", value: 1.2 }, status: "ENABLED", deviceCondition: { deviceTypes: ["DESKTOP", "TABLET"] }, audienceCondition: { userInterests: [`${C}/userInterests/80101`] } } } },
      { conversionValueRuleSetOperation: { create: { attachmentType: "CUSTOMER", dimensions: ["DEVICE", "AUDIENCE"], conversionValueRules: [`${C}/conversionValueRules/-1`] } } },
    ]);
    expect(done.result).toMatchObject({ rule_set: { rule_set_id: "901", created: true, attachment_type: "CUSTOMER", position: 1 }, applies: true });

    sets.delete("602");
    const c = await kit.run("create_conversion_value_rule", { operation: "ADD", value: 5, device_types: ["MOBILE"], apply_to: "campaign", campaign_id: "11" });
    expect(c.approval!.summary).toContain('A new rule set for campaign "Brand" is created to hold it; from then on this campaign uses its own rule set');
    expect((await approve(c.approval!.approval_id)).status).toBe("executed");
    expect(mutates[1]![1]).toEqual({ conversionValueRuleSetOperation: { create: { attachmentType: "CAMPAIGN", campaign: `${C}/campaigns/11`, dimensions: ["DEVICE"], conversionValueRules: [`${C}/conversionValueRules/-1`] } } });
  });

  it("apply_to none creates the rule only and says it does not apply yet", async () => {
    const r = await kit.run("create_conversion_value_rule", { operation: "ADD", value: 3, audience: { user_list_ids: ["555"] }, apply_to: "none" });
    expect(r.approval!.summary).toContain("It is not added to any rule set, so it changes no conversion values until it is.");
    const done = await approve(r.approval!.approval_id);
    expect(mutates[0]).toEqual([{ conversionValueRuleOperation: { create: { resourceName: `${C}/conversionValueRules/-1`, action: { operation: "ADD", value: 3 }, status: "ENABLED", audienceCondition: { userLists: [`${C}/userLists/555`] } } } }]);
    expect(done.result).toEqual({ rule_id: "900", status: "ENABLED", rule_set: null, applies: false });
  });

  it("validates actions, conditions and targets", async () => {
    const bad = [
      { operation: "ADD", value: 5 },
      { operation: "ADD", value: 5, device_types: ["MOBILE"], geo: { location_ids: ["2840"] }, audience: { user_list_ids: ["555"] } },
      { operation: "ADD", value: 0, device_types: ["MOBILE"] },
      { operation: "MULTIPLY", value: 11, device_types: ["MOBILE"] },
      { operation: "MULTIPLY", value: 0.4, device_types: ["MOBILE"] },
      { operation: "SET", value: 5, device_types: ["MOBILE"] },
      { operation: "ADD", value: 5, device_types: ["TV"] },
      { operation: "ADD", value: 5, audience: {} },
      { operation: "ADD", value: 5, device_types: ["MOBILE"], campaign_id: "11" },
      { operation: "ADD", value: 5, device_types: ["MOBILE"], apply_to: "campaign" },
      { operation: "ADD", value: 5, geo: { location_ids: ["2840"], excluded_match_type: "ANY" } },
    ];
    for (const args of bad) expect((await err("create_conversion_value_rule", args))?.code).toBe("invalid_argument");
    expect((await err("create_conversion_value_rule", { operation: "ADD", value: 5, geo: { location_ids: ["999"] } }))?.message).toContain("location 999");
    expect((await err("create_conversion_value_rule", { operation: "ADD", value: 5, audience: { user_list_ids: ["7"], user_interest_ids: ["8"] } }))?.message).toContain("user list 7, user interest 8");
    expect((await err("create_conversion_value_rule", { operation: "ADD", value: 5, device_types: ["MOBILE"], apply_to: "campaign", campaign_id: "99" }))?.code).toBe("not_found");
    expect((await err("create_conversion_value_rule", { operation: "ADD", value: 5, device_types: ["MOBILE"], apply_to: "campaign", campaign_id: "13" }))?.message).toContain("removed");
    // The campaign set already uses GEO_LOCATION and AUDIENCE: a device rule would make three condition types.
    expect((await err("create_conversion_value_rule", { operation: "ADD", value: 5, device_types: ["MOBILE"], apply_to: "campaign", campaign_id: "11" }))?.message).toContain("at most two per set");
    sets.get("601")!.ownerCustomer = "customers/5550001111";
    expect((await err("create_conversion_value_rule", { operation: "ADD", value: 5, device_types: ["DESKTOP"] }))?.message).toContain("inherited from account 5550001111");
    expect(mutates).toHaveLength(0);
  });

  it("drift applies nothing and an unconfirmed write is an unknown outcome", async () => {
    const r = await kit.run("create_conversion_value_rule", { operation: "ADD", value: 7, device_types: ["DESKTOP"] });
    sets.get("601")!.conversionValueRules.push(R("503"));
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    expect(mutates).toHaveLength(0);
    const r2 = await kit.run("create_conversion_value_rule", { operation: "ADD", value: 8, device_types: ["DESKTOP"] });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

describe("remove_conversion_value_rule", () => {
  it("takes the rule out of its set and removes it in one request (destructive, two approvers)", async () => {
    const r = await kit.run("remove_conversion_value_rule", { rule_id: "503" });
    expect(r.approval).toMatchObject({ risk: "destructive" });
    expect(r.approval!.change_set!.changes.map((c: any) => [c.resource, c.id, c.before, c.after, c.effect])).toEqual([
      ["conversion_value_rule_set", "602", "2 rule(s)", "1 rule(s)", "remove"],
      ["conversion_value_rule", "503", "ENABLED", "REMOVED", "remove"],
    ]);
    expect(r.approval!.summary).toBe("Permanently remove conversion value rule 503 (MULTIPLY 2, ENABLED). It is taken out of rule set 602 (campaign 11), which keeps 1 rule(s). This cannot be undone.");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      { conversionValueRuleSetOperation: { update: { resourceName: `${C}/conversionValueRuleSets/602`, conversionValueRules: [R("502")] }, updateMask: "conversion_value_rules" } },
      { conversionValueRuleOperation: { remove: R("503") } },
    ]);
    expect(done.result).toEqual({ rule_id: "503", status: "REMOVED", removed_from_rule_sets: ["602"], removed_rule_sets: [] });
    expect((await err("remove_conversion_value_rule", { rule_id: "503" }))?.message).toContain("Nothing would change");
  });

  it("refuses to empty a rule set unless asked, then removes the set too", async () => {
    expect((await err("remove_conversion_value_rule", { rule_id: "501" }))?.message).toContain("remove_rule_set_if_empty");
    const r = await kit.run("remove_conversion_value_rule", { rule_id: "501", remove_rule_set_if_empty: true });
    expect(r.approval!.summary).toContain("Rule set 601 (the account) has no other rule and is removed too");
    const done = await approve(r.approval!.approval_id);
    expect(mutates[0]).toEqual([{ conversionValueRuleSetOperation: { remove: `${C}/conversionValueRuleSets/601` } }, { conversionValueRuleOperation: { remove: R("501") } }]);
    expect(done.result).toEqual({ rule_id: "501", status: "REMOVED", removed_from_rule_sets: [], removed_rule_sets: ["601"] });
  });

  it("removes a rule in no set, and refuses unknown, removed and inherited rules", async () => {
    rules.set("505", { id: "505", status: "ENABLED", ownerCustomer: C, action: { operation: "ADD", value: 2 }, deviceCondition: { deviceTypes: ["DESKTOP"] } });
    const r = await kit.run("remove_conversion_value_rule", { rule_id: "505" });
    expect((await approve(r.approval!.approval_id)).status).toBe("executed");
    expect(mutates[0]).toEqual([{ conversionValueRuleOperation: { remove: R("505") } }]);
    expect((await err("remove_conversion_value_rule", { rule_id: "999" }))?.code).toBe("not_found");
    expect((await err("remove_conversion_value_rule", { rule_id: "504" }))?.message).toContain("Nothing would change");
    rules.get("503")!.ownerCustomer = "customers/5550001111";
    expect((await err("remove_conversion_value_rule", { rule_id: "503" }))?.message).toContain("inherited from account 5550001111");
    expect((await err("remove_conversion_value_rule", { rule_id: "abc" }))?.code).toBe("invalid_argument");
  });
});
