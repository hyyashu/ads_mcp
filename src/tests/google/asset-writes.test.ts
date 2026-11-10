import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

/** In-memory assets and campaign links; googleAds:mutate applies asset and campaign_asset operations atomically. */
const C = "customers/1234567890";
type Asset = Record<string, any> & { id: string };
let assets: Map<string, Asset>;
let links: { campaign: string; asset: string; fieldType: string; status: string }[];
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
    if (q.includes("FROM campaign ")) return J({ results: q.includes("campaign.id = 11") ? [{ campaign: { id: "11", name: "Brand", status: "ENABLED" } }] : q.includes("campaign.id = 13") ? [{ campaign: { id: "13", status: "REMOVED" } }] : [] });
    if (q.includes("FROM campaign_asset")) {
      const ft = /campaign_asset\.field_type = '([A-Z_]+)'/.exec(q)![1];
      const camp = /campaign_asset\.campaign = '([^']+)'/.exec(q)![1];
      return J({ results: links.filter((l) => l.fieldType === ft && l.campaign === camp && l.status !== "REMOVED").map((l) => ({ campaignAsset: { status: l.status }, asset: assets.get(l.asset) })) });
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
      } else if (op.campaignAssetOperation?.create) {
        const c = op.campaignAssetOperation.create;
        links.push({ campaign: c.campaign, asset: tempMap.get(c.asset) ?? c.asset.split("/").pop(), fieldType: c.fieldType, status: "ENABLED" });
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
    expect(done.result).toEqual({ campaign_id: "11", field_type: "CALL", linked: [{ asset_id: "700", label: "IN 8404802214" }], skipped_existing: [] });
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
