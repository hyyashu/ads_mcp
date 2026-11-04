import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { YouTubeClient, isoDurationSeconds } from "../../platforms/google/youtube";
import { png } from "../support/images";
import { googleHarness, type GoogleHarness } from "../support/harness";

const C = "customers/1234567890";
let brand: { asset: string; fieldType: string; status: string }[];
let assets: Map<string, Record<string, any>>;
let mutates: any[][];
let nextId = 4000;
let extra: Record<string, unknown[]>;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    const from = /FROM ([a-z_]+)/.exec(q)![1]!;
    if (from === "customer_asset") return J({ results: brand.filter((b) => b.status !== "REMOVED").map((b) => ({ asset: assets.get(b.asset), customerAsset: { fieldType: b.fieldType, status: b.status } })) });
    if (from === "customer") return J({ results: [{ customer: { id: "1234567890", descriptiveName: "Acme Shoes", currencyCode: "USD", timeZone: "America/New_York", autoTaggingEnabled: true } }] });
    return J({ results: extra[from] ?? [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    const tmp = new Map<string, string>();
    for (const op of body.mutateOperations) {
      if (op.assetOperation?.create) {
        const { resourceName, ...rest } = op.assetOperation.create;
        const id = String(nextId++);
        tmp.set(resourceName, id);
        assets.set(id, { id, type: rest.imageAsset ? "IMAGE" : "TEXT", ...(rest.name ? { name: rest.name } : {}), ...(rest.textAsset ? { textAsset: rest.textAsset } : {}) });
      } else if (op.customerAssetOperation?.create) brand.push({ asset: tmp.get(op.customerAssetOperation.create.asset)!, fieldType: op.customerAssetOperation.create.fieldType, status: "ENABLED" });
      else if (op.customerAssetOperation?.remove) {
        const [a, f] = op.customerAssetOperation.remove.split("/").pop().split("~");
        brand.find((b) => b.asset === a && b.fieldType === f)!.status = "REMOVED";
      }
    }
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let ytRequests: { url: string; headers: Record<string, string> }[] = [];
const yt = new YouTubeClient({
  apiKey: "AIzaSECRETKEY",
  fetch: async (url, init) => {
    ytRequests.push({ url, headers: init!.headers as Record<string, string> });
    return J({ items: [{ id: "dQw4w9WgXcQ", snippet: { title: "Launch", channelTitle: "Acme" }, contentDetails: { duration: "PT1M5S", regionRestriction: { blocked: ["DE"] } }, status: { uploadStatus: "processed", privacyStatus: "unlisted", embeddable: true, madeForKids: false }, player: { embedWidth: "1000", embedHeight: "563" } }, { id: "shortclip01", contentDetails: { duration: "PT6S" }, status: { uploadStatus: "processed", privacyStatus: "private", embeddable: false } }] });
  },
});

let kit: GoogleHarness;
let kitNoYt: GoogleHarness;
const images: Record<string, Buffer> = { "https://cdn.example/logo.png": png(512, 512), "https://cdn.example/wide.png": png(1200, 628) };
beforeAll(async () => {
  const opts = { images: async (u: string) => images[u] ?? Promise.reject(new Error("404")), pages: async () => `<html><head><title>Acme Trail Shoes</title><meta name="description" content="Shoes for every trail &amp; road"><meta property="og:site_name" content="Acme"></head></html>` };
  kit = await googleHarness("BA", fake, { ...opts, youtube: yt });
  kitNoYt = await googleHarness("BA2", fake, opts);
});
beforeEach(() => {
  assets = new Map([["10", { id: "10", type: "TEXT", textAsset: { text: "Acme" } }]]);
  brand = [{ asset: "10", fieldType: "BUSINESS_NAME", status: "ENABLED" }];
  mutates = [];
  extra = {};
  ytRequests = [];
});
const data = async (name: string, args: Record<string, unknown> = {}, k = kit) => {
  const r = await k.run(name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};

describe("business profile", () => {
  it("reads account details, brand assets and landing domains", async () => {
    extra.ad_group_ad = [{ adGroupAd: { ad: { finalUrls: ["https://www.acme.example/shoes"] } }, metrics: { impressions: "900" } }];
    const d = await data("get_business_profile");
    expect(d).toEqual({ account: { id: "1234567890", name: "Acme Shoes", currency: "USD", time_zone: "America/New_York", auto_tagging: true }, business_name: "Acme", business_logos: [], landing_domains: [{ domain: "acme.example", impressions: 900 }] });
  });

  it("save replaces the business name and adds a checked logo atomically", async () => {
    const r = await kit.run("save_business_profile", { business_name: "Acme Running", logo_url: "https://cdn.example/logo.png" });
    expect(r.approval?.risk).toBe("write");
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
    expect(mutates[0]!.map((o: any) => Object.keys(o)[0] + ":" + Object.keys(Object.values(o)[0] as object)[0])).toEqual(["customerAssetOperation:remove", "assetOperation:create", "customerAssetOperation:create", "assetOperation:create", "customerAssetOperation:create"]);
    expect(done.result).toMatchObject({ business_name: "Acme Running", business_logo_asset_id: expect.stringMatching(/^\d+$/) });
    expect((await kit.run("save_business_profile", { logo_url: "https://cdn.example/wide.png" })).error?.message).toContain("aspect ratio");
  });

  it("infer reports evidence with sources, including the website's title and description", async () => {
    extra.campaign = [{ campaign: { id: "1", advertisingChannelType: "SEARCH" } }, { campaign: { id: "2", advertisingChannelType: "SEARCH" } }];
    extra.keyword_view = [{ adGroupCriterion: { keyword: { text: "trail shoes" } }, metrics: { costMicros: "12340000" } }];
    extra.conversion_action = [{ conversionAction: { category: "PURCHASE" } }];
    const d = await data("infer_business_profile", { website_url: "https://acme.example" });
    expect(d).toMatchObject({ account_name: "Acme Shoes", campaign_types: [{ type: "SEARCH", campaigns: 2 }], top_keywords: [{ text: "trail shoes", cost: 12.34 }], conversion_categories: ["PURCHASE"], website: { title: "Acme Trail Shoes", description: "Shoes for every trail & road", site_name: "Acme" } });
    expect(d.sources).toHaveLength(2);
  });
});

describe("guidance and validation", () => {
  it("select_google_campaign_type checks Merchant Center and conversion tracking", async () => {
    const d = await data("select_google_campaign_type", { goal: "online_sales" });
    expect(d.account).toEqual({ merchant_center_linked: false, enabled_conversion_actions: 0 });
    expect(d.recommendations.find((r: any) => r.campaign_type === "SHOPPING").missing[0]).toContain("Merchant Center");
    expect((await data("select_google_campaign_type", { goal: "brand_awareness_video" })).recommendations[0]).toMatchObject({ campaign_type: "DEMAND_GEN", why: expect.stringContaining("cannot be created") });
  });

  it("help_user_upload is a workspace tool with the verified specs", async () => {
    const r = await (await import("../../mcp/pipeline")).runTool(kit.deps, kit.deps.registry.get("help_user_upload")!, {}, { tenantId: kit.tenantId, userId: kit.owner, role: "owner", scopes: ["ads:read"] });
    expect((r.data as any).images.types.find((t: any) => t.field_type === "LOGO").spec).toContain("1:1");
    expect((r.data as any).text_limits.HEADLINE).toBe(30);
  });

  it("validate_and_prepare_assets reports every image and text problem without uploading", async () => {
    const d = await data("validate_and_prepare_assets", { images: [{ url: "https://cdn.example/logo.png", field_type: "LOGO" }, { url: "https://cdn.example/logo.png", field_type: "MARKETING_IMAGE" }, { url: "https://cdn.example/missing.png", field_type: "LOGO" }], texts: [{ field_type: "HEADLINE", text: "x".repeat(31) }, { field_type: "CALLOUT", text: "Free returns" }] });
    expect(d.ok).toBe(false);
    expect(d.images.map((i: any) => i.ok)).toEqual([true, false, false]);
    expect(d.images[0]).toMatchObject({ width: 512, height: 512, mime: "IMAGE_PNG", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(d.texts).toEqual([{ field_type: "HEADLINE", text: "x".repeat(31), ok: false, length: 31, limit: 30 }, { field_type: "CALLOUT", text: "Free returns", ok: true, length: 12, limit: 25 }]);
    expect(mutates).toHaveLength(0);
  });

  it("validate_video uses the YouTube Data API with the key in a header, and is unsupported without a key", async () => {
    expect(isoDurationSeconds("PT1H2M3S")).toBe(3723);
    const d = await data("validate_video", { video_ids: ["dQw4w9WgXcQ", "shortclip01", "missing0001"] });
    expect(d.videos[0]).toMatchObject({ id: "dQw4w9WgXcQ", ok: true, duration_seconds: 65, privacy_status: "unlisted", region_blocked: ["DE"], aspect_ratio: 1.776 });
    expect(d.videos[1].problems).toEqual(["the video is private; make it public or unlisted", "embedding is disabled", "it is 6s; at least 10s is required"]);
    expect(d.videos[2]).toMatchObject({ found: false, ok: false });
    expect(ytRequests[0]!.url).not.toContain("AIzaSECRETKEY");
    expect(ytRequests[0]!.headers["x-goog-api-key"]).toBe("AIzaSECRETKEY");
    expect((await kitNoYt.run("validate_video", { video_ids: ["dQw4w9WgXcQ"] })).error?.code).toBe("unsupported");
  });

  it("suggest_ad_content returns real ad text with performance labels, top terms and limits, not generated copy", async () => {
    extra.ad_group_ad_asset_view = [{ adGroup: { id: "21" }, adGroupAdAssetView: { fieldType: "HEADLINE", performanceLabel: "BEST" }, asset: { type: "TEXT", textAsset: { text: "Free returns" } } }];
    extra.search_term_view = [{ searchTermView: { searchTerm: "trail shoes sale" }, metrics: { conversions: 4, clicks: "40" } }];
    extra.ad_group_ad = [{ adGroupAd: { ad: { finalUrls: ["https://acme.example/sale"] } } }];
    const d = await data("suggest_ad_content", { campaign_id: "11" });
    expect(d.assets).toEqual([{ field_type: "HEADLINE", text: "Free returns", performance_label: "BEST", ad_group_id: "21" }]);
    expect(d.top_search_terms[0]).toEqual({ text: "trail shoes sale", conversions: 4, clicks: 40 });
    expect(d.landing_pages).toEqual(["https://acme.example/sale"]);
    expect(d.limits.RSA_HEADLINE).toBe(30);
  });
});
