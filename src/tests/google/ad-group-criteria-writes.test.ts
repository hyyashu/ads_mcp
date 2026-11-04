import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

const C = "customers/1234567890";
type Crit = Record<string, any> & { criterionId: string; type: string; status: string };
let groups: Record<string, { name: string; status: string; campaign: string; channel: string; dg?: any }>;
let agc: Record<string, Crit[]>;
let cc: Crit[];
let nextId = 7000;
let mutates: any[][];
let dropWrites = false;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const typeOf = (b: any) => (b.userList ? "USER_LIST" : b.userInterest ? "USER_INTEREST" : b.customAudience ? "CUSTOM_AUDIENCE" : b.ageRange ? "AGE_RANGE" : b.gender ? "GENDER" : b.incomeRange ? "INCOME_RANGE" : b.parentalStatus ? "PARENTAL_STATUS" : b.keyword ? "KEYWORD" : b.placement ? "PLACEMENT" : b.youtubeChannel ? "YOUTUBE_CHANNEL" : b.youtubeVideo ? "YOUTUBE_VIDEO" : b.mobileApplication ? "MOBILE_APPLICATION" : b.topic ? "TOPIC" : "OTHER");

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    const ag = /ad_group\.id = (\d+)/.exec(q)?.[1];
    if (q.includes("FROM ad_group_criterion")) {
      const types = [...(/type IN \(([^)]*)\)/.exec(q)![1]!.matchAll(/'([A-Z_]+)'/g))].map((m) => m[1]);
      return J({ results: (agc[ag!] ?? []).filter((x) => types.includes(x.type) && x.status !== "REMOVED").map((x) => ({ adGroupCriterion: x })) });
    }
    if (q.includes("FROM ad_group")) {
      const g = groups[ag!];
      return J({ results: g ? [{ adGroup: { id: ag, name: g.name, status: g.status, ...(g.dg ? { demandGenAdGroupSettings: g.dg } : {}) }, campaign: { id: g.campaign, advertisingChannelType: g.channel } }] : [] });
    }
    if (q.includes("FROM campaign_criterion")) return J({ results: cc.filter((x) => x.status !== "REMOVED").map((x) => ({ campaignCriterion: x })) });
    if (q.includes("FROM campaign")) return J({ results: q.includes("campaign.id = 51") ? [{ campaign: { id: "51", name: "Disp", status: "ENABLED" } }] : [] });
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    if (dropWrites) return J({ mutateOperationResponses: [] });
    for (const op of body.mutateOperations) {
      const o = op.adGroupCriterionOperation;
      if (o?.create) {
        const id = o.create.adGroup.split("/").pop();
        const { adGroup: _a, ...rest } = o.create;
        (agc[id] ??= []).push({ criterionId: String(nextId++), type: typeOf(rest), status: "ENABLED", negative: false, ...rest });
      } else if (o?.remove) {
        const [g, crit] = o.remove.split("/").pop().split("~");
        agc[g]!.find((x) => x.criterionId === crit)!.status = "REMOVED";
      } else if (op.campaignCriterionOperation?.create) {
        const { campaign: _c, ...rest } = op.campaignCriterionOperation.create;
        cc.push({ criterionId: String(nextId++), type: typeOf(rest), status: "ENABLED", ...rest });
      } else if (op.adGroupOperation?.update) {
        const g = groups[op.adGroupOperation.update.resourceName.split("/").pop()]!;
        g.dg = op.adGroupOperation.update.demandGenAdGroupSettings;
      }
    }
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("AG", fake);
});
beforeEach(() => {
  groups = {
    "21": { name: "Core", status: "ENABLED", campaign: "11", channel: "SEARCH" },
    "61": { name: "Disp", status: "ENABLED", campaign: "51", channel: "DISPLAY" },
    "71": { name: "DG", status: "ENABLED", campaign: "70", channel: "DEMAND_GEN", dg: { channelControls: { channelConfig: "CHANNEL_STRATEGY", channelStrategy: "ALL_CHANNELS" } } },
  };
  agc = { "21": [{ criterionId: "1", type: "USER_LIST", status: "ENABLED", negative: false, userList: { userList: `${C}/userLists/501` } }], "71": [{ criterionId: "2", type: "USER_INTEREST", status: "ENABLED", negative: false, userInterest: { userInterestCategory: `${C}/userInterests/80432` } }] };
  cc = [];
  mutates = [];
  dropWrites = false;
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (id: string, by = kit.owner) => kit.approveAs(id, by);
const exec = async (name: string, args: Record<string, unknown>, by?: string) => {
  const r = await run(name, args);
  if (!r.approval) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  const done = await approve(r.approval.approval_id, by);
  expect(done.status).toBe("executed");
  return { r, done };
};

describe("audiences", () => {
  it("adds targets and exclusions with documented resource names, skipping existing ones", async () => {
    const { done } = await exec("add_ad_group_audiences", { ad_group_id: "21", audiences: [{ kind: "user_list", id: "501" }, { kind: "user_interest", id: "80432", exclude: true }, { kind: "custom_audience", id: "77" }] });
    expect(done.result).toEqual({ ad_group_id: "21", added: ["USER_INTEREST:80432", "CUSTOM_AUDIENCE:77"], skipped_existing: ["USER_LIST:501"] });
    expect(mutates[0]).toEqual([
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/21`, negative: true, userInterest: { userInterestCategory: `${C}/userInterests/80432` } } } },
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/21`, customAudience: { customAudience: `${C}/customAudiences/77` } } } },
    ]);
    expect((await run("add_ad_group_audiences", { ad_group_id: "21", audiences: [{ kind: "user_list", id: "501", exclude: true }] })).error?.message).toContain("remove it first");
    expect((await run("add_display_audiences", { ad_group_id: "21", audiences: [{ kind: "user_list", id: "1" }] })).error?.message).toContain("SEARCH campaign");
  });

  it("replace_demandgen_audiences swaps the whole set atomically and needs a second approver", async () => {
    const r = await run("replace_demandgen_audiences", { ad_group_id: "71", audiences: [{ kind: "user_list", id: "600" }] });
    expect(r.approval?.risk).toBe("high_impact");
    await expect(approve(r.approval!.approval_id, kit.owner)).rejects.toMatchObject({ code: "permission_denied" });
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(done.result).toEqual({ ad_group_id: "71", audiences: ["USER_LIST:600"] });
    expect(mutates[0]!.map((o: any) => Object.keys(o.adGroupCriterionOperation)[0])).toEqual(["remove", "create"]);
  });
});

