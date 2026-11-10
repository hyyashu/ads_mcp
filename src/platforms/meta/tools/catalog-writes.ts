import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { canonicalJson } from "../../../security/canonical";
import type { MetaAdsClient, MetaRow } from "../client";
import { type CatalogRow, productSetsOf, requireCatalog } from "./catalog";
import { ADS_MANAGEMENT, BUSINESS_MANAGEMENT, CATALOG_MANAGEMENT, EDGE_CAP, accountId, metaId, metaWrite, s } from "./common";
import {
  SPECIAL,
  type Step,
  type TargetingIn,
  budgetChange,
  budgetInput,
  budgetParams,
  buildTargeting,
  checkIdentity,
  destination,
  httpsLink,
  isoTime,
  named,
  objName,
  requireFreeName,
  runSteps,
  schedule,
  targetingInput,
  text,
  verdict,
  adSetBudgetRule,
  createChange,
  createOneAdSet,
  fullCreateSteps,
  requireUsable,
  restrictedCategories,
  verifyFullCreate,
} from "./create-kit";
import { adEditDef, adFields, adSetEditDef, adSetFields, campaignEditDef, campaignFields, editInput } from "./edits";
import { type MetaStateWriteDef, metaStateWrite } from "./write-kit";

/*
 * Catalog (Advantage+ catalog ads) writes, checked against the Marketing API v27.0 docs on 2026-11-05.
 * - Campaign: objective OUTCOME_SALES with promoted_object {product_catalog_id} (Omnichannel Ads guide, "Example for Advantage+
 *   catalog ads").
 * - Ad set: promoted_object {product_set_id[, custom_event_type: PURCHASE]}. Documented pairs: OFFSITE_CONVERSIONS billed on
 *   IMPRESSIONS with custom_event_type PURCHASE (Real Estate Ads guide, Omnichannel guide), and LINK_CLICKS billed on LINK_CLICKS
 *   (Advantage+ Catalog Ads Get Started, cross-sell example). promoted_object is immutable after creation (Ad Set, Promoted Object
 *   reference), so the product set of an ad set cannot change.
 * - Creative: object_story_spec {page_id[, instagram_user_id], template_data {link, message, name, description, call_to_action
 *   {type: SHOP_NOW}}} plus a top-level product_set_id. Template tags shown in the docs: {{product.name}}, {{product.name | titleize}},
 *   {{product.price}}, {{product.description}}; for home listings {{home_listing.name | titleize}}, {{home_listing.description}},
 *   {{home_listing.price strip_zeros}}, {{home_listing.num_beds}}, {{home_listing.num_baths}}.
 * - Advantage+ catalog ads with Home Listing catalogs must follow the special ad category rules: HOUSING is required here.
 * - Product sets: POST /{catalog}/product_sets with name and filter (JSON rule; {} means every item). Error 10803: "Product set with
 *   the same filters already exists".
 * - A catalog campaign is recognized by its ad sets' promoted_object.product_set_id: reading promoted_object on a campaign is not
 *   documented, so the campaign's catalog is taken from its catalog ad sets (product set field product_catalog).
 */

const PAGES_MANAGE_ADS = "pages_manage_ads";
const note = (p: string[]) => `The Meta app needs ${p.join(", ")}; the connected user needs an advertiser role on the ad account${p.includes(PAGES_MANAGE_ADS) ? " and the Page" : ""}.`;
const permsOf = (...p: string[]) => ({ platformPermissions: p, notes: note(p) });
const SET_PERMS = permsOf(BUSINESS_MANAGEMENT, CATALOG_MANAGEMENT);
const AD_SET_PERMS = permsOf(ADS_MANAGEMENT, BUSINESS_MANAGEMENT, CATALOG_MANAGEMENT);
const AD_PERMS = permsOf(ADS_MANAGEMENT, BUSINESS_MANAGEMENT, CATALOG_MANAGEMENT, PAGES_MANAGE_ADS);

const obj = (v: unknown): MetaRow => (v && typeof v === "object" && !Array.isArray(v) ? (v as MetaRow) : {});
const create = createChange;

// ---------------------------------------------------------------------------------------------------------------
// Catalog helpers

