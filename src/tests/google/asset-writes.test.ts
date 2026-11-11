import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

/** In-memory assets and campaign links; googleAds:mutate applies asset and campaign_asset operations atomically. */
const C = "customers/1234567890";
type Asset = Record<string, any> & { id: string };
let assets: Map<string, Asset>;
/** A link at one level: campaign (campaign set), ad group (adGroup set) or account (neither). */
let links: { campaign?: string; adGroup?: string; asset: string; fieldType: string; status: string }[];
let excluded: string[];
let nextId = 1000;
let mutates: any[][];
let dropWrites = false;
let failMutate = false;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    if (q.includes("FROM campaign ")) return J({ results: q.includes("campaign.id = 11") ? [{ campaign: { id: "11", name: "Brand", status: "ENABLED", excludedParentAssetFieldTypes: excluded } }] : q.includes("campaign.id = 13") ? [{ campaign: { id: "13", status: "REMOVED" } }] : [] });
    if (q.includes("FROM ad_group ")) return J({ results: q.includes("ad_group.id = 21") ? [{ adGroup: { id: "21", name: "Shoes", status: "ENABLED" } }] : [] });
    const level = /FROM (campaign_asset|ad_group_asset|customer_asset)\b/.exec(q)?.[1];
    if (level) {
      const ft = /_asset\.field_type = '([A-Z_]+)'/.exec(q)?.[1];
      const owner = /_asset\.(?:campaign|ad_group) = '([^']+)'/.exec(q)?.[1];
      const asset = /_asset\.asset = '[^']*\/assets\/(\d+)'/.exec(q)?.[1];
      const at = (l: (typeof links)[number]) => (level === "campaign_asset" ? !!l.campaign : level === "ad_group_asset" ? !!l.adGroup : !l.campaign && !l.adGroup);
      const hits = links.filter((l) => at(l) && l.status !== "REMOVED" && (!ft || l.fieldType === ft) && (!owner || l.campaign === owner || l.adGroup === owner) && (!asset || l.asset === asset));
      return J({
        results: hits.map((l) => ({
          ...(level === "campaign_asset" ? { campaignAsset: { campaign: l.campaign, fieldType: l.fieldType, status: l.status } } : level === "ad_group_asset" ? { adGroupAsset: { adGroup: l.adGroup, fieldType: l.fieldType, status: l.status } } : { customerAsset: { fieldType: l.fieldType, status: l.status } }),
          ...(l.campaign ? { campaign: { name: l.campaign.endsWith("/11") ? "Brand" : "Other" } } : {}),
          asset: assets.get(l.asset),
        })),
      });
    }
    if (q.includes("FROM asset ")) {
      const ids = (/asset\.id IN \(([^)]*)\)/.exec(q)?.[1] ?? "").split(",").map((x) => x.trim());
      return J({ results: ids.filter((id) => assets.has(id)).map((id) => ({ asset: assets.get(id) })) });
    }
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    if (failMutate) return J({ error: { code: 500, status: "INTERNAL", message: "boom" } }, 500);
    if (dropWrites) return J({ mutateOperationResponses: [] });
    const tempMap = new Map<string, string>();
    for (const op of body.mutateOperations) {
      if (op.assetOperation?.create) {
        const id = String(nextId++);
        const { resourceName, ...rest } = op.assetOperation.create;
        tempMap.set(resourceName, id);
        assets.set(id, { id, ...rest });
      } else if (op.assetOperation?.update) {
        // Paths in the mask are set from the update, or cleared when the update leaves them out.
        const { resourceName, ...u } = op.assetOperation.update;
        const a = assets.get(resourceName.split("/").pop())!;
        for (const path of op.assetOperation.updateMask.split(",")) {
          const keys = path.split(".").map((k: string) => k.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase()));
          let src: any = u, dst: any = a;
          for (const k of keys.slice(0, -1)) (src = src?.[k]), (dst = dst[k] ??= {});
          const last = keys.at(-1)!;
          if (src?.[last] === undefined) delete dst[last];
          else dst[last] = src[last];
        }
      } else if (op.campaignOperation?.update) {
        excluded = op.campaignOperation.update.excludedParentAssetFieldTypes ?? [];
      } else if (op.campaignAssetOperation?.create || op.adGroupAssetOperation?.create || op.customerAssetOperation?.create) {
        const c = op.campaignAssetOperation?.create ?? op.adGroupAssetOperation?.create ?? op.customerAssetOperation.create;
        links.push({ ...(c.campaign ? { campaign: c.campaign } : {}), ...(c.adGroup ? { adGroup: c.adGroup } : {}), asset: tempMap.get(c.asset) ?? c.asset.split("/").pop(), fieldType: c.fieldType, status: "ENABLED" });
      } else if (op.customerAssetOperation?.remove) {
        const [asset, ft] = op.customerAssetOperation.remove.split("/").pop().split("~");
        const l = links.find((x) => !x.campaign && !x.adGroup && x.asset === asset && x.fieldType === ft);
        if (l) l.status = "REMOVED";
      } else if (op.adGroupAssetOperation?.remove) {
        const [g, asset, ft] = op.adGroupAssetOperation.remove.split("/").pop().split("~");
        const l = links.find((x) => x.adGroup === `${C}/adGroups/${g}` && x.asset === asset && x.fieldType === ft);
        if (l) l.status = "REMOVED";
      } else if (op.campaignAssetOperation?.remove) {
        const [camp, asset, ft] = op.campaignAssetOperation.remove.split("/").pop().split("~");
        const l = links.find((x) => x.campaign === `${C}/campaigns/${camp}` && x.asset === asset && x.fieldType === ft);
        if (l) l.status = "REMOVED";
      } else if (op.campaignAssetOperation?.update) {
        const [camp, asset, ft] = op.campaignAssetOperation.update.resourceName.split("/").pop().split("~");
        const l = links.find((x) => x.campaign === `${C}/campaigns/${camp}` && x.asset === asset && x.fieldType === ft)!;
        l.status = op.campaignAssetOperation.update.status;
      }
    }
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("AW", fake);
});
beforeEach(() => {
  assets = new Map([["500", { id: "500", type: "SITELINK", finalUrls: ["https://shop.example/sale"], sitelinkAsset: { linkText: "Sale" } }], ["600", { id: "600", type: "CALL", callAsset: { countryCode: "US", phoneNumber: "+1 555-0100" } }]]);
  links = [{ campaign: `${C}/campaigns/11`, asset: "500", fieldType: "SITELINK", status: "ENABLED" }, { campaign: `${C}/campaigns/11`, asset: "600", fieldType: "CALL", status: "ENABLED" }];
  excluded = [];
  mutates = [];
  dropWrites = false;
  failMutate = false;
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, { campaign_id: "11", ...args });
const approve = (id: string, by = kit.owner) => kit.approveAs(id, by);

describe("add extensions", () => {
  it("add_sitelinks: queues with a change set, skips duplicates, creates asset+link atomically and confirms", async () => {
    const r = await run("add_sitelinks", { items: [{ link_text: "Sale", final_url: "https://shop.example/sale" }, { link_text: "Contact", final_url: "https://shop.example/contact", description1: "Call us", description2: "Open daily" }] });
    expect(r.approval).toMatchObject({ risk: "write", summary: expect.stringContaining("1 already present"), change_set: { changes: [{ field: "sitelink", before: null, after: "Contact -> https://shop.example/contact", effect: "neutral" }] } });
    expect(mutates).toHaveLength(0);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      { assetOperation: { create: { resourceName: `${C}/assets/-1`, finalUrls: ["https://shop.example/contact"], sitelinkAsset: { linkText: "Contact", description1: "Call us", description2: "Open daily" } } } },
      { campaignAssetOperation: { create: { asset: `${C}/assets/-1`, campaign: `${C}/campaigns/11`, fieldType: "SITELINK" } } },
    ]);
    expect(done.result).toEqual({ campaign_id: "11", added: [{ asset_id: "1000", label: "Contact -> https://shop.example/contact" }], skipped_existing: ["Sale -> https://shop.example/sale"] });
  });

  it("validates limits and refuses no-op, unknown and removed campaigns", async () => {
    expect((await run("add_sitelinks", { items: [{ link_text: "x".repeat(26), final_url: "https://a.example" }] })).error?.code).toBe("invalid_argument");
    expect((await run("add_sitelinks", { items: [{ link_text: "A", final_url: "https://a.example", description1: "only one" }] })).error?.code).toBe("invalid_argument");
    expect((await run("add_sitelinks", { items: [{ link_text: "A", final_url: "javascript:alert(1)" }] })).error?.code).toBe("invalid_argument");
    expect((await run("add_sitelinks", { items: [{ link_text: "SALE", final_url: "https://shop.example/SALE" }] })).error?.message).toContain("already on the campaign");
    expect((await kit.run("add_callout_extensions", { campaign_id: "99", items: [{ text: "Free" }] })).error?.code).toBe("not_found");
    expect((await kit.run("add_callout_extensions", { campaign_id: "13", items: [{ text: "Free" }] })).error?.message).toContain("removed");
    expect((await run("add_structured_snippets", { items: [{ header: "Colours", values: ["a", "b", "c"] }] })).error?.code).toBe("invalid_argument");
    expect((await run("add_structured_snippets", { items: [{ header: "Brands", values: ["a", "b"] }] })).error?.code).toBe("invalid_argument");
    expect(mutates).toHaveLength(0);
  });

  it("callouts, snippets and call assets send the documented asset shapes", async () => {
    for (const [tool, items] of [
      ["add_callout_extensions", [{ text: "Free shipping" }]],
      ["add_structured_snippets", [{ header: "Brands", values: ["Acme", "Zenith", "Nova"] }]],
      ["add_call_asset", [{ country_code: "GB", phone_number: "+44 20 7946 0000" }]],
    ] as const) {
      const r = await run(tool, { items });
      expect((await approve(r.approval!.approval_id)).status).toBe("executed");
    }
    expect(mutates.map((m) => m[0].assetOperation.create)).toEqual([
      { resourceName: `${C}/assets/-1`, calloutAsset: { calloutText: "Free shipping" } },
      { resourceName: `${C}/assets/-1`, structuredSnippetAsset: { header: "Brands", values: ["Acme", "Zenith", "Nova"] } },
      { resourceName: `${C}/assets/-1`, callAsset: { countryCode: "GB", phoneNumber: "+44 20 7946 0000", callConversionReportingState: "USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION" } },
    ]);
  });

  it("business name replaces the existing one in the same request", async () => {
    const first = await run("add_business_name_asset", { business_name: "Acme Shoes" });
    await approve(first.approval!.approval_id);
    const second = await run("add_business_name_asset", { business_name: "Acme Running" });
    expect(second.approval?.change_set?.changes[0]).toMatchObject({ before: "Acme Shoes", after: "Acme Running" });
    const done = await approve(second.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[1]!.map((o: any) => Object.keys(o.campaignAssetOperation ?? o.assetOperation ?? {})[0])).toEqual(["remove", "create", "create"]);
    expect((await run("add_business_name_asset", { business_name: "acme running" })).error?.message).toContain("already set");
  });
});

