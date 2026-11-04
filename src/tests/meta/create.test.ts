import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { META_SCOPES } from "../../auth/platform-oauth";
import type { FetchLike } from "../../auth/token-providers";
import type { Db } from "../../db";
import { createExecutor, runTool, type PipelineDeps } from "../../mcp/pipeline";
import { addUser, seedAccount, seedTenant, testDb } from "../support/helpers";
import { J, metaDeps, metaNotFound } from "../support/meta";

const tokens = { getToken: async () => ({ accessToken: "EAAuser", appSecretProof: "p" }), proofFor: () => "p" };

// ------------------------------------------------------------------- fake Graph API: POSTs create objects, lists derive from them
type Obj = Record<string, unknown> & { kind: "campaign" | "adset" | "creative" | "ad"; account_id: string };
let objs: Record<string, Obj>;
let posts: { path: string; params: Record<string, string> }[];
let failOn: { edge: string; mode: "definite" | "transient" | "no_id" } | null;
let nextId: number;
let images: { hash: string; status: string }[];
let videos: string[];

const KIND: Record<string, Obj["kind"]> = { campaigns: "campaign", adsets: "adset", adcreatives: "creative", ads: "ad" };
const list = (pred: (o: Obj) => boolean) => J({ data: Object.entries(objs).filter(([, o]) => pred(o)).map(([id, o]) => ({ id, ...o })) });

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const path = u.pathname.replace("/v27.0/", "");
  if ((init?.method ?? "GET") === "POST") {
    const params = Object.fromEntries(new URLSearchParams(String(init?.body)));
    delete params.appsecret_proof;
    posts.push({ path, params });
    const edge = path.split("/")[1]!;
    if (failOn?.edge === edge && failOn.mode === "definite") return J({ error: { code: 100, message: "Invalid parameter" } }, 400);
    if (failOn?.edge === edge && failOn.mode === "transient") return J({ error: { code: 2, message: "temporary", is_transient: true } }, 500);
    const id = String(nextId++);
    objs[id] = { kind: KIND[edge]!, account_id: "555", ...params, ...(params.adset_id ? { adset_id: params.adset_id } : {}) };
    return J(failOn?.edge === edge && failOn.mode === "no_id" ? { success: true } : { id });
  }
  if (path === "act_555/campaigns") return list((o) => o.kind === "campaign" && o.account_id === "555");
  if (path === "act_555/adcreatives") return list((o) => o.kind === "creative" && o.account_id === "555");
  if (path === "act_555/adimages") return J({ data: images });
  if (path === "act_555/advideos") return J({ data: videos.map((id) => ({ id })) });
  if (path === "act_555/promote_pages") return J({ data: [{ id: "700001" }] });
  if (path === "act_555/instagram_accounts") return J({ data: [{ id: "178001" }] });
  if (path === "act_555/adspixels") return J({ data: [{ id: "800001" }] });
  let m = path.match(/^(\d+)\/adsets$/);
  if (m) return list((o) => o.kind === "adset" && o.campaign_id === m![1]);
  m = path.match(/^(\d+)\/ads$/);
  if (m) return list((o) => o.kind === "ad" && o.adset_id === m![1]);
  const o = objs[path];
  return o ? J({ id: path, ...o }) : metaNotFound();
};

let db: Db, deps: PipelineDeps, tenantId: string, owner: string, second: string, acct: string;
beforeAll(async () => {
  db = await testDb();
  const t = await seedTenant(db, "MC", "owner");
  tenantId = t.tenant.id;
  owner = t.user.id;
  second = (await addUser(db, tenantId, "mc-adm", "admin")).id;
  acct = (await seedAccount(db, tenantId, "meta_ads", "write", "active", "act_555", { currencyCode: "USD", timeZone: "America/New_York" })).id;
  deps = metaDeps(db, { tokens, fetch: fake });
});

