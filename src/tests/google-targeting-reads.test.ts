import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeGoogle } from "./support/fake-google";
import { googleHarness, type GoogleHarness } from "./support/harness";

const g = fakeGoogle();
let kit: GoogleHarness;
const C = "customers/1234567890";
beforeAll(async () => {
  kit = await googleHarness("TR", g.fetch);
});
beforeEach(() => g.reset());
const run = (name: string, args: Record<string, unknown> = {}) => kit.run(name, args);
const data = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await run(name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};

describe("ad group criteria reads", () => {
  it("audiences: names for user lists, interests and custom audiences; exclusions marked", async () => {
    g.search.ad_group_criterion = [
      { campaign: { id: "11" }, adGroup: { id: "21" }, adGroupCriterion: { criterionId: "1", type: "USER_LIST", negative: false, status: "ENABLED", userList: { userList: `${C}/userLists/501` } }, userList: { name: "Cart abandoners" } },
      { campaign: { id: "11" }, adGroup: { id: "21" }, adGroupCriterion: { criterionId: "2", type: "USER_INTEREST", negative: true, userInterest: { userInterestCategory: `${C}/userInterests/80432` } }, userInterest: { name: "Sports Fans" } },
      { campaign: { id: "11" }, adGroup: { id: "21" }, adGroupCriterion: { criterionId: "3", type: "CUSTOM_AUDIENCE", customAudience: { customAudience: `${C}/customAudiences/77` } } },
    ];
    g.search.custom_audience = [{ customAudience: { id: "77", name: "Running gear intent" } }];
    const d = await data("get_ad_group_audiences", { campaign_id: "11" });
    expect(d.criteria.map((c: any) => [c.type, c.negative, c.detail.name])).toEqual([["USER_LIST", false, "Cart abandoners"], ["USER_INTEREST", true, "Sports Fans"], ["CUSTOM_AUDIENCE", false, "Running gear intent"]]);
    expect(d.criteria[0].detail.user_list_id).toBe("501");
    expect((await run("get_ad_group_audiences", {})).error?.code).toBe("invalid_argument");
  });

  it("demographics and device modifiers", async () => {
    g.search.ad_group_criterion = [{ adGroup: { id: "21" }, adGroupCriterion: { criterionId: "503001", type: "AGE_RANGE", negative: true, ageRange: { type: "AGE_RANGE_18_24" } } }];
    expect((await data("get_ad_group_demographics", { ad_group_ids: ["21"] })).criteria[0]).toMatchObject({ negative: true, detail: { age_range: "AGE_RANGE_18_24" } });
    g.search.ad_group_bid_modifier = [{ adGroup: { id: "21" }, adGroupBidModifier: { criterionId: "30001", device: { type: "MOBILE" }, bidModifier: 1.25 } }];
    expect((await data("get_ad_group_device_bid_modifiers", { ad_group_ids: ["21"] })).modifiers).toEqual([{ ad_group_id: "21", criterion_id: "30001", device: "MOBILE", bid_modifier: 1.25 }]);
  });

  it("display reads filter on the DISPLAY channel and map topics, keywords and placements", async () => {
    g.search.ad_group_criterion = (q) =>
      q.includes("'TOPIC'")
        ? [{ adGroup: { id: "61" }, adGroupCriterion: { criterionId: "9", type: "TOPIC", topic: { topicConstant: "topicConstants/35", path: ["Arts & Entertainment", "Music"] } } }]
        : q.includes("'KEYWORD'")
          ? [{ adGroup: { id: "61" }, adGroupCriterion: { criterionId: "8", type: "KEYWORD", keyword: { text: "trail running", matchType: "BROAD" } } }]
          : [{ adGroup: { id: "61" }, adGroupCriterion: { criterionId: "7", type: "PLACEMENT", placement: { url: "news.example.com" } } }];
    g.search.campaign_criterion = [{ campaign: { id: "51" }, campaignCriterion: { criterionId: "4", type: "YOUTUBE_CHANNEL", youtubeChannel: { channelId: "UC123" } } }];
    expect((await data("get_display_topics")).criteria[0].detail).toEqual({ topic_id: "35", path: "Arts & Entertainment > Music" });
    expect((await data("get_display_keywords")).criteria[0].detail).toEqual({ text: "trail running", match_type: "BROAD" });
    const p = await data("get_display_placements", { campaign_id: "51" });
    expect(p.ad_group_placements[0].detail).toEqual({ url: "news.example.com" });
    expect(p.campaign_exclusions[0]).toMatchObject({ campaign_id: "51", type: "YOUTUBE_CHANNEL", youtube_channel_id: "UC123" });
    expect(g.queries.filter((q) => q.includes("FROM ad_group_criterion")).every((q) => q.includes("campaign.advertising_channel_type = 'DISPLAY'"))).toBe(true);
  });

  it("display ad group settings, frequency caps and demand gen channel controls", async () => {
    g.search.ad_group = (q) =>
      q.includes("DEMAND_GEN")
        ? [{ adGroup: { id: "71", name: "DG", demandGenAdGroupSettings: { channelControls: { channelStrategy: "SELECTED_CHANNELS", selectedChannels: { youtubeShorts: true, gmail: false } } } }, campaign: { id: "70" } }]
        : [{ adGroup: { id: "61", name: "Disp", status: "ENABLED", cpcBidMicros: "700000", optimizedTargetingEnabled: true, targetingSetting: { targetRestrictions: [{ targetingDimension: "AUDIENCE", bidOnly: true }] } }, campaign: { id: "51" } }];
    const s = await data("get_display_ad_group_settings");
    expect(s.ad_groups[0]).toMatchObject({ ad_group_id: "61", cpc_bid: 0.7, cpm_bid: null, optimized_targeting: true, target_restrictions: [{ dimension: "AUDIENCE", bid_only: true }] });
    const dg = await data("get_demandgen_channel_controls");
    expect(dg.ad_groups[0]).toMatchObject({ channel_strategy: "SELECTED_CHANNELS", selected_channels: { youtube_shorts: true, gmail: false, maps: null } });
    g.search.campaign = [{ campaign: { id: "51", name: "Disp", frequencyCaps: [{ key: { level: "AD_GROUP", eventType: "IMPRESSION", timeUnit: "WEEK", timeLength: 1 }, cap: 5 }] } }];
    expect((await data("get_display_frequency_caps")).campaigns[0].frequency_caps[0]).toMatchObject({ level: "AD_GROUP", cap: 5 });
  });
});

