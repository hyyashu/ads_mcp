import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { type Change, type Effect, moneyChange } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, num, pick } from "../gaql";
import { tailId } from "./campaign-reads";
import { accountId, idSchema, str, toMicros } from "./common";
import { rn, stateWrite } from "./write-kit";

/**
 * Product partition trees: Standard Shopping product groups (ad_group_criterion listing groups) and Performance Max
 * listing group filters (asset_group_listing_group_filter). Rules from the v26 listing group guides (checked
 * 2026-11-04): creating a subdivision must create at least one child and an "Other" node in the same request, using
 * temporary negative ids (adGroupCriteria/{ad_group_id}~-1); existing nodes are referenced by their real ids; removing a
 * node removes its subtree. "Other" nodes have the dimension but no value; their dimension is taken from their siblings.
 */
const DIMENSIONS = ["brand", "item_id", "condition", "product_type", "custom_attribute"] as const;
type Dim = { kind: (typeof DIMENSIONS)[number]; level?: number; index?: number; value?: string };
const dimInput = z.object({ dimension: z.enum(DIMENSIONS), level: z.number().int().min(1).max(5).optional().describe("product_type level 1-5"), index: z.number().int().min(0).max(4).optional().describe("custom_attribute index 0-4 (custom_label_0..4)") }).refine((d) => (d.dimension === "product_type") === (d.level !== undefined) && (d.dimension === "custom_attribute") === (d.index !== undefined), "level only (and always) for product_type, index only (and always) for custom_attribute");
const valueSchema = z.string().trim().min(1).max(150).regex(/^[^\u0000-\u001f]+$/);
const CONDITIONS = ["NEW", "USED", "REFURBISHED"];

const sameDimType = (a: Dim, b: Dim) => a.kind === b.kind && a.level === b.level && a.index === b.index;
const dimLabel = (d: Dim | null) => (!d ? "all products" : `${d.kind}${d.level ? ` L${d.level}` : ""}${d.index !== undefined ? ` #${d.index}` : ""}=${d.value ?? "(other)"}`);
const dimKey = (d: Dim | null) => (!d ? "root" : `${d.kind}|${d.level ?? ""}|${d.index ?? ""}|${(d.value ?? "").toLowerCase()}`);

/** caseValue JSON for a dimension (same field names in both trees). */
function caseValue(d: Dim): Row {
  const v = d.value;
  if (d.kind === "brand") return { productBrand: v ? { value: v } : {} };
  if (d.kind === "item_id") return { productItemId: v ? { value: v } : {} };
  if (d.kind === "condition") return { productCondition: v ? { condition: v } : {} };
  if (d.kind === "product_type") return { productType: { level: `LEVEL${d.level}`, ...(v ? { value: v } : {}) } };
  return { productCustomAttribute: { index: `INDEX${d.index}`, ...(v ? { value: v } : {}) } };
}
function readDim(r: Row, cv: string): Dim | null {
  const p = (f: string) => pick(r, `${cv}.${f}`);
  if (p("product_brand.value") !== undefined) return { kind: "brand", value: String(p("product_brand.value")) };
  if (p("product_item_id.value") !== undefined) return { kind: "item_id", value: String(p("product_item_id.value")) };
  if (p("product_condition.condition") !== undefined) return { kind: "condition", value: String(p("product_condition.condition")) };
  if (p("product_type.level") !== undefined) return { kind: "product_type", level: Number(String(p("product_type.level")).replace("LEVEL", "")), ...(p("product_type.value") !== undefined ? { value: String(p("product_type.value")) } : {}) };
  if (p("product_custom_attribute.index") !== undefined) return { kind: "custom_attribute", index: Number(String(p("product_custom_attribute.index")).replace("INDEX", "")), ...(p("product_custom_attribute.value") !== undefined ? { value: String(p("product_custom_attribute.value")) } : {}) };
  return null; // root, or an "Other" node whose dimension is not reported
}
const caseFields = (cv: string) => [`${cv}.product_brand.value`, `${cv}.product_item_id.value`, `${cv}.product_condition.condition`, `${cv}.product_type.level`, `${cv}.product_type.value`, `${cv}.product_custom_attribute.index`, `${cv}.product_custom_attribute.value`];

interface Node {
  id: string;
  parent: string | null;
  subdivision: boolean;
  excluded: boolean;
  bid_micros: number | null;
  dim: Dim | null;
  other: boolean;
}
interface Tree {
  owner: { id: string; name: string | null };
  nodes: Node[];
}
/** Fills in "Other" nodes' dimension from their siblings and sorts nodes by id (stable snapshots). */
function finishTree(owner: Tree["owner"], nodes: Node[]): Tree {
  for (const n of nodes) {
    if (n.dim || !n.parent) continue;
    const sib = nodes.find((m) => m.parent === n.parent && m.dim && m.id !== n.id);
    if (sib?.dim) n.dim = { kind: sib.dim.kind, level: sib.dim.level, index: sib.dim.index };
    n.other = true;
  }
  for (const n of nodes) if (n.dim && n.parent && n.dim.value === undefined) n.other = true;
  return { owner, nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)) };
}
const childrenOf = (t: Tree, id: string) => t.nodes.filter((n) => n.parent === id);
const nodeOf = (t: Tree, id: string) => {
  const n = t.nodes.find((x) => x.id === id);
  if (!n) throw new ToolError("not_found", `No node ${id} in this tree.`);
  return n;
};