describe("link_existing_assets", () => {
  beforeEach(() => {
    assets.set("700", { id: "700", type: "CALL", callAsset: { countryCode: "IN", phoneNumber: "8404802214" } });
    assets.set("701", { id: "701", type: "CALLOUT", calloutAsset: { calloutText: "Free shipping" } });
  });

  it("links an asset from the library without creating a new one, then confirms", async () => {
    const r = await run("link_existing_assets", { field_type: "CALL", asset_ids: ["700"] });
    expect(r.approval).toMatchObject({ risk: "write", summary: expect.stringContaining("IN 8404802214"), change_set: { changes: [{ field: "call", before: null, after: "IN 8404802214" }] } });
    expect(mutates).toHaveLength(0);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ campaignAssetOperation: { create: { asset: `${C}/assets/700`, campaign: `${C}/campaigns/11`, fieldType: "CALL" } } }]);
    expect(done.result).toEqual({ level: "campaign", campaign_id: "11", ad_group_id: null, field_type: "CALL", linked: [{ asset_id: "700", label: "IN 8404802214" }], skipped_existing: [] });
    expect(assets.size).toBe(4); // nothing created
  });

  it("skips assets already on the campaign and links the rest", async () => {
    assets.set("702", { id: "702", type: "CALL", callAsset: { countryCode: "IN", phoneNumber: "1800 000 000" } });
    const r = await run("link_existing_assets", { field_type: "CALL", asset_ids: ["600", "702"] });
    expect(r.approval?.summary).toContain("1 already linked");
    const done = await approve(r.approval!.approval_id);
    expect(mutates[0]).toHaveLength(1);
    expect(done.result).toMatchObject({ linked: [{ asset_id: "702" }], skipped_existing: ["600"] });
  });

  it("refuses unknown assets, the wrong asset type, and a no-op", async () => {
    expect((await run("link_existing_assets", { field_type: "CALL", asset_ids: ["999"] })).error).toMatchObject({ code: "not_found", message: expect.stringContaining("999") });
    expect((await run("link_existing_assets", { field_type: "CALL", asset_ids: ["701"] })).error).toMatchObject({ code: "invalid_argument", message: expect.stringContaining("701 is a CALLOUT asset") });
    expect((await run("link_existing_assets", { field_type: "SITELINK", asset_ids: ["500"] })).error?.message).toContain("already linked");
    expect((await run("link_existing_assets", { field_type: "BUSINESS_NAME", asset_ids: ["700"] })).error?.code).toBe("invalid_argument");
    expect((await kit.run("link_existing_assets", { campaign_id: "13", field_type: "CALL", asset_ids: ["700"] })).error?.message).toContain("removed");
    expect(mutates).toHaveLength(0);
  });

  it("a paused link counts as linked, and drift before approval applies nothing", async () => {
    links.find((l) => l.asset === "600")!.status = "PAUSED";
    expect((await run("link_existing_assets", { field_type: "CALL", asset_ids: ["600"] })).error?.message).toContain("already linked");
    const r = await run("link_existing_assets", { field_type: "CALLOUT", asset_ids: ["701"] });
    links.push({ campaign: `${C}/campaigns/11`, asset: "701", fieldType: "CALLOUT", status: "ENABLED" });
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    expect(mutates).toHaveLength(0);
  });
});

