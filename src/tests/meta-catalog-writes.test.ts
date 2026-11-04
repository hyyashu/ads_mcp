import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike, MetaTokenProvider } from "../auth/token-providers";
import type { Db } from "../db";
import { loadInventory } from "../inventory";
import { createExecutor, runTool, type PipelineDeps } from "../mcp/pipeline";
import { ToolRegistry } from "../mcp/registry";
import { allTools } from "../platforms";
import { createServicesFactory } from "../platforms/services";
import { MetaGraphHttp } from "../platforms/meta/http";
import { ApprovalService } from "../security/approvals";
import { RateLimiter } from "../security/rate-limit";
import { addUser, seedAccount, seedTenant, testDb } from "./helpers";

const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const tokens = { getToken: async () => ({ accessToken: "EAAuser", appSecretProof: "p" }), proofFor: () => "p" };

// ----------------------------------------------------------- fake Graph API: POSTs create or update objects, lists derive from them
type Kind = "campaign" | "adset" | "creative" | "ad" | "product_set";
type Obj = Record<string, unknown> & { kind: Kind };
let objs: Record<string, Obj>;
let catalogs: Record<string, unknown>[];
let eventSources: Record<string, unknown[]>;
let posts: { path: string; params: Record<string, string> }[];
let failOn: { edge: string; mode: "definite" | "transient" | "10803" } | null;
let nextId: number;

const KIND: Record<string, Kind> = { campaigns: "campaign", adsets: "adset", adcreatives: "creative", ads: "ad", product_sets: "product_set" };
const list = (pred: (o: Obj) => boolean) => J({ data: Object.entries(objs).filter(([, o]) => pred(o)).map(([id, o]) => ({ id, ...o })) });
const parsed = (p: Record<string, string>) => ({ ...p, ...(p.promoted_object ? { promoted_object: JSON.parse(p.promoted_object) } : {}) });

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const path = u.pathname.replace("/v27.0/", "");
  if ((init?.method ?? "GET") === "POST") {
    const params = Object.fromEntries(new URLSearchParams(String(init?.body)));
    delete params.appsecret_proof;
    posts.push({ path, params });
    const [owner, edge] = path.split("/");
    if (!edge) {
      if (!objs[owner!]) return J({ error: { code: 100, error_subcode: 33, message: "does not exist" } }, 400);
      Object.assign(objs[owner!]!, parsed(params));
      return J({ success: true });
    }
    if (failOn?.edge === edge && failOn.mode === "definite") return J({ error: { code: 100, message: "Invalid parameter" } }, 400);
    if (failOn?.edge === edge && failOn.mode === "transient") return J({ error: { code: 2, message: "temporary", is_transient: true } }, 500);
    if (failOn?.edge === edge && failOn.mode === "10803") return J({ error: { code: 10803, message: "Product set with the same filters already exists" } }, 400);
    const id = String(nextId++);
    objs[id] = edge === "product_sets" ? { kind: "product_set", product_catalog: { id: owner }, ...params } : { kind: KIND[edge]!, account_id: "555", ...parsed(params) };
    return J({ id });
  }
  if (path === "act_555") return J({ id: "act_555", business: { id: "900" } });
  if (path === "900/owned_product_catalogs") return J({ data: catalogs });
  if (path === "900/client_product_catalogs") return J({ data: [] });
  if (path === "act_555/campaigns") return list((o) => o.kind === "campaign" && o.account_id === "555");
  if (path === "act_555/adcreatives") return list((o) => o.kind === "creative" && o.account_id === "555");
  if (path === "act_555/promote_pages") return J({ data: [{ id: "700001" }] });
  if (path === "act_555/instagram_accounts") return J({ data: [{ id: "178001" }] });
  let m = path.match(/^(\d+)\/product_sets$/);
  if (m) return list((o) => o.kind === "product_set" && (o.product_catalog as { id: string }).id === m![1]);
  m = path.match(/^(\d+)\/external_event_sources$/);
  if (m) return J({ data: eventSources[m[1]!] ?? [] });
  m = path.match(/^(\d+)\/adsets$/);
  if (m) return list((o) => o.kind === "adset" && o.campaign_id === m![1]);
  m = path.match(/^(\d+)\/ads$/);
  if (m) return list((o) => o.kind === "ad" && o.adset_id === m![1]);
  const o = objs[path];
  return o ? J({ id: path, ...o }) : J({ error: { code: 100, error_subcode: 33, message: "does not exist" } }, 400);
};