// --------------------------------------------------------------------------------------- product groups (Shopping)
async function readProductGroups(ads: GoogleAdsClient, adGroupId: string): Promise<Tree> {
  const [g] = await ads.query(new Gaql().select("ad_group.id", "ad_group.name", "ad_group.type", "ad_group.status").from("ad_group").where(`ad_group.id = ${lit.id(adGroupId)}`).limit(1), { maxRows: 1 });
  if (!g) throw new ToolError("not_found", `No ad group ${adGroupId} in this account.`);
  if (str(g, "ad_group.type") !== "SHOPPING_PRODUCT_ADS") throw new ToolError("invalid_argument", "Product groups belong to Standard Shopping ad groups (type SHOPPING_PRODUCT_ADS).");
  const c = "ad_group_criterion";
  const rows = await ads.query(new Gaql().select(`${c}.criterion_id`, `${c}.listing_group.type`, `${c}.listing_group.parent_ad_group_criterion`, `${c}.negative`, `${c}.cpc_bid_micros`, ...caseFields(`${c}.listing_group.case_value`)).from(c).where(`ad_group.id = ${lit.id(adGroupId)}`).where(`${c}.type = 'LISTING_GROUP'`).where(`${c}.status != 'REMOVED'`), { maxRows: 5000 });
  return finishTree(
    { id: adGroupId, name: str(g, "ad_group.name") },
    rows.map((r) => ({
      id: String(pick(r, `${c}.criterion_id`)),
      parent: tailId(pick(r, `${c}.listing_group.parent_ad_group_criterion`))?.split("~")[1] ?? null,
      subdivision: str(r, `${c}.listing_group.type`) === "SUBDIVISION",
      excluded: pick(r, `${c}.negative`) === true,
      bid_micros: pick(r, `${c}.cpc_bid_micros`) === undefined ? null : num(pick(r, `${c}.cpc_bid_micros`)),
      dim: readDim(r, `${c}.listing_group.case_value`),
      other: false,
    })),
  );
}
const pgRn = (ads: GoogleAdsClient, ag: string, id: string) => `customers/${ads.customerId}/adGroupCriteria/${ag}~${id}`;
function pgCreate(ads: GoogleAdsClient, ag: string, id: string, parent: string | null, n: { subdivision: boolean; dim: Dim | null; excluded?: boolean; bid?: number | null }): Row {
  return {
    adGroupCriterionOperation: {
      create: {
        resourceName: pgRn(ads, ag, id),
        adGroup: rn(ads, "adGroups", ag),
        status: "ENABLED",
        listingGroup: { type: n.subdivision ? "SUBDIVISION" : "UNIT", ...(parent ? { parentAdGroupCriterion: pgRn(ads, ag, parent) } : {}), ...(n.dim ? { caseValue: caseValue(n.dim) } : {}) },
        ...(n.excluded ? { negative: true } : !n.subdivision && n.bid ? { cpcBidMicros: String(n.bid) } : {}),
      },
    },
  };
}
const nodeRef = (t: Tree, n: Node | null, id: string) => ({ resource: "product_group", id, name: `${t.owner.name ?? t.owner.id}: ${dimLabel(n?.dim ?? null)}` });

