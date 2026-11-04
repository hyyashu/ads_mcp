import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

const C = "customers/1234567890";
type N = { id: string; parent: string | null; type: string; negative?: boolean; bid?: string; caseValue?: any; status: string };
let pg: N[];
let lf: N[];
let links: { mc: string }[];
let invites: { resource: string; status: string; mc: string }[];
let rpcs: { path: string; body: any }[];
let mutates: any[][];
let nextId = 100;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

/** Applies tree operations like Google does: temporary ids resolved in order; removing a node removes its subtree. */
function apply(tree: N[], ops: any[], key: "adGroupCriterionOperation" | "assetGroupListingGroupFilterOperation") {
  const tmp = new Map<string, string>();
  const id = (rn: string) => {
    const t = rn.split("~").pop()!;
    return t.startsWith("-") ? tmp.get(t)! : t;
  };
  const removeTree = (nid: string) => {
    for (const c of tree.filter((n) => n.parent === nid && n.status !== "REMOVED")) removeTree(c.id);
    tree.find((n) => n.id === nid)!.status = "REMOVED";
  };
  for (const op of ops) {
    const o = op[key];
    if (!o) continue;
    if (o.remove) removeTree(id(o.remove));
    else if (o.update) tree.find((n) => n.id === id(o.update.resourceName))!.bid = o.update.cpcBidMicros;
    else if (o.create) {
      const real = String(nextId++);
      tmp.set(o.create.resourceName.split("~").pop(), real);
      const lg = o.create.listingGroup;
      const parentRn = lg ? lg.parentAdGroupCriterion : o.create.parentListingGroupFilter;
      tree.push({ id: real, parent: parentRn ? id(parentRn) : null, type: lg ? lg.type : o.create.type, negative: o.create.negative, bid: o.create.cpcBidMicros, caseValue: lg ? lg.caseValue : o.create.caseValue, status: "ENABLED" });
    }
  }
}

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    if (q.includes("FROM ad_group_criterion")) return J({ results: pg.filter((n) => n.status !== "REMOVED").map((n) => ({ adGroupCriterion: { criterionId: n.id, negative: !!n.negative, ...(n.bid ? { cpcBidMicros: n.bid } : {}), listingGroup: { type: n.type, ...(n.parent ? { parentAdGroupCriterion: `${C}/adGroupCriteria/41~${n.parent}` } : {}), ...(n.caseValue ? { caseValue: n.caseValue } : {}) } } })) });
    if (q.includes("FROM ad_group")) return J({ results: q.includes("ad_group.id = 41") ? [{ adGroup: { id: "41", name: "Shop group", type: "SHOPPING_PRODUCT_ADS", status: "ENABLED" } }] : [{ adGroup: { id: "21", name: "Search", type: "SEARCH_STANDARD" } }] });
    if (q.includes("FROM asset_group_listing_group_filter")) return J({ results: lf.filter((n) => n.status !== "REMOVED").map((n) => ({ assetGroupListingGroupFilter: { id: n.id, type: n.type, listingSource: "SHOPPING", ...(n.parent ? { parentListingGroupFilter: `${C}/assetGroupListingGroupFilters/901~${n.parent}` } : {}), ...(n.caseValue ? { caseValue: n.caseValue } : {}) } })) });
    if (q.includes("FROM asset_group")) return J({ results: [{ assetGroup: { id: "901", name: "Shoes" }, campaign: { advertisingChannelType: "PERFORMANCE_MAX" } }] });
    if (q.includes("FROM product_link_invitation")) return J({ results: invites.map((i) => ({ productLinkInvitation: { resourceName: i.resource, status: i.status, merchantCenter: { merchantCenterId: i.mc } } })) });
    if (q.includes("FROM product_link")) return J({ results: links.map((l) => ({ productLink: { resourceName: `${C}/productLinks/${l.mc}`, productLinkId: l.mc, merchantCenter: { merchantCenterId: l.mc } } })) });
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    apply(pg, body.mutateOperations, "adGroupCriterionOperation");
    apply(lf, body.mutateOperations, "assetGroupListingGroupFilterOperation");
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  rpcs.push({ path, body });
  if (path.endsWith("productLinks:create")) links.push({ mc: body.productLink.merchantCenter.merchantCenterId });
  else if (path.endsWith("productLinkInvitations:update")) {
    const inv = invites.find((i) => i.resource === body.resourceName)!;
    inv.status = "ACCEPTED";
    links.push({ mc: inv.mc });
  } else if (path.endsWith("productLinks:remove")) links = links.filter((l) => `${C}/productLinks/${l.mc}` !== body.resourceName);
  return J({});
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("LT", fake);
});
beforeEach(() => {
  pg = [{ id: "1", parent: null, type: "UNIT", bid: "1000000", status: "ENABLED" }];
  lf = [];
  links = [];
  invites = [{ resource: `${C}/productLinkInvitations/5`, status: "PENDING_APPROVAL", mc: "777" }];
  rpcs = [];
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
const live = (t: N[]) => t.filter((n) => n.status !== "REMOVED");

describe("Shopping product groups", () => {
  it("splitting the all-products unit removes it and creates subdivision + Other + values in one request", async () => {
    const { r } = await exec("add_product_group", { ad_group_id: "41", parent_criterion_id: "1", split: { dimension: "brand" }, values: ["Acme", "Zenith"], cpc_bid: 2 }, kit.second);
    expect(r.approval?.risk).toBe("high_impact"); // the new groups bid above the old unit's 1.00
    const ops = mutates[0]!.map((o: any) => o.adGroupCriterionOperation);
    expect(ops[0]).toEqual({ remove: `${C}/adGroupCriteria/41~1` });
    expect(ops[1].create).toMatchObject({ resourceName: `${C}/adGroupCriteria/41~-1`, listingGroup: { type: "SUBDIVISION" } });
    expect(ops[2].create).toMatchObject({ listingGroup: { type: "UNIT", parentAdGroupCriterion: `${C}/adGroupCriteria/41~-1`, caseValue: { productBrand: {} } }, cpcBidMicros: "1000000" }); // Other keeps the old bid
    expect(ops[3].create).toMatchObject({ listingGroup: { caseValue: { productBrand: { value: "Acme" } } }, cpcBidMicros: "2000000" });
    expect(live(pg)).toHaveLength(4);
  });

  it("adds values to an existing split, refuses a different dimension, and updates bids", async () => {
    await exec("add_product_group", { ad_group_id: "41", parent_criterion_id: "1", split: { dimension: "condition" }, values: ["NEW"], cpc_bid: 1.5 }, kit.second);
    const sub = live(pg).find((n) => n.type === "SUBDIVISION")!.id;
    expect((await run("add_product_group", { ad_group_id: "41", parent_criterion_id: sub, split: { dimension: "brand" }, values: ["Acme"], cpc_bid: 1 })).error?.message).toContain("split on condition");
    expect((await run("add_product_group", { ad_group_id: "41", parent_criterion_id: sub, split: { dimension: "condition" }, values: ["BROKEN"], cpc_bid: 1 })).error?.message).toContain("NEW, USED, REFURBISHED");
    await exec("add_product_group", { ad_group_id: "41", parent_criterion_id: sub, split: { dimension: "condition" }, values: ["USED"], exclude: true });
    const used = live(pg).find((n) => n.caseValue?.productCondition?.condition === "USED")!;
    expect(used.negative).toBe(true);
    const newer = live(pg).find((n) => n.caseValue?.productCondition?.condition === "NEW")!;
    const up = await run("update_product_group", { ad_group_id: "41", criterion_id: newer.id, cpc_bid: 3 });
    expect(up.approval?.risk).toBe("high_impact");
    expect((await approve(up.approval!.approval_id, kit.second)).result).toEqual({ criterion_id: newer.id, excluded: false, cpc_bid: 3 });
    const incl = await run("update_product_group", { ad_group_id: "41", criterion_id: used.id, excluded: false, cpc_bid: 0.5 });
    expect((await approve(incl.approval!.approval_id, kit.second)).result).toMatchObject({ excluded: false, cpc_bid: 0.5 });
  });

  it("remove: a value group disappears; a subdivision collapses at a bid; Other and root are refused", async () => {
    await exec("add_product_group", { ad_group_id: "41", parent_criterion_id: "1", split: { dimension: "brand" }, values: ["Acme"], cpc_bid: 2 }, kit.second);
    const acme = live(pg).find((n) => n.caseValue?.productBrand?.value === "Acme")!;
    const other = live(pg).find((n) => n.caseValue?.productBrand && !n.caseValue.productBrand.value)!;
    const root = live(pg).find((n) => !n.parent)!;
    expect((await run("remove_product_group", { ad_group_id: "41", criterion_id: other.id })).error?.message).toContain("'Other'");
    expect((await run("remove_product_group", { ad_group_id: "41", criterion_id: root.id })).error?.message).toContain("root");
    await exec("remove_product_group", { ad_group_id: "41", criterion_id: acme.id }, kit.second);
    expect(live(pg).some((n) => n.id === acme.id)).toBe(false);
    expect((await run("add_product_group", { ad_group_id: "21", parent_criterion_id: "1", split: { dimension: "brand" }, values: ["X"], cpc_bid: 1 })).error?.message).toContain("Standard Shopping");
  });
});

describe("Performance Max listing filters", () => {
  it("an asset group without filters gets a root subdivision, Other and the values", async () => {
    await exec("add_asset_group_listing_filter", { asset_group_id: "901", split: { dimension: "product_type", level: 1 }, values: ["Shoes"], exclude_other: true });
    const ops = mutates[0]!.map((o: any) => o.assetGroupListingGroupFilterOperation.create);
    expect(ops[0]).toMatchObject({ type: "SUBDIVISION", listingSource: "SHOPPING", resourceName: `${C}/assetGroupListingGroupFilters/901~-1` });
    expect(ops[1]).toMatchObject({ type: "UNIT_EXCLUDED", caseValue: { productType: { level: "LEVEL1" } } });
    expect(ops[2]).toMatchObject({ type: "UNIT_INCLUDED", caseValue: { productType: { level: "LEVEL1", value: "Shoes" } } });
    const shoes = live(lf).find((n) => n.caseValue?.productType?.value === "Shoes")!;
    const rm = await run("remove_asset_group_listing_filter", { asset_group_id: "901", filter_id: shoes.id });
    expect(rm.approval?.risk).toBe("destructive");
    expect((await approve(rm.approval!.approval_id, kit.second)).status).toBe("executed");
    expect((await run("add_asset_group_listing_filter", { asset_group_id: "901", split: { dimension: "custom_attribute" }, values: ["x"] })).error?.code).toBe("invalid_argument");
  });
});

describe("Merchant Center links", () => {
  it("accepts a pending invitation when there is one, links directly otherwise, and unlinks", async () => {
    const { done } = await exec("link_merchant_center", { merchant_center_id: "777" }, kit.second);
    expect(done.result).toEqual({ merchant_center_id: "777", method: "accepted_invitation" });
    expect(rpcs[0]).toEqual({ path: "customers/1234567890/productLinkInvitations:update", body: { resourceName: `${C}/productLinkInvitations/5`, productLinkInvitationStatus: "ACCEPTED" } });
    const direct = await exec("link_merchant_center", { merchant_center_id: "888" }, kit.second);
    expect(direct.done.result).toMatchObject({ method: "direct_link" });
    expect(rpcs[1]).toEqual({ path: "customers/1234567890/productLinks:create", body: { productLink: { merchantCenter: { merchantCenterId: "888" } } } });
    expect((await run("link_merchant_center", { merchant_center_id: "888" })).error?.message).toContain("already linked");
    await exec("unlink_merchant_center", { merchant_center_id: "888" }, kit.second);
    expect(rpcs[2]).toEqual({ path: "customers/1234567890/productLinks:remove", body: { resourceName: `${C}/productLinks/888` } });
  });
});
