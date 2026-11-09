import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, fromMicros, lit, num, pick } from "../gaql";
import { assetContent, tailId } from "./campaign-reads";
import { Money, accountId, dateClause, dateFields, datesMsg, datesOk, googleRead, idSchema, ratio, round, str } from "./common";

const period = (a: { date_range: string; start_date?: string; end_date?: string }) => (a.start_date ? `${a.start_date}..${a.end_date}` : a.date_range);

/** The campaign must exist in this account and be Performance Max. */
export async function requirePmax(ads: GoogleAdsClient, campaignId: string) {
  const [r] = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.advertising_channel_type", "campaign.status").from("campaign").where(`campaign.id = ${lit.id(campaignId)}`).limit(1), { maxRows: 1 });
  if (!r) throw new ToolError("not_found", `No campaign ${campaignId} in this account.`);
  if (str(r, "campaign.advertising_channel_type") !== "PERFORMANCE_MAX") throw new ToolError("invalid_argument", `Campaign ${campaignId} is not a Performance Max campaign.`);
  return { name: str(r, "campaign.name"), status: str(r, "campaign.status") };
}

const pmaxScope = {
  account_id: accountId,
  campaign_id: idSchema.optional().describe("Only this Performance Max campaign."),
  asset_group_ids: z.array(idSchema).max(50).optional().describe("Only these asset groups."),
};
const scopeWhere = (q: Gaql, a: { campaign_id?: string; asset_group_ids?: string[] }) =>
  q.where(a.campaign_id && `campaign.id = ${lit.id(a.campaign_id)}`).where(a.asset_group_ids?.length ? `asset_group.id IN ${lit.list(a.asset_group_ids.map(lit.id))}` : undefined);

const perf = (r: Row) => {
  const impressions = num(pick(r, "metrics.impressions")), clicks = num(pick(r, "metrics.clicks")), cost = fromMicros(pick(r, "metrics.cost_micros")), conversions = num(pick(r, "metrics.conversions")), value = num(pick(r, "metrics.conversions_value"));
  return { impressions, clicks, cost: round(cost, 2)!, conversions: round(conversions, 2)!, conversion_value: round(value, 2)!, ctr: round(ratio(clicks, impressions)), cost_per_conversion: round(ratio(cost, conversions), 2), roas: round(ratio(value, cost)) };
};
const perfSchema = z.object({ impressions: z.number(), clicks: z.number(), cost: Money, conversions: z.number(), conversion_value: z.number(), ctr: z.number().nullable(), cost_per_conversion: Money.nullable(), roas: z.number().nullable() });

// ----------------------------------------------------------------------------------------------- get_pmax_asset_groups
export const getPmaxAssetGroups = googleRead({
  name: "get_pmax_asset_groups",
  title: "Performance Max asset groups",
  description: "Lists the asset groups of Performance Max campaigns with status, ad strength, final URLs and display paths, and their performance for a period. Fetched live.",
  input: z.object({ ...pmaxScope, ...dateFields }).refine(datesOk, datesMsg),
  output: z.object({ period: z.string(), asset_groups: z.array(z.object({ asset_group_id: z.string().min(1), campaign_id: z.string().nullable(), name: z.string().nullable(), status: z.string().nullable(), primary_status: z.string().nullable(), ad_strength: z.string().nullable(), final_urls: z.array(z.string()), path1: z.string().nullable(), path2: z.string().nullable(), performance: perfSchema })) }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    if (a.campaign_id) await requirePmax(ads, a.campaign_id);
    const base = ["asset_group.id", "campaign.id", "asset_group.name", "asset_group.status", "asset_group.primary_status", "asset_group.ad_strength", "asset_group.final_urls", "asset_group.path1", "asset_group.path2"];
    const [groups, metrics] = await Promise.all([
      ads.query(scopeWhere(new Gaql().select(...base).from("asset_group").where("asset_group.status != 'REMOVED'"), a), { maxRows: 1000 }),
      ads.query(scopeWhere(new Gaql().select("asset_group.id", "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value").from("asset_group").where(dateClause(a)), a), { maxRows: 10_000 }),
    ]);
    // A group with no activity in the period returns no metrics row: its counters are zero.
    const m = new Map(metrics.map((r) => [String(pick(r, "asset_group.id")), r]));
    return {
      period: period(a),
      asset_groups: groups.map((r) => {
        const id = String(pick(r, "asset_group.id") ?? "");
        return { asset_group_id: id, campaign_id: str(r, "campaign.id"), name: str(r, "asset_group.name"), status: str(r, "asset_group.status"), primary_status: str(r, "asset_group.primary_status"), ad_strength: str(r, "asset_group.ad_strength"), final_urls: (pick(r, "asset_group.final_urls") as string[] | undefined) ?? [], path1: str(r, "asset_group.path1"), path2: str(r, "asset_group.path2"), performance: perf(m.get(id) ?? {}) };
      }),
    };
  },
});