let db: Db, deps: PipelineDeps, tenantId: string, owner: string, second: string, acct: string;
beforeAll(async () => {
  db = await testDb();
  const t = await seedTenant(db, "MCW", "owner");
  tenantId = t.tenant.id;
  owner = t.user.id;
  second = (await addUser(db, tenantId, "mcw-adm", "admin")).id;
  acct = (await seedAccount(db, tenantId, "meta_ads", "write", "active", "act_555", { currencyCode: "USD", timeZone: "America/New_York" })).id;
  deps = {
    db,
    registry: new ToolRegistry(loadInventory()).registerAll(allTools()),
    approvals: new ApprovalService(db),
    tenantLimiter: new RateLimiter(10_000, 10_000),
    accountLimiter: new RateLimiter(10_000, 10_000),
    createServices: createServicesFactory({ db, meta: { tokens: tokens as unknown as MetaTokenProvider, http: new MetaGraphHttp({ apiVersion: "v27.0", fetch: fake, sleep: async () => {} }) } }),
  };
});

const CAT = "300001";
const CAT2 = "300002";
const HOME = "300003";
let n = 0;
beforeEach(() => {
  posts = [];
  failOn = null;
  nextId = 900001 + 1000 * ++n;
  catalogs = [
    { id: CAT, name: "Shop", vertical: "commerce", product_count: 10 },
    { id: CAT2, name: "Second", vertical: "commerce", product_count: 5 },
    { id: HOME, name: "Homes", vertical: "home_listings", product_count: 3 },
    { id: "300004", name: "Hotels", vertical: "hotels" },
    { id: "300005", name: "No vertical" },
  ];
  eventSources = { [CAT]: [{ id: "800001" }], [HOME]: [{ id: "800001" }] };
  objs = {
    "310001": { kind: "product_set", product_catalog: { id: CAT }, name: "Shoes", filter: '{"product_type":{"i_contains":"shoe"}}' },
    "310002": { kind: "product_set", product_catalog: { id: CAT }, name: "All", filter: "{}" },
    "320001": { kind: "product_set", product_catalog: { id: CAT2 }, name: "Other", filter: "{}" },
    "330001": { kind: "product_set", product_catalog: { id: HOME }, name: "Listings", filter: "{}" },
    "340001": { kind: "product_set", product_catalog: { id: "399999" }, name: "Foreign set", filter: "{}" },
    "200001": { kind: "campaign", account_id: "555", name: "Catalog CBO", status: "PAUSED", objective: "OUTCOME_SALES", daily_budget: "5000", special_ad_categories: [] },
    "200002": { kind: "campaign", account_id: "555", name: "Web", status: "ACTIVE", objective: "OUTCOME_SALES", daily_budget: "5000", special_ad_categories: [] },
    "200003": { kind: "campaign", account_id: "555", name: "Catalog ABO", status: "ACTIVE", objective: "OUTCOME_SALES", special_ad_categories: [] },
    "200009": { kind: "campaign", account_id: "111", name: "Foreign", status: "ACTIVE", objective: "OUTCOME_SALES" },
    "600001": { kind: "adset", account_id: "555", campaign_id: "200001", name: "Shoes set", status: "PAUSED", promoted_object: { product_set_id: "310001", custom_event_type: "PURCHASE" } },
    "600002": { kind: "adset", account_id: "555", campaign_id: "200002", name: "Web set", status: "ACTIVE", promoted_object: { pixel_id: "800001", custom_event_type: "PURCHASE" } },
    "600003": { kind: "adset", account_id: "555", campaign_id: "200003", name: "ABO set", status: "PAUSED", daily_budget: "2000", promoted_object: { product_set_id: "310002" } },
    "500001": { kind: "ad", account_id: "555", adset_id: "600001", name: "Catalog ad", status: "PAUSED" },
    "500002": { kind: "ad", account_id: "555", adset_id: "600002", name: "Web ad", status: "ACTIVE" },
  };
});