let n = 0;
beforeEach(() => {
  posts = [];
  failOn = null;
  nextId = 900001 + 1000 * ++n;
  images = [{ hash: "imghash0001", status: "ACTIVE" }, { hash: "imghash0002", status: "ACTIVE" }, { hash: "deletedhash", status: "DELETED" }];
  videos = ["610001"];
  objs = {
    "200001": { kind: "campaign", account_id: "555", name: "Existing CBO", status: "PAUSED", objective: "OUTCOME_SALES", daily_budget: "5000", special_ad_categories: [] },
    "200002": { kind: "campaign", account_id: "555", name: "Existing ABO", status: "ACTIVE", objective: "OUTCOME_TRAFFIC", special_ad_categories: ["HOUSING"] },
    "200003": { kind: "campaign", account_id: "555", name: "Awareness", status: "ACTIVE", objective: "OUTCOME_AWARENESS" },
    "200009": { kind: "campaign", account_id: "111", name: "Foreign", status: "ACTIVE", objective: "OUTCOME_SALES" },
    "300001": { kind: "adset", account_id: "555", campaign_id: "200001", name: "Plain set", status: "PAUSED", is_dynamic_creative: false },
    "300002": { kind: "adset", account_id: "555", campaign_id: "200001", name: "DCO set", status: "PAUSED", is_dynamic_creative: true },
    "400009": { kind: "creative", account_id: "111", name: "Foreign creative" },
    "400001": { kind: "creative", account_id: "555", name: "Existing creative" },
  };
});

const FUTURE = new Date(Date.now() + 40 * 86_400_000).toISOString();
const base = (over: Record<string, unknown> = {}) => ({
  campaign_name: `Spring ${n}`,
  objective: "OUTCOME_SALES",
  special_ad_categories: [],
  budget: { level: "campaign", type: "daily", amount: 50 },
  ad_set_name: `Spring set ${n}`,
  optimization_goal: "OFFSITE_CONVERSIONS",
  pixel_id: "800001",
  targeting: { countries: ["US"], age_min: 25, age_max: 54, interests: ["6003107902433"] },
  ad_name: `Spring ad ${n}`,
  page_id: "700001",
  link: "https://shop.example/spring",
  url_tags: "utm_source=meta&utm_medium=paid",
  image: { image_hash: "imghash0001", message: "Spring sale", headline: "20% off", call_to_action: "SHOP_NOW" },
  ...over,
});
const run = (name: string, args: Record<string, unknown>) => runTool(deps, deps.registry.get(name)!, { account_id: acct, ...args }, { tenantId, userId: owner, role: "owner", scopes: ["ads:read", "ads:write"] });
const approve = (id: string, by = second) => deps.approvals.decide({ tenantId, approvalId: id, decider: { userId: by, role: by === owner ? "owner" : "admin" }, decision: "approve", execute: createExecutor(deps) });
const planned = async (name: string, args: Record<string, unknown>) => {
  const r = await run(name, args);
  if (!r.approval) throw new Error(`no approval: ${JSON.stringify(r.error)}`);
  return r.approval;
};
const ctx = async () => ({ tenantId, userId: owner, account: null, signal: new AbortController().signal, services: await deps.createServices({ tenantId, account: { platform: "meta_ads", externalId: "act_555", id: acct, loginCustomerId: null, connectionId: "x", currencyCode: "USD" } }) });
const verify = async (name: string, args: Record<string, unknown>) => {
  const tool = deps.registry.get(name)!;
  if (tool.kind !== "write") throw new Error("write tool expected");
  return tool.verify(tool.input.parse({ account_id: acct, ...args }), (await ctx()) as never, { snapshot: null });
};
const statuses = () => posts.map((p) => p.params.status).filter(Boolean);