/** The catalog a product set belongs to (product set field product_catalog), which must be available to this ad account. */
export async function catalogOfSet(m: MetaAdsClient, setId: string): Promise<{ catalog: CatalogRow; setName: string | null }> {
  if (!/^\d{1,25}$/.test(setId)) throw new ToolError("invalid_argument", "product set id must be numeric.");
  const r = await m.get(setId, { fields: "id,name,product_catalog" });
  const cid = s(obj(r.product_catalog), "id");
  if (!cid) throw new ToolError("not_found", `Product set ${setId} has no readable catalog.`);
  return { catalog: await requireCatalog(m, cid), setName: s(r, "name") };
}

/** The product set ids promoted by a campaign's ad sets (empty when it is not a catalog campaign). */
async function campaignProductSets(m: MetaAdsClient, campaignId: string): Promise<string[]> {
  const rows = await m.list(`${campaignId}/adsets`, { fields: "id,promoted_object" }, EDGE_CAP);
  return [...new Set(rows.map((r) => s(obj(r.promoted_object), "product_set_id")).filter((x): x is string => !!x))];
}

/** Vertical rules: commerce or home_listings only; home listings need the HOUSING special ad category. */
type Vertical = "commerce" | "home_listings";
function verticalOf(c: CatalogRow): Vertical {
  if (c.vertical === null) throw new ToolError("invalid_argument", `Meta did not return the vertical of catalog ${c.catalog_id}, so the special ad category rules cannot be checked. Nothing was created.`);
  if (c.vertical === "commerce" || c.vertical === "home_listings") return c.vertical;
  throw new ToolError("invalid_argument", `Catalog ${c.catalog_id} is a ${c.vertical} catalog. Only commerce and home_listings catalogs are supported (their template tags are documented).`);
}
function requireHousing(v: Vertical, special: readonly string[]) {
  if (v === "home_listings" && !special.includes("HOUSING")) throw new ToolError("invalid_argument", "Home listing catalogs must run with the HOUSING special ad category (Meta's Advantage+ catalog ads rules). Add HOUSING to special_ad_categories.");
}

/** OFFSITE_CONVERSIONS needs a pixel or app connected to the catalog so purchases can be matched to items. */
async function requireEventSource(m: MetaAdsClient, catalogId: string) {
  const rows = await m.list(`${catalogId}/external_event_sources`, { fields: "id" }, 10, { partial: true });
  if (!rows.length) throw new ToolError("invalid_argument", `Catalog ${catalogId} has no connected pixel or app (external_event_sources), so OFFSITE_CONVERSIONS with PURCHASE cannot work. Connect one in Commerce Manager (see validate_catalog_readiness) or use LINK_CLICKS.`);
}

// ---------------------------------------------------------------------------------------------------------------
// Template creative

const TAGS: Record<Vertical, RegExp> = {
  commerce: /^(product\.name( \| titleize)?|product\.price|product\.description)$/,
  home_listings: /^(home_listing\.name( \| titleize)?|home_listing\.description|home_listing\.price( strip_zeros)?|home_listing\.num_beds|home_listing\.num_baths)$/,
};
const TAG_TEXT: Record<Vertical, string> = {
  commerce: "{{product.name}}, {{product.name | titleize}}, {{product.price}}, {{product.description}}",
  home_listings: "{{home_listing.name}}, {{home_listing.name | titleize}}, {{home_listing.description}}, {{home_listing.price}}, {{home_listing.price strip_zeros}}, {{home_listing.num_beds}}, {{home_listing.num_baths}}",
};

export const templateInput = z.object({
  link: httpsLink.describe("Website the ad sends people to (template_data.link)."),
  message: text(2200).optional().describe("Primary text. May use the documented template tags (see the description)."),
  headline: text(255).optional().describe("Headline (template_data.name). May use template tags."),
  description: text(255).optional().describe("Description. May use template tags."),
  call_to_action: z.enum(["SHOP_NOW"]).optional().describe("Only SHOP_NOW is shown with catalog templates in the docs."),
});
type Template = z.infer<typeof templateInput>;

/** Every {{...}} tag must be one documented for the catalog's vertical; stray braces are refused. */
export function checkTags(t: Template, v: Vertical) {
  for (const [field, value] of [
    ["message", t.message],
    ["headline", t.headline],
    ["description", t.description],
  ] as const) {
    if (!value) continue;
    const rest = value.replace(/\{\{([^{}]*)\}\}/g, (_m, inner: string) => {
      if (!TAGS[v].test(inner.trim())) throw new ToolError("invalid_argument", `${field}: the template tag {{${inner}}} is not one documented for ${v} catalogs. Allowed: ${TAG_TEXT[v]}.`);
      return "";
    });
    if (/\{\{|\}\}/.test(rest)) throw new ToolError("invalid_argument", `${field}: unbalanced {{ }} braces.`);
  }
}

