import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, fromMicros, lit, num, pick } from "../gaql";
import { IMAGE_SPECS, type ImageFieldType, MAX_IMAGE_BYTES, checkImage, imageInfo } from "../media";
import { assetContent } from "./campaign-reads";
import { accountId, googleRead, idSchema, str } from "./common";
import { imageData, stateWrite, temp, withImages } from "./write-kit";

/**
 * Business profile, asset preparation and guidance tools. Decisions recorded with the project owner: the business profile
 * is the Google Ads account's own business assets (no separate storage); validate_video uses the YouTube Data API;
 * suggest_ad_content returns the account's real ad text, performance labels and limits for the AI client to write from:
 * this server does not generate copy.
 */
const httpsUrl = z.string().url().max(2048).refine((u) => u.startsWith("https://"), "https URL");
/** Text limits verified in the v26 docs used by the creation tools (asset requirements, RDA guide, ad references). */
export const TEXT_LIMITS: Record<string, number> = { HEADLINE: 30, LONG_HEADLINE: 90, DESCRIPTION: 90, BUSINESS_NAME: 25, CALLOUT: 25, SITELINK_TEXT: 25, SITELINK_DESCRIPTION: 35, STRUCTURED_SNIPPET_VALUE: 25, SEARCH_THEME: 80 };

const domainOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

async function accountBasics(ads: GoogleAdsClient) {
  const [c] = await ads.query(new Gaql().select("customer.id", "customer.descriptive_name", "customer.currency_code", "customer.time_zone", "customer.auto_tagging_enabled").from("customer").limit(1), { maxRows: 1 });
  return { id: str(c ?? {}, "customer.id"), name: str(c ?? {}, "customer.descriptive_name"), currency: str(c ?? {}, "customer.currency_code"), time_zone: str(c ?? {}, "customer.time_zone"), auto_tagging: pick(c ?? {}, "customer.auto_tagging_enabled") === true };
}
async function accountBrandAssets(ads: GoogleAdsClient) {
  const rows = await ads.query(new Gaql().select("asset.id", "asset.type", "asset.name", "asset.text_asset.text", "asset.image_asset.full_size.url", "customer_asset.field_type", "customer_asset.status").from("customer_asset").where("customer_asset.field_type IN ('BUSINESS_NAME', 'BUSINESS_LOGO')").where("customer_asset.status != 'REMOVED'"), { maxRows: 50 });
  return rows.map((r) => ({ asset_id: String(pick(r, "asset.id")), field_type: str(r, "customer_asset.field_type") ?? "", text: str(r, "asset.text_asset.text"), image_url: str(r, "asset.image_asset.full_size.url"), name: str(r, "asset.name") })).sort((x, y) => `${x.field_type}${x.asset_id}`.localeCompare(`${y.field_type}${y.asset_id}`));
}
async function landingDomains(ads: GoogleAdsClient) {
  const rows = await ads.query(new Gaql().select("ad_group_ad.ad.final_urls", "metrics.impressions").from("ad_group_ad").where("ad_group_ad.status != 'REMOVED'").where("segments.date DURING LAST_30_DAYS"), { maxRows: 5000 });
  const counts = new Map<string, number>();
  for (const r of rows) for (const u of (pick(r, "ad_group_ad.ad.final_urls") as string[] | undefined) ?? []) {
    const d = domainOf(u);
    if (d) counts.set(d, (counts.get(d) ?? 0) + num(pick(r, "metrics.impressions")));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([domain, impressions]) => ({ domain, impressions }));
}

// ------------------------------------------------------------------------------------------------ get_business_profile
const profileSchema = z.object({
  account: z.object({ id: z.string().nullable(), name: z.string().nullable(), currency: z.string().nullable(), time_zone: z.string().nullable(), auto_tagging: z.boolean() }),
  business_name: z.string().nullable().describe("Account-level BUSINESS_NAME asset, if set."),
  business_logos: z.array(z.object({ asset_id: z.string(), image_url: z.string().nullable() })),
  landing_domains: z.array(z.object({ domain: z.string(), impressions: z.number() })).describe("Domains of ad final URLs, by impressions in the last 30 days."),
});
export const getBusinessProfile = googleRead({
  name: "get_business_profile",
  title: "Business profile",
  description: "Reads the business information held in the Google Ads account itself: account name, currency and time zone, the account-level business name and business logo assets, and the landing page domains ads point to (last 30 days, by impressions). Nothing is stored by this server. Fetched live.",
  input: z.object({ account_id: accountId }),
  output: profileSchema,
  handler: async (_a, ctx) => {
    const ads = ctx.services.ads;
    const [account, brand, domains] = await Promise.all([accountBasics(ads), accountBrandAssets(ads), landingDomains(ads)]);
    return { account, business_name: brand.find((b) => b.field_type === "BUSINESS_NAME")?.text ?? null, business_logos: brand.filter((b) => b.field_type === "BUSINESS_LOGO").map((b) => ({ asset_id: b.asset_id, image_url: b.image_url })), landing_domains: domains };
  },
});

