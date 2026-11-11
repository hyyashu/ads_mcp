import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

/** get_conversion_goals and update_conversion_goals against an in-memory account. */
const C = "customers/1234567890";
type Goal = { category: string; origin: string; biddable: boolean };
let accountGoals: Goal[];
let campaignGoals: Map<string, Goal[]>;
let configs: Map<string, { level: string; custom?: string }>;
const campaigns: Record<string, { name: string; status: string }> = { "11": { name: "Brand", status: "ENABLED" }, "12": { name: "Generic", status: "ENABLED" }, "13": { name: "Old", status: "REMOVED" } };
let conversionCustomer: string;
let queries: string[];
let mutates: any[][];
let dropWrites = false;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const live = (q: string) => {
  const only = /campaign\.id IN \(([^)]*)\)/.exec(q)?.[1]?.split(",").map((x) => x.trim());
  return Object.keys(campaigns).filter((id) => campaigns[id]!.status !== "REMOVED" && (!only || only.includes(id)));
};
const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    queries.push(q);
    if (q.includes("FROM customer ")) return J({ results: [{ customer: { id: "1234567890", conversionTrackingSetting: { googleAdsConversionCustomer: conversionCustomer } } }] });
    if (q.includes("FROM customer_conversion_goal")) return J({ results: accountGoals.map((g) => ({ customerConversionGoal: { ...g } })) });
    if (q.includes("FROM campaign_conversion_goal")) return J({ results: live(q).flatMap((id) => (campaignGoals.get(id) ?? []).map((g) => ({ campaign: { id, name: campaigns[id]!.name }, campaignConversionGoal: { ...g } }))) });
    if (q.includes("FROM conversion_goal_campaign_config")) {
      const ownOnly = q.includes("goal_config_level = 'CAMPAIGN'");
      return J({ results: live(q).filter((id) => !ownOnly || configs.get(id)!.level === "CAMPAIGN").map((id) => ({ campaign: { id, name: campaigns[id]!.name }, conversionGoalCampaignConfig: { goalConfigLevel: configs.get(id)!.level, ...(configs.get(id)!.custom ? { customConversionGoal: configs.get(id)!.custom } : {}) } })) });
    }
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    if (dropWrites) return J({ mutateOperationResponses: [] });
    for (const op of body.mutateOperations) {
      if (op.customerConversionGoalOperation) {
        const [cat, origin] = op.customerConversionGoalOperation.update.resourceName.split("/").pop().split("~");
        accountGoals.find((g) => g.category === cat && g.origin === origin)!.biddable = op.customerConversionGoalOperation.update.biddable;
        // Campaigns that follow the account goals take the change.
        for (const [id, c] of configs) if (c.level === "CUSTOMER") campaignGoals.get(id)!.find((g) => g.category === cat && g.origin === origin)!.biddable = op.customerConversionGoalOperation.update.biddable;
      } else if (op.campaignConversionGoalOperation) {
        const [camp, cat, origin] = op.campaignConversionGoalOperation.update.resourceName.split("/").pop().split("~");
        campaignGoals.get(camp)!.find((g) => g.category === cat && g.origin === origin)!.biddable = op.campaignConversionGoalOperation.update.biddable;
        configs.get(camp)!.level = "CAMPAIGN"; // what Google does when a campaign goal is updated
      }
    }
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("CG", fake);
});
beforeEach(() => {
  const goals = (): Goal[] => [
    { category: "PURCHASE", origin: "WEBSITE", biddable: true },
    { category: "PHONE_CALL_LEAD", origin: "CALL_FROM_ADS", biddable: true },
    { category: "PAGE_VIEW", origin: "GOOGLE_HOSTED", biddable: false },
  ];
  accountGoals = goals();
  campaignGoals = new Map([["11", goals()], ["12", goals().map((g) => (g.category === "PURCHASE" ? { ...g, biddable: false } : g))], ["13", goals()]]);
  configs = new Map([["11", { level: "CUSTOMER" }], ["12", { level: "CAMPAIGN", custom: `${C}/customConversionGoals/9` }], ["13", { level: "CUSTOMER" }]]);
  conversionCustomer = C;
  queries = [];
  mutates = [];
  dropWrites = false;
});
const data = async (name: string, args: Record<string, unknown>) => {
  const r = await kit.run(name, args);
  if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data as any;
};
const err = async (name: string, args: Record<string, unknown>) => (await kit.run(name, args)).error;
const approve = (id: string) => kit.approveAs(id, kit.second);

