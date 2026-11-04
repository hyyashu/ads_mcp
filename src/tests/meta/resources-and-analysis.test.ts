import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import type { Db } from "../../db";
import { ToolError } from "../../mcp/errors";
import { runTool, type PipelineDeps } from "../../mcp/pipeline";
import { applySegmentRules, ruleText } from "../../platforms/meta/tools/segments";
import { checkMedia } from "../../platforms/meta/tools/helpers";
import { seedAccount, seedTenant, testDb } from "../support/helpers";
import { J, metaDeps, metaNotFound, metaPage } from "../support/meta";

const USER_TOKEN = "EAAuser";
const tokens = { getToken: async () => ({ accessToken: USER_TOKEN, appSecretProof: "proof-user" }), proofFor: (t: string) => `proof-${t}` };

// --------------------------------------------------------------------------------------------- fake Graph API (v27.0)
type Row = Record<string, unknown>;
let objects: Record<string, Row>;
let edges: Record<string, Row[]>;
let pageEdges: Record<string, Row[]>; // edges that must be read with a Page token
let pageRoles: Set<string>;
let insights: (obj: string, p: URLSearchParams) => Row[];
let requests: { path: string; params: URLSearchParams; auth: string }[];

const page = (rows: Row[], p: URLSearchParams) => metaPage(rows, p);

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const path = u.pathname.replace("/v27.0/", "");
  const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
  requests.push({ path, params: u.searchParams, auth });
  if (path.endsWith("/insights")) return page(insights(path.slice(0, -"/insights".length), u.searchParams), u.searchParams);
  if (pageEdges[path]) {
    if (!auth.startsWith("Bearer PAGE-")) return J({ error: { code: 200, message: "needs a Page token" } }, 403);
    return page(pageEdges[path]!, u.searchParams);
  }
  if (edges[path]) return page(edges[path]!, u.searchParams);
  if (path.includes("/")) return J({ data: [] });
  if (u.searchParams.get("fields") === "access_token") return J(pageRoles.has(path) ? { id: path, access_token: `PAGE-${path}` } : { id: path });
  const o = objects[path];
  return o ? J({ id: path, ...o }) : metaNotFound();
};

