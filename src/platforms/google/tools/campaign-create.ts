import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { type Change, moneyChange } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, isRealDate, lit, pick } from "../gaql";
import { accountId, idSchema, str, toMicros } from "./common";
import { stateWrite, temp } from "./write-kit";

/**
 * Campaign creation. Every campaign is created PAUSED, together with its own (non-shared) budget and optional location
 * and language targeting, in one atomic GoogleAdsService.Mutate request with temporary ids (as Google's guides
 * recommend). It starts serving only after resume_campaign, which is high impact.
 *
 * Verified against the v26 guides (2026-11-04): Performance Max supports only MaximizeConversions (optional target CPA)
 * and MaximizeConversionValue (optional target ROAS); brand guidelines are enabled by default for new PMax campaigns
 * unless brand_guidelines_enabled is false (here they are disabled, so business name and logos live in asset groups);
 * Demand Gen needs a non-shared budget and a minimum daily budget (BUDGET_BELOW_PER_DAY_MINIMUM otherwise). The EU
 * political advertising declaration is a required field and is taken from the caller, never assumed.
 */
const clean = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, "not a real date");
const base = {
  account_id: accountId,
  name: clean(255),
  daily_budget: z.number().positive().max(10_000_000).describe("Daily budget in the account's currency."),
  contains_eu_political_advertising: z.boolean().describe("Required declaration: does this campaign contain EU political advertising?"),
  location_ids: z.array(idSchema).max(100).default([]).describe("Targeted location ids (resolve_google_locations). Empty = all locations."),
  language_ids: z.array(idSchema).max(50).default([]).describe("Language constant ids (list_google_languages). Empty = all languages."),
  start_date: day.optional(),
  end_date: day.optional(),
};

interface Existing {
  /** Only the live campaigns whose name matches the requested one (case-insensitively). */
  campaigns: { id: string; name: string }[];
}
/**
 * Reads the campaigns that would clash with `name`. The result is the approval snapshot, so it holds only those: a snapshot of
 * every campaign would make the approval fail as "account changed" whenever any unrelated campaign is added or renamed.
 * GAQL has no case-insensitive comparison, so names are read and matched here.
 */
async function readNameClashes(ads: GoogleAdsClient, name: string): Promise<Existing> {
  const rows = await ads.query(new Gaql().select("campaign.id", "campaign.name").from("campaign").where("campaign.status != 'REMOVED'").orderBy("campaign.id"), { maxRows: 10_000 });
  const want = name.toLowerCase();
  return { campaigns: rows.map((r) => ({ id: String(pick(r, "campaign.id")), name: str(r, "campaign.name") ?? "" })).filter((c) => c.name.toLowerCase() === want) };
}
const sameName = (s: Existing, name: string) => s.campaigns.find((c) => c.name.toLowerCase() === name.toLowerCase());

type Bidding = { strategy: string; target_cpa?: number; target_roas?: number; max_cpc?: number };
function biddingFields(b: Bidding): Row {
  if (b.strategy === "MANUAL_CPC") return { manualCpc: {} };
  if (b.strategy === "MAXIMIZE_CONVERSIONS") return { maximizeConversions: b.target_cpa ? { targetCpaMicros: String(toMicros(b.target_cpa)) } : {} };
  if (b.strategy === "MAXIMIZE_CONVERSION_VALUE") return { maximizeConversionValue: b.target_roas ? { targetRoas: b.target_roas } : {} };
  if (b.strategy === "TARGET_SPEND") return { targetSpend: b.max_cpc ? { cpcBidCeilingMicros: String(toMicros(b.max_cpc)) } : {} };
  if (b.strategy === "TARGET_CPA") return {}; // App campaigns: targetCpa is set with the app settings

  throw new ToolError("internal", `unsupported strategy ${b.strategy}`);
}
const bidding = (strategies: readonly [string, ...string[]]) => ({
  bidding_strategy: z.enum(strategies),
  target_cpa: z.number().positive().max(1_000_000).optional(),
  target_roas: z.number().positive().max(1000).optional(),
  max_cpc: z.number().positive().max(10_000).optional(),
});
const biddingOk = (v: { bidding_strategy: string; target_cpa?: number; target_roas?: number; max_cpc?: number }) =>
  (v.target_cpa === undefined || v.bidding_strategy === "MAXIMIZE_CONVERSIONS") && (v.target_roas === undefined || v.bidding_strategy === "MAXIMIZE_CONVERSION_VALUE") && (v.max_cpc === undefined || v.bidding_strategy === "TARGET_SPEND");