describe("get_conversion_goals", () => {
  it("lists account goals and each campaign's goals and goal configuration", async () => {
    const d = await data("get_conversion_goals", {});
    expect(d.conversion_customer_id).toBe("1234567890");
    expect(d.account_goals).toEqual([
      { category: "PAGE_VIEW", origin: "GOOGLE_HOSTED", biddable: false },
      { category: "PHONE_CALL_LEAD", origin: "CALL_FROM_ADS", biddable: true },
      { category: "PURCHASE", origin: "WEBSITE", biddable: true },
    ]);
    expect(d.campaigns.map((c: any) => [c.campaign_id, c.campaign_name, c.goal_config_level, c.custom_conversion_goal_id])).toEqual([["11", "Brand", "CUSTOMER", null], ["12", "Generic", "CAMPAIGN", "9"]]);
    expect(d.campaigns[1].goals).toContainEqual({ category: "PURCHASE", origin: "WEBSITE", biddable: false });
  });

  it("filters campaigns, or returns account goals only", async () => {
    const d = await data("get_conversion_goals", { campaign_ids: ["12"] });
    expect(d.campaigns.map((c: any) => c.campaign_id)).toEqual(["12"]);
    expect(queries.filter((q) => q.includes("campaign.id IN (12)"))).toHaveLength(2);
    queries = [];
    expect((await data("get_conversion_goals", { include_campaigns: false })).campaigns).toEqual([]);
    expect(queries.some((q) => q.includes("campaign_conversion_goal"))).toBe(false);
    expect((await err("get_conversion_goals", { campaign_ids: ["x"] }))?.code).toBe("invalid_argument");
  });
});

