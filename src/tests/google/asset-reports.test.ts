import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

const C = "customers/1234567890";
let search: Record<string, (q: string) => unknown[]>;
let queries: string[];
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const fake: FetchLike = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.endsWith("googleAds:search")) {
    queries.push(body.query);
    const from = /FROM ([a-z_]+)/.exec(body.query)![1]!;
    // Phone metrics come from their own query (they cannot be combined with the interaction segment): split each fixture row.
    const phone = body.query.includes("metrics.phone_calls");
    const rows = (search[from]?.(body.query) ?? []) as any[];
    return J({ results: rows.filter((r) => (phone ? r.campaignAsset?.fieldType ?? r.adGroupAsset?.fieldType ?? r.customerAsset?.fieldType : "") === (phone ? "CALL" : "")).map(({ segments, metrics, ...rest }) => ({ ...rest, ...(phone ? { metrics: { phoneCalls: metrics.phoneCalls, phoneImpressions: metrics.phoneImpressions } } : { segments, metrics: { ...metrics, phoneCalls: undefined, phoneImpressions: undefined } }) })) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: "no handler" } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("AR", fake);
});
beforeEach(() => {
  search = {};
  queries = [];
});
const data = async (args: Record<string, unknown>) => {
  const r = await kit.run("get_asset_performance", args);
  if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data as any;
};
const call = { id: "600", type: "CALL", callAsset: { countryCode: "IN", phoneNumber: "8404802214" } };
const link = { id: "500", type: "SITELINK", finalUrls: ["https://shop.example/sale"], sitelinkAsset: { linkText: "Sale" } };
/** One row per (link, interaction on this asset or not), as Google returns when the segment is selected. */
const m = (on: boolean, impressions: number, clicks: number, cost: number, conversions = 0, calls = 0) => ({ segments: { assetInteractionTarget: { interactionOnThisAsset: on } }, metrics: { impressions: String(impressions), clicks: String(clicks), costMicros: String(cost * 1e6), conversions, phoneCalls: String(calls), phoneImpressions: String(calls ? impressions : 0) } });

describe("get_asset_performance", () => {
  it("adds up each link's rows and separates interactions on the asset itself", async () => {
    search.campaign_asset = () => [
      { campaignAsset: { campaign: `${C}/campaigns/11`, fieldType: "SITELINK", status: "ENABLED" }, asset: link, ...m(true, 0, 30, 15, 3) },
      { campaignAsset: { campaign: `${C}/campaigns/11`, fieldType: "SITELINK", status: "ENABLED" }, asset: link, ...m(false, 1000, 70, 35, 2) },
      { campaignAsset: { campaign: `${C}/campaigns/11`, fieldType: "CALL", status: "ENABLED" }, asset: call, ...m(false, 400, 10, 8, 0, 6) },
    ];
    const d = await data({ level: "campaign" });
    expect(d.rows).toHaveLength(2);
    expect(d.rows[0]).toMatchObject({ level: "campaign", campaign_id: "11", ad_group_id: null, asset_id: "500", field_type: "SITELINK", status: "ENABLED", content: { link_text: "Sale" }, performance: { impressions: 1000, clicks: 100, cost: 50, conversions: 5 }, clicks_on_asset: 30, conversions_on_asset: 3, phone_calls: 0 });
    expect(d.rows[1]).toMatchObject({ asset_id: "600", field_type: "CALL", phone_calls: 6, phone_impressions: 400 });
    expect(d.by_field_type).toEqual(expect.arrayContaining([expect.objectContaining({ field_type: "SITELINK", links: 1, clicks_on_asset: 30 })]));
    const [main, phone] = [queries.find((x) => x.includes("FROM campaign_asset") && !x.includes("phone_calls"))!, queries.find((x) => x.includes("FROM campaign_asset") && x.includes("phone_calls"))!];
    expect(main).toContain("segments.asset_interaction_target.interaction_on_this_asset");
    expect(main).toContain("campaign_asset.status != 'REMOVED'");
    expect(phone).not.toContain("segments.asset_interaction_target");
    expect(phone).toContain("campaign_asset.field_type = 'CALL'");
  });

  it("reads all three levels by default; a campaign filter splits account-level assets by campaign", async () => {
    search.customer_asset = (q) => [{ customerAsset: { fieldType: "CALL", status: "ENABLED" }, asset: call, ...(q.includes("campaign.id") ? { campaign: { id: "11" } } : {}), ...m(false, 50, 5, 2) }];
    search.ad_group_asset = () => [{ adGroupAsset: { adGroup: `${C}/adGroups/21`, fieldType: "SITELINK", status: "PAUSED" }, campaign: { id: "11" }, asset: link, ...m(true, 0, 2, 1) }];
    const all = await data({});
    expect(all.rows.map((r: any) => r.level).sort()).toEqual(["account", "ad_group"]);
    expect(queries.some((q) => q.includes("FROM campaign_asset"))).toBe(true);
    queries = [];
    const one = await data({ campaign_ids: ["11"] });
    expect(one.rows.find((r: any) => r.level === "account")).toMatchObject({ campaign_id: "11" });
    expect(queries.find((q) => q.includes("FROM customer_asset"))).toMatch(/SELECT [^]*campaign\.id[^]*WHERE[^]*campaign\.id IN \(11\)/);
    expect(queries.find((q) => q.includes("FROM ad_group_asset"))).toMatch(/SELECT [^]*campaign\.id[^]*WHERE[^]*campaign\.id IN \(11\)/);
    expect(queries.find((q) => q.includes("FROM campaign_asset"))).toContain(`campaign_asset.campaign IN ('${C}/campaigns/11')`);
  });

  it("filters by field type and ranks by cost", async () => {
    search.campaign_asset = () => [
      { campaignAsset: { campaign: `${C}/campaigns/11`, fieldType: "CALL", status: "ENABLED" }, asset: call, ...m(false, 10, 1, 1) },
      { campaignAsset: { campaign: `${C}/campaigns/12`, fieldType: "CALL", status: "ENABLED" }, asset: call, ...m(false, 10, 1, 9) },
    ];
    const d = await data({ level: "campaign", field_types: ["CALL"], limit: 1 });
    expect(d.rows).toEqual([expect.objectContaining({ campaign_id: "12" })]);
    expect(d.truncated).toBe(true);
    expect(queries[0]).toContain("campaign_asset.field_type IN ('CALL')");
  });

  it("skips the phone query when call assets are not requested", async () => {
    await data({ level: "campaign", field_types: ["SITELINK"] });
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("phone_calls");
  });
});