export const addProductGroup = stateWrite({
  name: "add_product_group",
  title: "Subdivide product groups",
  risk: "write",
  description:
    "Splits a Standard Shopping product group by brand, item id, condition, product type (level 1-5) or custom label (0-4) into the given values plus an 'Other' group, or adds more values to a group already split on that dimension, after approval. New groups get cpc_bid (or are excluded); when a unit is split, its 'Other' group keeps the old bid unless other_cpc_bid is given. Applied atomically (Google requires the subdivision, its children and 'Other' in one request) and confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, parent_criterion_id: idSchema.describe("The product group to split (a unit), or a subdivision to add values to."), split: dimInput, values: z.array(valueSchema).min(1).max(100), cpc_bid: z.number().positive().max(10_000).optional(), exclude: z.boolean().default(false), other_cpc_bid: z.number().positive().max(10_000).optional() }).refine((v) => v.exclude || v.cpc_bid !== undefined, "give cpc_bid, or exclude: true"),
  output: z.object({ ad_group_id: z.string(), nodes: z.number() }),
  read: (a, ads) => readProductGroups(ads, a.ad_group_id),
  build: (a, t, ads) => {
    const parent = nodeOf(t, a.parent_criterion_id);
    const dimType = { kind: a.split.dimension, level: a.split.level, index: a.split.index } as Dim;
    if (dimType.kind === "condition" && a.values.some((v) => !CONDITIONS.includes(v))) throw new ToolError("invalid_argument", `condition values are ${CONDITIONS.join(", ")}.`);
    const dims = [...new Map(a.values.map((v) => [v.toLowerCase(), { ...dimType, value: v }])).values()];
    const bid = a.exclude ? null : toMicros(a.cpc_bid!);
    const ops: Row[] = [];
    const changes: Change[] = [];
    let tmp = -1;
    if (parent.subdivision) {
      const kids = childrenOf(t, parent.id);
      if (kids.some((k) => k.dim && !sameDimType(k.dim, dimType))) throw new ToolError("invalid_argument", `Product group ${parent.id} is split on ${dimLabel(kids[0]!.dim).split("=")[0]}, not ${a.split.dimension}.`);
      const fresh = dims.filter((d) => !kids.some((k) => dimKey(k.dim) === dimKey(d)));
      if (!fresh.length) throw new ToolError("invalid_argument", "Nothing would change: these values already have product groups.");
      for (const d of fresh) {
        ops.push(pgCreate(ads, a.ad_group_id, String(tmp--), parent.id, { subdivision: false, dim: d, excluded: a.exclude, bid }));
        changes.push(a.exclude ? { ...nodeRef(t, null, "new"), field: "product_group", before: null, after: `${dimLabel(d)} excluded`, unit: "text", effect: "pause" } : moneyChange(nodeRef(t, { ...parent, dim: d }, "new"), "cpc_bid", null, bid!));
      }
    } else {
      // Split a unit: remove it and recreate it as a subdivision with the new children and its "Other" node.
      const sub = String(tmp--);
      const otherBid = a.other_cpc_bid !== undefined ? toMicros(a.other_cpc_bid) : parent.bid_micros;
      if (parent.excluded) throw new ToolError("invalid_argument", "This product group is excluded; include it first (update_product_group) before splitting it.");
      ops.push({ adGroupCriterionOperation: { remove: pgRn(ads, a.ad_group_id, parent.id) } });
      ops.push(pgCreate(ads, a.ad_group_id, sub, parent.parent, { subdivision: true, dim: parent.dim }));
      ops.push(pgCreate(ads, a.ad_group_id, String(tmp--), sub, { subdivision: false, dim: { ...dimType, value: undefined }, bid: otherBid }));
      for (const d of dims) ops.push(pgCreate(ads, a.ad_group_id, String(tmp--), sub, { subdivision: false, dim: d, excluded: a.exclude, bid }));
      changes.push({ ...nodeRef(t, parent, parent.id), field: "split", before: dimLabel(parent.dim), after: `${dims.map(dimLabel).join(", ")} + other`, unit: "text", effect: "neutral" });
      for (const d of dims) changes.push(a.exclude ? { ...nodeRef(t, null, "new"), field: "product_group", before: null, after: `${dimLabel(d)} excluded`, unit: "text", effect: "pause" } : moneyChange(nodeRef(t, { ...parent, dim: d }, "new"), "cpc_bid", parent.bid_micros, bid!));
    }
    return { summary: `Ad group "${t.owner.name ?? a.ad_group_id}": ${parent.subdivision ? "add" : "split into"} ${dims.map(dimLabel).join(", ")}${a.exclude ? " (excluded)" : ` at ${a.cpc_bid}`}`, changes, ops };
  },
  landed: (a, _b, after) => a.values.every((v) => after.nodes.some((n) => n.dim && n.dim.kind === a.split.dimension && (n.dim.value ?? "").toLowerCase() === v.toLowerCase())),
  result: (a, after) => ({ ad_group_id: a.ad_group_id, nodes: after.nodes.length }),
});