/** A minimal PNG header: enough for imageInfo() to read the size. */
const png = (w: number, h: number) => {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
let images: Record<string, Buffer>;

let db: Db, deps: PipelineDeps, tenantId: string, owner: string, acct: string;
beforeAll(async () => {
  db = await testDb();
  const t = await seedTenant(db, "MB2", "owner");
  tenantId = t.tenant.id;
  owner = t.user.id;
  acct = (await seedAccount(db, tenantId, "meta_ads", "read", "active", "act_555", { currencyCode: "USD", timeZone: "America/New_York" })).id;
  deps = metaDeps(db, {
    tokens,
    fetch: fake,
    fetchImage: async (url) => {
      const b = images[url];
      if (!b) throw new ToolError("invalid_argument", "The image could not be downloaded: not found");
      return b;
    },
  });
});

beforeEach(() => {
  requests = [];
  images = {};
  pageRoles = new Set(["700001"]);
  objects = {
    "200001": { account_id: "555", name: "Spring" },
    "200009": { account_id: "111", name: "Foreign" },
    "500001": { account_id: "555", name: "Ad one" },
    "500009": { account_id: "111", name: "Foreign ad" },
  };
  edges = {
    "act_555/promote_pages": [{ id: "700001", name: "My Page" }, { id: "700002", name: "No-role Page" }],
    "act_555/adspixels": [
      { id: "800001", name: "Main pixel", creation_time: "2026-01-01T00:00:00+0000", last_fired_time: "2026-11-04T10:00:00+0000", is_unavailable: false, data_use_setting: "ADVERTISING_AND_ANALYTICS", owner_business: { id: "900", name: "Biz" } },
      { id: "800002", name: "Never fired", is_unavailable: true },
    ],
  };
  pageEdges = {};
  insights = () => [];
});

const run = (name: string, args: Record<string, unknown>) => runTool(deps, deps.registry.get(name)!, { account_id: acct, ...args }, { tenantId, userId: owner, role: "owner", scopes: ["ads:read"] });
const data = <T = Row>(r: Awaited<ReturnType<typeof run>>) => {
  if (!r.ok) throw new Error(`tool failed: ${JSON.stringify(r.error)}`);
  return r.data as T;
};
const last = (suffix: string) => [...requests].reverse().find((q) => q.path.endsWith(suffix))!;
const calls = (suffix: string) => requests.filter((q) => q.path.endsWith(suffix));

const ins = (ids: Row, m: { spend?: number; impressions?: number; clicks?: number; conversions?: number; value?: number; frequency?: number } = {}): Row => ({
  ...ids,
  spend: String(m.spend ?? 10),
  impressions: String(m.impressions ?? 1000),
  clicks: String(m.clicks ?? 20),
  inline_link_clicks: String(m.clicks ?? 20),
  ...(m.frequency !== undefined ? { frequency: String(m.frequency) } : {}),
  actions: m.conversions ? [{ action_type: "offsite_conversion.fb_pixel_purchase", value: String(m.conversions) }, { action_type: "link_click", value: "999" }] : [{ action_type: "link_click", value: "999" }],
  action_values: m.value ? [{ action_type: "offsite_conversion.fb_pixel_purchase", value: String(m.value) }] : [],
});

// ------------------------------------------------------------------------------------------------- account resources
describe("get_meta_ad_creatives", () => {
  beforeEach(() => {
    const creative = (id: string): Row => ({
      id,
      name: `Creative ${id}`,
      status: "ACTIVE",
      body: "Body text",
      object_story_spec: { page_id: "700001", link_data: { link: "https://shop.example/a", message: "Buy now", image_hash: "abc123hash", call_to_action: { type: "SHOP_NOW", value: { link: "https://shop.example/a" } } } },
      thumbnail_url: "https://cdn.example/t.jpg",
    });
    edges["act_555/adcreatives"] = Array.from({ length: 3 }, (_, i) => creative(String(910000 + i)));
    edges["500001/adcreatives"] = [{ id: "920001", name: "Video", status: "WITH_ISSUES", call_to_action_type: "LEARN_MORE", object_story_spec: { page_id: "700001", video_data: { video_id: "77", call_to_action: { type: "LEARN_MORE", value: { link: "https://x.example" } } } } }];
  });

  it("maps creative text, link, call to action, media and the story spec", async () => {
    const d = data<{ creatives: Row[]; truncated: boolean }>(await run("get_meta_ad_creatives", {}));
    expect(d.creatives[0]).toMatchObject({ creative_id: "910000", body: "Body text", call_to_action_type: "SHOP_NOW", link: "https://shop.example/a", image_hash: "abc123hash", thumbnail_url: "https://cdn.example/t.jpg", story: { page_id: "700001", format: "link_data", message: "Buy now" } });
    expect(last("act_555/adcreatives").params.get("fields")).toContain("object_story_spec");
    const v = data<{ creatives: Row[] }>(await run("get_meta_ad_creatives", { ad_id: "500001" }));
    expect(v.creatives[0]).toMatchObject({ status: "WITH_ISSUES", video_id: "77", link: "https://x.example", story: { format: "video_data" } });
    expect(data(await run("get_meta_ad_creatives", { limit: 2 }))).toMatchObject({ returned: 2, truncated: true });
  });

  it("refuses an ad of another ad account before reading its creatives", async () => {
    expect((await run("get_meta_ad_creatives", { ad_id: "500009" })).error?.code).toBe("not_found");
    expect(calls("/adcreatives")).toHaveLength(0);
  });
});

describe("list_meta_pages / list_meta_instagram_accounts", () => {
  it("lists promotable Pages and Instagram accounts", async () => {
    expect(data(await run("list_meta_pages", {}))).toMatchObject({ pages: [{ page_id: "700001", name: "My Page" }, { page_id: "700002" }], returned: 2, truncated: false });
    expect(data(await run("list_meta_pages", { limit: 1 }))).toMatchObject({ returned: 1, truncated: true });
    edges["act_555/instagram_accounts"] = [{ id: "178", username: "brand" }];
    expect(data(await run("list_meta_instagram_accounts", {}))).toMatchObject({ instagram_accounts: [{ instagram_account_id: "178", username: "brand" }] });
    expect(last("act_555/instagram_accounts").params.get("fields")).toBe("id,username");
  });

  it("declares the extra Meta permissions the endpoints need", () => {
    expect(deps.registry.get("list_meta_pages")!.permissions.platformPermissions).toEqual(["ads_read", "pages_show_list"]);
    expect(deps.registry.get("list_meta_instagram_accounts")!.permissions.platformPermissions).toEqual(["ads_read", "instagram_basic", "pages_read_engagement"]);
    expect(deps.registry.get("get_meta_lead_form_submissions")!.permissions.platformPermissions).toEqual(["ads_read", "leads_retrieval", "pages_show_list", "pages_read_engagement"]);
  });
});

describe("list_meta_pixels / get_meta_pixel_stats", () => {
  it("lists pixels with health fields", async () => {
    const d = data<{ pixels: Row[] }>(await run("list_meta_pixels", {}));
    expect(d.pixels[0]).toMatchObject({ pixel_id: "800001", last_fired_time: "2026-11-04T10:00:00+0000", is_unavailable: false, owner_business_id: "900" });
    expect(d.pixels[1]).toMatchObject({ pixel_id: "800002", last_fired_time: null, is_unavailable: true, owner_business_id: null });
  });

  it("totals event counts over the period, reading both result shapes", async () => {
    edges["800001/stats"] = [{ aggregation: "event_total_counts", data: [{ value: "PageView", count: 120 }, { value: "Purchase", count: 4 }] }, { value: "PageView", count: 30 }];
    const d = data<{ events: Row[]; total: number }>(await run("get_meta_pixel_stats", { pixel_id: "800001", days: 3 }));
    expect(d.events).toEqual([{ event: "PageView", count: 150 }, { event: "Purchase", count: 4 }]);
    expect(d.total).toBe(154);
    const q = last("800001/stats").params;
    expect(q.get("aggregation")).toBe("event_total_counts");
    expect(Number(q.get("end_time")) - Number(q.get("start_time"))).toBe(3 * 86_400);
  });

  it("refuses a pixel that is not on this ad account and caps the window at 7 days", async () => {
    expect((await run("get_meta_pixel_stats", { pixel_id: "899999" })).error?.code).toBe("not_found");
    expect(calls("/stats")).toHaveLength(0);
    expect((await run("get_meta_pixel_stats", { pixel_id: "800001", days: 8 })).ok).toBe(false);
  });
});

describe("list_meta_custom_audiences", () => {
  it("maps size bounds and statuses, filters by subtype and pages in small pages", async () => {
    edges["act_555/customaudiences"] = [
      { id: "1", name: "Buyers", subtype: "CUSTOM", approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1200, delivery_status: { code: 200, description: "Ready" }, operation_status: { code: 471, description: "Flagged" }, retention_days: 180, time_updated: 1790000000 },
      { id: "2", name: "LAL 1%", subtype: "LOOKALIKE" },
    ];
    const d = data<{ audiences: Row[] }>(await run("list_meta_custom_audiences", {}));
    expect(d.audiences[0]).toMatchObject({ approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1200, delivery_status: { code: 200, description: "Ready" }, operation_status: { code: 471 }, retention_days: 180 });
    expect(d.audiences[1]).toMatchObject({ delivery_status: null, approximate_count_lower_bound: null });
    expect(last("act_555/customaudiences").params.get("limit")).toBe("25");
    expect(data(await run("list_meta_custom_audiences", { subtype: "LOOKALIKE" }))).toMatchObject({ returned: 1 });
  });
});

describe("discover_meta_assets", () => {
  it("lists library images (no deleted) and videos with their largest format size", async () => {
    edges["act_555/adimages"] = [{ id: "i1", hash: "h1", name: "a.png", width: 1080, height: 1080, status: "ACTIVE", url: "https://tmp" }, { id: "i2", hash: "h2", status: "DELETED" }];
    edges["act_555/advideos"] = [{ id: "v1", name: "Clip", format: [{ width: 640, height: 360 }, { width: 1920, height: 1080 }], picture: "https://p" }];
    const d = data<{ images: Row[]; videos: Row[] }>(await run("discover_meta_assets", {}));
    expect(d.images).toEqual([expect.objectContaining({ image_hash: "h1", width: 1080, status: "ACTIVE" })]);
    expect(d.videos[0]).toMatchObject({ video_id: "v1", width: 1920, height: 1080 });
    expect(last("act_555/advideos").params.get("fields")).not.toContain("length");
    expect(data<{ images: Row[] }>(await run("discover_meta_assets", { include_deleted: true })).images).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------------------------- leads
describe("lead forms and submissions (personal data)", () => {
  beforeEach(() => {
    pageEdges["700001/leadgen_forms"] = [{ id: "600001", name: "Quote form", status: "ACTIVE" }, { id: "600002", name: "Old", status: "ARCHIVED" }];
    pageEdges["600001/leads"] = Array.from({ length: 300 }, (_, i) => ({
      id: String(610000 + i),
      created_time: "2026-11-03T08:00:00+0000",
      ad_id: "500001",
      form_id: "600001",
      field_data: [
        { name: "email", values: [`p${i}@example.com`] },
        { name: "full_name", values: ["Person Example"] },
        { name: "phone_number", values: ["+15550000"] },
      ],
    }));
  });

  it("lists a promotable Page's forms with the Page token, hiding archived ones by default", async () => {
    const d = data<{ forms: Row[] }>(await run("list_meta_lead_forms", { page_id: "700001" }));
    expect(d.forms).toEqual([{ form_id: "600001", name: "Quote form", status: "ACTIVE" }]);
    expect(last("700001/leadgen_forms").auth).toBe("Bearer PAGE-700001");
    expect(last("700001/leadgen_forms").params.get("appsecret_proof")).toBe("proof-PAGE-700001");
    expect(data(await run("list_meta_lead_forms", { page_id: "700001", include_archived: true }))).toMatchObject({ returned: 2 });
  });

  it("refuses a Page the ad account does not promote, before asking for any Page token", async () => {
    expect((await run("list_meta_lead_forms", { page_id: "799999" })).error?.code).toBe("not_found");
    expect(requests.some((q) => q.params.get("fields") === "access_token")).toBe(false);
    expect((await run("list_meta_lead_forms", { page_id: "700002" })).error?.code).toBe("platform_permission_denied"); // no role on the Page
  });

  it("returns only the requested fields, never more than the cap", async () => {
    const r = await run("get_meta_lead_form_submissions", { page_id: "700001", form_id: "600001", fields: ["email", "missing_field"], limit: 200, days: 30 });
    const d = data<{ leads: { fields: Record<string, unknown> }[]; returned: number; truncated: boolean }>(r);
    expect(d).toMatchObject({ returned: 200, truncated: true });
    expect(d.leads[0]!.fields).toEqual({ email: ["p0@example.com"], missing_field: null });
    expect(JSON.stringify(d)).not.toContain("Person Example");
    expect(JSON.stringify(d)).not.toContain("+15550000");
    const q = last("600001/leads");
    expect(q.auth).toBe("Bearer PAGE-700001");
    const f = JSON.parse(q.params.get("filtering")!)[0];
    expect(f).toMatchObject({ field: "time_created", operator: "GREATER_THAN_OR_EQUAL" });
    expect(Math.abs(Date.now() / 1000 - 30 * 86_400 - f.value)).toBeLessThan(5);
    expect((await run("get_meta_lead_form_submissions", { page_id: "700001", form_id: "600001", fields: ["email"], limit: 201 })).ok).toBe(false);
  });

  it("refuses a form that is not on that Page", async () => {
    expect((await run("get_meta_lead_form_submissions", { page_id: "700001", form_id: "699999", fields: ["email"] })).error?.code).toBe("not_found");
    expect(calls("/leads")).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------------------------------------- targeting
describe("browse_meta_targeting / search_meta_targeting", () => {
  it("passes the query and type, maps paths and audience size ranges", async () => {
    edges["act_555/targetingsearch"] = [{ id: "6003", name: "Running", type: "interests", path: ["Interests", "Fitness", "Running"], audience_size_lower_bound: 1000000, audience_size_upper_bound: 1200000 }];
    edges["act_555/targetingbrowse"] = Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1), name: `Cat ${i}`, type: "behaviors", path: ["Behaviors"] }));
    const d = data<{ results: Row[] }>(await run("search_meta_targeting", { q: "running", limit_type: "interests" }));
    expect(d.results[0]).toMatchObject({ id: "6003", path: ["Interests", "Fitness", "Running"], audience_size_lower_bound: 1000000 });
    expect(last("act_555/targetingsearch").params.get("q")).toBe("running");
    expect(last("act_555/targetingsearch").params.get("limit_type")).toBe("interests");
    expect(data(await run("browse_meta_targeting", { limit: 3 }))).toMatchObject({ returned: 3, truncated: true });
    expect((await run("search_meta_targeting", { q: "" })).ok).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- breakdowns and segments
describe("get_meta_audience_insights", () => {
  it("sends documented breakdowns and maps segment values", async () => {
    insights = (obj, p) => (obj === "act_555" && p.get("breakdowns") === "age,gender" ? [ins({ age: "25-34", gender: "female" }, { spend: 30, conversions: 3 }), ins({ age: "35-44", gender: "male" }, { spend: 50 })] : []);
    const d = data<{ rows: Row[]; conversions_available: boolean }>(await run("get_meta_audience_insights", { breakdown: "age_gender" }));
    expect(d.rows.map((r) => r.segment)).toEqual([{ age: "35-44", gender: "male" }, { age: "25-34", gender: "female" }]);
    expect(d.rows[1]).toMatchObject({ spend: 30, conversions: 3, cost_per_conversion: 10 });
    expect(d.conversions_available).toBe(true);
    expect(last("act_555/insights").params.get("use_unified_attribution_setting")).toBe("true");
    expect(data(await run("get_meta_audience_insights", { breakdown: "region" }))).toMatchObject({ conversions_available: false });
  });

  it("refuses another account's campaign and bad dates", async () => {
    expect((await run("get_meta_audience_insights", { breakdown: "age", campaign_id: "200009" })).error?.code).toBe("not_found");
    expect((await run("get_meta_audience_insights", { breakdown: "age", start_date: "2026-10-05", end_date: "2026-10-01" })).error?.code).toBe("invalid_argument");
    expect(calls("/insights")).toHaveLength(0);
  });
});

describe("segment rules (analyze_meta_audiences, optimize_meta_placements)", () => {
  const seg = (age: string, spend: number, conversions: number) => ins({ age }, { spend, conversions });

  it("cost_per_conversion_high fires exactly at cost_ratio x the overall cost per conversion", () => {
    // overall = 20 / 4 = 5; 2x = 10. Segment X costs exactly 10 per conversion.
    const at = applySegmentRules([seg("X", 10, 1), seg("Y", 10, 3)], "age", ["offsite_conversion.fb_pixel_purchase"], 1000, 2);
    expect(at.segments.find((s) => s.label === "X")!.flags).toEqual(["cost_per_conversion_high"]);
    expect(at.segments.find((s) => s.label === "Y")!.flags).toEqual([]);
    // 9.99 / (19.99 / 4) = 1.9990 x: just below.
    const below = applySegmentRules([seg("X", 9.99, 1), seg("Y", 10, 3)], "age", ["offsite_conversion.fb_pixel_purchase"], 1000, 2);
    expect(below.segments.find((s) => s.label === "X")!.flags).toEqual([]);
  });

  it("spend_without_conversions fires at min_spend and not below; no rule fires without conversion data", () => {
    const r = applySegmentRules([seg("A", 10, 0), seg("B", 9.99, 0), seg("C", 5, 2)], "age", ["offsite_conversion.fb_pixel_purchase"], 10, 2);
    expect(r.segments.find((s) => s.label === "A")!.flags).toEqual(["spend_without_conversions"]);
    expect(r.segments.find((s) => s.label === "B")!.flags).toEqual([]);
    const region = applySegmentRules([ins({ region: "Ontario" }, { spend: 500 })], "region", ["offsite_conversion.fb_pixel_purchase"], 10, 2);
    expect(region.segments[0]!.flags).toEqual([]);
    expect(region.overall.cost_per_conversion).toBeNull();
    expect(ruleText(10, 2)[0]).toBe("spend_without_conversions: spend >= 10 and conversions = 0");
  });

  it("nothing divides by zero when there is no spend and no conversion", () => {
    const r = applySegmentRules([ins({ age: "18-24" }, { spend: 0, impressions: 0, clicks: 0 })], "age", [], 10, 2);
    expect(r.segments[0]).toMatchObject({ share_of_spend: null, share_of_conversions: null, ctr: null, cpc: null, cpm: null, cost_per_conversion: null, roas: null });
  });

  it("analyze_meta_audiences and optimize_meta_placements run the rules on live breakdowns", async () => {
    insights = (_o, p) =>
      p.get("breakdowns") === "publisher_platform,platform_position"
        ? [ins({ publisher_platform: "instagram", platform_position: "story" }, { spend: 40, conversions: 0 }), ins({ publisher_platform: "facebook", platform_position: "feed" }, { spend: 60, conversions: 6 })]
        : [seg("25-34", 10, 0), seg("35-44", 30, 3)];
    const pl = data<{ segments: Row[]; flagged_counts: Row }>(await run("optimize_meta_placements", { min_spend: 40 }));
    expect(pl.segments[1]).toMatchObject({ label: "instagram / story", flags: ["spend_without_conversions"], share_of_spend: 0.4, share_of_conversions: 0 });
    expect(last("act_555/insights").params.get("breakdowns")).toBe("publisher_platform,platform_position");
    const au = data<{ segments: Row[] }>(await run("analyze_meta_audiences", { breakdown: "age", min_spend: 10, flagged_only: true }));
    expect(au.segments.map((s) => s.label)).toEqual(["25-34"]);
  });
});

// ---------------------------------------------------------------------------------------------------------- analysis
describe("analyze_meta_wasted_spend", () => {
  it("flags each level exactly at min_spend with zero conversions", async () => {
    insights = (_o, p) => {
      const l = p.get("level");
      if (l === "campaign") return [ins({ campaign_id: "1", campaign_name: "C1" }, { spend: 10 }), ins({ campaign_id: "2", campaign_name: "C2" }, { spend: 9.99 }), ins({ campaign_id: "3" }, { spend: 50, conversions: 1 })];
      if (l === "ad") return [ins({ ad_id: "9", ad_name: "A9", campaign_id: "1" }, { spend: 10 })];
      return [];
    };
    const d = data<{ levels: { level: string; flagged: Row[]; flagged_spend: number; flagged_share_of_spend: number | null }[] }>(await run("analyze_meta_wasted_spend", { min_spend: 10 }));
    const camp = d.levels.find((l) => l.level === "campaign")!;
    expect(camp.flagged.map((f) => f.id)).toEqual(["1"]);
    expect(camp.flagged_spend).toBe(10);
    expect(d.levels.find((l) => l.level === "ad")!.flagged.map((f) => f.id)).toEqual(["9"]);
    expect(d.levels.find((l) => l.level === "adset")).toMatchObject({ analyzed: 0, flagged_share_of_spend: null });
    expect((await run("analyze_meta_wasted_spend", { campaign_id: "200009" })).error?.code).toBe("not_found");
  });
});

describe("detect_meta_creative_fatigue", () => {
  it("compares two equal windows and fires each rule on its boundary", async () => {
    const recent = { since: "2026-10-25", until: "2026-10-31" };
    const prior = { since: "2026-10-18", until: "2026-10-24" };
    insights = (_o, p) => {
      const tr = JSON.parse(p.get("time_range") ?? "{}");
      const isRecent = tr.since === recent.since && tr.until === recent.until;
      if (!isRecent && !(tr.since === prior.since && tr.until === prior.until)) return [];
      return isRecent
        ? [
            ins({ ad_id: "1", ad_name: "Exact" }, { impressions: 1000, clicks: 8, spend: 12, frequency: 2.4 }), // freq x1.2, CTR x0.8, CPM x1.2
            ins({ ad_id: "2" }, { impressions: 1000, clicks: 9, spend: 11, frequency: 2.39 }), // just under every threshold
            ins({ ad_id: "3" }, { impressions: 999, clicks: 1, spend: 50, frequency: 9 }), // below min impressions
            ins({ ad_id: "4" }, { impressions: 2000, clicks: 0, spend: 20, frequency: 1 }), // prior had no clicks
          ]
        : [ins({ ad_id: "1" }, { impressions: 1000, clicks: 10, spend: 10, frequency: 2 }), ins({ ad_id: "2" }, { impressions: 1000, clicks: 10, spend: 10, frequency: 2 }), ins({ ad_id: "3" }, { impressions: 5000, clicks: 50, spend: 10, frequency: 2 }), ins({ ad_id: "4" }, { impressions: 2000, clicks: 0, spend: 0, frequency: 1 })];
    };
    const d = data<{ ads: { ad_id: string; flags: string[]; fatigued: boolean }[]; ads_not_evaluated: number; recent: Row; prior: Row }>(await run("detect_meta_creative_fatigue", { end_date: "2026-10-31", window_days: 7 }));
    expect(d.recent).toEqual({ start_date: "2026-10-25", end_date: "2026-10-31" });
    expect(d.prior).toEqual({ start_date: "2026-10-18", end_date: "2026-10-24" });
    const by = Object.fromEntries(d.ads.map((a) => [a.ad_id, a]));
    expect(by["1"]).toMatchObject({ flags: ["frequency_up", "ctr_down", "cpm_up"], fatigued: true });
    expect(by["2"]).toMatchObject({ flags: [], fatigued: false });
    expect(by["4"]).toMatchObject({ flags: [] });
    expect(by["3"]).toBeUndefined();
    expect(d.ads_not_evaluated).toBe(1);
    expect((await run("detect_meta_creative_fatigue", { end_date: "2999-01-01" })).error?.code).toBe("invalid_argument");
  });
});

describe("explain_meta_anomaly", () => {
  it("decomposes the change into children whose shares add up to 1", async () => {
    insights = (_o, p) => {
      const cur = JSON.parse(p.get("time_range")!).since === "2026-10-08";
      return cur ? [ins({ campaign_id: "1", campaign_name: "Up" }, { spend: 150 }), ins({ campaign_id: "2", campaign_name: "Down" }, { spend: 20 })] : [ins({ campaign_id: "1" }, { spend: 100 }), ins({ campaign_id: "2" }, { spend: 40 }), ins({ campaign_id: "3", campaign_name: "Gone" }, { spend: 10 })];
    };
    const d = data<{ total_delta: number; children: { id: string; delta: number; share_of_change: number | null }[]; change: Record<string, number | null> }>(
      await run("explain_meta_anomaly", { current: { start_date: "2026-10-08", end_date: "2026-10-14" }, previous: { start_date: "2026-10-01", end_date: "2026-10-07" } }),
    );
    expect(d.total_delta).toBe(20);
    expect(d.children.map((c) => [c.id, c.delta, c.share_of_change])).toEqual([["1", 50, 2.5], ["2", -20, -1], ["3", -10, -0.5]]);
    expect(d.children.reduce((t, c) => t + c.share_of_change!, 0)).toBeCloseTo(1);
    expect(d.change.conversions).toBeNull(); // previous conversions were 0
  });

  it("share_of_change is null when the total did not move", async () => {
    insights = (_o, p) => (JSON.parse(p.get("time_range")!).since === "2026-10-08" ? [ins({ campaign_id: "1" }, { spend: 30 }), ins({ campaign_id: "2" }, { spend: 10 })] : [ins({ campaign_id: "1" }, { spend: 10 }), ins({ campaign_id: "2" }, { spend: 30 })]);
    const d = data<{ total_delta: number; children: { share_of_change: number | null }[] }>(await run("explain_meta_anomaly", { current: { start_date: "2026-10-08", end_date: "2026-10-14" }, previous: { start_date: "2026-10-01", end_date: "2026-10-07" } }));
    expect(d.total_delta).toBe(0);
    expect(d.children.every((c) => c.share_of_change === null)).toBe(true);
  });
});

describe("optimize_meta_budget", () => {
  beforeEach(() => {
    edges["act_555/campaigns"] = [{ id: "1", daily_budget: "5000" }, { id: "2", daily_budget: "5000" }, { id: "3" }, { id: "4", lifetime_budget: "100000" }];
  });

  it("lists candidates by share of conversions vs share of spend, only where the budget lives at that level", async () => {
    // Totals: spend 100, conversions 10. Campaign 1: 20% of spend, 24% of conversions = exactly 1.2x -> increase.
    insights = () => [
      ins({ campaign_id: "1", campaign_name: "Efficient" }, { spend: 20, conversions: 2.4 }),
      ins({ campaign_id: "2", campaign_name: "Costly" }, { spend: 50, conversions: 4 }), // 40% vs 50% = 0.8x -> decrease (boundary)
      ins({ campaign_id: "3", campaign_name: "Ad set budgets" }, { spend: 20, conversions: 3.6 }), // efficient but no campaign budget
      ins({ campaign_id: "4" }, { spend: 10, conversions: 0 }), // spend with no conversions -> decrease
    ];
    const d = data<{ candidates_to_increase: Row[]; candidates_to_decrease: Row[]; items: Row[] }>(await run("optimize_meta_budget", { min_conversions: 2, margin: 0.2 }));
    expect(d.candidates_to_increase.map((c) => c.id)).toEqual(["1"]);
    expect(d.candidates_to_decrease.map((c) => c.id).sort()).toEqual(["2", "4"]);
    expect(d.items.find((i) => i.id === "1")).toMatchObject({ daily_budget: 50, budget_at_this_level: true, share_of_spend: 0.2, share_of_metric: 0.24 });
    expect(d.items.find((i) => i.id === "3")).toMatchObject({ budget_at_this_level: false });
  });

  it("does not divide by zero when nothing converted", async () => {
    insights = () => [ins({ campaign_id: "1" }, { spend: 0, conversions: 0, impressions: 0, clicks: 0 })];
    const d = data<{ totals: Row; items: Row[]; candidates_to_increase: Row[] }>(await run("optimize_meta_budget", {}));
    expect(d.totals).toMatchObject({ cost_per_conversion: null, roas: null });
    expect(d.items[0]).toMatchObject({ share_of_spend: null, share_of_metric: null });
    expect(d.candidates_to_increase).toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------------------- helpers
describe("select_meta_campaign_type", () => {
  it("maps a goal to its ODAX objective and lists the account's own accepted combinations", async () => {
    edges["act_555/campaigns"] = [{ id: "1", objective: "OUTCOME_SALES" }, { id: "2", objective: "OUTCOME_TRAFFIC" }];
    edges["act_555/adsets"] = [
      { id: "a", campaign_id: "1", optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS" },
      { id: "b", campaign_id: "1", optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS" },
      { id: "c", campaign_id: "2", optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS" },
    ];
    const d = data(await run("select_meta_campaign_type", { goal: "sales" }));
    expect(d).toMatchObject({ objective: "OUTCOME_SALES", campaigns_with_objective: 1, pixels: 2, used_in_this_account: [{ optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", ad_sets: 2 }] });
    expect(data(await run("select_meta_campaign_type", { goal: "engagement" }))).toMatchObject({ objective: "OUTCOME_ENGAGEMENT", documented_destination_types: ["ON_POST", "ON_VIDEO", "ON_EVENT", "ON_PAGE"], used_in_this_account: [] });
  });
});

describe("validate_and_prepare_meta_assets", () => {
  it("checks the 600px minimum width and Instagram aspect ratios on their boundaries", () => {
    const ig = ["instagram_feed"] as const;
    expect(checkMedia("image", { width: 600, height: 600 }, ig).problems).toEqual([]);
    expect(checkMedia("image", { width: 599, height: 599 }, ig).problems[0]).toMatch(/at least 600px/);
    expect(checkMedia("video", { width: 1080, height: 1350 }, ig).problems).toEqual([]); // 4:5
    expect(checkMedia("video", { width: 1200, height: 628 }, ig).problems).toEqual([]); // 1.91:1 as Meta rounds it
    expect(checkMedia("video", { width: 1080, height: 1920 }, ig).problems[0]).toMatch(/outside 4:5 to 1.91:1/);
    expect(checkMedia("image", { width: 1080, height: 1920 }, ig)).toMatchObject({ problems: [], warnings: [expect.stringMatching(/centre-crop/)] });
    expect(checkMedia("video", { width: 1080, height: 1920 }, ["instagram_stories"]).problems).toEqual([]); // 9:16
    expect(checkMedia("video", { width: 1000, height: 1600 }, ["instagram_stories"]).problems[0]).toMatch(/cannot be cropped/); // 0.625: neither range
  });

  it("checks Instagram video duration on 3 and 60 seconds", () => {
    const v = (d: number) => checkMedia("video", { width: 1080, height: 1080, duration_seconds: d }, ["instagram_feed"]).problems;
    expect(v(3)).toEqual([]);
    expect(v(60)).toEqual([]);
    expect(v(2.9)[0]).toMatch(/3 to 60/);
    expect(v(61)[0]).toMatch(/3 to 60/);
    expect(checkMedia("video", { width: 1080, height: 1080 }, ["instagram_feed"]).unchecked[0]).toMatch(/duration unknown/);
  });

  it("downloads images through the safe fetcher, reads library hashes and refuses foreign videos", async () => {
    images["https://img.example/ok.png"] = png(1080, 1080);
    images["https://img.example/small.png"] = png(500, 500);
    edges["act_555/adimages"] = [{ id: "i1", hash: "libhash01", width: 1200, height: 628, original_width: 1200, original_height: 628, status: "ACTIVE" }];
    edges["act_555/advideos"] = [{ id: "51", name: "Clip", format: [{ width: 1080, height: 1920 }] }];
    const d = data<{ ok: boolean; images: Row[]; videos: Row[] }>(
      await run("validate_and_prepare_meta_assets", {
        placements: ["instagram_feed", "facebook_feed"],
        images: [{ url: "https://img.example/ok.png" }, { url: "https://img.example/small.png" }, { image_hash: "libhash01" }, { url: "https://img.example/missing.png" }],
        videos: [{ video_id: "51", duration_seconds: 20 }, { video_id: "59" }],
      }),
    );
    expect(d.ok).toBe(false);
    expect(d.images[0]).toMatchObject({ ok: true, width: 1080, mime: "IMAGE_PNG" });
    expect(d.images[1]).toMatchObject({ ok: false });
    expect(d.images[2]).toMatchObject({ ok: true, width: 1200, warnings: [expect.stringMatching(/1080x1080/)] });
    expect(d.images[3]).toMatchObject({ ok: false, problems: [expect.stringMatching(/could not be downloaded/)] });
    expect(d.videos[0]).toMatchObject({ ok: false, width: 1080, height: 1920 }); // 9:16 is not allowed in the Instagram feed
    expect(d.videos[1]).toMatchObject({ ok: false, problems: [expect.stringMatching(/No video 59/)] });
    expect((await run("validate_and_prepare_meta_assets", { placements: ["instagram_feed"], images: [{ url: "http://insecure.example/a.png" }] })).ok).toBe(false);
  });
});