describe("demographics", () => {
  it("excluding narrows (one approver); including again widens (second approver)", async () => {
    const r = await run("update_display_demographics", { ad_group_id: "61", exclude: { age_ranges: ["AGE_RANGE_18_24"], genders: ["UNDETERMINED"] } });
    expect(r.approval?.risk).toBe("write");
    expect((await approve(r.approval!.approval_id)).status).toBe("executed");
    expect(mutates[0]![0]).toEqual({ adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/61`, negative: true, ageRange: { type: "AGE_RANGE_18_24" } } } });
    const back = await run("update_display_demographics", { ad_group_id: "61", include_again: { age_ranges: ["AGE_RANGE_18_24"] } });
    expect(back.approval?.risk).toBe("high_impact");
    expect((await approve(back.approval!.approval_id, kit.second)).result).toEqual({ ad_group_id: "61", excluded: ["GENDER:UNDETERMINED"] });
    expect((await run("update_ad_group_demographics", { ad_group_id: "21", exclude: { genders: ["MALE"] }, include_again: { genders: ["MALE"] } })).error?.code).toBe("invalid_argument");
  });
});

describe("Display keywords, placements, topics, removal and exclusions", () => {
  it("adds criteria of each kind and removes them (destructive)", async () => {
    await exec("add_display_keywords", { ad_group_id: "61", items: [{ text: "trail running" }, { text: "Trail Running" }] });
    expect(mutates[0]).toEqual([{ adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/61`, keyword: { text: "trail running", matchType: "BROAD" } } } }]);
    await exec("add_display_placements", { ad_group_id: "61", items: [{ type: "website", value: "news.example.com" }, { type: "youtube_channel", value: "UC123" }, { type: "mobile_app", value: "1-com.example.app" }] });
    await exec("add_display_topics", { ad_group_id: "61", items: [{ topic_id: "35" }] });
    expect(mutates[2]).toEqual([{ adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/61`, topic: { topicConstant: "topicConstants/35" } } } }]);
    expect((await run("add_display_topics", { ad_group_id: "61", items: [{ topic_id: "35" }] })).error?.message).toContain("Nothing would change");
    const kw = agc["61"]!.find((x) => x.type === "KEYWORD")!.criterionId;
    const rm = await run("remove_display_criteria", { ad_group_id: "61", criterion_ids: [kw] });
    expect(rm.approval?.risk).toBe("destructive");
    expect((await approve(rm.approval!.approval_id, kit.second)).status).toBe("executed");
    expect((await run("remove_display_criteria", { ad_group_id: "61", criterion_ids: ["424242"] })).error?.message).toContain("Not on this Display ad group");
  });

  it("campaign placement exclusions are negative campaign criteria", async () => {
    const { done } = await exec("add_placement_exclusions", { campaign_id: "51", placements: [{ type: "website", value: "spam.example" }, { type: "youtube_video", value: "abc123" }] });
    expect(done.result).toMatchObject({ excluded: ["PLACEMENT:spam.example", "YOUTUBE_VIDEO:abc123"], skipped_existing: [] });
    expect(mutates[0]![0]).toEqual({ campaignCriterionOperation: { create: { campaign: `${C}/campaigns/51`, negative: true, placement: { url: "spam.example" } } } });
    expect((await run("add_placement_exclusions", { campaign_id: "51", placements: [{ type: "website", value: "spam.example" }] })).error?.message).toContain("already excluded");
  });
});

describe("Demand Gen channel controls", () => {
  it("narrowing to selected channels is a write; going back to all channels widens", async () => {
    const r = await run("update_demandgen_channel_controls", { ad_group_id: "71", mode: "selected", channels: ["youtube_shorts", "gmail"] });
    expect(r.approval?.risk).toBe("write");
    const done = await approve(r.approval!.approval_id);
    expect(done.result).toEqual({ ad_group_id: "71", mode: "selected", selected: ["youtube_shorts", "gmail"] });
    expect(mutates[0]![0].adGroupOperation.update.demandGenAdGroupSettings.channelControls.selectedChannels).toEqual({ youtubeInStream: false, youtubeInFeed: false, youtubeShorts: true, discover: false, gmail: true, display: false, maps: false });
    expect(mutates[0]![0].adGroupOperation.update.demandGenAdGroupSettings.channelControls.channelConfig).toBe("SELECTED_CHANNELS");
    const owned = await run("update_demandgen_channel_controls", { ad_group_id: "71", mode: "google_owned_only" });
    expect(owned.approval?.risk).toBe("high_impact");
    expect((await run("update_demandgen_channel_controls", { ad_group_id: "71", mode: "selected" })).error?.code).toBe("invalid_argument");
    expect((await run("update_demandgen_channel_controls", { ad_group_id: "61", mode: "all_channels" })).error?.message).toContain("not in a Demand Gen");
  });

  it("an unconfirmed write is unknown_outcome", async () => {
    const r = await run("add_display_topics", { ad_group_id: "61", items: [{ topic_id: "99" }] });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});