const biddingMsg = "target_cpa only with MAXIMIZE_CONVERSIONS, target_roas only with MAXIMIZE_CONVERSION_VALUE, max_cpc only with TARGET_SPEND";

/** Budget + campaign + targeting operations for a new PAUSED campaign. */
function campaignOps(ads: GoogleAdsClient, a: z.infer<z.ZodObject<typeof base>> & { bidding_strategy: string; target_cpa?: number; target_roas?: number; max_cpc?: number }, fields: Row): Row[] {
  if (a.start_date && a.end_date && a.start_date > a.end_date) throw new ToolError("invalid_argument", "start_date must not be after end_date");
  const budget = temp(ads, "campaignBudgets", 1);
  const campaign = temp(ads, "campaigns", 2);
  return [
    { campaignBudgetOperation: { create: { resourceName: budget, name: `${a.name} budget`, amountMicros: String(toMicros(a.daily_budget)), deliveryMethod: "STANDARD", explicitlyShared: false } } },
    {
      campaignOperation: {
        create: {
          resourceName: campaign,
          name: a.name,
          status: "PAUSED",
          campaignBudget: budget,
          containsEuPoliticalAdvertising: a.contains_eu_political_advertising ? "CONTAINS_EU_POLITICAL_ADVERTISING" : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          ...(a.start_date ? { startDateTime: `${a.start_date} 00:00:00` } : {}),
          ...(a.end_date ? { endDateTime: `${a.end_date} 23:59:59` } : {}),
          ...biddingFields({ strategy: a.bidding_strategy, target_cpa: a.target_cpa, target_roas: a.target_roas, max_cpc: a.max_cpc }),
          ...fields,
        },
      },
    },
    ...[...new Set(a.location_ids)].map((g) => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: `geoTargetConstants/${g}` } } } })),
    ...[...new Set(a.language_ids)].map((l) => ({ campaignCriterionOperation: { create: { campaign, language: { languageConstant: `languageConstants/${l}` } } } })),
  ];
}
const createChanges = (a: { name: string; daily_budget: number }, type: string): Change[] => [
  { resource: "campaign", id: "new", name: a.name, field: "campaign", before: null, after: `${type} (PAUSED)`, unit: "text", effect: "create" },
  moneyChange({ resource: "campaign_budget", id: "new", name: a.name }, "daily_budget", null, toMicros(a.daily_budget)),
];
const output = z.object({ campaign_id: z.string(), name: z.string(), status: z.literal("PAUSED"), next_step: z.string() });

function createTool<I extends z.ZodObject>(o: { name: string; title: string; description: string; input: I; type: string; fields: (a: z.infer<I>, ads: GoogleAdsClient, s: Existing & Row) => Row; extraRead?: (a: z.infer<I>, ads: GoogleAdsClient) => Promise<Row>; extraOps?: (a: z.infer<I>, ads: GoogleAdsClient) => Row[]; next: string }) {
  return stateWrite({
    name: o.name,
    title: o.title,
    risk: "high_impact",
    description: o.description,
    input: o.input,
    output,
    read: async (a, ads) => ({ ...(await readNameClashes(ads, (a as { name: string }).name)), ...(o.extraRead ? await o.extraRead(a, ads) : {}) }),
    build: (a, s, ads) => {
      const args = a as z.infer<I> & z.infer<z.ZodObject<typeof base>> & { bidding_strategy: string };
      if (sameName(s, args.name)) throw new ToolError("invalid_argument", `A campaign named "${args.name}" already exists.`);
      const ops = [...campaignOps(ads, args, o.fields(a, ads, s as Existing & Row)), ...(o.extraOps ? o.extraOps(a, ads) : [])];
      return {
        summary: `Create ${o.type} campaign "${args.name}" (PAUSED), daily budget ${args.daily_budget}, ${args.bidding_strategy}${args.location_ids.length ? `, ${args.location_ids.length} location(s)` : ", all locations"}${args.language_ids.length ? `, ${args.language_ids.length} language(s)` : ""}`,
        changes: createChanges(args, o.type),
        ops,
      };
    },
    landed: (a, _b, after) => !!sameName(after, (a as { name: string }).name),
    result: (a, after) => ({ campaign_id: sameName(after, (a as { name: string }).name)!.id, name: (a as { name: string }).name, status: "PAUSED" as const, next_step: o.next }),
  });
}