// -------------------------------------------------------------------------------------- asset group asset listings
const assetFields = ["asset.id", "asset.name", "asset.type", "asset.text_asset.text", "asset.image_asset.full_size.url", "asset.image_asset.full_size.width_pixels", "asset.image_asset.full_size.height_pixels", "asset.youtube_video_asset.youtube_video_id", "asset.final_urls", "asset.sitelink_asset.link_text", "asset.callout_asset.callout_text"];
const IMAGE_FIELD_TYPES = ["MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "PORTRAIT_MARKETING_IMAGE", "TALL_PORTRAIT_MARKETING_IMAGE", "LOGO", "LANDSCAPE_LOGO"] as const;
const groupAssetRow = z.object({
  asset_group_id: z.string().nullable(),
  asset_id: z.string().min(1),
  field_type: z.string().nullable(),
  status: z.string().nullable(),
  primary_status: z.string().nullable(),
  approval: z.string().nullable(),
  asset_type: z.string().nullable(),
  name: z.string().nullable(),
  text: z.string().nullable(),
  image: z.object({ url: z.string().nullable(), width: z.number().nullable(), height: z.number().nullable() }).nullable(),
  youtube_video_id: z.string().nullable(),
});
async function groupAssets(ads: GoogleAdsClient, a: { campaign_id?: string; asset_group_ids?: string[] }, fieldTypes?: readonly string[]) {
  const rows = await ads.query(
    scopeWhere(
      new Gaql()
        .select("asset_group.id", "asset_group_asset.field_type", "asset_group_asset.status", "asset_group_asset.primary_status", "asset_group_asset.policy_summary.approval_status", ...assetFields)
        .from("asset_group_asset")
        .where("asset_group_asset.status != 'REMOVED'")
        .where(fieldTypes && `asset_group_asset.field_type IN ${lit.list(fieldTypes.map((t) => `'${t}'`))}`),
      a,
    ),
    { maxRows: 10_000 },
  );
  return rows.map((r) => {
    const content = assetContent(r);
    const isImage = str(r, "asset.type") === "IMAGE";
    const n = (f: string) => (pick(r, f) === undefined ? null : num(pick(r, f)));
    return {
      asset_group_id: str(r, "asset_group.id"),
      asset_id: String(pick(r, "asset.id") ?? ""),
      field_type: str(r, "asset_group_asset.field_type"),
      status: str(r, "asset_group_asset.status"),
      primary_status: str(r, "asset_group_asset.primary_status"),
      approval: str(r, "asset_group_asset.policy_summary.approval_status"),
      asset_type: str(r, "asset.type"),
      name: str(r, "asset.name"),
      text: typeof content.text === "string" ? content.text : str(r, "asset.text_asset.text"),
      image: isImage ? { url: str(r, "asset.image_asset.full_size.url"), width: n("asset.image_asset.full_size.width_pixels"), height: n("asset.image_asset.full_size.height_pixels") } : null,
      youtube_video_id: str(r, "asset.youtube_video_asset.youtube_video_id"),
    };
  });
}
const needGroupScope = (a: { campaign_id?: string; asset_group_ids?: string[] }) => {
  if (!a.campaign_id && !a.asset_group_ids?.length) throw new ToolError("invalid_argument", "Give campaign_id or asset_group_ids.");
};

export const listPmaxAssetGroupAssets = googleRead({
  name: "list_pmax_asset_group_assets",
  title: "Asset group assets",
  description: "Lists every asset in Performance Max asset groups (headlines, long headlines, descriptions, business name, images, logos, videos, sitelinks and more) with its role (field type), status and approval. Give campaign_id or asset_group_ids. Fetched live.",
  input: z.object(pmaxScope),
  output: z.object({ assets: z.array(groupAssetRow), returned: z.number() }),
  handler: async (a, ctx) => {
    needGroupScope(a);
    if (a.campaign_id) await requirePmax(ctx.services.ads, a.campaign_id);
    const assets = await groupAssets(ctx.services.ads, a);
    return { assets, returned: assets.length };
  },
});

export const listPmaxAssetGroupImages = googleRead({
  name: "list_pmax_asset_group_images",
  title: "Asset group images",
  description: "Lists the images and logos in Performance Max asset groups (landscape, square, portrait and tall portrait marketing images, logos and landscape logos) with size, status and approval. Give campaign_id or asset_group_ids. Fetched live.",
  input: z.object(pmaxScope),
  output: z.object({ images: z.array(groupAssetRow), returned: z.number() }),
  handler: async (a, ctx) => {
    needGroupScope(a);
    if (a.campaign_id) await requirePmax(ctx.services.ads, a.campaign_id);
    const images = await groupAssets(ctx.services.ads, a, IMAGE_FIELD_TYPES);
    return { images, returned: images.length };
  },
});

// ---------------------------------------------------------------------------------------- get_pmax_asset_performance
export const getPmaxAssetPerformance = googleRead({
  name: "get_pmax_asset_performance",
  title: "Performance Max asset performance",
  description: "Performance of each asset in Performance Max asset groups for a period (impressions, clicks, cost, conversions, value), so weak assets can be replaced. Asset-level numbers describe the asset's share of combined ads, not a stand-alone ad. Give campaign_id or asset_group_ids. Fetched live.",
  input: z.object({ ...pmaxScope, ...dateFields, limit: z.number().int().min(1).max(1000).default(200) }).refine(datesOk, datesMsg),
  output: z.object({ period: z.string(), assets: z.array(z.object({ asset_group_id: z.string().nullable(), asset_id: z.string().min(1), field_type: z.string().nullable(), asset_type: z.string().nullable(), text: z.string().nullable(), youtube_video_id: z.string().nullable(), performance: perfSchema })), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    needGroupScope(a);
    const ads = ctx.services.ads;
    if (a.campaign_id) await requirePmax(ads, a.campaign_id);
    const rows = await ads.query(
      scopeWhere(new Gaql().select("asset_group.id", "asset_group_asset.field_type", "asset.id", "asset.type", "asset.text_asset.text", "asset.youtube_video_asset.youtube_video_id", "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value").from("asset_group_asset").where(dateClause(a)).where("asset_group_asset.status != 'REMOVED'"), a)
        .orderBy("metrics.impressions", "DESC")
        .limit(a.limit + 1),
      { maxRows: a.limit + 1, partial: true },
    );
    const shown = rows.slice(0, a.limit).map((r) => ({ asset_group_id: str(r, "asset_group.id"), asset_id: String(pick(r, "asset.id") ?? ""), field_type: str(r, "asset_group_asset.field_type"), asset_type: str(r, "asset.type"), text: str(r, "asset.text_asset.text"), youtube_video_id: str(r, "asset.youtube_video_asset.youtube_video_id"), performance: perf(r) }));
    return { period: period(a), assets: shown, returned: shown.length, truncated: rows.length > a.limit };
  },
});

// ---------------------------------------------------------------------------------- signals: audiences and themes
export const getPmaxAudienceSignals = googleRead({
  name: "get_pmax_audience_signals",
  title: "Performance Max audience signals",
  description: "Lists the audience signals on Performance Max asset groups, with the audience's name, description and approval. Signals are hints for Google's targeting, not restrictions. Give campaign_id or asset_group_ids. Fetched live.",
  input: z.object(pmaxScope),
  output: z.object({ signals: z.array(z.object({ asset_group_id: z.string().nullable(), audience_id: z.string().nullable(), name: z.string().nullable(), description: z.string().nullable(), approval: z.string().nullable() })) }),
  handler: async (a, ctx) => {
    needGroupScope(a);
    const ads = ctx.services.ads;
    if (a.campaign_id) await requirePmax(ads, a.campaign_id);
    const rows = await ads.query(scopeWhere(new Gaql().select("asset_group.id", "asset_group_signal.audience.audience", "asset_group_signal.approval_status").from("asset_group_signal").where("asset_group_signal.audience.audience IS NOT NULL"), a), { maxRows: 5000 });
    const ids = [...new Set(rows.map((r) => tailId(pick(r, "asset_group_signal.audience.audience"))).filter((x): x is string => !!x))];
    const info = new Map<string, Row>();
    if (ids.length) for (const r of await ads.query(new Gaql().select("audience.id", "audience.name", "audience.description").from("audience").where(`audience.id IN ${lit.list(ids.slice(0, 1000).map(lit.id))}`), { maxRows: 1000 })) info.set(String(pick(r, "audience.id")), r);
    return {
      signals: rows.map((r) => {
        const id = tailId(pick(r, "asset_group_signal.audience.audience"));
        const i = id ? info.get(id) : undefined;
        return { asset_group_id: str(r, "asset_group.id"), audience_id: id, name: i ? str(i, "audience.name") : null, description: i ? str(i, "audience.description") : null, approval: str(r, "asset_group_signal.approval_status") };
      }),
    };
  },
});

export const getPmaxSearchThemes = googleRead({
  name: "get_pmax_search_themes",
  title: "Performance Max search themes",
  description: "Lists the search themes (words or phrases describing what customers search for) on Performance Max asset groups, with approval status. Give campaign_id or asset_group_ids. Fetched live.",
  input: z.object(pmaxScope),
  output: z.object({ themes: z.array(z.object({ asset_group_id: z.string().nullable(), text: z.string().nullable(), approval: z.string().nullable(), signal_resource: z.string().nullable() })) }),
  handler: async (a, ctx) => {
    needGroupScope(a);
    if (a.campaign_id) await requirePmax(ctx.services.ads, a.campaign_id);
    const rows = await ctx.services.ads.query(scopeWhere(new Gaql().select("asset_group.id", "asset_group_signal.search_theme.text", "asset_group_signal.approval_status", "asset_group_signal.resource_name").from("asset_group_signal").where("asset_group_signal.search_theme.text IS NOT NULL"), a), { maxRows: 5000 });
    return { themes: rows.map((r) => ({ asset_group_id: str(r, "asset_group.id"), text: str(r, "asset_group_signal.search_theme.text"), approval: str(r, "asset_group_signal.approval_status"), signal_resource: str(r, "asset_group_signal.resource_name") })) };
  },
});

// ------------------------------------------------------------------------------------------ get_pmax_conversion_goals
export const getPmaxConversionGoals = googleRead({
  name: "get_pmax_conversion_goals",
  title: "Performance Max conversion goals",
  description: "Shows which conversion goals (category and origin, for example PURCHASE from WEBSITE) a Performance Max campaign bids for. Biddable goals are what Smart Bidding optimises toward. Fetched live.",
  input: z.object({ account_id: accountId, campaign_id: idSchema }),
  output: z.object({ campaign_id: z.string(), goals: z.array(z.object({ category: z.string().nullable(), origin: z.string().nullable(), biddable: z.boolean() })) }),
  handler: async (a, ctx) => {
    await requirePmax(ctx.services.ads, a.campaign_id);
    const rows = await ctx.services.ads.query(new Gaql().select("campaign.id", "campaign_conversion_goal.category", "campaign_conversion_goal.origin", "campaign_conversion_goal.biddable").from("campaign_conversion_goal").where(`campaign.id = ${lit.id(a.campaign_id)}`), { maxRows: 500 });
    return { campaign_id: a.campaign_id, goals: rows.map((r) => ({ category: str(r, "campaign_conversion_goal.category"), origin: str(r, "campaign_conversion_goal.origin"), biddable: pick(r, "campaign_conversion_goal.biddable") === true })) };
  },
});

// ------------------------------------------------------------------------------------ get_asset_group_listing_filters
export const getAssetGroupListingFilters = googleRead({
  name: "get_asset_group_listing_filters",
  title: "Asset group listing filters",
  description: "Shows the product filter tree of Performance Max asset groups with a product feed: which products (by brand, category, item id, condition, product type, custom label) each asset group advertises or excludes. Give campaign_id or asset_group_ids. Fetched live.",
  input: z.object(pmaxScope),
  output: z.object({ filters: z.array(z.object({ asset_group_id: z.string().nullable(), filter_id: z.string().min(1), parent_filter_id: z.string().nullable(), type: z.string().nullable(), listing_source: z.string().nullable(), dimension: z.string().nullable(), value: z.string().nullable() })) }),
  handler: async (a, ctx) => {
    needGroupScope(a);
    if (a.campaign_id) await requirePmax(ctx.services.ads, a.campaign_id);
    const cv = "asset_group_listing_group_filter.case_value";
    const dims: [string, string][] = [["product_brand", `${cv}.product_brand.value`], ["product_item_id", `${cv}.product_item_id.value`], ["product_condition", `${cv}.product_condition.condition`], ["product_type", `${cv}.product_type.value`], ["product_category", `${cv}.product_category.category_id`], ["product_channel", `${cv}.product_channel.channel`], ["product_custom_attribute", `${cv}.product_custom_attribute.value`]];
    const rows = await ctx.services.ads.query(scopeWhere(new Gaql().select("asset_group.id", "asset_group_listing_group_filter.id", "asset_group_listing_group_filter.type", "asset_group_listing_group_filter.listing_source", "asset_group_listing_group_filter.parent_listing_group_filter", ...dims.map((d) => d[1])).from("asset_group_listing_group_filter"), a), { maxRows: 10_000 });
    return {
      filters: rows.map((r) => {
        const d = dims.find(([, f]) => pick(r, f) !== undefined);
        const parent = tailId(pick(r, "asset_group_listing_group_filter.parent_listing_group_filter"));
        return { asset_group_id: str(r, "asset_group.id"), filter_id: String(pick(r, "asset_group_listing_group_filter.id") ?? ""), parent_filter_id: parent ? parent.split("~").pop()! : null, type: str(r, "asset_group_listing_group_filter.type"), listing_source: str(r, "asset_group_listing_group_filter.listing_source"), dimension: d ? d[0] : null, value: d ? String(pick(r, d[1])) : null };
      }),
    };
  },
});

// --------------------------------------------------------------------------------- PMax search terms and categories
export const analyzePmaxSearchTerms = googleRead({
  name: "analyze_pmax_search_terms",
  title: "Analyze Performance Max search terms",
  description: "Shows the search terms that triggered a Performance Max campaign in a period, with clicks, cost, conversions and value, and flags terms that spent above a threshold without converting (candidates for negative keywords or brand exclusions). Computed from live campaign search term data.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, ...dateFields, min_cost_without_conversion: z.number().min(0).max(1_000_000).default(10), limit: z.number().int().min(1).max(500).default(100) }).refine(datesOk, datesMsg),
  output: z.object({ period: z.string(), terms: z.array(z.object({ search_term: z.string().nullable(), wasted: z.boolean(), performance: perfSchema })), wasted_cost: Money.describe("Cost of the flagged terms among the returned ones."), analyzed_cost: Money.describe("Cost of the returned terms only (the highest-cost ones). When truncated is true, the campaign's other terms are not included."), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    await requirePmax(ads, a.campaign_id);
    const rows = await ads.query(
      new Gaql().select("campaign_search_term_view.search_term", "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value").from("campaign_search_term_view").where(`campaign.id = ${lit.id(a.campaign_id)}`).where(dateClause(a)).orderBy("metrics.cost_micros", "DESC").limit(a.limit + 1),
      { maxRows: a.limit + 1, partial: true },
    );
    const terms = rows.slice(0, a.limit).map((r) => {
      const p = perf(r);
      return { search_term: str(r, "campaign_search_term_view.search_term"), wasted: p.conversions === 0 && p.cost >= a.min_cost_without_conversion, performance: p };
    });
    const sum = (xs: typeof terms) => round(xs.reduce((s, t) => s + t.performance.cost, 0), 2)!;
    return { period: period(a), terms, wasted_cost: sum(terms.filter((t) => t.wasted)), analyzed_cost: sum(terms), returned: terms.length, truncated: rows.length > a.limit };
  },
});

export const analyzePmaxSearchCategories = googleRead({
  name: "analyze_pmax_search_categories",
  title: "Analyze Performance Max search categories",
  description: "Groups a Performance Max campaign's searches into Google's search categories (search term insights) for a period, with impressions, clicks, conversions and value per category, sorted by conversions. Cost is not available per category. Historical data starts March 2023. Fetched live.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, ...dateFields, limit: z.number().int().min(1).max(500).default(100) }).refine(datesOk, datesMsg),
  output: z.object({ period: z.string(), categories: z.array(z.object({ category_id: z.string().nullable(), category_label: z.string().nullable(), impressions: z.number(), clicks: z.number(), conversions: z.number(), conversion_value: z.number(), conversion_share: z.number().nullable().describe("Share of the conversions of every category in the period, not only the returned ones.") })), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    await requirePmax(ads, a.campaign_id);
    // Search term insights must be filtered on a single campaign id (insight-specific field).
    const rows = await ads.query(
      new Gaql().select("campaign_search_term_insight.id", "campaign_search_term_insight.category_label", "metrics.impressions", "metrics.clicks", "metrics.conversions", "metrics.conversions_value").from("campaign_search_term_insight").where(`campaign_search_term_insight.campaign_id = ${lit.id(a.campaign_id)}`).where(dateClause(a)).orderBy("metrics.conversions", "DESC"),
      { maxRows: 10_000 },
    );
    // Shares are of every category, so all rows are read (the client refuses rather than cut past 10,000) and only the top `limit` shown.
    const total = rows.reduce((s, r) => s + num(pick(r, "metrics.conversions")), 0);
    const shown = rows.slice(0, a.limit);
    return {
      period: period(a),
      returned: shown.length,
      truncated: rows.length > a.limit,
      categories: shown.map((r) => {
        const conv = num(pick(r, "metrics.conversions"));
        return { category_id: str(r, "campaign_search_term_insight.id"), category_label: str(r, "campaign_search_term_insight.category_label"), impressions: num(pick(r, "metrics.impressions")), clicks: num(pick(r, "metrics.clicks")), conversions: round(conv, 2)!, conversion_value: round(num(pick(r, "metrics.conversions_value")), 2)!, conversion_share: round(ratio(conv, total)) };
      }),
    };
  },
});

export const pmaxReadTools = [getPmaxAssetGroups, listPmaxAssetGroupAssets, listPmaxAssetGroupImages, getPmaxAssetPerformance, getPmaxAudienceSignals, getPmaxSearchThemes, getPmaxConversionGoals, getAssetGroupListingFilters, analyzePmaxSearchTerms, analyzePmaxSearchCategories];