describe("update_conversion_goals", () => {
  it("account level: updates only the goals that differ, with biddable masks, and confirms by re-reading", async () => {
    const r = await kit.run("update_conversion_goals", { level: "account", goals: [{ category: "PURCHASE", origin: "WEBSITE", biddable: false }, { category: "PHONE_CALL_LEAD", origin: "CALL_FROM_ADS", biddable: true }] });
    expect(r.approval).toMatchObject({ risk: "high_impact", change_set: { changes: [{ resource: "customer_conversion_goal", id: "PURCHASE~WEBSITE", field: "biddable", before: true, after: false }] } });
    expect(r.approval!.summary).toBe("Set conversion goal biddability at account level: PURCHASE/WEBSITE true -> false. Applies to every campaign that follows the account goals; 1 campaign(s) with their own goals are not affected.");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ customerConversionGoalOperation: { update: { resourceName: `${C}/customerConversionGoals/PURCHASE~WEBSITE`, biddable: false }, updateMask: "biddable" } }]);
    expect(done.result).toEqual({ level: "account", updated: [{ campaign_id: null, category: "PURCHASE", origin: "WEBSITE", biddable: false }], unchanged: 1, campaigns_goal_config_level: [] });
    expect((await err("update_conversion_goals", { level: "account", goals: [{ category: "PURCHASE", origin: "WEBSITE", biddable: false }] }))?.message).toContain("Nothing would change");
  });

  it("campaign level: updates each campaign's goal and says which campaigns leave the account goals", async () => {
    const r = await kit.run("update_conversion_goals", { level: "campaign", campaign_ids: ["12", "11"], goals: [{ category: "PURCHASE", origin: "WEBSITE", biddable: false }, { category: "PAGE_VIEW", origin: "GOOGLE_HOSTED", biddable: true }] });
    expect(r.approval!.summary).toContain('campaign "Brand" PURCHASE/WEBSITE true -> false');
    expect(r.approval!.summary).toContain('"Brand" will switch from the account goals to their own goals');
    expect(r.approval!.summary).not.toContain('"Generic" will switch');
    expect(r.approval!.change_set!.changes).toHaveLength(3);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      { campaignConversionGoalOperation: { update: { resourceName: `${C}/campaignConversionGoals/11~PURCHASE~WEBSITE`, biddable: false }, updateMask: "biddable" } },
      { campaignConversionGoalOperation: { update: { resourceName: `${C}/campaignConversionGoals/11~PAGE_VIEW~GOOGLE_HOSTED`, biddable: true }, updateMask: "biddable" } },
      { campaignConversionGoalOperation: { update: { resourceName: `${C}/campaignConversionGoals/12~PAGE_VIEW~GOOGLE_HOSTED`, biddable: true }, updateMask: "biddable" } },
    ]);
    expect(done.result).toMatchObject({ level: "campaign", unchanged: 1, campaigns_goal_config_level: [{ campaign_id: "11", goal_config_level: "CAMPAIGN" }, { campaign_id: "12", goal_config_level: "CAMPAIGN" }] });
  });

  it("refuses goals that do not exist, unknown or removed campaigns, and account goals managed by another account", async () => {
    expect((await err("update_conversion_goals", { level: "account", goals: [{ category: "SIGNUP", origin: "WEBSITE", biddable: true }] }))?.message).toContain("no conversion goal for category SIGNUP and origin WEBSITE");
    expect((await err("update_conversion_goals", { level: "campaign", campaign_ids: ["11", "99"], goals: [{ category: "PURCHASE", origin: "WEBSITE", biddable: false }] }))?.code).toBe("not_found");
    expect((await err("update_conversion_goals", { level: "campaign", campaign_ids: ["13"], goals: [{ category: "PURCHASE", origin: "WEBSITE", biddable: false }] }))?.code).toBe("not_found");
    conversionCustomer = "customers/5550001111";
    expect((await err("update_conversion_goals", { level: "account", goals: [{ category: "PURCHASE", origin: "WEBSITE", biddable: false }] }))?.message).toContain("managed by account 5550001111");
    // Campaign goals are changed in the serving account itself, so they still work.
    expect((await kit.run("update_conversion_goals", { level: "campaign", campaign_ids: ["11"], goals: [{ category: "PURCHASE", origin: "WEBSITE", biddable: false }] })).approval?.risk).toBe("high_impact");
    expect(mutates).toHaveLength(0);
  });

  it("validates the input", async () => {
    const g = [{ category: "PURCHASE", origin: "WEBSITE", biddable: false }];
    expect((await err("update_conversion_goals", { level: "account", campaign_ids: ["11"], goals: g }))?.code).toBe("invalid_argument");
    expect((await err("update_conversion_goals", { level: "campaign", goals: g }))?.code).toBe("invalid_argument");
    expect((await err("update_conversion_goals", { level: "account", goals: [...g, ...g] }))?.code).toBe("invalid_argument");
    expect((await err("update_conversion_goals", { level: "account", goals: [{ category: "NOPE", origin: "WEBSITE", biddable: true }] }))?.code).toBe("invalid_argument");
    expect((await err("update_conversion_goals", { level: "account", goals: [] }))?.code).toBe("invalid_argument");
  });

  it("drift applies nothing and an unconfirmed write is an unknown outcome", async () => {
    const r = await kit.run("update_conversion_goals", { level: "account", goals: [{ category: "PHONE_CALL_LEAD", origin: "CALL_FROM_ADS", biddable: false }] });
    accountGoals[2]!.biddable = true; // PAGE_VIEW changed meanwhile
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    expect(mutates).toHaveLength(0);
    const r2 = await kit.run("update_conversion_goals", { level: "campaign", campaign_ids: ["11"], goals: [{ category: "PHONE_CALL_LEAD", origin: "CALL_FROM_ADS", biddable: false }] });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});