// ------------------------------------------------------------------------------------------------------- Search
export const createSearchCampaign = createTool({
  name: "create_search_campaign",
  title: "Create Search campaign",
  description:
    "Creates a Search campaign, PAUSED, with its own daily budget, bidding (MANUAL_CPC, MAXIMIZE_CONVERSIONS with optional target CPA, MAXIMIZE_CONVERSION_VALUE with optional target ROAS, or TARGET_SPEND with optional max CPC), Google Search plus optionally search partners and Display, and optional locations, languages and dates, in one atomic request after a person approves it. Add ad groups, keywords and ads next; it serves only after resume_campaign.",
  input: z.object({ ...base, ...bidding(["MANUAL_CPC", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_SPEND"]), search_partners: z.boolean().default(false), display_expansion: z.boolean().default(false) }).refine(biddingOk, biddingMsg),
  type: "SEARCH",
  fields: (a) => ({ advertisingChannelType: "SEARCH", networkSettings: { targetGoogleSearch: true, targetSearchNetwork: a.search_partners, targetContentNetwork: a.display_expansion, targetPartnerSearchNetwork: false }, geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" } }),
  next: "Add an ad group (add_search_ad_group), keywords (add_keywords) and a responsive search ad (create_ad), then resume_campaign.",
});

// ----------------------------------------------------------------------------------------------------- Shopping
export const createShoppingCampaign = createTool({
  name: "create_shopping_campaign",
  title: "Create Shopping campaign",
  description: "Creates a Standard Shopping campaign, PAUSED, linked to a Merchant Center account that is already linked to this Google Ads account (get_merchant_center_links), with its own daily budget, bidding (MANUAL_CPC, TARGET_SPEND or MAXIMIZE_CONVERSION_VALUE), priority (0 low, 1 medium, 2 high), optional feed label, locations and languages, in one atomic request after a person approves it. It serves only after resume_campaign.",
  input: z.object({ ...base, ...bidding(["MANUAL_CPC", "TARGET_SPEND", "MAXIMIZE_CONVERSION_VALUE"]), merchant_center_id: idSchema, feed_label: z.string().trim().min(1).max(20).optional(), campaign_priority: z.number().int().min(0).max(2).default(0), enable_local: z.boolean().default(false) }).refine(biddingOk, biddingMsg),
  type: "SHOPPING",
  extraRead: async (a, ads) => {
    const links = await ads.query(new Gaql().select("product_link.merchant_center.merchant_center_id").from("product_link").where("product_link.type = 'MERCHANT_CENTER'"), { maxRows: 200 });
    if (!links.some((r) => String(pick(r, "product_link.merchant_center.merchant_center_id")) === a.merchant_center_id)) throw new ToolError("invalid_argument", `Merchant Center ${a.merchant_center_id} is not linked to this account. Link it first (link_merchant_center).`);
    return { merchant_linked: true };
  },
  fields: (a) => ({ advertisingChannelType: "SHOPPING", shoppingSetting: { merchantId: a.merchant_center_id, campaignPriority: a.campaign_priority, enableLocal: a.enable_local, ...(a.feed_label ? { feedLabel: a.feed_label } : {}) }, networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false } }),
  next: "Add a Shopping ad group (add_shopping_ad_group) and product groups, then resume_campaign.",
});

// ---------------------------------------------------------------------------------------------- Performance Max
export const createPmaxCampaign = createTool({
  name: "create_pmax_campaign",
  title: "Create Performance Max campaign",
  description: "Creates a Performance Max campaign, PAUSED, with its own daily budget, MAXIMIZE_CONVERSIONS (optional target CPA) or MAXIMIZE_CONVERSION_VALUE (optional target ROAS) bidding, optional Merchant Center feed, locations and languages, in one atomic request after a person approves it. Brand guidelines are turned off, so the business name and logos go into each asset group. Add an asset group (add_pmax_asset_group) before resuming it.",
  input: z.object({ ...base, ...bidding(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]), merchant_center_id: idSchema.optional() }).refine(biddingOk, biddingMsg),
  type: "PERFORMANCE_MAX",
  fields: (a) => ({ advertisingChannelType: "PERFORMANCE_MAX", brandGuidelinesEnabled: false, ...(a.merchant_center_id ? { shoppingSetting: { merchantId: a.merchant_center_id } } : {}) }),
  next: "Add an asset group with add_pmax_asset_group, then resume_campaign.",
});

// --------------------------------------------------------------------------------------------------- Demand Gen
export const createDemandgenCampaign = createTool({
  name: "create_demandgen_campaign",
  title: "Create Demand Gen campaign",
  description: "Creates a Demand Gen campaign (YouTube, Discover, Gmail and more), PAUSED, with its own non-shared daily budget (Google enforces a minimum, about 5 USD or the equivalent), bidding (MAXIMIZE_CONVERSIONS with optional target CPA, MAXIMIZE_CONVERSION_VALUE with optional target ROAS, or TARGET_SPEND for clicks), in one atomic request after a person approves it. Locations and languages are set on Demand Gen ad groups, not here. This is also the way to create YouTube video ads through the API.",
  input: z.object({ ...base, location_ids: z.array(idSchema).max(0).default([]).describe("Not used for Demand Gen: set locations on ad groups."), language_ids: z.array(idSchema).max(0).default([]), ...bidding(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_SPEND"]) }).refine(biddingOk, biddingMsg),
  type: "DEMAND_GEN",
  fields: () => ({ advertisingChannelType: "DEMAND_GEN" }),
  next: "Add an ad group (add_demandgen_ad_group) and an ad (add_demandgen_ad), then resume_campaign.",
});

// ------------------------------------------------------------------------------------------------------------- App
export const createAppCampaign = createTool({
  name: "create_app_campaign",
  title: "Create App campaign",
  description: "Creates an App campaign for installs of an Android (Google Play package name) or iOS (App Store id) app, PAUSED, with its own daily budget and a target cost per install, plus its ad group and an app ad with 2-5 headlines (30 chars) and 1-5 descriptions (90 chars), in one atomic request after a person approves it. It serves only after resume_campaign.",
  input: z.object({
    ...base,
    bidding_strategy: z.literal("TARGET_CPA").default("TARGET_CPA"),
    target_cost_per_install: z.number().positive().max(10_000),
    app_store: z.enum(["GOOGLE_APP_STORE", "APPLE_APP_STORE"]),
    app_id: z.string().trim().regex(/^([a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+|\d{6,12})$/, "a package name (com.example.app) or an App Store numeric id"),
    headlines: z.array(clean(30)).min(2).max(5),
    descriptions: z.array(clean(90)).min(1).max(5),
  }),
  type: "MULTI_CHANNEL (App)",
  fields: (a) => ({ advertisingChannelType: "MULTI_CHANNEL", advertisingChannelSubType: "APP_CAMPAIGN", appCampaignSetting: { appId: a.app_id, appStore: a.app_store, biddingStrategyGoalType: "OPTIMIZE_INSTALLS_TARGET_INSTALL_COST" }, targetCpa: { targetCpaMicros: String(toMicros(a.target_cost_per_install)) } }),
  extraOps: (a, ads) => {
    const campaign = temp(ads, "campaigns", 2);
    const group = temp(ads, "adGroups", 3);
    return [
      { adGroupOperation: { create: { resourceName: group, campaign, name: `${a.name} ad group`, status: "ENABLED" } } },
      { adGroupAdOperation: { create: { adGroup: group, status: "ENABLED", ad: { appAd: { headlines: a.headlines.map((t) => ({ text: t })), descriptions: a.descriptions.map((t) => ({ text: t })) } } } } },
    ];
  },
  next: "Review it, then resume_campaign.",
});
export const campaignCreateTools = [createSearchCampaign, createShoppingCampaign, createPmaxCampaign, createDemandgenCampaign, createAppCampaign];