describe("account and ad group levels", () => {
  beforeEach(() => {
    assets.set("700", { id: "700", type: "CALL", callAsset: { countryCode: "IN", phoneNumber: "8404802214" } });
  });

  it("links at account level with a customer asset, and removes it again", async () => {
    const r = await kit.run("link_existing_assets", { level: "account", field_type: "CALL", asset_ids: ["700"] });
    expect(r.approval?.summary).toContain("the account");
    expect(r.approval?.change_set?.changes[0]).toMatchObject({ resource: "account", id: "1234567890", after: "IN 8404802214" });
    const done = await approve(r.approval!.approval_id);
    expect(mutates[0]).toEqual([{ customerAssetOperation: { create: { asset: `${C}/assets/700`, fieldType: "CALL" } } }]);
    expect(done.result).toEqual({ level: "account", campaign_id: null, ad_group_id: null, field_type: "CALL", linked: [{ asset_id: "700", label: "IN 8404802214" }], skipped_existing: [] });
    const rm = await kit.run("remove_call_assets", { level: "account", asset_ids: ["700"] });
    expect((await approve(rm.approval!.approval_id, kit.second)).status).toBe("executed");
    expect(mutates[1]).toEqual([{ customerAssetOperation: { remove: `${C}/customerAssets/700~CALL` } }]);
  });

  it("links at ad group level with an ad group asset, and removes it again", async () => {
    const r = await kit.run("link_existing_assets", { level: "ad_group", ad_group_id: "21", field_type: "SITELINK", asset_ids: ["500"] });
    expect(r.approval?.summary).toContain('ad group "Shoes"');
    const done = await approve(r.approval!.approval_id);
    expect(mutates[0]).toEqual([{ adGroupAssetOperation: { create: { asset: `${C}/assets/500`, adGroup: `${C}/adGroups/21`, fieldType: "SITELINK" } } }]);
    expect(done.result).toMatchObject({ level: "ad_group", ad_group_id: "21", linked: [{ asset_id: "500" }] });
    const rm = await kit.run("remove_sitelinks", { level: "ad_group", ad_group_id: "21", asset_ids: ["500"] });
    expect((await approve(rm.approval!.approval_id, kit.second)).status).toBe("executed");
    expect(mutates[1]).toEqual([{ adGroupAssetOperation: { remove: `${C}/adGroupAssets/21~500~SITELINK` } }]);
  });

  it("requires the id that matches the level, and an existing ad group", async () => {
    expect((await kit.run("link_existing_assets", { level: "account", campaign_id: "11", field_type: "CALL", asset_ids: ["700"] })).error?.code).toBe("invalid_argument");
    expect((await kit.run("link_existing_assets", { level: "ad_group", field_type: "CALL", asset_ids: ["700"] })).error?.code).toBe("invalid_argument");
    expect((await kit.run("link_existing_assets", { field_type: "CALL", asset_ids: ["700"] })).error?.code).toBe("invalid_argument");
    expect((await kit.run("link_existing_assets", { level: "ad_group", ad_group_id: "99", field_type: "CALL", asset_ids: ["700"] })).error?.code).toBe("not_found");
    expect((await kit.run("remove_call_assets", { level: "account", asset_ids: ["600"] })).error?.message).toContain("Not linked to the account");
    expect(mutates).toHaveLength(0);
  });
});