const run = (name: string, args: Record<string, unknown>) => runTool(deps, deps.registry.get(name)!, { account_id: acct, ...args }, { tenantId, userId: owner, role: "owner", scopes: ["ads:read", "ads:write"] });
const approve = (id: string, by = second) => deps.approvals.decide({ tenantId, approvalId: id, decider: { userId: by, role: by === owner ? "owner" : "admin" }, decision: "approve", execute: createExecutor(deps) });
const planned = async (name: string, args: Record<string, unknown>) => {
  const r = await run(name, args);
  if (!r.approval) throw new Error(`no approval: ${JSON.stringify(r.error)}`);
  return r.approval;
};
const refused = async (name: string, args: Record<string, unknown>) => {
  const r = await run(name, args);
  expect(r.approval, JSON.stringify(r)).toBeUndefined();
  return r.error as { code: string; message: string };
};
const errMsg = (d: { result?: unknown }) => (d.result as { error: { message: string } }).error.message;
const ctx = async () => ({ tenantId, userId: owner, account: null, signal: new AbortController().signal, services: await deps.createServices({ tenantId, account: { platform: "meta_ads", externalId: "act_555", id: acct, loginCustomerId: null, connectionId: "x", currencyCode: "USD" } }) });
const verify = async (name: string, args: Record<string, unknown>) => {
  const tool = deps.registry.get(name)!;
  if (tool.kind !== "write") throw new Error("write tool expected");
  return tool.verify(tool.input.parse({ account_id: acct, ...args }), (await ctx()) as never, { snapshot: null });
};

describe("permissions and registration", () => {
  it("declares exactly what each catalog write needs", () => {
    const p = (n: string) => deps.registry.get(n)!.permissions.platformPermissions;
    expect(p("create_meta_product_set")).toEqual(["business_management", "catalog_management"]);
    expect(p("create_meta_catalog_campaign")).toEqual(["ads_management", "business_management", "catalog_management", "pages_manage_ads"]);
    expect(p("add_meta_catalog_ad")).toEqual(["ads_management", "business_management", "catalog_management", "pages_manage_ads"]);
    expect(p("add_meta_catalog_ad_set")).toEqual(["ads_management", "business_management", "catalog_management"]);
    for (const t of ["update_meta_catalog_campaign", "update_meta_catalog_ad_set", "update_meta_catalog_ad"]) expect(p(t), t).toEqual(["ads_management"]);
  });
});

