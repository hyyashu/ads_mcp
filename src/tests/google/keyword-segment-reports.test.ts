import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

const C = "customers/1234567890";
let search: Record<string, (q: string) => unknown[]>;
let sets: { id: string; name: string; refs: number }[];
let crit: { set: string; id: string; text: string; match: string; removed?: boolean }[];
let links: { campaign: string; set: string; removed?: boolean }[];
let queries: string[];
let mutates: any[][];
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    queries.push(q);
    const from = /FROM ([a-z_]+)/.exec(q)![1]!;
    if (from === "shared_set") return J({ results: sets.map((s) => ({ sharedSet: { id: s.id, name: s.name, memberCount: String(crit.filter((c) => c.set === s.id && !c.removed).length), referenceCount: String(s.refs) } })) });
    if (from === "shared_criterion") return J({ results: crit.filter((c) => !c.removed && q.includes(`shared_set.id = ${c.set}`)).map((c) => ({ sharedCriterion: { criterionId: c.id, keyword: { text: c.text, matchType: c.match } } })) });
    if (from === "campaign_shared_set") return J({ results: links.filter((l) => !l.removed && q.includes(`shared_set.id = ${l.set}`)).map((l) => ({ campaign: { id: l.campaign, name: "C" } })) });
    return J({ results: search[from]?.(q) ?? [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    for (const op of body.mutateOperations) {
      if (op.sharedCriterionOperation?.remove) {
        const [s, c] = op.sharedCriterionOperation.remove.split("/").pop().split("~");
        crit.find((x) => x.set === s && x.id === c)!.removed = true;
      }
      if (op.campaignSharedSetOperation?.remove) {
        const [c, s] = op.campaignSharedSetOperation.remove.split("/").pop().split("~");
        links.find((x) => x.campaign === c && x.set === s)!.removed = true;
      }
    }
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("KS", fake);
});
beforeEach(() => {
  search = {};
  sets = [{ id: "70", name: "Brand negatives", refs: 2 }];
  crit = [{ set: "70", id: "1", text: "free", match: "BROAD" }, { set: "70", id: "2", text: "jobs", match: "PHRASE" }];
  links = [{ campaign: "11", set: "70" }, { campaign: "12", set: "70" }];
  queries = [];
  mutates = [];
});
const data = async (name: string, args: Record<string, unknown>) => {
  const r = await kit.run(name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};

describe("get_keyword_performance", () => {
  it("returns Quality Score components, bid estimates and metrics; filters are injection-safe", async () => {
    search.keyword_view = () => [
      {
        campaign: { id: "11" },
        adGroup: { id: "21" },
        adGroupCriterion: { criterionId: "5", status: "ENABLED", systemServingStatus: "ELIGIBLE", effectiveCpcBidMicros: "1200000", keyword: { text: "trail shoes", matchType: "PHRASE" }, qualityInfo: { qualityScore: 4, searchPredictedCtr: "BELOW_AVERAGE", creativeQualityScore: "AVERAGE", postClickQualityScore: "ABOVE_AVERAGE" }, positionEstimates: { firstPageCpcMicros: "900000", topOfPageCpcMicros: "1800000" } },
        metrics: { impressions: "1000", clicks: "40", costMicros: "48000000", conversions: 2, searchImpressionShare: 0.35 },
      },
    ];
    const d = await data("get_keyword_performance", { campaign_ids: ["11"], max_quality_score: 5, min_impressions: 100 });
    expect(d.keywords[0]).toEqual({ campaign_id: "11", ad_group_id: "21", criterion_id: "5", text: "trail shoes", match_type: "PHRASE", status: "ENABLED", serving_status: "ELIGIBLE", cpc_bid: 1.2, quality_score: 4, expected_ctr: "BELOW_AVERAGE", ad_relevance: "AVERAGE", landing_page_experience: "ABOVE_AVERAGE", first_page_cpc: 0.9, top_of_page_cpc: 1.8, search_impression_share: 0.35, performance: { impressions: 1000, clicks: 40, cost: 48, conversions: 2, conversion_value: 0, ctr: 0.04, average_cpc: 1.2, conversion_rate: 0.05, cost_per_conversion: 24, roas: 0 } });
    expect(queries[0]).toContain("ad_group_criterion.negative = FALSE");
    expect(queries[0]).toContain("ad_group_criterion.quality_info.quality_score <= 5");
    expect((await kit.run("get_keyword_performance", { campaign_ids: ["1 OR 1=1"] })).error?.code).toBe("invalid_argument");
  });
});

describe("get_segment_performance", () => {
  it("device: shares and comparison with the total, from the campaign resource", async () => {
    search.campaign = () => [
      { segments: { device: "MOBILE" }, metrics: { impressions: "800", clicks: "60", costMicros: "60000000", conversions: 2 } },
      { segments: { device: "DESKTOP" }, metrics: { impressions: "200", clicks: "40", costMicros: "40000000", conversions: 3 } },
      { segments: { device: "MOBILE" }, metrics: { impressions: "100", clicks: "0", costMicros: "0" } },
    ];
    const d = await data("get_segment_performance", { segment: "device" });
    expect(d.total).toMatchObject({ cost: 100, conversions: 5, cost_per_conversion: 20 });
    expect(d.rows[0]).toMatchObject({ value: "MOBILE", cost_share: 0.6, conversion_share: 0.4, cpa_vs_total: 1.5, performance: { impressions: 900, cost_per_conversion: 30 } });
    expect(d.rows[1]).toMatchObject({ value: "DESKTOP", cpa_vs_total: round(13.333 / 20) });
  });

  it("hours are ordered by hour; regions are resolved to names with location type", async () => {
    search.campaign = () => [{ segments: { hour: 14 }, metrics: { clicks: "5" } }, { segments: { hour: 9 }, metrics: { clicks: "3" } }];
    expect((await data("get_segment_performance", { segment: "hour_of_day" })).rows.map((r: any) => r.value)).toEqual(["9", "14"]);
    search.geographic_view = () => [{ geographicView: { locationType: "LOCATION_OF_PRESENCE" }, segments: { geoTargetRegion: "geoTargetConstants/21137" }, metrics: { impressions: "50", costMicros: "5000000" } }];
    search.geo_target_constant = () => [{ geoTargetConstant: { id: "21137", canonicalName: "California,United States" } }];
    const d = await data("get_segment_performance", { segment: "region", date_range: "LAST_7_DAYS" });
    expect(d.rows[0]).toMatchObject({ value: "21137", name: "California,United States", location_type: "LOCATION_OF_PRESENCE" });
    search.age_range_view = () => [{ adGroupCriterion: { ageRange: { type: "AGE_RANGE_25_34" } }, metrics: { costMicros: "1000000" } }];
    expect((await data("get_segment_performance", { segment: "age" })).rows[0].value).toBe("AGE_RANGE_25_34");
  });

  it("a campaign filter also selects campaign.id (Google rejects a WHERE field absent from SELECT) and rows still merge across campaigns", async () => {
    search.geographic_view = () => [
      { campaign: { id: "11" }, geographicView: { locationType: "AREA_OF_INTEREST" }, segments: { geoTargetCity: "geoTargetConstants/1007768" }, metrics: { costMicros: "3000000" } },
      { campaign: { id: "12" }, geographicView: { locationType: "AREA_OF_INTEREST" }, segments: { geoTargetCity: "geoTargetConstants/1007768" }, metrics: { costMicros: "2000000" } },
    ];
    search.geo_target_constant = () => [{ geoTargetConstant: { id: "1007768", canonicalName: "Mumbai,Maharashtra,India" } }];
    const d = await data("get_segment_performance", { segment: "city", campaign_ids: ["11", "12"] });
    const q = queries.find((x) => x.includes("FROM geographic_view"))!;
    expect(q).toMatch(/SELECT [^]*\bcampaign\.id\b[^]*FROM/);
    expect(q).toContain("campaign.id IN (11, 12)");
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]).toMatchObject({ value: "1007768", name: "Mumbai,Maharashtra,India", performance: { cost: 5 } });
  });

  it.each(["device", "hour_of_day", "day_of_week", "country", "region", "city", "age", "gender"])("%s with a campaign filter is a valid query", async (segment) => {
    // The schema guard fails the test if Google would reject the query (e.g. a segmenting field filtered but not selected).
    expect((await kit.run("get_segment_performance", { segment, campaign_ids: ["11"] })).error).toBeUndefined();
  });
});