export const updateProductGroup = stateWrite({
  name: "update_product_group",
  title: "Update product group bid or exclusion",
  risk: "write",
  description: "Changes a Standard Shopping product group's max CPC bid, or excludes / includes it again, after approval. Raising a bid or including a group again is high impact. Only unit (leaf) groups have bids. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, criterion_id: idSchema, cpc_bid: z.number().positive().max(10_000).optional(), excluded: z.boolean().optional() }).refine((v) => v.cpc_bid !== undefined || v.excluded !== undefined, "give cpc_bid or excluded").refine((v) => !(v.excluded === true && v.cpc_bid !== undefined), "an excluded group has no bid"),
  output: z.object({ criterion_id: z.string(), excluded: z.boolean(), cpc_bid: z.number().nullable() }),
  read: (a, ads) => readProductGroups(ads, a.ad_group_id),
  build: (a, t, ads) => {
    const n = nodeOf(t, a.criterion_id);
    if (n.subdivision) throw new ToolError("invalid_argument", "Subdivisions have no bid; change their unit (leaf) groups.");
    const ref = nodeRef(t, n, n.id);
    // Exclusion is fixed at creation: toggling it replaces the node under the same parent.
    if (a.excluded !== undefined && a.excluded !== n.excluded) {
      if (!a.excluded && a.cpc_bid === undefined) throw new ToolError("invalid_argument", "Including a group again needs a cpc_bid.");
      const bid = a.excluded ? null : toMicros(a.cpc_bid!);
      return {
        summary: `Product group ${dimLabel(n.dim)}: ${a.excluded ? "exclude" : `include again at ${a.cpc_bid}`}`,
        changes: [{ ...ref, field: "excluded", before: String(n.excluded), after: String(a.excluded), unit: "text", effect: a.excluded ? "pause" : "enable" }],
        ops: [{ adGroupCriterionOperation: { remove: pgRn(ads, a.ad_group_id, n.id) } }, pgCreate(ads, a.ad_group_id, "-1", n.parent, { subdivision: false, dim: n.dim, excluded: a.excluded, bid })],
      };
    }
    if (n.excluded) throw new ToolError("invalid_argument", "This group is excluded; include it again with excluded: false and a cpc_bid.");
    if (a.cpc_bid === undefined || toMicros(a.cpc_bid) === n.bid_micros) throw new ToolError("invalid_argument", "Nothing would change.");
    return { summary: `Product group ${dimLabel(n.dim)}: max CPC ${n.bid_micros === null ? "unset" : n.bid_micros / 1e6} -> ${a.cpc_bid}`, changes: [moneyChange(ref, "cpc_bid", n.bid_micros, toMicros(a.cpc_bid))], ops: [{ adGroupCriterionOperation: { update: { resourceName: pgRn(ads, a.ad_group_id, n.id), cpcBidMicros: String(toMicros(a.cpc_bid)) }, updateMask: "cpc_bid_micros" } }] };
  },
  landed: (a, b, after) => {
    const before = b.nodes.find((x) => x.id === a.criterion_id)!;
    const n = after.nodes.find((x) => (a.excluded !== undefined && a.excluded !== before.excluded ? dimKey(x.dim) === dimKey(before.dim) && x.parent === before.parent && x.id !== before.id : x.id === a.criterion_id));
    return !!n && (a.excluded === undefined || n.excluded === a.excluded) && (a.cpc_bid === undefined || n.bid_micros === toMicros(a.cpc_bid));
  },
  result: (a, after, _r, before) => {
    const old = before.nodes.find((x) => x.id === a.criterion_id)!;
    const n = after.nodes.find((x) => x.id === a.criterion_id) ?? after.nodes.find((x) => dimKey(x.dim) === dimKey(old.dim) && x.parent === old.parent)!;
    return { criterion_id: n.id, excluded: n.excluded, cpc_bid: n.bid_micros === null ? null : n.bid_micros / 1e6 };
  },
});