// ------------------------------------------------------------------------------------------------ create_meta_product_set
describe("create_meta_product_set", () => {
  const args = (over: Record<string, unknown> = {}) => ({ catalog_id: CAT, name: `Bags ${n}`, filter: { field: "product_type", operator: "i_contains", value: "bag" }, ...over });

  it("plans as a one-approver write, posts name and the documented filter once, and verifies by name", async () => {
    const ap = await planned("create_meta_product_set", args());
    expect(ap.risk).toBe("write");
    expect(posts).toHaveLength(0);
    const done = await approve(ap.approval_id, owner);
    expect(done.status).toBe("executed");
    expect(posts).toEqual([{ path: `${CAT}/product_sets`, params: expect.objectContaining({ name: `Bags ${n}`, filter: '{"product_type":{"i_contains":"bag"}}' }) }]);
    expect(await verify("create_meta_product_set", args())).toEqual({ outcome: "applied" });
  });

  it("sends {} for a set of every item and is_any lists as arrays", async () => {
    objs["310002"]!.filter = '{"brand":{"eq":"x"}}';
    await approve((await planned("create_meta_product_set", args({ filter: undefined }))).approval_id, owner);
    expect(posts[0]!.params.filter).toBe("{}");
    posts = [];
    await approve((await planned("create_meta_product_set", args({ name: `Ids ${n}`, filter: { field: "retailer_id", operator: "is_any", value: ["pid1", "pid2"] } }))).approval_id, owner);
    expect(JSON.parse(posts[0]!.params.filter!)).toEqual({ retailer_id: { is_any: ["pid1", "pid2"] } });
  });

  it("refuses a used name, the same filter as an existing set, and undocumented filter shapes", async () => {
    expect((await refused("create_meta_product_set", args({ name: "shoes" }))).message).toMatch(/already exists/);
    const same = await refused("create_meta_product_set", args({ filter: { field: "product_type", operator: "i_contains", value: "shoe" } }));
    expect(same.message).toMatch(/same filter already exists: "Shoes" \(310001\)/);
    expect((await refused("create_meta_product_set", args({ filter: { field: "availability", operator: "contains", value: "in stock" } }))).code).toBe("invalid_argument");
    expect((await refused("create_meta_product_set", args({ filter: { field: "availability", operator: "eq", value: "maybe" } }))).code).toBe("invalid_argument");
    expect((await refused("create_meta_product_set", args({ filter: { field: "retailer_id", operator: "is_any", value: "pid1" } }))).code).toBe("invalid_argument");
    expect((await refused("create_meta_product_set", args({ filter: { field: "price", operator: "lt", value: "10" } }))).code).toBe("invalid_argument");
    expect(posts).toHaveLength(0);
  });

  it("refuses a catalog outside the ad account's business", async () => {
    expect((await refused("create_meta_product_set", args({ catalog_id: "399999" }))).code).toBe("not_found");
  });

  it("maps Meta error 10803 to a clear definite failure, sent once", async () => {
    failOn = { edge: "product_sets", mode: "10803" };
    const done = await approve((await planned("create_meta_product_set", args())).approval_id, owner);
    expect(done.status).toBe("failed");
    expect(errMsg(done)).toMatch(/same filter already exists\. Meta allows one set per filter/);
    expect(posts).toHaveLength(1);
  });

  it("verify(): none and ambiguous", async () => {
    expect(await verify("create_meta_product_set", args())).toEqual({ outcome: "not_applied" });
    objs["319001"] = { kind: "product_set", product_catalog: { id: CAT }, name: `Bags ${n}` };
    objs["319002"] = { kind: "product_set", product_catalog: { id: CAT }, name: `Bags ${n}` };
    expect(await verify("create_meta_product_set", args())).toMatchObject({ outcome: "indeterminate", detail: expect.stringMatching(/ambiguous: 2 product sets/) });
  });
});

// ------------------------------------------------------------------------------------------- create_meta_catalog_campaign
const tpl = { link: "https://shop.example/", message: "{{product.name | titleize}} now {{product.price}}", headline: "{{product.name}}", description: "{{product.description}}", call_to_action: "SHOP_NOW" };
const camp = (over: Record<string, unknown> = {}) => ({
  catalog_id: CAT,
  campaign_name: `Catalog ${n}`,
  budget: { level: "campaign", type: "daily", amount: 50 },
  ad_set_name: `Catalog set ${n}`,
  product_set_id: "310001",
  optimization_goal: "OFFSITE_CONVERSIONS",
  targeting: { countries: ["US"] },
  ad_name: `Catalog ad ${n}`,
  page_id: "700001",
  template: tpl,
  ...over,
});

