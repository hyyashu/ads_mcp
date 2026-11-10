import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { png } from "../support/images";
import { googleHarness, type GoogleHarness } from "../support/harness";

const C = "customers/1234567890";
let camps: Record<string, { name: string; status: string; channel: string; sub?: string }>;
let groups: Record<string, { name: string; status: string; campaign: string }>;
let ads: Record<string, { group: string; status: string; ad: Record<string, any> }>;
let crits: Record<string, any>[];
let nextId = 2000;
let mutates: any[][];
let images: Record<string, Buffer>;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const adType = (ad: any) => (ad.responsiveDisplayAd ? "RESPONSIVE_DISPLAY_AD" : ad.demandGenMultiAssetAd ? "DEMAND_GEN_MULTI_ASSET_AD" : ad.shoppingProductAd ? "SHOPPING_PRODUCT_AD" : ad.appAd ? "APP_AD" : "UNKNOWN");

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    const cid = /campaign\.id = (\d+)/.exec(q)?.[1];
    const ag = /ad_group\.id = (\d+)/.exec(q)?.[1];
    if (q.includes("FROM ad_group_ad")) return J({ results: Object.entries(ads).filter(([, a]) => a.group === ag && a.status !== "REMOVED").map(([id, a]) => ({ adGroupAd: { status: a.status, ad: { id, type: adType(a.ad), ...a.ad } } })) });
    if (q.includes("FROM ad_group") && ag) {
      const g = groups[ag];
      const c = g && camps[g.campaign]!;
      return J({ results: g ? [{ adGroup: { id: ag, name: g.name, status: g.status }, campaign: { status: c!.status, advertisingChannelType: c!.channel, ...(c!.sub ? { advertisingChannelSubType: c!.sub } : {}) } }] : [] });
    }
    if (q.includes("FROM ad_group")) return J({ results: Object.entries(groups).filter(([, g]) => g.campaign === cid && g.status !== "REMOVED").map(([id, g]) => ({ adGroup: { id, name: g.name } })) });
    if (q.includes("FROM campaign")) {
      const c = camps[cid!];
      return J({ results: c ? [{ campaign: { id: cid, name: c.name, status: c.status, advertisingChannelType: c.channel } }] : [] });
    }
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    const tmp = new Map<string, string>();
    const real = (rn: string) => tmp.get(rn) ?? rn.split("/").pop()!;
    for (const op of body.mutateOperations) {
      if (op.assetOperation?.create) tmp.set(op.assetOperation.create.resourceName, String(nextId++));
      else if (op.adGroupOperation?.create) {
        const id = String(nextId++);
        tmp.set(op.adGroupOperation.create.resourceName, id);
        groups[id] = { name: op.adGroupOperation.create.name, status: op.adGroupOperation.create.status, campaign: real(op.adGroupOperation.create.campaign) };
      } else if (op.adGroupAdOperation?.create) ads[String(nextId++)] = { group: real(op.adGroupAdOperation.create.adGroup), status: op.adGroupAdOperation.create.status, ad: op.adGroupAdOperation.create.ad };
      else if (op.adGroupCriterionOperation?.create) crits.push({ ...op.adGroupCriterionOperation.create, adGroup: real(op.adGroupCriterionOperation.create.adGroup) });
      else if (op.adOperation?.update) {
        const u = op.adOperation.update;
        const a = ads[u.resourceName.split("/").pop()]!;
        for (const k of ["responsiveDisplayAd", "appAd"]) if (u[k]) a.ad[k] = { ...a.ad[k], ...u[k] };
      }
    }
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("GA", fake, { images: async (u) => images[u] ?? Promise.reject(new Error("404")) });
});
beforeEach(() => {
  camps = { "11": { name: "Search", status: "PAUSED", channel: "SEARCH" }, "12": { name: "Live search", status: "ENABLED", channel: "SEARCH" }, "31": { name: "Shop", status: "PAUSED", channel: "SHOPPING" }, "51": { name: "Disp", status: "PAUSED", channel: "DISPLAY" }, "70": { name: "DG", status: "PAUSED", channel: "DEMAND_GEN" }, "90": { name: "App", status: "ENABLED", channel: "MULTI_CHANNEL", sub: "APP_CAMPAIGN" } };
  groups = { "61": { name: "Disp group", status: "ENABLED", campaign: "51" }, "71": { name: "DG group", status: "ENABLED", campaign: "70" }, "41": { name: "Shop group", status: "ENABLED", campaign: "31" }, "91": { name: "App group", status: "ENABLED", campaign: "90" } };
  ads = { "801": { group: "61", status: "ENABLED", ad: { finalUrls: ["https://shop.example"], responsiveDisplayAd: { headlines: [{ text: "Old" }], descriptions: [{ text: "Old desc" }], longHeadline: { text: "Old long" } } } }, "901": { group: "91", status: "ENABLED", ad: { appAd: { headlines: [{ text: "Get it" }, { text: "Run more" }], descriptions: [{ text: "Track runs" }] } } } };
  crits = [];
  mutates = [];
  images = { "https://cdn.example/land.png": png(1200, 628), "https://cdn.example/sq.png": png(1200, 1200), "https://cdn.example/logo.png": png(512, 512) };
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (id: string, by = kit.owner) => kit.approveAs(id, by);
const exec = async (name: string, args: Record<string, unknown>, by?: string) => {
  const r = await run(name, args);
  if (!r.approval) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  const done = await approve(r.approval.approval_id, by);
  expect(done.status, JSON.stringify(done.result)).toBe("executed");
  return { r, done };
};

describe("ad groups", () => {
  it("Search ad group in a paused campaign is a write; in a live campaign it is high impact", async () => {
    const { r, done } = await exec("add_search_ad_group", { campaign_id: "11", name: "Core", cpc_bid: 1.5 });
    expect(r.approval?.risk).toBe("write");
    expect(done.result).toMatchObject({ campaign_id: "11", name: "Core", status: "ENABLED" });
    expect(mutates[0]![0].adGroupOperation.create).toMatchObject({ campaign: `${C}/campaigns/11`, type: "SEARCH_STANDARD", cpcBidMicros: "1500000" });
    expect((await run("add_search_ad_group", { campaign_id: "12", name: "Live" })).approval?.risk).toBe("high_impact");
    expect((await run("add_search_ad_group", { campaign_id: "11", name: "core" })).error?.message).toContain("already has an ad group");
    expect((await run("add_search_ad_group", { campaign_id: "51", name: "X" })).error?.message).toContain("DISPLAY campaign");
  });

  it("Shopping ad group comes with its all-products group and product ad; Demand Gen has no type and ad-group targeting", async () => {
    await exec("add_shopping_ad_group", { campaign_id: "31", name: "All products", cpc_bid: 0.8 });
    expect(mutates[0]!.map((o: any) => Object.keys(o)[0])).toEqual(["adGroupOperation", "adGroupCriterionOperation", "adGroupAdOperation"]);
    expect(mutates[0]![1].adGroupCriterionOperation.create).toEqual({ adGroup: `${C}/adGroups/-1`, status: "ENABLED", listingGroup: { type: "UNIT" }, cpcBidMicros: "800000" });
    await exec("add_demandgen_ad_group", { campaign_id: "70", name: "Runners", location_ids: ["2840"], language_ids: ["1000"] });
    expect(mutates[1]![0].adGroupOperation.create.type).toBeUndefined();
    expect(mutates[1]!.slice(1).map((o: any) => Object.keys(o.adGroupCriterionOperation.create).sort())).toEqual([["adGroup", "location"], ["adGroup", "language"]]);
    await exec("add_display_ad_group", { campaign_id: "51", name: "Prospecting", cpm_bid: 3 });
    expect((await run("add_shopping_product_ad", { ad_group_id: "41" })).approval?.risk).toBe("write");
  });
});

describe("ads", () => {
  const rda = { ad_group_id: "61", final_url: "https://shop.example/new", headlines: ["New shoes"], long_headline: "New shoes for every trail", descriptions: ["Free returns"], business_name: "Acme", images: [{ url: "https://cdn.example/land.png", field_type: "MARKETING_IMAGE" }, { url: "https://cdn.example/sq.png", field_type: "SQUARE_MARKETING_IMAGE" }, { url: "https://cdn.example/logo.png", field_type: "LOGO" }] };

  it("responsive display ad: uploads the images and references them from the ad in one request", async () => {
    const { done } = await exec("add_display_ad", rda);
    const ops = mutates[0]!;
    expect(ops.slice(0, 3).every((o: any) => o.assetOperation.create.imageAsset.data)).toBe(true);
    const ad = ops[3].adGroupAdOperation.create.ad;
    expect(ad.finalUrls).toEqual(["https://shop.example/new"]);
    expect(ad.responsiveDisplayAd).toMatchObject({ businessName: "Acme", longHeadline: { text: "New shoes for every trail" }, marketingImages: [{ asset: `${C}/assets/-1` }], squareMarketingImages: [{ asset: `${C}/assets/-2` }], squareLogoImages: [{ asset: `${C}/assets/-3` }] });
    expect((done.result as any).ad_id).toMatch(/^\d+$/);
    expect((await run("add_display_ad", { ...rda, images: rda.images.slice(1) })).error?.message).toContain("MARKETING_IMAGE");
    expect((await run("add_display_ad", { ...rda, ad_group_id: "71" })).error?.message).toContain("DEMAND_GEN campaign");
  });

  it("updates responsive display ad text in place with a field mask", async () => {
    const { done } = await exec("update_display_ad_creative", { ad_group_id: "61", ad_id: "801", headlines: ["Fresh"], descriptions: ["Ships free"] });
    expect(mutates[0]).toEqual([{ adOperation: { update: { resourceName: `${C}/ads/801`, responsiveDisplayAd: { headlines: [{ text: "Fresh" }], descriptions: [{ text: "Ships free" }] } }, updateMask: "responsive_display_ad.headlines,responsive_display_ad.descriptions" } }]);
    expect(done.result).toEqual({ ad_id: "801", headlines: ["Fresh"], long_headline: "Old long", descriptions: ["Ships free"] });
  });

  it("Demand Gen image ad requires logos and sends the multi-asset ad shape", async () => {
    await exec("add_demandgen_ad", { ad_group_id: "71", final_url: "https://shop.example", business_name: "Acme", headlines: ["Run more"], descriptions: ["Shoes for trails"], images: [{ url: "https://cdn.example/sq.png", field_type: "SQUARE_MARKETING_IMAGE" }, { url: "https://cdn.example/logo.png", field_type: "LOGO" }], call_to_action_text: "Shop now" });
    expect(mutates[0]![2].adGroupAdOperation.create.ad.demandGenMultiAssetAd).toMatchObject({ businessName: "Acme", logoImages: [{ asset: `${C}/assets/-2` }], squareMarketingImages: [{ asset: `${C}/assets/-1` }], callToActionText: "Shop now" });
    expect((await run("add_demandgen_ad", { ad_group_id: "71", final_url: "https://shop.example", business_name: "Acme", headlines: ["X"], descriptions: ["Y"], images: [{ url: "https://cdn.example/sq.png", field_type: "SQUARE_MARKETING_IMAGE" }, { url: "https://cdn.example/land.png", field_type: "MARKETING_IMAGE" }] })).error?.message).toContain("LOGO");
  });

  it("app ad texts: add merges and caps at 5; remove keeps at least one of each and is destructive", async () => {
    const { done } = await exec("add_app_ad_asset", { ad_group_id: "91", headlines: ["get it", "Join free"] });
    expect(done.result).toEqual({ ad_id: "901", headlines: ["Get it", "Run more", "Join free"], descriptions: ["Track runs"] });
    expect((await run("add_app_ad_asset", { ad_group_id: "91", headlines: ["a", "b", "c"] })).error?.message).toContain("at most 5");
    expect((await run("remove_app_ad_asset", { ad_group_id: "91", descriptions: ["Track runs"] })).error?.message).toContain("must remain");
    const rm = await run("remove_app_ad_asset", { ad_group_id: "91", headlines: ["Run more"] });
    expect(rm.approval?.risk).toBe("destructive");
    expect((await approve(rm.approval!.approval_id, kit.second)).result).toEqual({ ad_id: "901", headlines: ["Get it", "Join free"], descriptions: ["Track runs"] });
    expect((await run("add_app_ad_asset", { ad_group_id: "61", headlines: ["x"] })).error?.message).toContain("not in an App campaign");
  });
});