// -------------------------------------------------------------------------------------------- create_meta_image_campaign
describe("create_meta_image_campaign", () => {
  it("creates campaign -> ad set -> creative -> ad, all PAUSED, after a second approval; exact params per step", async () => {
    const ap = await planned("create_meta_image_campaign", base());
    expect(ap.risk).toBe("high_impact");
    expect(ap.change_set!.changes.map((c) => c.resource)).toEqual(["campaign", "ad_set", "ad_creative", "ad", "campaign"]);
    expect(ap.change_set!.changes.at(-1)).toMatchObject({ field: "daily_budget", after: 50, effect: "increase_spend" });
    expect(posts).toHaveLength(0);
    await expect(approve(ap.approval_id, owner)).rejects.toMatchObject({ code: "permission_denied" });
    const done = await approve(ap.approval_id);
    expect(done.status).toBe("executed");
    expect(posts.map((p) => p.path)).toEqual(["act_555/campaigns", "act_555/adsets", "act_555/adcreatives", "act_555/ads"]);
    const [c, s, cr, ad] = posts.map((p) => p.params);
    expect(c).toEqual({ name: `Spring ${n}`, objective: "OUTCOME_SALES", status: "PAUSED", special_ad_categories: "[]", daily_budget: "5000", bid_strategy: "LOWEST_COST_WITHOUT_CAP" });
    expect(s).toMatchObject({ name: `Spring set ${n}`, optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", status: "PAUSED", campaign_id: (done.result as { campaign_id: string }).campaign_id, promoted_object: JSON.stringify({ pixel_id: "800001", custom_event_type: "PURCHASE" }) });
    expect(s!.daily_budget).toBeUndefined();
    expect(JSON.parse(s!.targeting!)).toEqual({ geo_locations: { countries: ["US"] }, age_min: 25, age_max: 54, flexible_spec: [{ interests: [{ id: "6003107902433" }] }], targeting_automation: { advantage_audience: 0 } });
    expect(JSON.parse(cr!.object_story_spec!)).toEqual({ page_id: "700001", link_data: { link: "https://shop.example/spring", image_hash: "imghash0001", message: "Spring sale", name: "20% off", call_to_action: { type: "SHOP_NOW", value: { link: "https://shop.example/spring" } } } });
    expect(cr!.url_tags).toBe("utm_source=meta&utm_medium=paid");
    expect(ad).toEqual({ name: `Spring ad ${n}`, adset_id: (done.result as { ad_set_id: string }).ad_set_id, creative: JSON.stringify({ creative_id: (done.result as { creative_id: string }).creative_id }), status: "PAUSED" });
    expect(statuses()).toEqual(["PAUSED", "PAUSED", "PAUSED"]);
    expect(done.result).toMatchObject({ status: "PAUSED" });
    expect(await verify("create_meta_image_campaign", base())).toEqual({ outcome: "applied" });
    expect(JSON.stringify(posts)).not.toContain("meta_moment_maker_spec");
  });

  it("ad set budget: the campaign sends is_adset_budget_sharing_enabled=false, the ad set carries the budget; lifetime needs end_time", async () => {
    expect((await run("create_meta_image_campaign", base({ budget: { level: "ad_set", type: "lifetime", amount: 300 } }))).error?.message).toMatch(/lifetime budget needs an end_time/);
    const ap = await planned("create_meta_image_campaign", base({ budget: { level: "ad_set", type: "lifetime", amount: 300 }, end_time: FUTURE }));
    await approve(ap.approval_id);
    const [c, s] = posts.map((p) => p.params);
    expect(c).toMatchObject({ is_adset_budget_sharing_enabled: "false" });
    expect(c!.lifetime_budget).toBeUndefined();
    expect(s).toMatchObject({ lifetime_budget: "30000", bid_strategy: "LOWEST_COST_WITHOUT_CAP", end_time: String(Math.floor(Date.parse(FUTURE) / 1000)) });
  });

  it("refuses assets, Pages, pixels and Instagram accounts that are not the ad account's", async () => {
    expect((await run("create_meta_image_campaign", base({ image: { image_hash: "missinghash1" } }))).error?.message).toMatch(/not in this ad account's image library/);
    expect((await run("create_meta_image_campaign", base({ image: { image_hash: "deletedhash" } }))).error?.code).toBe("not_found");
    expect((await run("create_meta_image_campaign", base({ page_id: "799999" }))).error?.code).toBe("not_found");
    expect((await run("create_meta_image_campaign", base({ pixel_id: "899999" }))).error?.code).toBe("not_found");
    expect((await run("create_meta_image_campaign", base({ instagram_account_id: "178999" }))).error?.code).toBe("not_found");
    expect((await run("create_meta_image_campaign", base({ link: "https://user:pw@shop.example/" }))).ok).toBe(false);
    expect((await run("create_meta_image_campaign", base({ link: "http://shop.example/" }))).ok).toBe(false);
    expect(posts).toHaveLength(0);
  });

  it("enforces special ad category restrictions", async () => {
    const special = (t: Record<string, unknown>) => run("create_meta_image_campaign", base({ special_ad_categories: ["HOUSING"], targeting: { countries: ["US"], ...t } }));
    expect((await special({ age_min: 25 })).error?.message).toMatch(/18-65/);
    expect((await special({ genders: [2] })).error?.message).toMatch(/gender/);
    expect((await special({ interests: ["6003107902433"] })).error?.message).toMatch(/interest/);
    expect((await special({ cities: [{ key: "2420379", radius: 10, distance_unit: "mile" }] })).error?.message).toMatch(/15 miles/);
    expect((await special({ cities: [{ key: "2420379", radius: 24, distance_unit: "kilometer" }] })).error?.message).toMatch(/25 km/);
    expect((await special({ cities: [{ key: "2420379" }] })).error?.message).toMatch(/radius/);
    const ok = await special({ cities: [{ key: "2420379", radius: 15, distance_unit: "mile" }] });
    expect(ok.error).toBeUndefined();
    expect(ok.approval).toBeDefined();
  });

  it("accepts only documented objective / optimization goal combinations and Advantage+ audience rules", async () => {
    expect((await run("create_meta_image_campaign", base({ optimization_goal: "LINK_CLICKS", pixel_id: undefined }))).error?.message).toMatch(/not a documented combination/);
    expect((await run("create_meta_image_campaign", base({ objective: "OUTCOME_AWARENESS" }))).ok).toBe(false);
    expect((await run("create_meta_image_campaign", base({ optimization_goal: "OFFSITE_CONVERSIONS", pixel_id: undefined }))).error?.message).toMatch(/needs a pixel_id/);
    const traffic = await planned("create_meta_image_campaign", base({ objective: "OUTCOME_TRAFFIC", optimization_goal: "LINK_CLICKS", pixel_id: undefined }));
    await approve(traffic.approval_id);
    expect(posts[1]!.params).toMatchObject({ optimization_goal: "LINK_CLICKS", billing_event: "LINK_CLICKS" });
    expect((await run("create_meta_image_campaign", base({ targeting: { countries: ["US"], age_max: 50, advantage_audience: true } }))).error?.message).toMatch(/age_max at 65/);
  });

  it("placements: documented positions only; Explore and Messenger Stories are not accepted", async () => {
    expect((await run("create_meta_image_campaign", base({ targeting: { countries: ["US"], publisher_platforms: ["instagram"], instagram_positions: ["explore"] } }))).ok).toBe(false);
    expect((await run("create_meta_image_campaign", base({ targeting: { countries: ["US"], publisher_platforms: ["messenger"] } }))).ok).toBe(false);
    expect((await run("create_meta_image_campaign", base({ targeting: { countries: ["US"], publisher_platforms: ["facebook"], facebook_positions: ["marketplace"] } }))).error?.message).toMatch(/need Facebook feed/);
    const ap = await planned("create_meta_image_campaign", base({ targeting: { countries: ["US"], publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed", "story"], instagram_positions: ["stream", "story", "reels"] } }));
    await approve(ap.approval_id);
    const t = JSON.parse(posts[1]!.params.targeting!);
    expect(t).toMatchObject({ publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed", "story"], instagram_positions: ["stream", "story", "reels"] });
    expect(JSON.stringify(t)).not.toMatch(/explore|messenger/);
  });

  it("refuses a name already in use at planning, and refuses at execution when one appears after approval", async () => {
    expect((await run("create_meta_image_campaign", base({ campaign_name: "existing cbo" }))).error?.message).toMatch(/already exists/);
    expect((await run("create_meta_image_campaign", base({ ad_name: "Existing creative" }))).error?.message).toMatch(/creative named/);
    const ap = await planned("create_meta_image_campaign", base());
    objs["999999"] = { kind: "campaign", account_id: "555", name: `Spring ${n}`, status: "PAUSED" };
    expect((await approve(ap.approval_id)).status).toBe("failed");
    expect(posts).toHaveLength(0);
  });

  it("partial failure at each later step lists every id created so far; nothing is retried or deleted", async () => {
    for (const [edge, created, missing] of [
      ["adsets", ["campaign"], "ad set, creative, ad"],
      ["adcreatives", ["campaign", "ad set"], "creative, ad"],
      ["ads", ["campaign", "ad set", "creative"], "ad"],
    ] as const) {
      posts = [];
      failOn = { edge, mode: "definite" };
      const ap = await planned("create_meta_image_campaign", base({ campaign_name: `P ${edge} ${n}`, ad_name: `P ad ${edge} ${n}` }));
      const done = await approve(ap.approval_id);
      expect(done.status).toBe("unknown_outcome");
      const msg = (done.result as { error: { message: string } }).error.message;
      expect(msg).toContain("Partly created");
      for (const label of created) expect(msg).toMatch(new RegExp(`${label} \\d+`));
      expect(msg).toContain(`Not created: ${missing}`);
      expect(msg).toContain("Nothing was deleted");
      expect(posts).toHaveLength(created.length + 1);
      expect(posts.filter((p) => p.path.endsWith(`/${edge}`))).toHaveLength(1);
    }
  });

  it("a failure at the first step creates nothing and is a plain failure", async () => {
    failOn = { edge: "campaigns", mode: "definite" };
    const ap = await planned("create_meta_image_campaign", base());
    expect((await approve(ap.approval_id)).status).toBe("failed");
    expect(posts).toHaveLength(1);
  });

  it("a transient failure on a later step says the object may exist", async () => {
    failOn = { edge: "ads", mode: "transient" };
    const ap = await planned("create_meta_image_campaign", base());
    const done = await approve(ap.approval_id);
    expect((done.result as { error: { message: string } }).error.message).toMatch(/ad step failed with an unknown outcome, so it may also exist/);
    expect(posts.filter((p) => p.path.endsWith("/ads"))).toHaveLength(1);
  });

  it("verify(): none, partial, applied and ambiguous", async () => {
    expect(await verify("create_meta_image_campaign", base())).toEqual({ outcome: "not_applied" });
    failOn = { edge: "adcreatives", mode: "definite" };
    await approve((await planned("create_meta_image_campaign", base())).approval_id);
    const partial = await verify("create_meta_image_campaign", base());
    expect(partial.outcome).toBe("indeterminate");
    expect(partial.detail).toMatch(/partial: exists campaign \d+, ad set \d+; missing creative, ad/);
    objs["999998"] = { kind: "campaign", account_id: "555", name: `Spring ${n}`, status: "PAUSED" };
    expect(await verify("create_meta_image_campaign", base())).toMatchObject({ outcome: "indeterminate", detail: expect.stringMatching(/ambiguous: 2 campaigns/) });
  });
});

// -------------------------------------------------------------------------------------------- video and carousel campaigns
describe("create_meta_video_campaign / create_meta_carousel_campaign", () => {
  it("video: video_data with the library video and a thumbnail URL", async () => {
    const { image: _i, ...rest } = base();
    expect((await run("create_meta_video_campaign", { ...rest, video: { video_id: "619999", thumbnail_url: "https://cdn.example/t.jpg" } })).error?.message).toMatch(/video library/);
    const ap = await planned("create_meta_video_campaign", { ...rest, video: { video_id: "610001", thumbnail_url: "https://cdn.example/t.jpg", message: "Watch" } });
    await approve(ap.approval_id);
    expect(JSON.parse(posts[2]!.params.object_story_spec!)).toEqual({ page_id: "700001", video_data: { video_id: "610001", image_url: "https://cdn.example/t.jpg", message: "Watch", call_to_action: { type: "LEARN_MORE", value: { link: "https://shop.example/spring" } } } });
    expect(statuses()).toEqual(["PAUSED", "PAUSED", "PAUSED"]);
  });

  it("carousel: 2-10 child_attachments, video cards with an image thumbnail", async () => {
    const { image: _i, ...rest } = base();
    const cards = [
      { image_hash: "imghash0001", link: "https://shop.example/a", headline: "A", description: "$9" },
      { image_hash: "imghash0002", video_id: "610001", link: "https://shop.example/b" },
    ];
    expect((await run("create_meta_carousel_campaign", { ...rest, carousel: { cards: [cards[0]] } })).ok).toBe(false);
    expect((await run("create_meta_carousel_campaign", { ...rest, carousel: { cards: Array(11).fill(cards[0]) } })).ok).toBe(false);
    const ap = await planned("create_meta_carousel_campaign", { ...rest, instagram_account_id: "178001", carousel: { cards, message: "Pick one" } });
    await approve(ap.approval_id);
    const spec = JSON.parse(posts[2]!.params.object_story_spec!);
    expect(spec).toMatchObject({ page_id: "700001", instagram_user_id: "178001", link_data: { link: "https://shop.example/spring", message: "Pick one" } });
    expect(spec.link_data.child_attachments).toEqual([
      { link: "https://shop.example/a", image_hash: "imghash0001", name: "A", description: "$9", call_to_action: { type: "LEARN_MORE", value: { link: "https://shop.example/a" } } },
      { link: "https://shop.example/b", image_hash: "imghash0002", video_id: "610001", call_to_action: { type: "LEARN_MORE", value: { link: "https://shop.example/b" } } },
    ]);
  });
});

// ------------------------------------------------------------------------------------------- add_meta_ad_set / add_meta_ad
describe("add_meta_ad_set", () => {
  const set = (over: Record<string, unknown> = {}) => ({ campaign_id: "200001", ad_set_name: `New set ${n}`, optimization_goal: "OFFSITE_CONVERSIONS", pixel_id: "800001", targeting: { countries: ["GB"] }, ...over });

  it("follows the campaign's budget owner and objective, and the campaign's special category", async () => {
    expect((await run("add_meta_ad_set", set({ budget: { type: "daily", amount: 10 } }))).error?.message).toMatch(/campaign budget/);
    expect((await run("add_meta_ad_set", set({ campaign_id: "200002", optimization_goal: "LINK_CLICKS", pixel_id: undefined }))).error?.message).toMatch(/give the ad set a daily or lifetime budget/);
    expect((await run("add_meta_ad_set", set({ campaign_id: "200003" }))).error?.message).toMatch(/no documented optimization-goal combination/);
    expect((await run("add_meta_ad_set", set({ campaign_id: "200009" }))).error?.code).toBe("not_found");
    expect((await run("add_meta_ad_set", set({ campaign_id: "200002", optimization_goal: "LINK_CLICKS", pixel_id: undefined, budget: { type: "daily", amount: 10 }, targeting: { countries: ["US"], genders: [1] } }))).error?.message).toMatch(/HOUSING/);
    const ap = await planned("add_meta_ad_set", set({ campaign_id: "200002", optimization_goal: "LINK_CLICKS", pixel_id: undefined, budget: { type: "daily", amount: 10 } }));
    expect(ap.risk).toBe("high_impact");
    const done = await approve(ap.approval_id);
    expect(done.status).toBe("executed");
    expect(posts[0]).toMatchObject({ path: "act_555/adsets", params: { campaign_id: "200002", daily_budget: "1000", status: "PAUSED", billing_event: "LINK_CLICKS" } });
    expect(await verify("add_meta_ad_set", set({ campaign_id: "200002", optimization_goal: "LINK_CLICKS", pixel_id: undefined, budget: { type: "daily", amount: 10 } }))).toEqual({ outcome: "applied" });
  });

  it("dynamic creative ad sets need OFFSITE_CONVERSIONS and send is_dynamic_creative", async () => {
    expect((await run("add_meta_ad_set", set({ campaign_id: "200002", optimization_goal: "LINK_CLICKS", pixel_id: undefined, budget: { type: "daily", amount: 10 }, is_dynamic_creative: true }))).error?.message).toMatch(/OFFSITE_CONVERSIONS/);
    const ap = await planned("add_meta_ad_set", set({ is_dynamic_creative: true }));
    await approve(ap.approval_id);
    expect(posts[0]!.params).toMatchObject({ is_dynamic_creative: "true", campaign_id: "200001" });
    expect(posts[0]!.params.daily_budget).toBeUndefined();
  });
});

describe("add_meta_ad", () => {
  it("with an existing creative: one POST; foreign creatives and dynamic creative ad sets are refused", async () => {
    expect((await run("add_meta_ad", { ad_set_id: "300001", ad_name: `A ${n}`, creative_id: "400009" })).error?.code).toBe("not_found");
    expect((await run("add_meta_ad", { ad_set_id: "300002", ad_name: `A ${n}`, creative_id: "400001" })).error?.message).toMatch(/create_meta_dco_ad/);
    const ap = await planned("add_meta_ad", { ad_set_id: "300001", ad_name: `A ${n}`, creative_id: "400001" });
    await approve(ap.approval_id);
    expect(posts).toEqual([{ path: "act_555/ads", params: { name: `A ${n}`, adset_id: "300001", creative: JSON.stringify({ creative_id: "400001" }), status: "PAUSED" } }]);
  });

  it("with a new image creative: creative then ad; an ad failure reports the creative id; verify finds both", async () => {
    const args = { ad_set_id: "300001", ad_name: `B ${n}`, page_id: "700001", link: "https://shop.example/x", image: { image_hash: "imghash0002" } };
    expect((await run("add_meta_ad", { ...args, page_id: undefined })).ok).toBe(false);
    failOn = { edge: "ads", mode: "definite" };
    const done = await approve((await planned("add_meta_ad", args)).approval_id);
    expect(done.status).toBe("unknown_outcome");
    expect((done.result as { error: { message: string } }).error.message).toMatch(/creative \d+.*Not created: ad/);
    expect(await verify("add_meta_ad", args)).toMatchObject({ outcome: "indeterminate", detail: expect.stringMatching(/partial: exists creative \d+; missing ad/) });
  });
});

// ---------------------------------------------------------------------------------------------------- create_meta_dco_ad
describe("create_meta_dco_ad", () => {
  const dco = (over: Record<string, unknown> = {}) => ({ ad_set_id: "300002", ad_name: `DCO ${n}`, page_id: "700001", images: ["imghash0001", "imghash0002"], bodies: ["Text one", "Text two"], titles: ["Head"], link_urls: ["https://shop.example/"], call_to_action_types: ["SHOP_NOW"], ...over });

  it("needs an empty dynamic creative ad set; creates the asset_feed_spec creative and the ad, PAUSED", async () => {
    expect((await run("create_meta_dco_ad", dco({ ad_set_id: "300001" }))).error?.message).toMatch(/not a dynamic creative ad set/);
    expect((await run("create_meta_dco_ad", dco({ images: ["missinghash9"] }))).error?.code).toBe("not_found");
    expect((await run("create_meta_dco_ad", dco({ videos: [{ video_id: "610001", thumbnail_url: "https://cdn.example/t.jpg" }] }))).ok).toBe(false); // images and videos together
    const ap = await planned("create_meta_dco_ad", dco());
    expect(ap.risk).toBe("high_impact");
    await approve(ap.approval_id);
    expect(posts.map((p) => p.path)).toEqual(["act_555/adcreatives", "act_555/ads"]);
    expect(JSON.parse(posts[0]!.params.asset_feed_spec!)).toEqual({ images: [{ hash: "imghash0001" }, { hash: "imghash0002" }], ad_formats: ["SINGLE_IMAGE"], bodies: [{ text: "Text one" }, { text: "Text two" }], titles: [{ text: "Head" }], link_urls: [{ website_url: "https://shop.example/" }], call_to_action_types: ["SHOP_NOW"] });
    expect(JSON.parse(posts[0]!.params.object_story_spec!)).toEqual({ page_id: "700001" });
    expect(posts[1]!.params.status).toBe("PAUSED");
    expect((await run("create_meta_dco_ad", dco({ ad_name: `DCO second ${n}` }))).error?.message).toMatch(/one ad per dynamic creative ad set/);
  });
});

describe("permissions", () => {
  it("the write consent asks for pages_manage_ads and the creation tools declare it", () => {
    expect(META_SCOPES.write).toContain("pages_manage_ads");
    for (const t of ["create_meta_image_campaign", "create_meta_video_campaign", "create_meta_carousel_campaign", "add_meta_ad_set", "add_meta_ad", "create_meta_dco_ad"]) {
      expect(deps.registry.get(t)!.permissions.platformPermissions).toEqual(["ads_management", "pages_manage_ads"]);
    }
  });
});