export const removeProductGroup = stateWrite({
  name: "remove_product_group",
  title: "Remove product group",
  risk: "destructive",
  description: "Removes a Standard Shopping product group after a person approves it. A value group is removed and its products fall into the 'Other' group. A subdivision is collapsed back into a single group at collapse_cpc_bid (its whole subtree is removed). 'Other' groups and the root cannot be removed. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, criterion_id: idSchema, collapse_cpc_bid: z.number().positive().max(10_000).optional() }),
  output: z.object({ ad_group_id: z.string(), nodes: z.number() }),
  read: (a, ads) => readProductGroups(ads, a.ad_group_id),
  build: (a, t, ads) => {
    const n = nodeOf(t, a.criterion_id);
    if (!n.parent) throw new ToolError("invalid_argument", "The root group cannot be removed (the ad group would advertise nothing).");
    if (n.other) throw new ToolError("invalid_argument", "An 'Other' group cannot be removed: every subdivision needs one.");
    const ref = nodeRef(t, n, n.id);
    if (!n.subdivision) return { summary: `Remove product group ${dimLabel(n.dim)}`, changes: [{ ...ref, field: "product_group", before: dimLabel(n.dim), after: null, unit: "text", effect: "remove" }], ops: [{ adGroupCriterionOperation: { remove: pgRn(ads, a.ad_group_id, n.id) } }] };
    if (a.collapse_cpc_bid === undefined) throw new ToolError("invalid_argument", "Collapsing a subdivision needs collapse_cpc_bid for the resulting group.");
    return {
      summary: `Collapse product group ${dimLabel(n.dim)} (and its ${t.nodes.filter((x) => x.parent === n.id).length} children) into one group at ${a.collapse_cpc_bid}`,
      changes: [{ ...ref, field: "subdivision", before: dimLabel(n.dim), after: `single group at ${a.collapse_cpc_bid}`, unit: "text", effect: "remove" }],
      ops: [{ adGroupCriterionOperation: { remove: pgRn(ads, a.ad_group_id, n.id) } }, pgCreate(ads, a.ad_group_id, "-1", n.parent, { subdivision: false, dim: n.dim, bid: toMicros(a.collapse_cpc_bid) })],
    };
  },
  landed: (a, b, after) => {
    const old = b.nodes.find((x) => x.id === a.criterion_id)!;
    if (after.nodes.some((x) => x.id === a.criterion_id)) return false;
    return !old.subdivision || after.nodes.some((x) => !x.subdivision && x.parent === old.parent && dimKey(x.dim) === dimKey(old.dim));
  },
  result: (a, after) => ({ ad_group_id: a.ad_group_id, nodes: after.nodes.length }),
});

