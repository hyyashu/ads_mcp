import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeGoogle } from "./support/fake-google";
import { googleHarness, type GoogleHarness } from "./support/harness";

const g = fakeGoogle();
let kit: GoogleHarness;
const C = "customers/1234567890";
beforeAll(async () => {
  kit = await googleHarness("PX", g.fetch);
});
const pmax = (q: string) => (q.includes("campaign.id = 81") ? [{ campaign: { id: "81", name: "PMax", advertisingChannelType: "PERFORMANCE_MAX", status: "ENABLED" } }] : q.includes("campaign.id = 11") ? [{ campaign: { id: "11", advertisingChannelType: "SEARCH" } }] : []);
beforeEach(() => {
  g.reset();
  g.search.campaign = pmax;
});
const run = (name: string, args: Record<string, unknown> = {}) => kit.run(name, args);
const data = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await run(name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};

describe("Performance Max reads", () => {
  it("refuses non-PMax and unknown campaigns", async () => {
    expect((await run("get_pmax_conversion_goals", { campaign_id: "11" })).error).toMatchObject({ code: "invalid_argument", message: expect.stringContaining("not a Performance Max") });
    expect((await run("get_pmax_conversion_goals", { campaign_id: "99" })).error?.code).toBe("not_found");
    expect((await run("list_pmax_asset_group_assets", {})).error?.code).toBe("invalid_argument");
  });

  it("asset groups with metrics; groups without activity get zero counters and null ratios", async () => {
    g.search.asset_group = (q) =>
      q.includes("metrics.")
        ? [{ assetGroup: { id: "901" }, metrics: { impressions: "1000", clicks: "50", costMicros: "25000000", conversions: 5, conversionsValue: 100 } }]
        : [{ assetGroup: { id: "901", name: "Shoes", status: "ENABLED", adStrength: "GOOD", finalUrls: ["https://x.example"] }, campaign: { id: "81" } }, { assetGroup: { id: "902", name: "Idle", status: "PAUSED", adStrength: "POOR" }, campaign: { id: "81" } }];
    const d = await data("get_pmax_asset_groups", { campaign_id: "81" });
    expect(d.asset_groups[0].performance).toEqual({ impressions: 1000, clicks: 50, cost: 25, conversions: 5, conversion_value: 100, ctr: 0.05, cost_per_conversion: 5, roas: 4 });
    expect(d.asset_groups[1].performance).toEqual({ impressions: 0, clicks: 0, cost: 0, conversions: 0, conversion_value: 0, ctr: null, cost_per_conversion: null, roas: null });
  });

  it("asset listings, images only, and asset performance", async () => {
    g.search.asset_group_asset = (q) =>
      q.includes("metrics.")
        ? [{ assetGroup: { id: "901" }, assetGroupAsset: { fieldType: "HEADLINE" }, asset: { id: "1", type: "TEXT", textAsset: { text: "Run faster" } }, metrics: { impressions: "500", clicks: "10", costMicros: "1000000" } }]
        : q.includes("MARKETING_IMAGE")
          ? [{ assetGroup: { id: "901" }, assetGroupAsset: { fieldType: "SQUARE_MARKETING_IMAGE", status: "ENABLED" }, asset: { id: "2", type: "IMAGE", imageAsset: { fullSize: { url: "https://img", widthPixels: 1200, heightPixels: 1200 } } } }]
          : [{ assetGroup: { id: "901" }, assetGroupAsset: { fieldType: "HEADLINE", status: "ENABLED", policySummary: { approvalStatus: "APPROVED" } }, asset: { id: "1", type: "TEXT", textAsset: { text: "Run faster" } } }];
    expect((await data("list_pmax_asset_group_assets", { asset_group_ids: ["901"] })).assets[0]).toMatchObject({ asset_id: "1", field_type: "HEADLINE", text: "Run faster", approval: "APPROVED", image: null });
    expect((await data("list_pmax_asset_group_images", { campaign_id: "81" })).images[0]).toMatchObject({ field_type: "SQUARE_MARKETING_IMAGE", image: { width: 1200, height: 1200 } });
    expect((await data("get_pmax_asset_performance", { asset_group_ids: ["901"] })).assets[0]).toMatchObject({ text: "Run faster", performance: { impressions: 500, clicks: 10, cost: 1, ctr: 0.02 } });
  });

  it("audience signals with names, search themes, conversion goals and listing filters", async () => {
    g.search.asset_group_signal = (q) => (q.includes("search_theme") ? [{ assetGroup: { id: "901" }, assetGroupSignal: { searchTheme: { text: "trail shoes" }, approvalStatus: "APPROVED", resourceName: `${C}/assetGroupSignals/901~5` } }] : [{ assetGroup: { id: "901" }, assetGroupSignal: { audience: { audience: `${C}/audiences/44` }, approvalStatus: "APPROVED" } }]);
    g.search.audience = [{ audience: { id: "44", name: "Runners", description: "people who run" } }];
    expect((await data("get_pmax_audience_signals", { campaign_id: "81" })).signals).toEqual([{ asset_group_id: "901", audience_id: "44", name: "Runners", description: "people who run", approval: "APPROVED" }]);
    expect((await data("get_pmax_search_themes", { campaign_id: "81" })).themes[0]).toMatchObject({ text: "trail shoes" });
    g.search.campaign_conversion_goal = [{ campaign: { id: "81" }, campaignConversionGoal: { category: "PURCHASE", origin: "WEBSITE", biddable: true } }];
    expect((await data("get_pmax_conversion_goals", { campaign_id: "81" })).goals).toEqual([{ category: "PURCHASE", origin: "WEBSITE", biddable: true }]);
    g.search.asset_group_listing_group_filter = [
      { assetGroup: { id: "901" }, assetGroupListingGroupFilter: { id: "1", type: "SUBDIVISION", listingSource: "SHOPPING" } },
      { assetGroup: { id: "901" }, assetGroupListingGroupFilter: { id: "2", type: "UNIT_INCLUDED", parentListingGroupFilter: `${C}/assetGroupListingGroupFilters/901~1`, caseValue: { productBrand: { value: "Acme" } } } },
    ];
    const f = await data("get_asset_group_listing_filters", { asset_group_ids: ["901"] });
    expect(f.filters[1]).toEqual({ asset_group_id: "901", filter_id: "2", parent_filter_id: "1", type: "UNIT_INCLUDED", listing_source: null, dimension: "product_brand", value: "Acme" });
  });

  it("search terms flag non-converting spend; categories show conversion share", async () => {
    g.search.campaign_search_term_view = [
      { campaignSearchTermView: { searchTerm: "cheap shoes" }, metrics: { impressions: "900", clicks: "30", costMicros: "15000000" } },
      { campaignSearchTermView: { searchTerm: "acme trail shoe" }, metrics: { impressions: "300", clicks: "20", costMicros: "8000000", conversions: 2, conversionsValue: 160 } },
    ];
    const t = await data("analyze_pmax_search_terms", { campaign_id: "81", min_cost_without_conversion: 10 });
    expect(t.terms.map((x: any) => [x.search_term, x.wasted])).toEqual([["cheap shoes", true], ["acme trail shoe", false]]);
    expect(t).toMatchObject({ wasted_cost: 15, analyzed_cost: 23 });
    g.search.campaign_search_term_insight = [{ campaignSearchTermInsight: { id: "7", categoryLabel: "running shoes" }, metrics: { impressions: "100", clicks: "9", conversions: 3 } }, { campaignSearchTermInsight: { id: "8", categoryLabel: "sneakers" }, metrics: { conversions: 1 } }];
    const c = await data("analyze_pmax_search_categories", { campaign_id: "81" });
    expect(c.categories[0]).toEqual({ category_id: "7", category_label: "running shoes", impressions: 100, clicks: 9, conversions: 3, conversion_value: 0, conversion_share: 0.75 });
    expect(g.queries.find((q) => q.includes("FROM campaign_search_term_insight"))).toContain("campaign_search_term_insight.campaign_id = 81");
  });
});