// ----------------------------------------------------------------------------------------------- save_business_profile
export const saveBusinessProfile = stateWrite({
  name: "save_business_profile",
  title: "Save business name and logo",
  risk: "write",
  description: "Sets the account-level business name (max 25 characters) and/or business logo (square 1:1, at least 128x128, from an https URL) used by Google's automated formats, replacing the current ones in one atomic request, after approval. Only the Google Ads account's own business assets are changed; nothing is stored elsewhere. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, business_name: z.string().trim().min(1).max(25).regex(/^[^\u0000-\u001f]+$/).optional(), logo_url: httpsUrl.optional() }).refine((v) => v.business_name || v.logo_url, "give business_name and/or logo_url"),
  output: z.object({ business_name: z.string().nullable(), business_logo_asset_id: z.string().nullable() }),
  timeoutMs: 120_000,
  read: async (a, ads, svc) => withImages({ assets: await accountBrandAssets(ads) }, svc, a.logo_url ? [{ url: a.logo_url, field: "LOGO" }] : []),
  build: (a, s, ads) => {
    const ops: Row[] = [];
    const changes: Change[] = [];
    const cur = (f: string) => s.assets.filter((x) => x.field_type === f);
    const unlink = (f: string) => cur(f).forEach((x) => ops.push({ customerAssetOperation: { remove: `customers/${ads.customerId}/customerAssets/${x.asset_id}~${f}` } }));
    let n = 1;
    if (a.business_name && cur("BUSINESS_NAME")[0]?.text !== a.business_name) {
      unlink("BUSINESS_NAME");
      const t = temp(ads, "assets", n++);
      ops.push({ assetOperation: { create: { resourceName: t, textAsset: { text: a.business_name } } } }, { customerAssetOperation: { create: { asset: t, fieldType: "BUSINESS_NAME" } } });
      changes.push({ resource: "account", id: ads.customerId, field: "business_name", before: cur("BUSINESS_NAME")[0]?.text ?? null, after: a.business_name, unit: "text", effect: "neutral" });
    }
    if (a.logo_url) {
      const name = `business_logo-${s.image_sha256[a.logo_url]!.slice(0, 16)}`;
      if (!(cur("BUSINESS_LOGO").length === 1 && cur("BUSINESS_LOGO")[0]!.name === name)) {
        unlink("BUSINESS_LOGO");
        const t = temp(ads, "assets", n++);
        ops.push({ assetOperation: { create: { resourceName: t, name, imageAsset: { data: imageData(s, a.logo_url).data } } } }, { customerAssetOperation: { create: { asset: t, fieldType: "BUSINESS_LOGO" } } });
        changes.push({ resource: "account", id: ads.customerId, field: "business_logo", before: cur("BUSINESS_LOGO")[0]?.asset_id ?? null, after: `${a.logo_url} sha256:${s.image_sha256[a.logo_url]!.slice(0, 12)}`, unit: "text", effect: "neutral" });
      }
    }
    if (!ops.length) throw new ToolError("invalid_argument", "Nothing would change: the account already has this business name and logo.");
    return { summary: `Account business profile: ${changes.map((c) => `${c.field} -> ${c.after}`).join("; ")}`, changes, ops };
  },
  landed: (a, _b, after) => (!a.business_name || after.assets.some((x) => x.field_type === "BUSINESS_NAME" && x.text === a.business_name)) && (!a.logo_url || after.assets.some((x) => x.field_type === "BUSINESS_LOGO" && x.name === `business_logo-${after.image_sha256[a.logo_url!]!.slice(0, 16)}`)),
  result: (_a, after) => ({ business_name: after.assets.find((x) => x.field_type === "BUSINESS_NAME")?.text ?? null, business_logo_asset_id: after.assets.find((x) => x.field_type === "BUSINESS_LOGO")?.asset_id ?? null }),
});

