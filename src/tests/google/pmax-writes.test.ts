import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { png } from "../support/images";
import { googleHarness, type GoogleHarness } from "../support/harness";

const C = "customers/1234567890";
let camps: Record<string, { name: string; channel: string; brand: boolean; status: string }>;
let groups: Record<string, { name: string; status: string; campaign: string; finalUrls: string[]; path1?: string; path2?: string }>;
let assets: Map<string, Record<string, any>>;
let links: { group: string; asset: string; fieldType: string; status: string }[];
let campLinks: { campaign: string; asset: string; fieldType: string; status: string }[];
let signals: { resourceName: string; group: string; audience?: string; theme?: string }[];
let nextId = 5000;
let mutates: any[][];
let images: Record<string, Buffer>;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    const ag = /asset_group\.id = (\d+)/.exec(q)?.[1];
    const cid = /campaign\.id = (\d+)/.exec(q)?.[1];
    if (q.includes("FROM asset_group_asset")) return J({ results: links.filter((l) => l.group === ag && l.status !== "REMOVED").map((l) => ({ asset: assets.get(l.asset), assetGroupAsset: { fieldType: l.fieldType } })) });
    if (q.includes("FROM asset_group_signal")) return J({ results: signals.filter((x) => x.group === ag).map((x) => ({ assetGroupSignal: { resourceName: x.resourceName, ...(x.audience ? { audience: { audience: `${C}/audiences/${x.audience}` } } : {}), ...(x.theme ? { searchTheme: { text: x.theme } } : {}) } })) });
    if (q.includes("FROM asset_group")) {
      if (ag) {
        const g = groups[ag];
        return J({ results: g ? [{ assetGroup: { id: ag, name: g.name, status: g.status, finalUrls: g.finalUrls, path1: g.path1, path2: g.path2 }, campaign: { id: g.campaign, advertisingChannelType: "PERFORMANCE_MAX" } }] : [] });
      }
      return J({ results: Object.entries(groups).filter(([, g]) => g.campaign === cid && g.status !== "REMOVED").map(([id, g]) => ({ assetGroup: { id, name: g.name } })) });
    }
    if (q.includes("FROM campaign_asset")) {
      const camp = /campaign_asset\.campaign = '[^']*\/(\d+)'/.exec(q)![1];
      return J({ results: campLinks.filter((l) => l.campaign === camp && l.status !== "REMOVED").map((l) => ({ asset: assets.get(l.asset), campaignAsset: { fieldType: l.fieldType } })) });
    }
    if (q.includes("FROM campaign")) {
      const c = camps[cid!];
      return J({ results: c ? [{ campaign: { id: cid, name: c.name, status: c.status, advertisingChannelType: c.channel, brandGuidelinesEnabled: c.brand } }] : [] });
    }
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    const tmp = new Map<string, string>();
    const real = (rn: string) => tmp.get(rn) ?? rn.split("/").pop()!;
    for (const op of body.mutateOperations) {
      if (op.assetOperation?.create) {
        const { resourceName, ...rest } = op.assetOperation.create;
        const id = String(nextId++);
        tmp.set(resourceName, id);
        assets.set(id, { id, type: rest.imageAsset ? "IMAGE" : rest.youtubeVideoAsset ? "YOUTUBE_VIDEO" : "TEXT", ...(rest.name ? { name: rest.name } : {}), ...(rest.textAsset ? { textAsset: rest.textAsset } : {}), ...(rest.youtubeVideoAsset ? { youtubeVideoAsset: rest.youtubeVideoAsset } : {}) });
      } else if (op.assetGroupOperation?.create) {
        const { resourceName, campaign, ...rest } = op.assetGroupOperation.create;
        const id = String(nextId++);
        tmp.set(resourceName, id);
        groups[id] = { name: rest.name, status: rest.status, campaign: campaign.split("/").pop(), finalUrls: rest.finalUrls };
      } else if (op.assetGroupOperation?.update) Object.assign(groups[real(op.assetGroupOperation.update.resourceName)]!, op.assetGroupOperation.update);
      else if (op.assetGroupOperation?.remove) groups[real(op.assetGroupOperation.remove)]!.status = "REMOVED";
      else if (op.assetGroupAssetOperation?.create) links.push({ group: real(op.assetGroupAssetOperation.create.assetGroup), asset: real(op.assetGroupAssetOperation.create.asset), fieldType: op.assetGroupAssetOperation.create.fieldType, status: "ENABLED" });
      else if (op.assetGroupAssetOperation?.remove) {
        const [g, a, f] = op.assetGroupAssetOperation.remove.split("/").pop().split("~");
        links.find((l) => l.group === g && l.asset === a && l.fieldType === f)!.status = "REMOVED";
      } else if (op.campaignAssetOperation?.create) campLinks.push({ campaign: real(op.campaignAssetOperation.create.campaign), asset: real(op.campaignAssetOperation.create.asset), fieldType: op.campaignAssetOperation.create.fieldType, status: "ENABLED" });
      else if (op.assetGroupSignalOperation?.create) {
        const c = op.assetGroupSignalOperation.create;
        const g = real(c.assetGroup);
        signals.push({ resourceName: `${C}/assetGroupSignals/${g}~${nextId++}`, group: g, audience: c.audience?.audience.split("/").pop(), theme: c.searchTheme?.text });
      } else if (op.assetGroupSignalOperation?.remove) signals = signals.filter((x) => x.resourceName !== op.assetGroupSignalOperation.remove);
    }
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("PW", fake, { images: async (u) => images[u] ?? Promise.reject(new Error("404")) });
});
beforeEach(() => {
  camps = { "81": { name: "PMax", channel: "PERFORMANCE_MAX", brand: false, status: "ENABLED" }, "82": { name: "PMax brand", channel: "PERFORMANCE_MAX", brand: true, status: "ENABLED" }, "11": { name: "Search", channel: "SEARCH", brand: false, status: "ENABLED" } };
  groups = { "901": { name: "Shoes", status: "ENABLED", campaign: "81", finalUrls: ["https://shop.example"] } };
  assets = new Map();
  links = [];
  campLinks = [];
  const add = (field: string, a: Record<string, any>) => {
    const id = String(nextId++);
    assets.set(id, { id, ...a });
    links.push({ group: "901", asset: id, fieldType: field, status: "ENABLED" });
  };
  for (const h of ["Run faster", "Trail shoes", "Free returns"]) add("HEADLINE", { type: "TEXT", textAsset: { text: h } });
  add("LONG_HEADLINE", { type: "TEXT", textAsset: { text: "Shoes for every trail" } });
  for (const d of ["Durable", "Light"]) add("DESCRIPTION", { type: "TEXT", textAsset: { text: d } });
  signals = [{ resourceName: `${C}/assetGroupSignals/901~1`, group: "901", audience: "44" }, { resourceName: `${C}/assetGroupSignals/901~2`, group: "901", theme: "trail shoes" }];
  images = { "https://cdn.example/land.png": png(1200, 628), "https://cdn.example/sq.png": png(1200, 1200), "https://cdn.example/logo.png": png(512, 512), "https://cdn.example/wide-logo.png": png(1200, 300), "https://cdn.example/tiny.png": png(100, 100) };
  mutates = [];
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
const newGroup = { campaign_id: "81", name: "Sandals", final_url: "https://shop.example/sandals", headlines: ["Cool sandals", "Summer ready", "Free returns"], long_headlines: ["Sandals for every summer day"], descriptions: ["Light and durable", "Ships free"], business_name: "Acme", images: [{ url: "https://cdn.example/land.png", field_type: "MARKETING_IMAGE" }, { url: "https://cdn.example/sq.png", field_type: "SQUARE_MARKETING_IMAGE" }, { url: "https://cdn.example/logo.png", field_type: "LOGO" }] };

describe("asset groups", () => {
  it("creates an asset group with all its assets in one atomic, schema-valid request", async () => {
    const r = await run("add_pmax_asset_group", newGroup);
    expect(r.approval?.summary).toContain("with 10 assets");
    expect(r.approval?.risk).toBe("write"); // created PAUSED: nothing can serve yet
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    const ops = mutates[0]!;
    expect(ops.filter((o: any) => o.assetOperation).length).toBe(10);
    expect(ops.findIndex((o: any) => o.assetGroupOperation)).toBe(10); // assets first, then the group, then links
    expect(ops[10].assetGroupOperation.create).toMatchObject({ resourceName: `${C}/assetGroups/-1`, name: "Sandals", status: "PAUSED", finalUrls: ["https://shop.example/sandals"] });
    expect(ops.filter((o: any) => o.assetGroupAssetOperation).every((o: any) => o.assetGroupAssetOperation.create.assetGroup === `${C}/assetGroups/-1`)).toBe(true);
    expect(done.result).toMatchObject({ campaign_id: "81", status: "PAUSED", assets: 10 });
  });

  it("enabling at creation is high impact; missing required assets and bad images are refused", async () => {
    expect((await run("add_pmax_asset_group", { ...newGroup, name: "Live", status: "ENABLED" })).approval?.risk).toBe("high_impact");
    expect((await run("add_pmax_asset_group", { ...newGroup, business_name: undefined })).error?.message).toContain("business_name is required");
    expect((await run("add_pmax_asset_group", { ...newGroup, images: newGroup.images.filter((i) => i.field_type !== "LOGO") })).error?.message).toContain("LOGO");
    expect((await run("add_pmax_asset_group", { ...newGroup, images: [...newGroup.images.slice(1), { url: "https://cdn.example/sq.png", field_type: "MARKETING_IMAGE" }] })).error?.message).toContain("aspect ratio");
    expect((await run("add_pmax_asset_group", { ...newGroup, campaign_id: "82" })).error?.message).toContain("brand guidelines");
    expect((await run("add_pmax_asset_group", { ...newGroup, campaign_id: "11" })).error?.message).toContain("not a Performance Max");
    expect((await run("add_pmax_asset_group", { ...newGroup, name: "shoes" })).error?.message).toContain("already has an asset group");
    expect((await run("add_pmax_asset_group", { ...newGroup, images: [{ url: "http://cdn.example/land.png", field_type: "MARKETING_IMAGE" }, newGroup.images[1]] })).error?.code).toBe("invalid_argument");
    expect(mutates).toHaveLength(0);
  });

  it("a changed image between approval and execution is refused as drift", async () => {
    const r = await run("add_pmax_asset_group", { ...newGroup, name: "Boots" });
    images["https://cdn.example/sq.png"] = png(1200, 1200, 128); // same size, different bytes
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ error: { code: "conflict" } });
    expect(mutates).toHaveLength(0);
  });

  it("updates name, URL and status; enabling widens; removes the group (destructive)", async () => {
    const r = await run("update_pmax_asset_group", { asset_group_id: "901", name: "Shoes 2", status: "PAUSED" });
    expect(r.approval?.risk).toBe("write");
    expect((await approve(r.approval!.approval_id)).result).toMatchObject({ name: "Shoes 2", status: "PAUSED" });
    expect((await run("update_pmax_asset_group", { asset_group_id: "901", status: "ENABLED" })).approval?.risk).toBe("high_impact");
    const rm = await run("remove_pmax_asset_group", { asset_group_id: "901" });
    expect(rm.approval?.risk).toBe("destructive");
    expect((await approve(rm.approval!.approval_id, kit.second)).result).toEqual({ asset_group_id: "901", status: "REMOVED" });
  });
});