function templateCreative(name: string, d: { page_id: string; instagram_account_id?: string }, productSetId: string, t: Template): Record<string, string> {
  const data = { link: t.link, ...(t.message ? { message: t.message } : {}), ...(t.headline ? { name: t.headline } : {}), ...(t.description ? { description: t.description } : {}), ...(t.call_to_action ? { call_to_action: { type: t.call_to_action } } : {}) };
  return { name, object_story_spec: JSON.stringify({ page_id: d.page_id, ...(d.instagram_account_id ? { instagram_user_id: d.instagram_account_id } : {}), template_data: data }), product_set_id: productSetId };
}

// ---------------------------------------------------------------------------------------------------------------
// Catalog ad set parameters

export const CATALOG_GOALS = ["OFFSITE_CONVERSIONS", "LINK_CLICKS"] as const;
const BILLING: Record<(typeof CATALOG_GOALS)[number], string> = { OFFSITE_CONVERSIONS: "IMPRESSIONS", LINK_CLICKS: "LINK_CLICKS" };
const GOAL_TEXT = "OFFSITE_CONVERSIONS (billed on IMPRESSIONS, optimizing PURCHASE; the catalog needs a connected pixel or app) or LINK_CLICKS (billed on LINK_CLICKS)";

const catalogAdSetCore = {
  ad_set_name: objName(255),
  product_set_id: metaId.describe("Product set to promote (list_meta_product_sets). It cannot be changed later."),
  optimization_goal: z.enum(CATALOG_GOALS).describe(`Documented catalog pairs only: ${GOAL_TEXT}.`),
  targeting: targetingInput,
  start_time: isoTime.optional(),
  end_time: isoTime.optional().describe("Required with a lifetime budget."),
};
type CatalogAdSetIn = { ad_set_name: string; product_set_id: string; optimization_goal: (typeof CATALOG_GOALS)[number]; targeting: TargetingIn; start_time?: string; end_time?: string };