describe("update_extension_asset", () => {
  beforeEach(() => {
    assets.set("701", { id: "701", type: "CALLOUT", source: "ADVERTISER", calloutAsset: { calloutText: "Free shipping" } });
    assets.set("702", { id: "702", type: "CALLOUT", source: "AUTOMATICALLY_CREATED", calloutAsset: { calloutText: "Top rated" } });
    assets.set("500", { ...assets.get("500")!, source: "ADVERTISER", sitelinkAsset: { linkText: "Sale", description1: "Up to 50% off", description2: "This week" } });
    links.push({ campaign: `${C}/campaigns/11`, asset: "701", fieldType: "CALLOUT", status: "ENABLED" }, { campaign: `${C}/campaigns/12`, asset: "701", fieldType: "CALLOUT", status: "ENABLED" }, { asset: "701", fieldType: "CALLOUT", status: "ENABLED" });
  });

  it("edits a callout in place and lists everywhere it is used", async () => {
    const r = await kit.run("update_extension_asset", { asset_id: "701", callout: { text: "Free delivery" } });
    expect(r.approval?.summary).toMatch(/used in 3 places: the account, campaign "Brand", campaign "Other"/);
    expect(r.approval?.change_set?.changes).toEqual([expect.objectContaining({ resource: "asset", id: "701", field: "callout_text", before: "Free shipping", after: "Free delivery" })]);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ assetOperation: { update: { resourceName: `${C}/assets/701`, calloutAsset: { calloutText: "Free delivery" } }, updateMask: "callout_asset.callout_text" } }]);
    expect(done.result).toEqual({ asset_id: "701", field_type: "CALLOUT", updated: ["callout_text"], used_in: 3 });
  });

  it("sitelink: changes only the given fields, and null clears both descriptions", async () => {
    const r = await kit.run("update_extension_asset", { asset_id: "500", sitelink: { final_url: "https://shop.example/offers", description1: null, description2: null } });
    expect((await approve(r.approval!.approval_id)).status).toBe("executed");
    expect(mutates[0]).toEqual([{ assetOperation: { update: { resourceName: `${C}/assets/500`, finalUrls: ["https://shop.example/offers"] }, updateMask: "final_urls,sitelink_asset.description1,sitelink_asset.description2" } }]);
    expect(assets.get("500")).toMatchObject({ finalUrls: ["https://shop.example/offers"], sitelinkAsset: { linkText: "Sale" } });
    expect(assets.get("500")!.sitelinkAsset.description1).toBeUndefined();
  });

  it("call: changes the number", async () => {
    const r = await kit.run("update_extension_asset", { asset_id: "600", call: { country_code: "US", phone_number: "+1 555-0199" } });
    expect((await approve(r.approval!.approval_id)).status).toBe("executed");
    expect(mutates[0]![0].assetOperation).toEqual({ update: { resourceName: `${C}/assets/600`, callAsset: { phoneNumber: "+1 555-0199" } }, updateMask: "call_asset.phone_number" });
  });

  it("refuses the wrong type, unknown and Google-created assets, a no-op, half a description pair, and zero or two kinds", async () => {
    expect((await kit.run("update_extension_asset", { asset_id: "600", callout: { text: "x" } })).error?.message).toContain("600 is a CALL asset");
    expect((await kit.run("update_extension_asset", { asset_id: "999", callout: { text: "x" } })).error?.code).toBe("not_found");
    expect((await kit.run("update_extension_asset", { asset_id: "702", callout: { text: "x" } })).error?.message).toContain("created automatically");
    expect((await kit.run("update_extension_asset", { asset_id: "701", callout: { text: "Free shipping" } })).error?.message).toContain("Nothing would change");
    expect((await kit.run("update_extension_asset", { asset_id: "500", sitelink: { description1: null } })).error?.message).toContain("both descriptions");
    expect((await kit.run("update_extension_asset", { asset_id: "701" })).error?.code).toBe("invalid_argument");
    expect((await kit.run("update_extension_asset", { asset_id: "701", callout: { text: "a" }, call: { country_code: "US", phone_number: "123456" } })).error?.code).toBe("invalid_argument");
    expect(mutates).toHaveLength(0);
  });
});