describe("asset group assets and images", () => {
  it("adds text and video assets within limits, skipping duplicates", async () => {
    const { done } = await exec("add_pmax_asset_group_asset", { asset_group_id: "901", assets: [{ field_type: "HEADLINE", text: "run faster" }, { field_type: "HEADLINE", text: "New colours" }, { field_type: "YOUTUBE_VIDEO", youtube_video_id: "dQw4w9WgXcQ" }] });
    expect(done.result).toEqual({ asset_group_id: "901", added: ["text:new colours", "video:dQw4w9WgXcQ"], skipped_existing: ["text:run faster"] });
    expect((await run("add_pmax_asset_group_asset", { asset_group_id: "901", assets: [{ field_type: "HEADLINE", text: "x".repeat(31) }] })).error?.message).toContain("longer than 30");
    expect((await run("add_pmax_asset_group_asset", { asset_group_id: "901", assets: [{ field_type: "HEADLINE" }] })).error?.code).toBe("invalid_argument");
  });

  it("removing below Google's minimum is refused; removal otherwise unlinks", async () => {
    const headline = links.find((l) => l.fieldType === "HEADLINE")!.asset;
    expect((await run("remove_pmax_asset_group_asset", { asset_group_id: "901", assets: [{ asset_id: headline, field_type: "HEADLINE" }] })).error?.message).toContain("at least 3");
    await exec("add_pmax_asset_group_asset", { asset_group_id: "901", assets: [{ field_type: "HEADLINE", text: "Extra" }] });
    const rm = await run("remove_pmax_asset_group_asset", { asset_group_id: "901", assets: [{ asset_id: headline, field_type: "HEADLINE" }] });
    expect(rm.approval?.risk).toBe("destructive");
    expect((await approve(rm.approval!.approval_id, kit.second)).status).toBe("executed");
    expect(mutates.at(-1)).toEqual([{ assetGroupAssetOperation: { remove: `${C}/assetGroupAssets/901~${headline}~HEADLINE` } }]);
  });

  it("uploads checked images with their bytes, recognises the same image again, and refuses too-small ones", async () => {
    const { done } = await exec("add_pmax_asset_group_image", { asset_group_id: "901", images: [{ url: "https://cdn.example/land.png", field_type: "MARKETING_IMAGE" }] });
    const create = mutates[0]![0].assetOperation.create;
    expect(Buffer.from(create.imageAsset.data, "base64").equals(images["https://cdn.example/land.png"]!)).toBe(true);
    expect(create.name).toMatch(/^marketing_image-[0-9a-f]{16}-ag901$/);
    expect((done.result as any).added[0].asset_id).toMatch(/^\d+$/);
    expect((await run("add_pmax_asset_group_image", { asset_group_id: "901", images: [{ url: "https://cdn.example/land.png", field_type: "MARKETING_IMAGE" }] })).error?.message).toContain("already in the asset group");
    expect((await run("add_pmax_asset_group_image", { asset_group_id: "901", images: [{ url: "https://cdn.example/tiny.png", field_type: "SQUARE_MARKETING_IMAGE" }] })).error?.message).toContain("at least 300x300");
  });

  it("campaign logos need brand guidelines; Search images need a Search campaign", async () => {
    await exec("add_pmax_campaign_logo", { campaign_id: "82", url: "https://cdn.example/wide-logo.png", field_type: "LANDSCAPE_LOGO" });
    expect(mutates[0]![1]).toEqual({ campaignAssetOperation: { create: { campaign: `${C}/campaigns/82`, asset: `${C}/assets/-1`, fieldType: "LANDSCAPE_LOGO" } } });
    expect((await run("add_pmax_campaign_logo", { campaign_id: "81", url: "https://cdn.example/logo.png", field_type: "LOGO" })).error?.message).toContain("does not use brand guidelines");
    await exec("add_search_campaign_image", { campaign_id: "11", url: "https://cdn.example/sq.png", shape: "square" });
    expect(mutates[1]![1].campaignAssetOperation.create.fieldType).toBe("AD_IMAGE");
    expect((await run("add_search_campaign_image", { campaign_id: "81", url: "https://cdn.example/sq.png", shape: "square" })).error?.message).toContain("not a Search campaign");
  });
});