// --------------------------------------------------------------------------------------- PMax listing group filters
async function readFilters(ads: GoogleAdsClient, assetGroupId: string): Promise<Tree> {
  const [g] = await ads.query(new Gaql().select("asset_group.id", "asset_group.name", "campaign.advertising_channel_type").from("asset_group").where(`asset_group.id = ${lit.id(assetGroupId)}`).limit(1), { maxRows: 1 });
  if (!g) throw new ToolError("not_found", `No asset group ${assetGroupId} in this account.`);
  const f = "asset_group_listing_group_filter";
  const rows = await ads.query(new Gaql().select(`${f}.id`, `${f}.type`, `${f}.parent_listing_group_filter`, `${f}.listing_source`, ...caseFields(`${f}.case_value`)).from(f).where(`asset_group.id = ${lit.id(assetGroupId)}`), { maxRows: 5000 });
  return finishTree(
    { id: assetGroupId, name: str(g, "asset_group.name") },
    rows
      .filter((r) => (str(r, `${f}.listing_source`) ?? "SHOPPING") === "SHOPPING")
      .map((r) => ({ id: String(pick(r, `${f}.id`)), parent: tailId(pick(r, `${f}.parent_listing_group_filter`))?.split("~")[1] ?? null, subdivision: str(r, `${f}.type`) === "SUBDIVISION", excluded: str(r, `${f}.type`) === "UNIT_EXCLUDED", bid_micros: null, dim: readDim(r, `${f}.case_value`), other: false })),
  );
}
const lfRn = (ads: GoogleAdsClient, ag: string, id: string) => `customers/${ads.customerId}/assetGroupListingGroupFilters/${ag}~${id}`;
const lfCreate = (ads: GoogleAdsClient, ag: string, id: string, parent: string | null, n: { subdivision: boolean; dim: Dim | null; excluded?: boolean }): Row => ({
  assetGroupListingGroupFilterOperation: { create: { resourceName: lfRn(ads, ag, id), assetGroup: rn(ads, "assetGroups", ag), type: n.subdivision ? "SUBDIVISION" : n.excluded ? "UNIT_EXCLUDED" : "UNIT_INCLUDED", listingSource: "SHOPPING", ...(parent ? { parentListingGroupFilter: lfRn(ads, ag, parent) } : {}), ...(n.dim ? { caseValue: caseValue(n.dim) } : {}) } },
});

export const addAssetGroupListingFilter = stateWrite({
  name: "add_asset_group_listing_filter",
  title: "Filter asset group products",
  risk: "write",
  description:
    "Chooses which feed products a Performance Max asset group advertises: splits a filter node (or, for an asset group without filters, all products) by brand, item id, condition, product type (level 1-5) or custom label (0-4) into the given values plus 'Other', or adds values to a node already split on that dimension; the new values are included or excluded. Applied atomically (Google requires the subdivision, its children and 'Other' together) and confirmed by re-reading.",
  input: z.object({ account_id: accountId, asset_group_id: idSchema, parent_filter_id: idSchema.optional().describe("Node to split or extend; omit when the asset group has no filters yet."), split: dimInput, values: z.array(valueSchema).min(1).max(100), exclude: z.boolean().default(false), exclude_other: z.boolean().default(false).describe("When splitting: exclude everything not listed.") }),
  output: z.object({ asset_group_id: z.string(), nodes: z.number() }),
  read: (a, ads) => readFilters(ads, a.asset_group_id),
  build: (a, t, ads) => {
    const dimType = { kind: a.split.dimension, level: a.split.level, index: a.split.index } as Dim;
    if (dimType.kind === "condition" && a.values.some((v) => !CONDITIONS.includes(v))) throw new ToolError("invalid_argument", `condition values are ${CONDITIONS.join(", ")}.`);
    const dims = [...new Map(a.values.map((v) => [v.toLowerCase(), { ...dimType, value: v }])).values()];
    const ref = { resource: "asset_group", id: a.asset_group_id, name: t.owner.name };
    const ops: Row[] = [];
    let tmp = -1;
    const split = (removeId: string | null, parentOfSub: string | null, subDim: Dim | null) => {
      const sub = String(tmp--);
      if (removeId) ops.push({ assetGroupListingGroupFilterOperation: { remove: lfRn(ads, a.asset_group_id, removeId) } });
      ops.push(lfCreate(ads, a.asset_group_id, sub, parentOfSub, { subdivision: true, dim: subDim }));
      ops.push(lfCreate(ads, a.asset_group_id, String(tmp--), sub, { subdivision: false, dim: { ...dimType, value: undefined }, excluded: a.exclude_other }));
      for (const d of dims) ops.push(lfCreate(ads, a.asset_group_id, String(tmp--), sub, { subdivision: false, dim: d, excluded: a.exclude }));
    };
    if (!t.nodes.length) {
      if (a.parent_filter_id) throw new ToolError("invalid_argument", "This asset group has no filters yet: omit parent_filter_id to split all products.");
      split(null, null, null);
    } else {
      if (!a.parent_filter_id) throw new ToolError("invalid_argument", "Give parent_filter_id (get_asset_group_listing_filters).");
      const parent = nodeOf(t, a.parent_filter_id);
      if (parent.subdivision) {
        const kids = childrenOf(t, parent.id);
        if (kids.some((k) => k.dim && !sameDimType(k.dim, dimType))) throw new ToolError("invalid_argument", `Filter ${parent.id} is split on another dimension.`);
        const fresh = dims.filter((d) => !kids.some((k) => dimKey(k.dim) === dimKey(d)));
        if (!fresh.length) throw new ToolError("invalid_argument", "Nothing would change: these values are already filtered.");
        for (const d of fresh) ops.push(lfCreate(ads, a.asset_group_id, String(tmp--), parent.id, { subdivision: false, dim: d, excluded: a.exclude }));
      } else {
        if (parent.excluded) throw new ToolError("invalid_argument", "This node is excluded; an excluded node cannot be split.");
        split(parent.id, parent.parent, parent.dim);
      }
    }
    const effect: Effect = a.exclude || a.exclude_other ? "pause" : "neutral";
    return { summary: `Asset group "${t.owner.name ?? a.asset_group_id}": ${a.exclude ? "exclude" : "include"} ${dims.map(dimLabel).join(", ")}${a.exclude_other ? "; exclude everything else" : ""}`, changes: dims.map((d) => ({ ...ref, field: "listing_filter", before: null, after: `${dimLabel(d)} ${a.exclude ? "excluded" : "included"}`, unit: "text" as const, effect })), ops };
  },
  landed: (a, _b, after) => a.values.every((v) => after.nodes.some((n) => n.dim && n.dim.kind === a.split.dimension && (n.dim.value ?? "").toLowerCase() === v.toLowerCase() && n.excluded === a.exclude)),
  result: (a, after) => ({ asset_group_id: a.asset_group_id, nodes: after.nodes.length }),
});