describe("exclude_account_assets_from_campaign", () => {
  beforeEach(() => {
    links.push({ asset: "500", fieldType: "SITELINK", status: "ENABLED" });
  });

  it("excludes account-level sitelinks from one campaign, then allows them again", async () => {
    const r = await run("exclude_account_assets_from_campaign", { field_types: ["SITELINK"] });
    expect(r.approval?.summary).toContain("1 account-level sitelink");
    expect(r.approval?.change_set?.changes).toEqual([expect.objectContaining({ resource: "campaign", id: "11", field: "excluded_account_asset_types", before: "(none)", after: "SITELINK" })]);
    const done = await approve(r.approval!.approval_id);
    expect(mutates[0]).toEqual([{ campaignOperation: { update: { resourceName: `${C}/campaigns/11`, excludedParentAssetFieldTypes: ["SITELINK"] }, updateMask: "excluded_parent_asset_field_types" } }]);
    expect(done.result).toEqual({ campaign_id: "11", excluded_field_types: ["SITELINK"] });
    expect((await run("exclude_account_assets_from_campaign", { field_types: ["SITELINK"] })).error?.message).toContain("Nothing would change");
    const back = await run("exclude_account_assets_from_campaign", { field_types: ["SITELINK"], action: "include" });
    expect((await approve(back.approval!.approval_id)).result).toEqual({ campaign_id: "11", excluded_field_types: [] });
    expect(mutates[1]![0].campaignOperation.update.excludedParentAssetFieldTypes).toEqual([]);
  });

  it("refuses removed and unknown campaigns", async () => {
    expect((await kit.run("exclude_account_assets_from_campaign", { campaign_id: "13", field_types: ["CALL"] })).error?.message).toContain("removed");
    expect((await kit.run("exclude_account_assets_from_campaign", { campaign_id: "99", field_types: ["CALL"] })).error?.code).toBe("not_found");
  });
});