describe("lookups", () => {
  it("languages", async () => {
    g.search.language_constant = [{ languageConstant: { id: "1000", name: "English", code: "en", targetable: true } }];
    expect((await data("list_google_languages", { name_contains: "Eng" })).languages).toEqual([{ language_constant_id: "1000", name: "English", code: "en", targetable: true }]);
    expect(g.queries[0]).toContain("LIKE '%Eng%'");
  });

  it("locations use the suggest service with the documented request shape", async () => {
    g.rpc["geoTargetConstants:suggest"] = (body) => ({ geoTargetConstantSuggestions: body.locationNames.names.map((nm: string) => ({ searchTerm: nm, reach: "1000000", geoTargetConstant: { id: "1023191", name: "New York", canonicalName: "New York,New York,United States", targetType: "City", countryCode: "US", status: "ENABLED" } })) });
    const d = await data("resolve_google_locations", { names: ["New York"], country_code: "US" });
    expect(d.suggestions[0]).toEqual({ search_term: "New York", geo_target_id: "1023191", name: "New York", canonical_name: "New York,New York,United States", target_type: "City", country_code: "US", status: "ENABLED", reach: 1000000 });
    expect(g.calls.find((c) => c.path === "geoTargetConstants:suggest")!.body).toEqual({ locale: "en", countryCode: "US", locationNames: { names: ["New York"] } });
  });

  it("search_audiences queries the chosen kinds and refuses wildcard characters", async () => {
    g.search.user_interest = [{ userInterest: { userInterestId: "80432", name: "Sports Fans", taxonomyType: "AFFINITY" } }];
    g.search.user_list = [{ userList: { id: "501", name: "Sports buyers", type: "RULE_BASED", sizeForDisplay: "12000", membershipStatus: "OPEN" } }];
    const d = await data("search_audiences", { query: "Sport", kinds: ["user_interest", "user_list"] });
    expect(d.audiences.map((x: any) => [x.kind, x.id])).toEqual([["user_interest", "80432"], ["user_list", "501"]]);
    expect(d.audiences[1].size_for_display).toBe(12000);
    expect(g.queries.some((q) => q.includes("FROM custom_audience"))).toBe(false);
    expect((await run("search_audiences", { query: "50%" })).error?.code).toBe("invalid_argument");
  });
});