function catalogAdSetParams(a: CatalogAdSetIn, special: readonly string[], lifetime: boolean): Record<string, string> {
  const { start, end } = schedule(a, lifetime);
  const po = a.optimization_goal === "OFFSITE_CONVERSIONS" ? { product_set_id: a.product_set_id, custom_event_type: "PURCHASE" } : { product_set_id: a.product_set_id };
  return {
    name: a.ad_set_name,
    optimization_goal: a.optimization_goal,
    billing_event: BILLING[a.optimization_goal],
    targeting: JSON.stringify(buildTargeting(a.targeting, special)),
    promoted_object: JSON.stringify(po),
    status: "PAUSED",
    ...(start !== null ? { start_time: String(start) } : {}),
    ...(end !== null ? { end_time: String(end) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// create_meta_product_set

const TEXT_FIELDS = ["brand", "category", "product_type", "retailer_id", "color", "custom_label_0", "custom_label_1", "custom_label_2", "custom_label_3", "custom_label_4"] as const;
const ENUM_FIELDS: Record<string, readonly string[]> = {
  availability: ["in stock", "out of stock", "preorder", "available for order"],
  condition: ["new", "refurbished", "used"],
  age_group: ["newborn", "infant", "toddler", "kids", "adult"],
};
const STRING_OPS = ["contains", "not_contains", "i_contains"];
const LIST_OPS = ["is_any", "is_not_any"];
const value = z.string().trim().min(1).max(500);
export const filterRule = z
  .object({
    field: z.enum([...TEXT_FIELDS, ...(Object.keys(ENUM_FIELDS) as ["availability", "condition", "age_group"])]),
    operator: z.enum(["eq", "neq", "contains", "not_contains", "i_contains", "is_any", "is_not_any"]),
    value: z.union([value, z.array(value).min(1).max(1000)]),
  })
  .superRefine((r, ctx) => {
    const list = LIST_OPS.includes(r.operator);
    if (list !== Array.isArray(r.value)) ctx.addIssue({ code: "custom", message: list ? `${r.operator} takes a list of values` : `${r.operator} takes one value` });
    const allowed = ENUM_FIELDS[r.field];
    if (allowed) {
      if (STRING_OPS.includes(r.operator)) ctx.addIssue({ code: "custom", message: `${r.field} is an enum: use eq, neq, is_any or is_not_any (Meta: "For enum values use the eq operators")` });
      const bad = (Array.isArray(r.value) ? r.value : [r.value]).filter((x) => !allowed.includes(x));
      if (bad.length) ctx.addIssue({ code: "custom", message: `${r.field} must be one of: ${allowed.join(", ")}` });
    }
  });
export const filterJson = (r?: z.infer<typeof filterRule>) => (r ? JSON.stringify({ [r.field]: { [r.operator]: r.value } }) : "{}");
const canon = (f: unknown): string => {
  if (f === null || f === undefined || f === "") return "{}";
  try {
    return canonicalJson(JSON.parse(String(f)));
  } catch {
    return String(f);
  }
};

const setInput = z.object({
  account_id: accountId,
  catalog_id: metaId.describe("Catalog to add the set to (list_meta_catalogs)."),
  name: objName(255),
  filter: filterRule.optional().describe("One filter rule. Leave out for a set of every item in the catalog."),
});
type SetIn = z.infer<typeof setInput>;

async function prepareSet(a: SetIn, m: MetaAdsClient) {
  await requireCatalog(m, a.catalog_id);
  const sets = await productSetsOf(m, a.catalog_id);
  if (sets.some((r) => (s(r, "name") ?? "").toLowerCase() === a.name.toLowerCase())) throw new ToolError("invalid_argument", `A product set named "${a.name}" already exists in this catalog. Names must be unique so the result can be verified; choose another name.`);
  const filter = filterJson(a.filter);
  const same = sets.find((r) => canon(r.filter) === canon(filter));
  if (same) throw sameFilter(same);
  return filter;
}
const sameFilter = (r?: MetaRow) => new ToolError("invalid_argument", `A product set with the same filter already exists${r ? `: "${s(r, "name") ?? ""}" (${String(r.id)})` : ""}. Meta allows one set per filter; use that set.`);

export const createMetaProductSet = metaWrite({
  name: "create_meta_product_set",
  title: "Create Meta product set",
  risk: "write",
  description:
    'Creates a product set in a catalog available to this ad account, after approval: a name (unique in the catalog) and one documented filter rule on brand, category, product_type, retailer_id, color, custom_label_0-4 (eq, neq, contains, not_contains, i_contains, is_any, is_not_any) or availability, condition, age_group (eq, neq, is_any, is_not_any with Meta\'s values), or no filter for every item. Meta allows only one set per filter: an existing set with the same filter is named and refused. A product set does not spend, so one approver is enough. Sent once, never retried; verified by finding the name in the catalog. Needs business_management and catalog_management.',
  input: setInput,
  output: z.object({ product_set_id: z.string(), catalog_id: z.string(), name: z.string(), filter: z.string() }),
  permissions: SET_PERMS,
  plan: async (a, ctx) => {
    const filter = await prepareSet(a, ctx.services.meta);
    return { summary: `Create product set "${a.name}" in catalog ${a.catalog_id} with filter ${filter}`, snapshot: { name_free: true, filter_free: true }, changes: [{ resource: "product_set", id: "new", name: a.name, field: "create", before: null, after: filter, unit: "text", effect: "neutral" }] };
  },
  execute: async (a, ctx) => {
    const m = ctx.services.meta;
    const filter = await prepareSet(a, m);
    try {
      const ids = await runSteps(m, [{ key: "set", label: "product set", post: () => ({ path: `${a.catalog_id}/product_sets`, params: { name: a.name, filter } }) }]);
      return { product_set_id: ids.set!, catalog_id: a.catalog_id, name: a.name, filter };
    } catch (e) {
      if (e instanceof ToolError && e.opts.details?.meta_code === 10803) {
        const same = (await productSetsOf(m, a.catalog_id).catch(() => [] as MetaRow[])).find((r) => canon(r.filter) === canon(filter));
        throw sameFilter(same);
      }
      throw e;
    }
  },
  verify: async (a, ctx) => verdict([{ key: "set", label: "product set", ids: await named(ctx.services.meta, `${a.catalog_id}/product_sets`, a.name) }]),
});

// ---------------------------------------------------------------------------------------------------------------
// create_meta_catalog_campaign

const campaignInput = z.object({
  account_id: accountId,
  catalog_id: metaId.describe("Catalog the campaign promotes (list_meta_catalogs)."),
  campaign_name: objName(255),
  special_ad_categories: z.array(z.enum(SPECIAL)).max(3).default([]).describe("[] when none applies. Home listing catalogs need HOUSING."),
  budget: budgetInput,
  ...catalogAdSetCore,
  ad_name: objName(100).describe("Also used as the template creative's name."),
  page_id: destination.page_id,
  instagram_account_id: destination.instagram_account_id,
  template: templateInput,
});
type CampaignIn = z.infer<typeof campaignInput>;
const createdOut = z.object({ campaign_id: z.string(), ad_set_id: z.string(), creative_id: z.string(), ad_id: z.string(), status: z.literal("PAUSED"), next_step: z.string() });

async function prepareCampaign(a: CampaignIn, m: MetaAdsClient): Promise<Step[]> {
  const catalog = await requireCatalog(m, a.catalog_id);
  const v = verticalOf(catalog);
  requireHousing(v, a.special_ad_categories);
  checkTags(a.template, v);
  if (!(await productSetsOf(m, a.catalog_id)).some((r) => s(r, "id") === a.product_set_id)) throw new ToolError("not_found", `No product set ${a.product_set_id} in catalog ${a.catalog_id}.`);
  if (a.optimization_goal === "OFFSITE_CONVERSIONS") await requireEventSource(m, a.catalog_id);
  const set = catalogAdSetParams(a, a.special_ad_categories, a.budget.type === "lifetime");
  await checkIdentity(m, { page_id: a.page_id, instagram_account_id: a.instagram_account_id });
  await requireFreeName(m, `${m.adAccountId}/campaigns`, a.campaign_name, "campaign");
  await requireFreeName(m, `${m.adAccountId}/adcreatives`, a.ad_name, "creative");
  return fullCreateSteps(m, {
    campaign: { name: a.campaign_name, objective: "OUTCOME_SALES", special_ad_categories: JSON.stringify(a.special_ad_categories), promoted_object: JSON.stringify({ product_catalog_id: a.catalog_id }) },
    budget: a.budget,
    adSet: set,
    creative: templateCreative(a.ad_name, a, a.product_set_id, a.template),
    adName: a.ad_name,
  });
}

export const createMetaCatalogCampaign = metaWrite({
  name: "create_meta_catalog_campaign",
  title: "Create Meta catalog campaign",
  risk: "high_impact",
  description: `Creates a complete Advantage+ catalog campaign after a person approves it, all PAUSED: campaign (OUTCOME_SALES, promoted_object = the catalog), ad set (promoted_object = one product set of that catalog), template creative and ad. Optimization: ${GOAL_TEXT}. The catalog must be available to this ad account and be a commerce or home_listings catalog; home listings require the HOUSING special ad category, which enforces Meta's targeting restrictions. Template text may only use the documented tags: commerce ${TAG_TEXT.commerce}; home listings ${TAG_TEXT.home_listings}. Budget on the campaign or the ad set, daily or lifetime (lifetime needs end_time), lowest-cost bidding. Names must be unused. The four objects are created one by one and never retried; if a later step fails the ids already created (all PAUSED) are reported and nothing is deleted. Needs ads_management, business_management, catalog_management and pages_manage_ads.`,
  input: campaignInput,
  output: createdOut,
  permissions: AD_PERMS,
  plan: async (a, ctx) => {
    const m = ctx.services.meta;
    await prepareCampaign(a, m);
    const ref = a.budget.level === "campaign" ? { resource: "campaign", id: "new", name: a.campaign_name } : { resource: "ad_set", id: "new", name: a.ad_set_name };
    return {
      summary: `Create Meta catalog campaign "${a.campaign_name}" (OUTCOME_SALES, catalog ${a.catalog_id}, PAUSED) with ad set "${a.ad_set_name}" (${a.optimization_goal}, product set ${a.product_set_id}) and ad "${a.ad_name}", ${a.budget.type} budget ${a.budget.amount} on the ${a.budget.level === "campaign" ? "campaign" : "ad set"}`,
      snapshot: { names_free: true },
      changes: [create("campaign", a.campaign_name, "OUTCOME_SALES"), create("ad_set", a.ad_set_name, a.optimization_goal), create("ad_creative", a.ad_name, "catalog template"), create("ad", a.ad_name, "PAUSED"), budgetChange(ref, a.budget, m.currency)],
    };
  },
  execute: async (a, ctx) => {
    const m = ctx.services.meta;
    const ids = await runSteps(m, await prepareCampaign(a, m));
    return { campaign_id: ids.campaign!, ad_set_id: ids.ad_set!, creative_id: ids.creative!, ad_id: ids.ad!, status: "PAUSED" as const, next_step: "Review the ad in Ads Manager, then activate it with update_meta_catalog_campaign, update_meta_catalog_ad_set and update_meta_catalog_ad." };
  },
  verify: async (a, ctx) => verifyFullCreate(ctx.services.meta, a),
});

// ---------------------------------------------------------------------------------------------------------------
// add_meta_catalog_ad_set

const adSetInput = z.object({ account_id: accountId, campaign_id: metaId, ...catalogAdSetCore, budget: budgetInput.omit({ level: true }).optional().describe("Required when the campaign has no campaign budget; not allowed when it has one.") });
type AdSetIn = z.infer<typeof adSetInput>;

async function prepareAdSet(a: AdSetIn, m: MetaAdsClient) {
  const c = await m.getOwned(a.campaign_id, ["id", "name", "status", "objective", "daily_budget", "lifetime_budget", "special_ad_categories"], "campaign");
  requireUsable(s(c, "status"), "campaign");
  if (s(c, "objective") !== "OUTCOME_SALES") throw new ToolError("invalid_argument", `The campaign's objective is ${s(c, "objective") ?? "unknown"}; catalog ad sets are documented only under OUTCOME_SALES catalog campaigns.`);
  const existing = await campaignProductSets(m, a.campaign_id);
  if (!existing.length) throw new ToolError("invalid_argument", "This campaign has no catalog ad set, so its catalog cannot be confirmed (a campaign's promoted_object is not a documented readable field). Use create_meta_catalog_campaign.");
  const campCatalog = (await catalogOfSet(m, existing[0]!)).catalog;
  const target = await catalogOfSet(m, a.product_set_id);
  if (target.catalog.catalog_id !== campCatalog.catalog_id) throw new ToolError("invalid_argument", `Product set ${a.product_set_id} is in catalog ${target.catalog.catalog_id}, but the campaign promotes catalog ${campCatalog.catalog_id}. Use a product set of the campaign's catalog.`);
  const special = restrictedCategories(c);
  requireHousing(verticalOf(campCatalog), special);
  const { lifetime } = adSetBudgetRule(c, a.budget);
  if (a.optimization_goal === "OFFSITE_CONVERSIONS") await requireEventSource(m, campCatalog.catalog_id);
  const params = catalogAdSetParams(a, special, lifetime);
  await requireFreeName(m, `${a.campaign_id}/adsets`, a.ad_set_name, "ad set in this campaign");
  return {
    campaignName: s(c, "name"),
    params: { ...params, campaign_id: a.campaign_id, ...(a.budget ? { ...budgetParams({ level: "ad_set", ...a.budget }, m.currency), bid_strategy: "LOWEST_COST_WITHOUT_CAP" } : {}) },
  };
}

export const addMetaCatalogAdSet = metaWrite({
  name: "add_meta_catalog_ad_set",
  title: "Add Meta catalog ad set",
  risk: "high_impact",
  description: `Adds a PAUSED catalog ad set to an existing OUTCOME_SALES catalog campaign of this ad account, after a person approves it. The product set must belong to the campaign's catalog (taken from the campaign's existing catalog ad sets). Optimization: ${GOAL_TEXT}. Budget only when the campaign has no campaign budget. The campaign's special ad categories apply to targeting. The name must be unused in the campaign. This is also how to promote a different product set: an ad set's product set cannot be changed. Needs ads_management, business_management and catalog_management.`,
  input: adSetInput,
  output: z.object({ ad_set_id: z.string(), campaign_id: z.string(), status: z.literal("PAUSED") }),
  permissions: AD_SET_PERMS,
  plan: async (a, ctx) => {
    const m = ctx.services.meta;
    const p = await prepareAdSet(a, m);
    return {
      summary: `Add PAUSED catalog ad set "${a.ad_set_name}" (${a.optimization_goal}, product set ${a.product_set_id}) to campaign "${p.campaignName ?? a.campaign_id}" (${a.campaign_id})${a.budget ? `, ${a.budget.type} budget ${a.budget.amount}` : ", campaign budget"}`,
      snapshot: { names_free: true },
      changes: [create("ad_set", a.ad_set_name, a.optimization_goal), ...(a.budget ? [budgetChange({ resource: "ad_set", id: "new", name: a.ad_set_name }, { level: "ad_set", ...a.budget }, m.currency)] : [])],
    };
  },
  execute: async (a, ctx) => {
    const m = ctx.services.meta;
    const p = await prepareAdSet(a, m);
    return { ad_set_id: await createOneAdSet(m, p.params), campaign_id: a.campaign_id, status: "PAUSED" as const };
  },
  verify: async (a, ctx) => verdict([{ key: "ad_set", label: "ad set", ids: await named(ctx.services.meta, `${a.campaign_id}/adsets`, a.ad_set_name) }]),
});

// ---------------------------------------------------------------------------------------------------------------
// add_meta_catalog_ad

const adInput = z.object({ account_id: accountId, ad_set_id: metaId, ad_name: objName(100).describe("Also used as the template creative's name."), page_id: destination.page_id, instagram_account_id: destination.instagram_account_id, template: templateInput });
type AdIn = z.infer<typeof adInput>;

async function prepareAd(a: AdIn, m: MetaAdsClient) {
  const set = await m.getOwned(a.ad_set_id, ["id", "name", "status", "promoted_object"], "ad set");
  requireUsable(s(set, "status"), "ad set");
  const productSet = s(obj(set.promoted_object), "product_set_id");
  if (!productSet) throw new ToolError("invalid_argument", "This ad set does not promote a product set (it is not a catalog ad set): use add_meta_ad.");
  const { catalog } = await catalogOfSet(m, productSet);
  checkTags(a.template, verticalOf(catalog));
  await checkIdentity(m, { page_id: a.page_id, instagram_account_id: a.instagram_account_id });
  await requireFreeName(m, `${a.ad_set_id}/ads`, a.ad_name, "ad in this ad set");
  await requireFreeName(m, `${m.adAccountId}/adcreatives`, a.ad_name, "creative");
  const creative = templateCreative(a.ad_name, a, productSet, a.template);
  const steps: Step[] = [
    { key: "creative", label: "creative", post: () => ({ path: `${m.adAccountId}/adcreatives`, params: creative }) },
    { key: "ad", label: "ad", post: (ids) => ({ path: `${m.adAccountId}/ads`, params: { name: a.ad_name, adset_id: a.ad_set_id, creative: JSON.stringify({ creative_id: ids.creative! }), status: "PAUSED" } }) },
  ];
  return { steps, setName: s(set, "name"), productSet };
}

export const addMetaCatalogAd = metaWrite({
  name: "add_meta_catalog_ad",
  title: "Add Meta catalog ad",
  risk: "high_impact",
  description: `Adds a PAUSED catalog ad to an existing catalog ad set of this ad account, after a person approves it: a new template creative for the ad set's product set (Page, optional Instagram account, link, and text that may use the documented tags for the catalog's vertical: commerce ${TAG_TEXT.commerce}; home listings ${TAG_TEXT.home_listings}), then the ad. The ad name (also the creative's name) must be unused. The two objects are created one after the other and never retried; if the ad step fails the creative's id is reported. Needs ads_management, business_management, catalog_management and pages_manage_ads.`,
  input: adInput,
  output: z.object({ ad_id: z.string(), creative_id: z.string(), ad_set_id: z.string(), status: z.literal("PAUSED") }),
  permissions: AD_PERMS,
  plan: async (a, ctx) => {
    const p = await prepareAd(a, ctx.services.meta);
    return { summary: `Add PAUSED catalog ad "${a.ad_name}" to ad set "${p.setName ?? a.ad_set_id}" (${a.ad_set_id}) with a template creative for product set ${p.productSet}`, snapshot: { names_free: true }, changes: [create("ad_creative", a.ad_name, "catalog template"), create("ad", a.ad_name, "PAUSED")] };
  },
  execute: async (a, ctx) => {
    const m = ctx.services.meta;
    const ids = await runSteps(m, (await prepareAd(a, m)).steps);
    return { ad_id: ids.ad!, creative_id: ids.creative!, ad_set_id: a.ad_set_id, status: "PAUSED" as const };
  },
  verify: async (a, ctx) => {
    const m = ctx.services.meta;
    return verdict([
      { key: "creative", label: "creative", ids: await named(m, `${m.adAccountId}/adcreatives`, a.ad_name) },
      { key: "ad", label: "ad", ids: await named(m, `${a.ad_set_id}/ads`, a.ad_name) },
    ]);
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Updates: the batch 3 edit definitions, restricted to catalog objects

/** A batch 3 update tool with fewer fields and a catalog check before every read (plan, drift check, verify). */
function catalogEdit<I extends z.ZodObject, O extends z.ZodType, S>(base: MetaStateWriteDef<I, O, S>, o: { name: string; title: string; description: string; input: z.ZodObject; check: (a: z.infer<I>, m: MetaAdsClient) => Promise<void> }) {
  return metaStateWrite<I, O, S>({
    ...base,
    name: o.name,
    title: o.title,
    description: o.description,
    input: o.input as unknown as I,
    read: async (a, m) => {
      await o.check(a, m);
      return base.read(a, m);
    },
  });
}
const notCatalog = (label: string, other: string) => new ToolError("invalid_argument", `This ${label} is not a catalog ${label} (no ad set promotes a product set): use ${other}.`);

const { bid_strategy: _cb, ...catalogCampaignFields } = campaignFields;
export const updateMetaCatalogCampaign = catalogEdit(campaignEditDef, {
  name: "update_meta_catalog_campaign",
  title: "Update Meta catalog campaign",
  description:
    'Changes one catalog campaign (one whose ad sets promote a product set) after human approval: name, status (ACTIVE or PAUSED), the campaign budget (daily or lifetime, only on a campaign that already uses that kind) and the spend cap (set, change or "remove"). Same rules as update_meta_campaign: only changed fields are sent, in one request; activating, raising a budget and raising or removing the spend cap need a second approver; pausing, lowering, setting a first cap and renaming do not. Other campaigns are refused. Confirmed by re-reading; never retried.',
  input: editInput(catalogCampaignFields),
  check: async (a, m) => {
    await m.getOwned(a.campaign_id, ["id"], "campaign");
    if (!(await campaignProductSets(m, a.campaign_id)).length) throw notCatalog("campaign", "update_meta_campaign");
  },
});

const { bid_amount: _ba, bid_strategy: _bs, ...catalogAdSetFields } = adSetFields;
export const updateMetaCatalogAdSet = catalogEdit(adSetEditDef, {
  name: "update_meta_catalog_ad_set",
  title: "Update Meta catalog ad set",
  description:
    "Changes one catalog ad set (its promoted_object names a product set) after human approval: name, status (ACTIVE or PAUSED), its own budget (daily or lifetime, not under a campaign budget) and end time. Same rules as update_meta_ad_set: only changed fields are sent; activating, raising the budget and moving the end later need a second approver. The product set cannot be changed: Meta's promoted_object is immutable after creation, so add a new ad set with add_meta_catalog_ad_set instead. Other ad sets are refused. Confirmed by re-reading; never retried.",
  input: editInput(catalogAdSetFields),
  check: async (a, m) => {
    const r = await m.getOwned(a.ad_set_id, ["id", "promoted_object"], "ad set");
    if (!s(obj(r.promoted_object), "product_set_id")) throw notCatalog("ad set", "update_meta_ad_set");
  },
});

export const updateMetaCatalogAd = catalogEdit(adEditDef, {
  name: "update_meta_catalog_ad",
  title: "Update Meta catalog ad",
  description:
    "Renames one catalog ad (in an ad set that promotes a product set) or changes its status (ACTIVE or PAUSED) after human approval. Activating needs a second approver; pausing and renaming do not. The template creative cannot be edited in place: add a new ad with add_meta_catalog_ad. Other ads are refused. Confirmed by re-reading; never retried.",
  input: editInput(adFields),
  check: async (a, m) => {
    const ad = await m.getOwned(a.ad_id, ["id", "adset_id"], "ad");
    const set = await m.getOwned(String(ad.adset_id ?? ""), ["id", "promoted_object"], "ad set");
    if (!s(obj(set.promoted_object), "product_set_id")) throw notCatalog("ad", "update_meta_ad");
  },
});

export const catalogWriteTools = [createMetaProductSet, createMetaCatalogCampaign, addMetaCatalogAdSet, addMetaCatalogAd, updateMetaCatalogCampaign, updateMetaCatalogAdSet, updateMetaCatalogAd];