describe("remove and status", () => {
  it("remove_sitelinks is destructive, is high impact, and removes only the link", async () => {
    const r = await run("remove_sitelinks", { asset_ids: ["500"] });
    expect(r.approval).toMatchObject({ risk: "destructive", change_set: { changes: [{ effect: "remove", before: "Sale -> https://shop.example/sale" }] } });
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ campaignAssetOperation: { remove: `${C}/campaignAssets/11~500~SITELINK` } }]);
    expect(assets.has("500")).toBe(true);
    expect((await run("remove_callouts", { asset_ids: ["500"] })).error?.message).toContain("Not linked");
  });

  it("set_call_asset_status updates the link status with a mask", async () => {
    const r = await run("set_call_asset_status", { asset_ids: ["600"], status: "PAUSED" });
    expect((await approve(r.approval!.approval_id)).status).toBe("executed");
    expect(mutates[0]).toEqual([{ campaignAssetOperation: { update: { resourceName: `${C}/campaignAssets/11~600~CALL`, status: "PAUSED" }, updateMask: "status" } }]);
    expect((await run("set_call_asset_status", { asset_ids: ["600"], status: "PAUSED" })).error?.message).toContain("Nothing would change");
  });

  it("drift, unconfirmed writes and server errors are never reported as success", async () => {
    const r = await run("add_callout_extensions", { items: [{ text: "Fast delivery" }] });
    links.push({ campaign: `${C}/campaigns/11`, asset: "500", fieldType: "CALLOUT", status: "ENABLED" }); // account changed meanwhile
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    expect(mutates).toHaveLength(0);

    const r2 = await run("add_callout_extensions", { items: [{ text: "Gift wrap" }] });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id)).status).toBe("unknown_outcome");

    dropWrites = false;
    const r3 = await run("add_callout_extensions", { items: [{ text: "Price match" }] });
    failMutate = true;
    expect((await approve(r3.approval!.approval_id)).status).toBe("unknown_outcome");
    const tool = kit.deps.registry.get("add_callout_extensions")!;
    if (tool.kind !== "write") throw new Error("write tool expected");
    const services = await kit.deps.createServices({ tenantId: kit.tenantId, account: { id: kit.accountId, platform: "google_ads", externalId: "1234567890", loginCustomerId: "5550001111", connectionId: "x" } });
    const row = await kit.approvals.get(kit.tenantId, r3.approval!.approval_id);
    expect(await tool.verify(row!.args as never, { services } as never, { snapshot: row!.planSnapshot })).toEqual({ outcome: "not_applied" });
  });
});