export const removeAssetGroupListingFilter = stateWrite({
  name: "remove_asset_group_listing_filter",
  title: "Remove asset group product filter",
  risk: "destructive",
  description: "Removes a product filter node from a Performance Max asset group after a person approves it: a value node is removed (its products fall into 'Other'); a subdivision is collapsed back into a single included node (its subtree is removed). 'Other' nodes and the root cannot be removed. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, asset_group_id: idSchema, filter_id: idSchema }),
  output: z.object({ asset_group_id: z.string(), nodes: z.number() }),
  read: (a, ads) => readFilters(ads, a.asset_group_id),
  build: (a, t, ads) => {
    const n = nodeOf(t, a.filter_id);
    if (!n.parent) throw new ToolError("invalid_argument", "The root filter cannot be removed.");
    if (n.other) throw new ToolError("invalid_argument", "An 'Other' node cannot be removed: every subdivision needs one.");
    const ref = { resource: "asset_group", id: a.asset_group_id, name: t.owner.name };
    const ops: Row[] = [{ assetGroupListingGroupFilterOperation: { remove: lfRn(ads, a.asset_group_id, n.id) } }];
    if (n.subdivision) ops.push(lfCreate(ads, a.asset_group_id, "-1", n.parent, { subdivision: false, dim: n.dim }));
    return { summary: `Asset group "${t.owner.name ?? a.asset_group_id}": ${n.subdivision ? "collapse" : "remove"} filter ${dimLabel(n.dim)}`, changes: [{ ...ref, field: "listing_filter", before: dimLabel(n.dim), after: n.subdivision ? `${dimLabel(n.dim)} (single node)` : null, unit: "text", effect: "remove" }], ops };
  },
  landed: (a, _b, after) => !after.nodes.some((x) => x.id === a.filter_id),
  result: (a, after) => ({ asset_group_id: a.asset_group_id, nodes: after.nodes.length }),
});