describe("negative keyword list maintenance", () => {
  it("removes keywords from a list (destructive, case-insensitive match) and refuses unknown ones", async () => {
    const r = await kit.run("remove_negative_keywords_from_list", { shared_set_id: "70", keywords: [{ text: "FREE", match_type: "BROAD" }] });
    expect(r.approval).toMatchObject({ risk: "destructive", summary: expect.stringContaining("used by 2 campaign") });
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.result).toEqual({ shared_set_id: "70", removed: 1, campaigns_affected: 2 });
    expect(mutates[0]).toEqual([{ sharedCriterionOperation: { remove: `${C}/sharedCriteria/70~1` } }]);
    expect((await kit.run("remove_negative_keywords_from_list", { shared_set_id: "70", keywords: [{ text: "jobs", match_type: "EXACT" }] })).error?.message).toContain("Not in the list");
    expect((await kit.run("remove_negative_keywords_from_list", { shared_set_id: "99", keywords: [{ text: "x", match_type: "EXACT" }] })).error?.code).toBe("not_found");
  });

  it("detaches a list from one campaign only", async () => {
    const r = await kit.run("detach_negative_keyword_list_from_campaign", { campaign_id: "12", shared_set_id: "70" });
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ campaignSharedSetOperation: { remove: `${C}/campaignSharedSets/12~70` } }]);
    expect(links.filter((l) => !l.removed).map((l) => l.campaign)).toEqual(["11"]);
    expect((await kit.run("detach_negative_keyword_list_from_campaign", { campaign_id: "12", shared_set_id: "70" })).error?.message).toContain("not attached");
  });
});

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}
