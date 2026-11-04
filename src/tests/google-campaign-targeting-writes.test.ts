import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../auth/token-providers";
import { googleHarness, type GoogleHarness } from "./support/harness";

const C = "customers/1234567890";
type Crit = Record<string, any> & { criterionId: string; type: string; status: string };
let camps: Record<string, Record<string, any>>;
let crits: Record<string, Crit[]>;
let mods: Record<string, any>[];
let nextId = 9000;
let mutates: any[][];
let dropWrites = false;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const strategyKeys: Record<string, string> = { manualCpc: "MANUAL_CPC", maximizeConversions: "MAXIMIZE_CONVERSIONS", maximizeConversionValue: "MAXIMIZE_CONVERSION_VALUE", targetSpend: "TARGET_SPEND" };
function applyCampaignUpdate(u: any, mask: string) {
  const c = camps[u.resourceName.split("/").pop()]!;
  for (const path of mask.split(",")) {
    const top = path.split(".")[0]!.replace(/_([a-z])/g, (_, x) => x.toUpperCase());
    if (strategyKeys[top]) {
      for (const k of Object.keys(strategyKeys)) delete c[k];
      c[top] = u[top] ?? {};
      c.biddingStrategyType = strategyKeys[top];
    } else if (u[top] === undefined) delete c[top];
    else c[top] = u[top];
  }
}

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    const id = /campaign\.id = (\d+)/.exec(q)?.[1];
    if (q.includes("FROM campaign_criterion")) {
      const type = /campaign_criterion\.type = '([A-Z_]+)'/.exec(q)![1];
      return J({ results: (crits[id!] ?? []).filter((x) => x.type === type && x.status !== "REMOVED").map((x) => ({ campaignCriterion: x })) });
    }
    if (q.includes("FROM campaign")) return J({ results: camps[id!] ? [{ campaign: camps[id!] }] : [] });
    if (q.includes("FROM ad_group_bid_modifier")) return J({ results: mods.map((m) => ({ adGroupBidModifier: m })) });
    if (q.includes("FROM ad_group")) return J({ results: q.includes("ad_group.id = 21") ? [{ adGroup: { id: "21", name: "Core", status: "ENABLED" } }] : [] });
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    if (dropWrites) return J({ mutateOperationResponses: [] });
    for (const op of body.mutateOperations) {
      const cc = op.campaignCriterionOperation;
      if (cc?.create) {
        const cid = cc.create.campaign.split("/").pop();
        const type = cc.create.location ? "LOCATION" : cc.create.proximity ? "PROXIMITY" : cc.create.adSchedule ? "AD_SCHEDULE" : cc.create.device ? "DEVICE" : "OTHER";
        const { campaign: _c, ...rest } = cc.create;
        (crits[cid] ??= []).push({ criterionId: String(nextId++), type, status: "ENABLED", negative: false, ...rest });
      } else if (cc?.remove) {
        const [cid, crid] = cc.remove.split("/").pop().split("~");
        crits[cid]!.find((x) => x.criterionId === crid)!.status = "REMOVED";
      } else if (cc?.update) {
        const [cid, crid] = cc.update.resourceName.split("/").pop().split("~");
        Object.assign(crits[cid]!.find((x) => x.criterionId === crid)!, { bidModifier: cc.update.bidModifier });
      } else if (op.campaignOperation?.update) applyCampaignUpdate(op.campaignOperation.update, op.campaignOperation.updateMask);
      else if (op.adGroupBidModifierOperation?.create) mods.push({ criterionId: String(nextId++), device: op.adGroupBidModifierOperation.create.device, bidModifier: op.adGroupBidModifierOperation.create.bidModifier });
      else if (op.adGroupBidModifierOperation?.update) {
        const crid = op.adGroupBidModifierOperation.update.resourceName.split("~").pop();
        mods.find((m) => m.criterionId === crid)!.bidModifier = op.adGroupBidModifierOperation.update.bidModifier;
      }
    }
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("TW", fake);
});
beforeEach(() => {
  camps = {
    "11": { id: "11", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH", geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" }, biddingStrategyType: "MAXIMIZE_CONVERSIONS", maximizeConversions: { targetCpaMicros: "20000000" } },
    "51": { id: "51", name: "Disp", status: "ENABLED", advertisingChannelType: "DISPLAY", frequencyCaps: [{ key: { level: "CAMPAIGN", eventType: "IMPRESSION", timeUnit: "DAY", timeLength: 1 }, cap: 3 }], startDateTime: "2026-01-01 00:00:00", endDateTime: "2026-12-31 23:59:59", biddingStrategyType: "MANUAL_CPC", manualCpc: {} },
  };
  crits = { "11": [{ criterionId: "2840", type: "LOCATION", status: "ENABLED", negative: false, location: { geoTargetConstant: "geoTargetConstants/2840" } }, { criterionId: "30001", type: "DEVICE", status: "ENABLED", device: { type: "MOBILE" }, bidModifier: 1 }] };
  mods = [];
  mutates = [];
  dropWrites = false;
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (id: string, by = kit.second) => kit.approveAs(id, by);
const ok = async (name: string, args: Record<string, unknown>, by?: string) => {
  const r = await run(name, args);
  if (!r.approval) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  const done = await approve(r.approval.approval_id, by);
  expect(done.status).toBe("executed");
  return { r, done };
};

describe("locations and radius", () => {
  it("adds targets and exclusions, changes match type; widening needs a second approver", async () => {
    const r = await run("update_location_targeting", { campaign_id: "11", add_targeted: ["2826"], add_excluded: ["1023191"], location_match: "PRESENCE_OR_INTEREST" });
    expect(r.approval?.risk).toBe("high_impact");
    await expect(approve(r.approval!.approval_id, kit.owner)).rejects.toMatchObject({ code: "permission_denied" });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(done.result).toEqual({ campaign_id: "11", targeted: ["2826", "2840"], excluded: ["1023191"], location_match: "PRESENCE_OR_INTEREST" });
    expect(mutates[0]).toContainEqual({ campaignCriterionOperation: { create: { campaign: `${C}/campaigns/11`, negative: true, location: { geoTargetConstant: "geoTargetConstants/1023191" } } } });
  });

  it("only narrowing (an exclusion) needs one approver; removing the last target is refused", async () => {
    const r = await run("update_location_targeting", { campaign_id: "11", add_excluded: ["1023191"] });
    expect(r.approval?.risk).toBe("write");
    expect((await run("update_location_targeting", { campaign_id: "11", remove: ["2840"] })).error?.message).toContain("all countries");
    expect((await run("update_location_targeting", { campaign_id: "11", remove: ["999"] })).error?.message).toContain("not on this campaign");
  });

  it("radius: add by coordinates, refuse duplicates, remove is destructive", async () => {
    await ok("add_campaign_proximity", { campaign_id: "11", radius: 10, radius_units: "KILOMETERS", latitude: 52.52, longitude: 13.405 });
    expect(mutates[0]![0].campaignCriterionOperation.create.proximity).toEqual({ radius: 10, radiusUnits: "KILOMETERS", geoPoint: { latitudeInMicroDegrees: 52520000, longitudeInMicroDegrees: 13405000 } });
    expect((await run("add_campaign_proximity", { campaign_id: "11", radius: 10, radius_units: "KILOMETERS", latitude: 52.52, longitude: 13.405 })).error?.message).toContain("already targeted");
    const id = crits["11"]!.find((x) => x.type === "PROXIMITY")!.criterionId;
    const rm = await run("remove_campaign_proximity", { campaign_id: "11", criterion_ids: [id] });
    expect(rm.approval?.risk).toBe("destructive");
    expect((await approve(rm.approval!.approval_id)).status).toBe("executed");
  });
});

describe("schedule and device adjustments", () => {
  it("replaces the ad schedule; clearing needs clear: true; more than 6 slots a day is refused", async () => {
    await ok("set_campaign_ad_schedule", { campaign_id: "11", slots: [{ day_of_week: "MONDAY", start_hour: 9, end_hour: 17, end_minute: 30 }] });
    expect(mutates[0]![0].campaignCriterionOperation.create.adSchedule).toEqual({ dayOfWeek: "MONDAY", startHour: 9, startMinute: "ZERO", endHour: 17, endMinute: "THIRTY" });
    expect((await run("set_campaign_ad_schedule", { campaign_id: "11" })).error?.code).toBe("invalid_argument");
    const many = Array.from({ length: 7 }, (_, i) => ({ day_of_week: "TUESDAY", start_hour: i * 3, end_hour: i * 3 + 1 }));
    expect((await run("set_campaign_ad_schedule", { campaign_id: "11", slots: many })).error?.message).toContain("6 schedule slots");
    expect((await run("set_campaign_ad_schedule", { campaign_id: "11", slots: [{ day_of_week: "MONDAY", start_hour: 18, end_hour: 9 }] })).error?.code).toBe("invalid_argument");
    const { done } = await ok("set_campaign_ad_schedule", { campaign_id: "11", clear: true });
    expect(done.result).toEqual({ campaign_id: "11", slots: [] });
  });

  it("device adjustments: lowering is a write, raising is high impact; ad group adjustments are created", async () => {
    const down = await run("set_campaign_device_bid_modifiers", { campaign_id: "11", modifiers: { MOBILE: 0.8 } });
    expect(down.approval).toMatchObject({ risk: "write", change_set: { changes: [{ effect: "decrease_spend" }] } });
    expect((await approve(down.approval!.approval_id, kit.owner)).status).toBe("executed");
    expect(mutates[0]).toEqual([{ campaignCriterionOperation: { update: { resourceName: `${C}/campaignCriteria/11~30001`, bidModifier: 0.8 }, updateMask: "bid_modifier" } }]);
    const up = await run("set_campaign_device_bid_modifiers", { campaign_id: "11", modifiers: { TABLET: 1.3 } });
    expect(up.approval?.risk).toBe("high_impact");
    const { done } = await ok("set_ad_group_device_bid_modifiers", { ad_group_id: "21", modifiers: { DESKTOP: 0 } });
    expect(done.result).toEqual({ ad_group_id: "21", modifiers: { DESKTOP: 0 } });
    expect((await run("set_ad_group_device_bid_modifiers", { ad_group_id: "21", modifiers: { DESKTOP: 0 } })).error?.message).toContain("Nothing would change");
  });
});

describe("frequency caps, bidding and Display dates", () => {
  it("frequency caps replace the list; raising widens delivery; non-display campaigns are refused", async () => {
    const r = await run("update_display_frequency_caps", { campaign_id: "51", caps: [{ time_unit: "DAY", cap: 5 }, { time_unit: "WEEK", cap: 20 }] });
    expect(r.approval?.risk).toBe("high_impact");
    expect((await approve(r.approval!.approval_id)).status).toBe("executed");
    expect(camps["51"]!.frequencyCaps).toEqual([{ key: { level: "CAMPAIGN", eventType: "IMPRESSION", timeUnit: "DAY", timeLength: 1 }, cap: 5 }, { key: { level: "CAMPAIGN", eventType: "IMPRESSION", timeUnit: "WEEK", timeLength: 1 }, cap: 20 }]);
    expect((await run("update_display_frequency_caps", { campaign_id: "11", caps: [] })).error?.message).toContain("SEARCH");
    const lower = await run("update_campaign_frequency_caps", { campaign_id: "51", caps: [{ time_unit: "DAY", cap: 2 }, { time_unit: "WEEK", cap: 20 }] });
    expect(lower.approval?.risk).toBe("write");
  });

  it("bid strategy: switching is high impact; lowering only the target is a write; portfolio refused", async () => {
    const { done } = await ok("update_bid_strategy", { campaign_id: "51", strategy: "MAXIMIZE_CONVERSIONS", target_cpa: 15 });
    expect(done.result).toEqual({ campaign_id: "51", strategy: "MAXIMIZE_CONVERSIONS", target_cpa: 15, target_roas: null, max_cpc: null });
    expect(mutates[0]).toEqual([{ campaignOperation: { update: { resourceName: `${C}/campaigns/51`, maximizeConversions: { targetCpaMicros: "15000000" } }, updateMask: "maximize_conversions.target_cpa_micros" } }]);
    const lower = await run("update_bid_strategy", { campaign_id: "11", strategy: "MAXIMIZE_CONVERSIONS", target_cpa: 18 });
    expect(lower.approval).toMatchObject({ risk: "write", change_set: { changes: [{ field: "target_cpa", before: 20, after: 18, effect: "decrease_spend" }] } });
    expect((await run("update_bid_strategy", { campaign_id: "11", strategy: "MANUAL_CPC", target_cpa: 5 })).error?.code).toBe("invalid_argument");
    camps["11"]!.biddingStrategy = `${C}/biddingStrategies/7`;
    expect((await run("update_bid_strategy", { campaign_id: "11", strategy: "MANUAL_CPC" })).error?.message).toContain("portfolio");
  });

  it("Display dates: earlier end is a write, clearing the end is high impact, non-Display refused", async () => {
    const earlier = await run("update_display_campaign_schedule", { campaign_id: "51", end_date: "2026-11-30" });
    expect(earlier.approval?.risk).toBe("write");
    expect((await approve(earlier.approval!.approval_id, kit.owner)).status).toBe("executed");
    expect(camps["51"]!.endDateTime).toBe("2026-11-30 23:59:59");
    const { done } = await ok("update_display_campaign_schedule", { campaign_id: "51", clear_end_date: true });
    expect(done.result).toMatchObject({ end_date_time: null });
    expect((await run("update_display_campaign_schedule", { campaign_id: "11", end_date: "2026-12-01" })).error?.message).toContain("not a Display campaign");
  });

  it("an unconfirmed write is unknown_outcome", async () => {
    const r = await run("update_display_frequency_caps", { campaign_id: "51", caps: [{ time_unit: "DAY", cap: 1 }] });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id, kit.owner)).status).toBe("unknown_outcome");
  });
});