// ------------------------------------------------------------------------------------------- Merchant Center links
async function readMerchantLinks(ads: GoogleAdsClient) {
  const [links, invites] = await Promise.all([
    ads.query(new Gaql().select("product_link.resource_name", "product_link.product_link_id", "product_link.merchant_center.merchant_center_id").from("product_link").where("product_link.type = 'MERCHANT_CENTER'"), { maxRows: 500 }),
    ads.query(new Gaql().select("product_link_invitation.resource_name", "product_link_invitation.status", "product_link_invitation.merchant_center.merchant_center_id").from("product_link_invitation").where("product_link_invitation.type = 'MERCHANT_CENTER'"), { maxRows: 500 }),
  ]);
  return {
    links: links.map((r) => ({ resource: String(pick(r, "product_link.resource_name")), merchant_center_id: String(pick(r, "product_link.merchant_center.merchant_center_id") ?? "") })).sort((x, y) => x.merchant_center_id.localeCompare(y.merchant_center_id)),
    invitations: invites.map((r) => ({ resource: String(pick(r, "product_link_invitation.resource_name")), status: str(r, "product_link_invitation.status") ?? "", merchant_center_id: String(pick(r, "product_link_invitation.merchant_center.merchant_center_id") ?? "") })).sort((x, y) => x.resource.localeCompare(y.resource)),
  };
}
export const linkMerchantCenter = stateWrite({
  name: "link_merchant_center",
  title: "Link Merchant Center",
  risk: "high_impact",
  description: "Links a Merchant Center account to this Google Ads account after a person approves it: accepts a pending link request sent from that Merchant Center account, or, when there is none, links directly (Google allows this only when the connected user is an administrator of both accounts; otherwise send a link request from Merchant Center first). Confirmed by re-reading.",
  input: z.object({ account_id: accountId, merchant_center_id: idSchema }),
  output: z.object({ merchant_center_id: z.string(), method: z.enum(["accepted_invitation", "direct_link"]) }),
  read: (_a, ads) => readMerchantLinks(ads),
  build: (a, s, ads) => {
    if (s.links.some((l) => l.merchant_center_id === a.merchant_center_id)) throw new ToolError("invalid_argument", "Nothing would change: this Merchant Center account is already linked.");
    const pending = s.invitations.find((i) => i.merchant_center_id === a.merchant_center_id && i.status === "PENDING_APPROVAL");
    const changes: Change[] = [{ resource: "account", id: ads.customerId, field: "merchant_center_link", before: null, after: a.merchant_center_id, unit: "text", effect: "create" }];
    if (pending) return { summary: `Accept the pending link request from Merchant Center ${a.merchant_center_id}`, changes, ops: [], rpc: { path: `customers/${ads.customerId}/productLinkInvitations:update`, body: { resourceName: pending.resource, productLinkInvitationStatus: "ACCEPTED" } } };
    return { summary: `Link Merchant Center ${a.merchant_center_id} directly (requires admin access to both accounts)`, changes, ops: [], rpc: { path: `customers/${ads.customerId}/productLinks:create`, body: { productLink: { merchantCenter: { merchantCenterId: a.merchant_center_id } } } } };
  },
  landed: (a, _b, after) => after.links.some((l) => l.merchant_center_id === a.merchant_center_id),
  result: (a, _x, _r, before) => ({ merchant_center_id: a.merchant_center_id, method: before.invitations.some((i) => i.merchant_center_id === a.merchant_center_id && i.status === "PENDING_APPROVAL") ? ("accepted_invitation" as const) : ("direct_link" as const) }),
});
export const unlinkMerchantCenter = stateWrite({
  name: "unlink_merchant_center",
  title: "Unlink Merchant Center",
  risk: "destructive",
  description: "Removes the link between a Merchant Center account and this Google Ads account after a person approves it. Shopping and feed-based Performance Max campaigns using it stop receiving products. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, merchant_center_id: idSchema }),
  output: z.object({ merchant_center_id: z.string(), unlinked: z.literal(true) }),
  read: (_a, ads) => readMerchantLinks(ads),
  build: (a, s, ads) => {
    const link = s.links.find((l) => l.merchant_center_id === a.merchant_center_id);
    if (!link) throw new ToolError("invalid_argument", "This Merchant Center account is not linked.");
    return { summary: `Unlink Merchant Center ${a.merchant_center_id}`, changes: [{ resource: "account", id: ads.customerId, field: "merchant_center_link", before: a.merchant_center_id, after: null, unit: "text", effect: "remove" }], ops: [], rpc: { path: `customers/${ads.customerId}/productLinks:remove`, body: { resourceName: link.resource } } };
  },
  landed: (a, _b, after) => !after.links.some((l) => l.merchant_center_id === a.merchant_center_id),
  result: (a) => ({ merchant_center_id: a.merchant_center_id, unlinked: true as const }),
});

export const listingTreeTools = [addProductGroup, updateProductGroup, removeProductGroup, addAssetGroupListingFilter, removeAssetGroupListingFilter, linkMerchantCenter, unlinkMerchantCenter];