describe("signals", () => {
  it("audience signals: add, replace atomically, remove", async () => {
    await exec("add_pmax_audience_signal", { asset_group_id: "901", audience_id: "45" });
    expect(mutates[0]).toEqual([{ assetGroupSignalOperation: { create: { assetGroup: `${C}/assetGroups/901`, audience: { audience: `${C}/audiences/45` } } } }]);
    const { done } = await exec("update_pmax_audience_signal", { asset_group_id: "901", from_audience_id: "44", to_audience_id: "46" });
    expect(done.result).toEqual({ asset_group_id: "901", audience_ids: ["45", "46"] });
    const rm = await run("remove_pmax_audience_signal", { asset_group_id: "901", audience_id: "45" });
    expect((await approve(rm.approval!.approval_id, kit.second)).result).toEqual({ asset_group_id: "901", audience_ids: ["46"] });
    expect((await run("add_pmax_audience_signal", { asset_group_id: "901", audience_id: "46" })).error?.message).toContain("already a signal");
  });

  it("search themes: add skips existing case-insensitively; remove matches case-insensitively", async () => {
    const { done } = await exec("add_pmax_search_themes", { asset_group_id: "901", themes: ["Trail Shoes", "running gear"] });
    expect(done.result).toEqual({ asset_group_id: "901", themes: ["running gear", "trail shoes"], skipped_existing: ["Trail Shoes"] });
    const rm = await run("remove_pmax_search_themes", { asset_group_id: "901", themes: ["TRAIL SHOES"] });
    expect((await approve(rm.approval!.approval_id, kit.second)).result).toEqual({ asset_group_id: "901", themes: ["running gear"] });
    expect((await run("remove_pmax_search_themes", { asset_group_id: "901", themes: ["nope"] })).error?.message).toContain("Not a search theme");
  });
});