// ---------------------------------------------------------------------------------------------- infer_business_profile
const meta = (html: string, re: RegExp) => {
  const m = re.exec(html);
  return m ? m[1]!.replace(/\s+/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim().slice(0, 300) : null;
};
export const inferBusinessProfile = googleRead({
  name: "infer_business_profile",
  title: "Infer business profile",
  description:
    "Gathers evidence about what the business sells and where, from the account and (optionally) its website, and says where each fact came from: account name, main landing domains, campaign types in use, top keywords and search terms by cost (last 30 days), conversion goal categories, top targeted countries, and the website's title, description and site name. It reports evidence; it does not guess beyond it.",
  input: z.object({ account_id: accountId, website_url: httpsUrl.optional().describe("Read the page's title and description (public https page; no redirects).") }),
  output: z.object({
    account_name: z.string().nullable(),
    landing_domains: z.array(z.object({ domain: z.string(), impressions: z.number() })),
    campaign_types: z.array(z.object({ type: z.string(), campaigns: z.number() })),
    top_keywords: z.array(z.object({ text: z.string(), cost: z.number() })),
    top_search_terms: z.array(z.object({ text: z.string(), cost: z.number() })),
    conversion_categories: z.array(z.string()),
    website: z.object({ url: z.string(), title: z.string().nullable(), description: z.string().nullable(), site_name: z.string().nullable() }).nullable(),
    sources: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const [basics, domains, types, kws, terms, convs] = await Promise.all([
      accountBasics(ads),
      landingDomains(ads),
      ads.query(new Gaql().select("campaign.id", "campaign.advertising_channel_type").from("campaign").where("campaign.status != 'REMOVED'"), { maxRows: 5000 }),
      ads.query(new Gaql().select("ad_group_criterion.keyword.text", "metrics.cost_micros").from("keyword_view").where("segments.date DURING LAST_30_DAYS").orderBy("metrics.cost_micros", "DESC").limit(20), { maxRows: 20 }),
      ads.query(new Gaql().select("search_term_view.search_term", "metrics.cost_micros").from("search_term_view").where("segments.date DURING LAST_30_DAYS").orderBy("metrics.cost_micros", "DESC").limit(20), { maxRows: 20 }),
      ads.query(new Gaql().select("conversion_action.category").from("conversion_action").where("conversion_action.status = 'ENABLED'"), { maxRows: 500 }),
    ]);
    const typeCounts = new Map<string, number>();
    for (const r of types) typeCounts.set(String(pick(r, "campaign.advertising_channel_type")), (typeCounts.get(String(pick(r, "campaign.advertising_channel_type"))) ?? 0) + 1);
    let website = null;
    const sources = ["Google Ads account (live)"];
    if (a.website_url) {
      const html = await ctx.services.fetchPage(a.website_url);
      website = { url: a.website_url, title: meta(html, /<title[^>]*>([^<]{1,500})<\/title>/i), description: meta(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,1000})["']/i), site_name: meta(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,300})["']/i) };
      sources.push(`website ${a.website_url} (title and meta tags only)`);
    }
    return {
      account_name: basics.name,
      landing_domains: domains,
      campaign_types: [...typeCounts.entries()].map(([type, campaigns]) => ({ type, campaigns })).sort((x, y) => y.campaigns - x.campaigns),
      top_keywords: kws.map((r) => ({ text: str(r, "ad_group_criterion.keyword.text") ?? "", cost: Math.round(fromMicros(pick(r, "metrics.cost_micros")) * 100) / 100 })),
      top_search_terms: terms.map((r) => ({ text: str(r, "search_term_view.search_term") ?? "", cost: Math.round(fromMicros(pick(r, "metrics.cost_micros")) * 100) / 100 })),
      conversion_categories: [...new Set(convs.map((r) => str(r, "conversion_action.category")).filter((x): x is string => !!x))].sort(),
      website,
      sources,
    };
  },
});

// -------------------------------------------------------------------------------------------- select_google_campaign_type
const GOALS = ["online_sales", "leads", "website_traffic", "app_installs", "brand_awareness_video", "local_store_visits"] as const;
export const selectGoogleCampaignType = googleRead({
  name: "select_google_campaign_type",
  title: "Choose a campaign type",
  description:
    "Recommends Google Ads campaign types for a goal, checked against this account: whether a Merchant Center account is linked (needed for Shopping and feed-based Performance Max), whether conversion tracking is set up (needed for conversion-based bidding and Performance Max), and what the API can create (Video campaigns cannot be created through the API; Demand Gen is the API route for YouTube video ads). Each recommendation lists what is missing.",
  input: z.object({ account_id: accountId, goal: z.enum(GOALS) }),
  output: z.object({ goal: z.string(), account: z.object({ merchant_center_linked: z.boolean(), enabled_conversion_actions: z.number() }), recommendations: z.array(z.object({ campaign_type: z.string(), create_with: z.string(), why: z.string(), missing: z.array(z.string()) })) }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const [links, convs] = await Promise.all([
      ads.query(new Gaql().select("product_link.product_link_id").from("product_link").where("product_link.type = 'MERCHANT_CENTER'"), { maxRows: 50 }),
      ads.query(new Gaql().select("conversion_action.id").from("conversion_action").where("conversion_action.status = 'ENABLED'"), { maxRows: 500 }),
    ]);
    const mc = links.length > 0;
    const conv = convs.length;
    const needConv = conv === 0 ? ["conversion tracking (create_conversion_action) for conversion-based bidding"] : [];
    const needMc = mc ? [] : ["a linked Merchant Center account (link_merchant_center)"];
    const r = (campaign_type: string, create_with: string, why: string, missing: string[]) => ({ campaign_type, create_with, why, missing });
    const recs: ReturnType<typeof r>[] = [];
    if (a.goal === "online_sales") recs.push(r("PERFORMANCE_MAX", "create_pmax_campaign", "Serves across all Google channels and optimises to conversions or value; with a product feed it shows products.", [...needConv]), r("SHOPPING", "create_shopping_campaign", "Product listing ads from the Merchant Center feed with manual control over product group bids.", [...needMc]), r("SEARCH", "create_search_campaign", "Ads for people searching for what you sell, with keyword-level control.", []));
    if (a.goal === "leads") recs.push(r("SEARCH", "create_search_campaign", "Captures people searching for the service; works with lead form and call assets.", needConv), r("PERFORMANCE_MAX", "create_pmax_campaign", "Finds leads across all channels when conversion tracking is reliable.", needConv));
    if (a.goal === "website_traffic") recs.push(r("SEARCH", "create_search_campaign", "TARGET_SPEND (maximize clicks) bidding buys clicks from relevant searches.", []), r("DEMAND_GEN", "create_demandgen_campaign", "Visual ads on YouTube, Discover and Gmail with click-based bidding.", []));
    if (a.goal === "app_installs") recs.push(r("APP (MULTI_CHANNEL)", "create_app_campaign", "Google's campaign type for installs across Search, Play, YouTube and Display; bids to a target cost per install.", []));
    if (a.goal === "brand_awareness_video") recs.push(r("DEMAND_GEN", "create_demandgen_campaign", "The API-creatable way to run YouTube video and image ads; Video campaigns cannot be created through the Google Ads API (v26 Video overview).", []));
    if (a.goal === "local_store_visits") recs.push(r("SEARCH", "create_search_campaign", "Location and radius targeting (update_location_targeting, add_campaign_proximity) with call and location assets.", []), r("PERFORMANCE_MAX", "create_pmax_campaign", "Can optimise to store visits when the account is eligible for store visit conversions.", needConv));
    return { goal: a.goal, account: { merchant_center_linked: mc, enabled_conversion_actions: conv }, recommendations: recs };
  },
});

// ------------------------------------------------------------------------------------------------------ help_user_upload
export const helpUserUpload = googleRead({
  name: "help_user_upload",
  title: "How to provide images and videos",
  description: "Explains how to give this server images and videos for ads: images as public https URLs (PNG, JPEG or GIF, at most 5120 KB, the aspect ratios and minimum sizes per image type below, checked before upload), videos as YouTube video ids (public or unlisted, embeddable), and texts with their character limits. Use validate_and_prepare_assets to check files before creating ads.",
  accountScope: "none",
  input: z.object({}),
  output: z.object({ images: z.object({ how: z.string(), formats: z.array(z.string()), max_kb: z.number(), types: z.array(z.object({ field_type: z.string(), spec: z.string() })) }), videos: z.object({ how: z.string() }), text_limits: z.record(z.string(), z.number()) }),
  permissions: { platformPermissions: [], notes: "Guidance only: calls no ad platform." },
  handler: async () => ({
    images: { how: "Host each image at a public https URL (no login, no redirect) and pass the URL; the server downloads it, checks it, and uploads the exact bytes you approved.", formats: ["PNG", "JPEG", "GIF"], max_kb: MAX_IMAGE_BYTES / 1024, types: (Object.keys(IMAGE_SPECS) as ImageFieldType[]).map((f) => ({ field_type: f, spec: IMAGE_SPECS[f].label })) },
    videos: { how: "Upload the video to YouTube (public or unlisted, embeddable) and pass its 11-character video id; validate_video checks it." },
    text_limits: TEXT_LIMITS,
  }),
});

// ----------------------------------------------------------------------------------------- validate_and_prepare_assets
export const validateAndPrepareAssets = googleRead({
  name: "validate_and_prepare_assets",
  title: "Validate assets",
  description: "Checks images (downloaded from https URLs: type, size, aspect ratio and minimum dimensions for the intended image type) and texts (character limits for the intended field) before creating ads, and returns every problem found, plus each image's dimensions and SHA-256. Nothing is uploaded or changed.",
  input: z.object({ account_id: accountId, images: z.array(z.object({ url: httpsUrl, field_type: z.enum(Object.keys(IMAGE_SPECS) as [ImageFieldType, ...ImageFieldType[]]) })).max(30).default([]), texts: z.array(z.object({ field_type: z.enum(Object.keys(TEXT_LIMITS) as [string, ...string[]]), text: z.string().max(500) })).max(100).default([]) }).refine((v) => v.images.length + v.texts.length > 0, "give images or texts"),
  output: z.object({ ok: z.boolean(), images: z.array(z.object({ url: z.string(), field_type: z.string(), ok: z.boolean(), problems: z.array(z.string()), width: z.number().nullable(), height: z.number().nullable(), bytes: z.number().nullable(), mime: z.string().nullable(), sha256: z.string().nullable() })), texts: z.array(z.object({ field_type: z.string(), text: z.string(), ok: z.boolean(), length: z.number(), limit: z.number() })) }),
  handler: async (a, ctx) => {
    const images = [];
    for (const im of a.images) {
      try {
        const info = imageInfo(await ctx.services.fetchImage(im.url));
        const problems = checkImage(info, im.field_type);
        images.push({ url: im.url, field_type: im.field_type, ok: problems.length === 0, problems, width: info.width, height: info.height, bytes: info.bytes, mime: info.mime, sha256: info.sha256 });
      } catch (e) {
        images.push({ url: im.url, field_type: im.field_type, ok: false, problems: [e instanceof ToolError ? e.message : "could not be read"], width: null, height: null, bytes: null, mime: null, sha256: null });
      }
    }
    const texts = a.texts.map((t) => ({ field_type: t.field_type, text: t.text, ok: t.text.trim().length > 0 && [...t.text].length <= TEXT_LIMITS[t.field_type]!, length: [...t.text].length, limit: TEXT_LIMITS[t.field_type]! }));
    return { ok: images.every((i) => i.ok) && texts.every((t) => t.ok), images, texts };
  },
});

// ------------------------------------------------------------------------------------------------------- validate_video
export const validateVideo = googleRead({
  name: "validate_video",
  title: "Validate YouTube videos",
  description: "Checks YouTube videos for use in ads with the YouTube Data API: that each exists, finished processing, is public or unlisted, is embeddable, is at least the minimum length (10 seconds for Performance Max), and reports made-for-kids, region restrictions and the aspect ratio of its player. Needs YOUTUBE_API_KEY on the server; without it the tool reports that it is unavailable.",
  input: z.object({ account_id: accountId, video_ids: z.array(z.string().regex(/^[\w-]{11}$/, "11-character YouTube video id")).min(1).max(50), min_duration_seconds: z.number().int().min(0).max(3600).default(10) }),
  output: z.object({ ok: z.boolean(), videos: z.array(z.object({ id: z.string(), found: z.boolean(), ok: z.boolean(), problems: z.array(z.string()), title: z.string().nullable(), duration_seconds: z.number().nullable(), privacy_status: z.string().nullable(), embeddable: z.boolean().nullable(), made_for_kids: z.boolean().nullable(), region_blocked: z.array(z.string()), aspect_ratio: z.number().nullable() })) }),
  handler: async (a, ctx) => {
    if (!ctx.services.youtube) throw new ToolError("unsupported", "Video validation needs the YouTube Data API: the server operator must set YOUTUBE_API_KEY.");
    const found = new Map((await ctx.services.youtube.videos([...new Set(a.video_ids)])).map((v) => [v.id, v]));
    const videos = a.video_ids.map((id) => {
      const v = found.get(id);
      if (!v) return { id, found: false, ok: false, problems: ["not found, private to another account, or deleted"], title: null, duration_seconds: null, privacy_status: null, embeddable: null, made_for_kids: null, region_blocked: [], aspect_ratio: null };
      const problems: string[] = [];
      if (v.upload_status && v.upload_status !== "processed") problems.push(`upload status is ${v.upload_status}`);
      if (v.privacy_status === "private") problems.push("the video is private; make it public or unlisted");
      if (v.embeddable === false) problems.push("embedding is disabled");
      if (v.duration_seconds !== null && v.duration_seconds < a.min_duration_seconds) problems.push(`it is ${v.duration_seconds}s; at least ${a.min_duration_seconds}s is required`);
      return { id, found: true, ok: problems.length === 0, problems, title: v.title, duration_seconds: v.duration_seconds, privacy_status: v.privacy_status, embeddable: v.embeddable, made_for_kids: v.made_for_kids, region_blocked: v.region_blocked, aspect_ratio: v.aspect_ratio };
    });
    return { ok: videos.every((v) => v.ok), videos };
  },
});

// --------------------------------------------------------------------------------------------------- suggest_ad_content
export const suggestAdContent = googleRead({
  name: "suggest_ad_content",
  title: "Material for new ad text",
  description:
    "Gives the AI client what it needs to write new ad text, from this account: the existing headlines and descriptions of responsive search ads with Google's performance label for each (BEST, GOOD, LOW, LEARNING), the top search terms by conversions, landing pages, and the character limits. This server does not write copy itself; draft the text from this material and create it with create_ad or update_ad_headlines (both go through approval).",
  input: z.object({ account_id: accountId, campaign_id: idSchema.optional(), ad_group_id: idSchema.optional() }),
  output: z.object({ assets: z.array(z.object({ field_type: z.string().nullable(), text: z.string().nullable(), performance_label: z.string().nullable(), ad_group_id: z.string().nullable() })), top_search_terms: z.array(z.object({ text: z.string(), conversions: z.number(), clicks: z.number() })), landing_pages: z.array(z.string()), limits: z.record(z.string(), z.number()) }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const scope = (q: Gaql) => q.where(a.campaign_id && `campaign.id = ${lit.id(a.campaign_id)}`).where(a.ad_group_id && `ad_group.id = ${lit.id(a.ad_group_id)}`);
    const [assetRows, terms, urls] = await Promise.all([
      ads.query(scope(new Gaql().select("ad_group.id", "ad_group_ad_asset_view.field_type", "ad_group_ad_asset_view.performance_label", "asset.text_asset.text", "asset.type").from("ad_group_ad_asset_view").where("ad_group_ad_asset_view.field_type IN ('HEADLINE', 'DESCRIPTION')").where("ad_group_ad_asset_view.enabled = TRUE")), { maxRows: 2000 }),
      ads.query(scope(new Gaql().select("search_term_view.search_term", "metrics.conversions", "metrics.clicks").from("search_term_view").where("segments.date DURING LAST_30_DAYS").orderBy("metrics.conversions", "DESC").limit(25)), { maxRows: 25 }),
      ads.query(scope(new Gaql().select("ad_group_ad.ad.final_urls").from("ad_group_ad").where("ad_group_ad.status = 'ENABLED'")), { maxRows: 500 }),
    ]);
    return {
      assets: assetRows.map((r) => ({ field_type: str(r, "ad_group_ad_asset_view.field_type"), text: (assetContent(r).text as string | undefined) ?? str(r, "asset.text_asset.text"), performance_label: str(r, "ad_group_ad_asset_view.performance_label"), ad_group_id: str(r, "ad_group.id") })),
      top_search_terms: terms.map((r) => ({ text: str(r, "search_term_view.search_term") ?? "", conversions: num(pick(r, "metrics.conversions")), clicks: num(pick(r, "metrics.clicks")) })),
      landing_pages: [...new Set(urls.flatMap((r) => (pick(r, "ad_group_ad.ad.final_urls") as string[] | undefined) ?? []))].slice(0, 20),
      limits: { RSA_HEADLINE: 30, RSA_DESCRIPTION: 90, RSA_HEADLINES_MAX: 15, RSA_DESCRIPTIONS_MAX: 4 },
    };
  },
});

export const businessAssetTools = [getBusinessProfile, saveBusinessProfile, inferBusinessProfile, selectGoogleCampaignType, helpUserUpload, validateAndPrepareAssets, validateVideo, suggestAdContent];