describe("create_meta_catalog_campaign", () => {
  it("creates campaign -> ad set -> template creative -> ad, all PAUSED, after a second approval; exact params", async () => {
    const ap = await planned("create_meta_catalog_campaign", camp());
    expect(ap.risk).toBe("high_impact");
    expect(posts).toHaveLength(0);
    await expect(approve(ap.approval_id, owner)).rejects.toMatchObject({ code: "permission_denied" });
    const done = await approve(ap.approval_id);
    expect(done.status).toBe("executed");
    expect(posts.map((p) => p.path)).toEqual(["act_555/campaigns", "act_555/adsets", "act_555/adcreatives", "act_555/ads"]);
    const [c, s, cr, ad] = posts.map((p) => p.params);
    expect(c).toMatchObject({ name: `Catalog ${n}`, objective: "OUTCOME_SALES", status: "PAUSED", special_ad_categories: "[]", promoted_object: `{"product_catalog_id":"${CAT}"}`, daily_budget: "5000", bid_strategy: "LOWEST_COST_WITHOUT_CAP" });
    expect(s).toMatchObject({ name: `Catalog set ${n}`, optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", status: "PAUSED", campaign_id: expect.stringMatching(/^\d+$/) });
    expect(JSON.parse(s!.promoted_object!)).toEqual({ product_set_id: "310001", custom_event_type: "PURCHASE" });
    expect(s!.daily_budget).toBeUndefined();
    expect(cr).toMatchObject({ name: `Catalog ad ${n}`, product_set_id: "310001" });
    expect(JSON.parse(cr!.object_story_spec!)).toEqual({ page_id: "700001", template_data: { link: "https://shop.example/", message: tpl.message, name: "{{product.name}}", description: "{{product.description}}", call_to_action: { type: "SHOP_NOW" } } });
    expect(ad).toMatchObject({ name: `Catalog ad ${n}`, status: "PAUSED" });
    expect(await verify("create_meta_catalog_campaign", camp())).toEqual({ outcome: "applied" });
  });

  it("uses LINK_CLICKS / LINK_CLICKS with a plain product set promoted_object and an ad set budget", async () => {
    await approve((await planned("create_meta_catalog_campaign", camp({ optimization_goal: "LINK_CLICKS", budget: { level: "ad_set", type: "daily", amount: 20 } }))).approval_id);
    const [c, s] = posts.map((p) => p.params);
    expect(c).toMatchObject({ is_adset_budget_sharing_enabled: "false" });
    expect(c!.daily_budget).toBeUndefined();
    expect(s).toMatchObject({ optimization_goal: "LINK_CLICKS", billing_event: "LINK_CLICKS", daily_budget: "2000" });
    expect(JSON.parse(s!.promoted_object!)).toEqual({ product_set_id: "310001" });
  });

  it("refuses undocumented goal pairs and OFFSITE_CONVERSIONS without a connected event source", async () => {
    expect((await refused("create_meta_catalog_campaign", camp({ optimization_goal: "REACH" }))).code).toBe("invalid_argument");
    eventSources[CAT] = [];
    expect((await refused("create_meta_catalog_campaign", camp())).message).toMatch(/no connected pixel or app/);
    expect(posts).toHaveLength(0);
  });

  it("checks catalog, product set and Page ownership", async () => {
    expect((await refused("create_meta_catalog_campaign", camp({ catalog_id: "399999" }))).code).toBe("not_found");
    expect((await refused("create_meta_catalog_campaign", camp({ product_set_id: "320001" }))).code).toBe("not_found");
    expect((await refused("create_meta_catalog_campaign", camp({ page_id: "700009" }))).code).toBe("not_found");
    expect(posts).toHaveLength(0);
  });

  it("accepts only documented template tags for the catalog's vertical", async () => {
    expect((await refused("create_meta_catalog_campaign", camp({ template: { ...tpl, message: "Buy {{product.url}}" } }))).message).toMatch(/not one documented for commerce/);
    expect((await refused("create_meta_catalog_campaign", camp({ template: { ...tpl, headline: "{{product.name" } }))).message).toMatch(/unbalanced/);
    expect((await refused("create_meta_catalog_campaign", camp({ template: { ...tpl, call_to_action: "LEARN_MORE" } }))).code).toBe("invalid_argument");
  });

  it("home listing catalogs need HOUSING, which restricts targeting; other or unknown verticals are refused", async () => {
    const home = { catalog_id: HOME, product_set_id: "330001", template: { link: "https://homes.example/", message: "{{home_listing.num_beds}} beds, {{home_listing.price strip_zeros}}", headline: "{{home_listing.name | titleize}}" } };
    expect((await refused("create_meta_catalog_campaign", camp(home))).message).toMatch(/HOUSING/);
    expect((await refused("create_meta_catalog_campaign", camp({ ...home, special_ad_categories: ["HOUSING"], targeting: { countries: ["US"], interests: ["6003107902433"] } }))).code).toBe("invalid_argument");
    await approve((await planned("create_meta_catalog_campaign", camp({ ...home, special_ad_categories: ["HOUSING"] }))).approval_id);
    expect(posts[0]!.params.special_ad_categories).toBe('["HOUSING"]');
    expect((await refused("create_meta_catalog_campaign", camp({ catalog_id: "300004" }))).message).toMatch(/hotels catalog/);
    expect((await refused("create_meta_catalog_campaign", camp({ catalog_id: "300005" }))).message).toMatch(/did not return the vertical/);
  });

  it("refuses a used name at plan time, and re-checks at execution (drift): nothing is sent", async () => {
    objs["201001"] = { kind: "campaign", account_id: "555", name: `catalog ${n}`, status: "PAUSED" };
    expect((await refused("create_meta_catalog_campaign", camp())).message).toMatch(/campaign named/);
    delete objs["201001"];
    const ap = await planned("create_meta_catalog_campaign", camp());
    objs["201002"] = { kind: "creative", account_id: "555", name: `Catalog ad ${n}` };
    const done = await approve(ap.approval_id);
    expect(done.status).toBe("failed");
    expect(posts).toHaveLength(0);
  });

  it("partial failure at each step lists the ids created so far; never retried or deleted", async () => {
    for (const [edge, created, missing] of [
      ["adsets", ["campaign"], "ad set, creative, ad"],
      ["adcreatives", ["campaign", "ad set"], "creative, ad"],
      ["ads", ["campaign", "ad set", "creative"], "ad"],
    ] as const) {
      posts = [];
      failOn = { edge, mode: "definite" };
      const done = await approve((await planned("create_meta_catalog_campaign", camp({ campaign_name: `P ${edge} ${n}`, ad_name: `P ad ${edge} ${n}` }))).approval_id);
      expect(done.status).toBe("unknown_outcome");
      const msg = errMsg(done);
      for (const label of created) expect(msg).toMatch(new RegExp(`${label} \\d+`));
      expect(msg).toContain(`Not created: ${missing}`);
      expect(posts).toHaveLength(created.length + 1);
    }
    posts = [];
    failOn = { edge: "campaigns", mode: "transient" };
    const first = await approve((await planned("create_meta_catalog_campaign", camp({ campaign_name: `T ${n}`, ad_name: `T ad ${n}` }))).approval_id);
    expect(first.status).toBe("unknown_outcome");
    expect(posts).toHaveLength(1);
  });

  it("verify(): none, partial, applied and ambiguous", async () => {
    expect(await verify("create_meta_catalog_campaign", camp())).toEqual({ outcome: "not_applied" });
    failOn = { edge: "adcreatives", mode: "definite" };
    await approve((await planned("create_meta_catalog_campaign", camp())).approval_id);
    expect(await verify("create_meta_catalog_campaign", camp())).toMatchObject({ outcome: "indeterminate", detail: expect.stringMatching(/partial: exists campaign \d+, ad set \d+; missing creative, ad/) });
    objs["209999"] = { kind: "campaign", account_id: "555", name: `Catalog ${n}` };
    expect(await verify("create_meta_catalog_campaign", camp())).toMatchObject({ outcome: "indeterminate", detail: expect.stringMatching(/ambiguous: 2 campaigns/) });
  });
});

// ------------------------------------------------------------------------------------------- add_meta_catalog_ad_set / ad
describe("add_meta_catalog_ad_set", () => {
  const set = (over: Record<string, unknown> = {}) => ({ campaign_id: "200001", ad_set_name: `More ${n}`, product_set_id: "310002", optimization_goal: "LINK_CLICKS", targeting: { countries: ["GB"] }, ...over });

  it("adds a PAUSED ad set for a product set of the campaign's catalog, after a second approval", async () => {
    const ap = await planned("add_meta_catalog_ad_set", set());
    expect(ap.risk).toBe("high_impact");
    expect(posts).toHaveLength(0);
    expect((await approve(ap.approval_id)).status).toBe("executed");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.params).toMatchObject({ campaign_id: "200001", name: `More ${n}`, status: "PAUSED", optimization_goal: "LINK_CLICKS", billing_event: "LINK_CLICKS", promoted_object: '{"product_set_id":"310002"}' });
    expect(posts[0]!.params.daily_budget).toBeUndefined();
    expect(await verify("add_meta_catalog_ad_set", set())).toEqual({ outcome: "applied" });
  });

  it("refuses a product set of another catalog, a campaign without catalog ad sets, and foreign ids", async () => {
    expect((await refused("add_meta_catalog_ad_set", set({ product_set_id: "320001" }))).message).toMatch(/is in catalog 300002, but the campaign promotes catalog 300001/);
    expect((await refused("add_meta_catalog_ad_set", set({ campaign_id: "200002" }))).message).toMatch(/no catalog ad set/);
    expect((await refused("add_meta_catalog_ad_set", set({ campaign_id: "200009" }))).code).toBe("not_found");
    expect((await refused("add_meta_catalog_ad_set", set({ product_set_id: "340001" }))).code).toBe("not_found");
    expect((await refused("add_meta_catalog_ad_set", set({ ad_set_name: "shoes SET" }))).message).toMatch(/already exists/);
    expect(posts).toHaveLength(0);
  });

  it("follows the campaign's budget level", async () => {
    expect((await refused("add_meta_catalog_ad_set", set({ budget: { type: "daily", amount: 10 } }))).message).toMatch(/campaign budget/);
    expect((await refused("add_meta_catalog_ad_set", set({ campaign_id: "200003" }))).message).toMatch(/give the ad set a daily or lifetime budget/);
    await approve((await planned("add_meta_catalog_ad_set", set({ campaign_id: "200003", budget: { type: "daily", amount: 10 } }))).approval_id);
    expect(posts[0]!.params).toMatchObject({ daily_budget: "1000", bid_strategy: "LOWEST_COST_WITHOUT_CAP" });
  });
});

describe("add_meta_catalog_ad", () => {
  const ad = (over: Record<string, unknown> = {}) => ({ ad_set_id: "600001", ad_name: `New ad ${n}`, page_id: "700001", template: tpl, ...over });

  it("creates a template creative for the ad set's product set, then a PAUSED ad", async () => {
    const ap = await planned("add_meta_catalog_ad", ad());
    expect(ap.risk).toBe("high_impact");
    expect(posts).toHaveLength(0);
    expect((await approve(ap.approval_id)).status).toBe("executed");
    expect(posts.map((p) => p.path)).toEqual(["act_555/adcreatives", "act_555/ads"]);
    expect(posts[0]!.params).toMatchObject({ name: `New ad ${n}`, product_set_id: "310001" });
    expect(posts[1]!.params).toMatchObject({ adset_id: "600001", status: "PAUSED" });
    expect(await verify("add_meta_catalog_ad", ad())).toEqual({ outcome: "applied" });
  });

  it("refuses a non-catalog or foreign ad set and undocumented tags", async () => {
    expect((await refused("add_meta_catalog_ad", ad({ ad_set_id: "600002" }))).message).toMatch(/not a catalog ad set/);
    expect((await refused("add_meta_catalog_ad", ad({ ad_set_id: "699999" }))).code).toBe("not_found");
    expect((await refused("add_meta_catalog_ad", ad({ template: { ...tpl, message: "{{home_listing.num_beds}}" } }))).code).toBe("invalid_argument");
  });

  it("reports the creative id when the ad step fails, and verify() says partial", async () => {
    failOn = { edge: "ads", mode: "definite" };
    const done = await approve((await planned("add_meta_catalog_ad", ad())).approval_id);
    expect(done.status).toBe("unknown_outcome");
    expect(errMsg(done)).toMatch(/Created \(all PAUSED, nothing spends\): creative \d+/);
    expect(posts).toHaveLength(2);
    expect(await verify("add_meta_catalog_ad", ad())).toMatchObject({ outcome: "indeterminate", detail: expect.stringMatching(/partial: exists creative \d+; missing ad/) });
  });
});

// ---------------------------------------------------------------------------------------------------------- updates
describe("catalog updates", () => {
  it("update_meta_catalog_campaign: rename is a write, activation needs a second approver, landed by read-back", async () => {
    const ren = await planned("update_meta_catalog_campaign", { campaign_id: "200001", name: `Renamed ${n}` });
    expect(ren.risk).toBe("write");
    expect(posts).toHaveLength(0);
    expect((await approve(ren.approval_id, owner)).status).toBe("executed");
    expect(posts).toEqual([{ path: "200001", params: expect.objectContaining({ name: `Renamed ${n}` }) }]);
    expect(objs["200001"]!.name).toBe(`Renamed ${n}`);
    const act = await planned("update_meta_catalog_campaign", { campaign_id: "200001", status: "ACTIVE" });
    expect(act.risk).toBe("high_impact");
    expect((await planned("update_meta_catalog_campaign", { campaign_id: "200001", daily_budget: 80 })).risk).toBe("high_impact");
    expect((await planned("update_meta_catalog_campaign", { campaign_id: "200001", daily_budget: 20 })).risk).toBe("write");
    expect((await planned("update_meta_catalog_campaign", { campaign_id: "200001", spend_cap: 500 })).risk).toBe("write");
  });

  it("refuses non-catalog and foreign campaigns, no-op changes and fields it does not offer", async () => {
    expect((await refused("update_meta_catalog_campaign", { campaign_id: "200002", name: "x" })).message).toMatch(/not a catalog campaign/);
    expect((await refused("update_meta_catalog_campaign", { campaign_id: "200009", name: "x" })).code).toBe("not_found");
    expect((await refused("update_meta_catalog_campaign", { campaign_id: "200001", name: "Catalog CBO" })).message).toMatch(/Nothing would change/);
    expect((await refused("update_meta_catalog_campaign", { campaign_id: "200001", bid_strategy: "LOWEST_COST_WITHOUT_CAP" })).code).toBe("invalid_argument");
    expect(posts).toHaveLength(0);
  });

  it("detects drift between plan and execution and sends nothing", async () => {
    const ap = await planned("update_meta_catalog_campaign", { campaign_id: "200001", name: `Drift ${n}` });
    objs["200001"]!.status = "ACTIVE";
    const done = await approve(ap.approval_id, owner);
    expect(done.status).toBe("failed");
    expect(errMsg(done)).toMatch(/changed since this was requested/);
    expect(posts).toHaveLength(0);
  });

  it("update_meta_catalog_ad_set: budget raise is high impact, the product set cannot change, non-catalog refused", async () => {
    const up = await planned("update_meta_catalog_ad_set", { ad_set_id: "600003", daily_budget: 30 });
    expect(up.risk).toBe("high_impact");
    expect((await approve(up.approval_id)).status).toBe("executed");
    expect(posts).toEqual([{ path: "600003", params: expect.objectContaining({ daily_budget: "3000" }) }]);
    expect((await planned("update_meta_catalog_ad_set", { ad_set_id: "600003", status: "PAUSED", name: `S ${n}` })).risk).toBe("write");
    expect((await refused("update_meta_catalog_ad_set", { ad_set_id: "600003", product_set_id: "310001" })).code).toBe("invalid_argument");
    expect((await refused("update_meta_catalog_ad_set", { ad_set_id: "600002", name: "x" })).message).toMatch(/not a catalog ad set/);
    expect(deps.registry.get("update_meta_catalog_ad_set")!.description).toMatch(/promoted_object is immutable/);
  });

  it("update_meta_catalog_ad: pause is a write, activation high impact, non-catalog ads refused", async () => {
    objs["500001"]!.status = "ACTIVE";
    const p = await planned("update_meta_catalog_ad", { ad_id: "500001", status: "PAUSED" });
    expect(p.risk).toBe("write");
    expect((await approve(p.approval_id, owner)).status).toBe("executed");
    expect(objs["500001"]!.status).toBe("PAUSED");
    expect((await planned("update_meta_catalog_ad", { ad_id: "500001", status: "ACTIVE" })).risk).toBe("high_impact");
    expect((await refused("update_meta_catalog_ad", { ad_id: "500002", status: "PAUSED" })).message).toMatch(/not a catalog ad/);
  });

  it("verify(): applied after the change, not_applied before", async () => {
    const args = { ad_id: "500001", name: `V ${n}` };
    const tool = deps.registry.get("update_meta_catalog_ad")!;
    if (tool.kind !== "write") throw new Error("write tool expected");
    const before = await (tool as unknown as { plan: (a: unknown, c: unknown) => Promise<{ snapshot: unknown }> }).plan(tool.input.parse({ account_id: acct, ...args }), await ctx());
    expect(await tool.verify(tool.input.parse({ account_id: acct, ...args }), (await ctx()) as never, { snapshot: before.snapshot })).toEqual({ outcome: "not_applied" });
    objs["500001"]!.name = `V ${n}`;
    expect(await tool.verify(tool.input.parse({ account_id: acct, ...args }), (await ctx()) as never, { snapshot: before.snapshot })).toEqual({ outcome: "applied" });
  });
});
