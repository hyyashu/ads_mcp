import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeGoogle } from "./support/fake-google";
import { googleHarness, type GoogleHarness } from "./support/harness";

const g = fakeGoogle();
let kit: GoogleHarness;
const C = "customers/1234567890";
beforeAll(async () => {
  kit = await googleHarness("CR", g.fetch);
});
beforeEach(() => g.reset());
const run = (name: string, args: Record<string, unknown> = {}) => kit.run(name, args);
const data = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await run(name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};

describe("get_campaign_structure", () => {
  it("counts ads and keywords per ad group; unknown campaign is not_found", async () => {
    g.search.campaign = (q) => (q.includes("campaign.id = 11") ? [{ campaign: { id: "11", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH" } }] : []);
    g.search.ad_group = [{ adGroup: { id: "21", name: "Core", status: "ENABLED", type: "SEARCH_STANDARD" } }, { adGroup: { id: "22", name: "Empty", status: "PAUSED", type: "SEARCH_STANDARD" } }];
    g.search.ad_group_ad = [{ adGroup: { id: "21" }, adGroupAd: { ad: { id: "1" } } }, { adGroup: { id: "21" }, adGroupAd: { ad: { id: "2" } } }];
    g.search.ad_group_criterion = [{ adGroup: { id: "21" }, adGroupCriterion: { criterionId: "5" } }];
    const d = await data("get_campaign_structure", { campaign_id: "11" });
    expect(d.campaign).toEqual({ id: "11", name: "Brand", status: "ENABLED", channel_type: "SEARCH" });
    expect(d.ad_groups).toEqual([
      { ad_group_id: "21", name: "Core", status: "ENABLED", type: "SEARCH_STANDARD", ads: 2, keywords: 1 },
      { ad_group_id: "22", name: "Empty", status: "PAUSED", type: "SEARCH_STANDARD", ads: 0, keywords: 0 },
    ]);
    expect((await run("get_campaign_structure", { campaign_id: "99" })).error?.code).toBe("not_found");
    expect((await run("get_campaign_structure", { campaign_id: "1 OR 1=1" })).error?.code).toBe("invalid_argument");
  });
});

describe("get_campaign_targeting", () => {
  it("returns criteria with location names resolved and coordinates in degrees", async () => {
    g.search.campaign = [{ campaign: { id: "11", geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE", negativeGeoTargetType: "PRESENCE" } } }];
    g.search.campaign_criterion = [
      { campaignCriterion: { criterionId: "2840", type: "LOCATION", negative: false, location: { geoTargetConstant: "geoTargetConstants/2840" } } },
      { campaignCriterion: { criterionId: "7", type: "PROXIMITY", negative: false, proximity: { radius: 10, radiusUnits: "KILOMETERS", geoPoint: { latitudeInMicroDegrees: 52520000, longitudeInMicroDegrees: 13405000 } } } },
      { campaignCriterion: { criterionId: "30001", type: "DEVICE", bidModifier: 0.8, device: { type: "MOBILE" } } },
      { campaignCriterion: { criterionId: "9", type: "AD_SCHEDULE", adSchedule: { dayOfWeek: "MONDAY", startHour: 9, startMinute: "ZERO", endHour: 17, endMinute: "THIRTY" } } },
    ];
    g.search.geo_target_constant = [{ geoTargetConstant: { id: "2840", canonicalName: "United States", targetType: "Country" } }];
    const d = await data("get_campaign_targeting", { campaign_id: "11" });
    expect(d.location_match).toEqual({ positive: "PRESENCE", negative: "PRESENCE" });
    expect(d.criteria[0]).toEqual({ criterion_id: "2840", type: "LOCATION", negative: false, bid_modifier: null, detail: { geo_target_id: "2840", name: "United States (Country)" } });
    expect(d.criteria[1].detail).toMatchObject({ radius: 10, radius_units: "KILOMETERS", latitude: 52.52, longitude: 13.405 });
    expect(d.criteria[2]).toMatchObject({ bid_modifier: 0.8, detail: { device: "MOBILE" } });
    expect(d.criteria[3].detail).toEqual({ day_of_week: "MONDAY", start: "9:ZERO", end: "17:THIRTY" });
  });
});

describe("labels, frequency caps, extensions, call assets", () => {
  it("get_campaign_labels filters by campaign ids", async () => {
    g.search.campaign_label = [{ campaign: { id: "11", name: "Brand" }, label: { id: "3", name: "Q4" } }];
    g.search.label = [{ label: { id: "3", name: "Q4", status: "ENABLED", textLabel: { description: "holiday" } } }];
    const d = await data("get_campaign_labels", { campaign_ids: ["11"] });
    expect(d.campaign_labels).toEqual([{ campaign_id: "11", campaign_name: "Brand", label_id: "3", label_name: "Q4" }]);
    expect(d.labels[0]).toEqual({ label_id: "3", name: "Q4", status: "ENABLED", description: "holiday" });
    expect(g.queries[0]).toContain("campaign.id IN (11)");
  });

  it("get_campaign_frequency_caps maps cap entries", async () => {
    g.search.campaign = [{ campaign: { id: "11", name: "Disp", advertisingChannelType: "DISPLAY", frequencyCaps: [{ key: { level: "CAMPAIGN", eventType: "IMPRESSION", timeUnit: "DAY", timeLength: 1 }, cap: 3 }] } }, { campaign: { id: "12", name: "Search", advertisingChannelType: "SEARCH" } }];
    const d = await data("get_campaign_frequency_caps");
    expect(d.campaigns[0].frequency_caps).toEqual([{ level: "CAMPAIGN", event_type: "IMPRESSION", time_unit: "DAY", time_length: 1, cap: 3 }]);
    expect(d.campaigns[1].frequency_caps).toEqual([]);
  });

  it("list_campaign_extensions returns campaign and account level assets with content", async () => {
    g.search.campaign_asset = [{ campaignAsset: { campaign: `${C}/campaigns/11`, fieldType: "SITELINK", status: "ENABLED" }, asset: { id: "100", type: "SITELINK", finalUrls: ["https://x.example/a"], sitelinkAsset: { linkText: "Shop", description1: "d1" }, policySummary: { approvalStatus: "APPROVED" } } }];
    g.search.customer_asset = [{ customerAsset: { fieldType: "CALLOUT", status: "ENABLED" }, asset: { id: "101", type: "CALLOUT", calloutAsset: { calloutText: "Free shipping" } } }];
    const d = await data("list_campaign_extensions", { campaign_ids: ["11"] });
    expect(d.extensions).toEqual([
      { level: "campaign", campaign_id: "11", asset_id: "100", field_type: "SITELINK", status: "ENABLED", asset_type: "SITELINK", approval: "APPROVED", content: { link_text: "Shop", description1: "d1", description2: null, final_urls: ["https://x.example/a"] } },
      { level: "account", campaign_id: null, asset_id: "101", field_type: "CALLOUT", status: "ENABLED", asset_type: "CALLOUT", approval: null, content: { text: "Free shipping" } },
    ]);
    expect(g.queries.find((q) => q.includes("FROM campaign_asset"))).toContain(`'${C}/campaigns/11'`);
    g.queries.length = 0;
    await data("list_campaign_extensions", { include_account_level: false, field_type: "CALL" });
    expect(g.queries.some((q) => q.includes("FROM customer_asset") && q.includes("'CALL'"))).toBe(false);
  });

  it("list_call_assets shows where each number is linked", async () => {
    g.search.asset = [{ asset: { id: "200", callAsset: { phoneNumber: "+1 555 0100", countryCode: "US", callConversionReportingState: "USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION" } } }];
    g.search.customer_asset = [{ asset: { id: "200" }, customerAsset: { status: "ENABLED" } }];
    g.search.campaign_asset = [{ asset: { id: "200" }, campaignAsset: { campaign: `${C}/campaigns/11`, status: "PAUSED" } }];
    g.search.ad_group_asset = [];
    const d = await data("list_call_assets");
    expect(d.call_assets[0]).toMatchObject({ asset_id: "200", phone_number: "+1 555 0100", linked_to: [{ level: "account", id: null, status: "ENABLED" }, { level: "campaign", id: "11", status: "PAUSED" }] });
  });
});

describe("performance and shopping reads", () => {
  it("get_conversion_action_performance sums per action and includes actions with no conversions", async () => {
    g.search.campaign = [
      { segments: { conversionAction: `${C}/conversionActions/1`, conversionActionName: "Purchase" }, metrics: { conversions: 2, conversionsValue: 100, allConversions: 2, allConversionsValue: 100 } },
      { segments: { conversionAction: `${C}/conversionActions/1`, conversionActionName: "Purchase" }, metrics: { conversions: 1, conversionsValue: 50, allConversions: 1.5, allConversionsValue: 60 } },
    ];
    g.search.conversion_action = [{ conversionAction: { id: "1", name: "Purchase", category: "PURCHASE", status: "ENABLED", primaryForGoal: true, countingType: "MANY_PER_CLICK" } }, { conversionAction: { id: "2", name: "Lead", category: "SUBMIT_LEAD_FORM", status: "ENABLED", primaryForGoal: false } }];
    const d = await data("get_conversion_action_performance", { date_range: "LAST_7_DAYS" });
    expect(d.actions[0]).toEqual({ conversion_action_id: "1", name: "Purchase", category: "PURCHASE", status: "ENABLED", primary_for_goal: true, counting_type: "MANY_PER_CLICK", conversions: 3, conversion_value: 150, all_conversions: 3.5, all_conversion_value: 160 });
    expect(d.actions[1]).toMatchObject({ conversion_action_id: "2", conversions: 0, primary_for_goal: false });
  });

  it("get_placement_performance computes ratios and null when undefined", async () => {
    g.search.detail_placement_view = [{ detailPlacementView: { placement: "example.com", displayName: "Example", placementType: "WEBSITE", targetUrl: "https://example.com" }, campaign: { id: "11" }, metrics: { impressions: "1000", clicks: "10", costMicros: "5000000" } }];
    const d = await data("get_placement_performance", { min_impressions: 100 });
    expect(d.placements[0]).toEqual({ placement: "example.com", display_name: "Example", type: "WEBSITE", target_url: "https://example.com", campaign_id: "11", impressions: 1000, clicks: 10, cost: 5, conversions: 0, ctr: 0.01, cost_per_conversion: null });
    expect(g.queries[0]).toContain("metrics.impressions >= 100");
  });

  it("merchant links, shopping settings and product groups", async () => {
    g.search.product_link = [{ productLink: { productLinkId: "9", type: "MERCHANT_CENTER", merchantCenter: { merchantCenterId: "123456" } } }];
    expect((await data("get_merchant_center_links")).links).toEqual([{ product_link_id: "9", merchant_center_id: "123456" }]);

    g.search.campaign = [{ campaign: { id: "31", name: "Shop", advertisingChannelType: "SHOPPING", shoppingSetting: { merchantId: "123456", feedLabel: "US", campaignPriority: 1, enableLocal: false } } }];
    expect((await data("get_shopping_settings")).campaigns[0]).toEqual({ campaign_id: "31", name: "Shop", channel_type: "SHOPPING", merchant_id: "123456", feed_label: "US", campaign_priority: 1, enable_local: false, use_vehicle_inventory: null });

    g.search.ad_group_criterion = [
      { adGroupCriterion: { criterionId: "1", listingGroup: { type: "SUBDIVISION" } } },
      { adGroupCriterion: { criterionId: "2", cpcBidMicros: "1500000", listingGroup: { type: "UNIT", parentAdGroupCriterion: `${C}/adGroupCriteria/41~1`, caseValue: { productBrand: { value: "Acme" } } } } },
      { adGroupCriterion: { criterionId: "3", negative: true, listingGroup: { type: "UNIT", parentAdGroupCriterion: `${C}/adGroupCriteria/41~1`, caseValue: { productBrand: {} } } } },
    ];
    const pg = await data("get_product_groups", { ad_group_id: "41" });
    expect(pg.nodes[0]).toEqual({ criterion_id: "1", parent_criterion_id: null, type: "SUBDIVISION", negative: false, dimension: null, value: null, cpc_bid: null });
    expect(pg.nodes[1]).toEqual({ criterion_id: "2", parent_criterion_id: "1", type: "UNIT", negative: false, dimension: "product_brand", value: "Acme", cpc_bid: 1.5 });
    expect(pg.nodes[2]).toMatchObject({ negative: true, parent_criterion_id: "1" });
  });

  it("discover_existing_assets lists reusable assets with type-specific content", async () => {
    g.search.asset = [
      { asset: { id: "301", name: "Logo", type: "IMAGE", imageAsset: { mimeType: "IMAGE_PNG", fullSize: { url: "https://tpc.googlesyndication.com/x.png", widthPixels: 1200, heightPixels: 1200 } } } },
      { asset: { id: "302", type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId: "abc123" } } },
      { asset: { id: "303", type: "TEXT", textAsset: { text: "Fast delivery" } } },
    ];
    const d = await data("discover_existing_assets", { limit: 2 });
    expect(d.assets[0]).toMatchObject({ asset_id: "301", image: { width: 1200, height: 1200, mime_type: "IMAGE_PNG" } });
    expect(d.assets[1]).toMatchObject({ youtube_video_id: "abc123", image: null });
    expect(d.truncated).toBe(true);
    expect((await run("discover_existing_assets", { name_contains: "x' OR '1'='1" })).error?.code).toBe("invalid_argument");
  });
});
