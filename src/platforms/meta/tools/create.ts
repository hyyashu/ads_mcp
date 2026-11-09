import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { MetaAdsClient, MetaRow } from "../client";
import { ADS_MANAGEMENT, accountId, metaId, metaWrite, s } from "./common";
import {
  CTA,
  COMBO_TEXT,
  OBJECTIVES,
  SPECIAL,
  type Step,
  adSetCore,
  adSetParams,
  budgetChange,
  budgetInput,
  budgetParams,
  checkAssets,
  checkIdentity,
  destination,
  httpsLink,
  imageHash,
  named,
  objName,
  requireFreeName,
  runSteps,
  text,
  urlTags,
  verdict,
  adSetBudgetRule,
  createChange,
  createOneAdSet,
  fullCreateSteps,
  requireUsable,
  restrictedCategories,
  verifyFullCreate,
} from "./create-kit";

/*
 * Meta creation tools (Marketing API v27, checked 2026-11-05). Everything is created PAUSED: there is no input that creates
 * anything active; activating is a separate update_meta_* request with high-impact approval. Only images and videos already in
 * the ad account's library are used (no uploads). Destinations are websites only. Each object is one POST, sent once in the
 * order campaign -> ad set -> creative -> ad and never retried; a later failure is reported with every id created so far.
 * Names must be unused (checked at planning and again before sending) so verify() can find what exists after a crash.
 * Creative shapes: link_data {link, message, name, description, image_hash, call_to_action {type, value {link}}};
 * video_data {video_id, image_url (thumbnail), message, call_to_action}; carousel link_data.child_attachments (2-10 cards, each
 * with link and image_hash, or video_id plus an image_hash thumbnail); dynamic creative asset_feed_spec with images or videos,
 * bodies, titles, descriptions, link_urls, call_to_action_types and ad_formats, in an ad set with is_dynamic_creative=true that
 * holds no other ad (Dynamic Creative guide: one ad per ad set).
 */

const PAGES_MANAGE_ADS = "pages_manage_ads";
const perms = { platformPermissions: [ADS_MANAGEMENT, PAGES_MANAGE_ADS], notes: "The Meta app needs ads_management and pages_manage_ads (ads for a Page); the connected user needs an advertiser role on the ad account and the Page." };
const create = createChange;
const cta = z.enum(CTA).default("LEARN_MORE");

// ----------------------------------------------------------------------------------------------------- creative specs
const singleImage = z.object({ image_hash: imageHash, message: text(2200).optional(), headline: text(255).optional(), description: text(255).optional(), call_to_action: cta });
const singleVideo = z.object({ video_id: metaId, thumbnail_url: httpsLink.describe("https URL of the thumbnail image Meta shows before the video plays."), message: text(2200).optional(), call_to_action: cta });
const card = z
  .object({ image_hash: imageHash.optional().describe("Card image, or the thumbnail when video_id is set."), video_id: metaId.optional(), link: httpsLink, headline: text(255).optional(), description: text(255).optional() })
  .refine((c) => c.image_hash !== undefined, "each card needs an image_hash (the thumbnail for a video card)");
const carousel = z.object({ cards: z.array(card).min(2).max(10).describe("2-10 cards."), message: text(2200).optional(), call_to_action: cta });

type Dest = { page_id: string; instagram_account_id?: string; link: string; url_tags?: string };
const story = (d: Dest, data: Record<string, unknown>) => ({ page_id: d.page_id, ...(d.instagram_account_id ? { instagram_user_id: d.instagram_account_id } : {}), ...data });
const ctaSpec = (type: string, link: string) => ({ type, value: { link } });

export function imageCreative(d: Dest, c: z.infer<typeof singleImage>, name: string) {
  const link_data = { link: d.link, image_hash: c.image_hash, ...(c.message ? { message: c.message } : {}), ...(c.headline ? { name: c.headline } : {}), ...(c.description ? { description: c.description } : {}), call_to_action: ctaSpec(c.call_to_action, d.link) };
  return { name, object_story_spec: JSON.stringify(story(d, { link_data })), ...(d.url_tags ? { url_tags: d.url_tags } : {}) };
}
export function videoCreative(d: Dest, c: z.infer<typeof singleVideo>, name: string) {
  const video_data = { video_id: c.video_id, image_url: c.thumbnail_url, ...(c.message ? { message: c.message } : {}), call_to_action: ctaSpec(c.call_to_action, d.link) };
  return { name, object_story_spec: JSON.stringify(story(d, { video_data })), ...(d.url_tags ? { url_tags: d.url_tags } : {}) };
}
export function carouselCreative(d: Dest, c: z.infer<typeof carousel>, name: string) {
  const child_attachments = c.cards.map((k) => ({ link: k.link, image_hash: k.image_hash, ...(k.video_id ? { video_id: k.video_id } : {}), ...(k.headline ? { name: k.headline } : {}), ...(k.description ? { description: k.description } : {}), call_to_action: ctaSpec(c.call_to_action, k.link) }));
  const link_data = { link: d.link, child_attachments, ...(c.message ? { message: c.message } : {}) };
  return { name, object_story_spec: JSON.stringify(story(d, { link_data })), ...(d.url_tags ? { url_tags: d.url_tags } : {}) };
}

// ----------------------------------------------------------------------------------------------- full campaign creators
const campaignBase = {
  account_id: accountId,
  campaign_name: objName(255),
  objective: z.enum(OBJECTIVES).describe(`Documented combinations only: ${COMBO_TEXT}.`),
  special_ad_categories: z.array(z.enum(SPECIAL)).max(3).describe("Required by Meta: [] when none applies. HOUSING, EMPLOYMENT and FINANCIAL_PRODUCTS_SERVICES restrict targeting."),
  budget: budgetInput,
  ...adSetCore,
  ad_name: objName(100).describe("Also used as the creative's name (Meta allows 100 characters)."),
  ...destination,
};
const createdOut = z.object({ campaign_id: z.string(), ad_set_id: z.string(), creative_id: z.string(), ad_id: z.string(), status: z.literal("PAUSED"), next_step: z.string() });

function campaignCreator<K extends string, C extends z.ZodType>(o: { name: "create_meta_image_campaign" | "create_meta_video_campaign" | "create_meta_carousel_campaign"; title: string; key: K; creative: C; what: string; build: (d: Dest, c: z.infer<C>, name: string) => Record<string, string>; assets: (c: z.infer<C>) => { hashes: string[]; videos: string[] } }) {
  // The runtime schema includes the creative under o.key; the static type covers the shared fields and creativeOf reads the rest.
  const input = z.object({ ...campaignBase, [o.key]: o.creative }) as unknown as z.ZodObject<typeof campaignBase>;
  type A = z.infer<typeof input>;
  const creativeOf = (a: A) => (a as unknown as Record<K, z.infer<C>>)[o.key];

  /** Validates everything and returns the four POSTs. Read-only. */
  async function prepare(a: A, m: MetaAdsClient) {
    const adSet = adSetParams(a, a.objective, a.special_ad_categories, a.budget.type === "lifetime");
    await checkIdentity(m, a);
    const assets = o.assets(creativeOf(a));
    await checkAssets(m, assets.hashes, assets.videos);
    await requireFreeName(m, `${m.adAccountId}/campaigns`, a.campaign_name, "campaign");
    await requireFreeName(m, `${m.adAccountId}/adcreatives`, a.ad_name, "creative");
    return fullCreateSteps(m, {
      campaign: { name: a.campaign_name, objective: a.objective, special_ad_categories: JSON.stringify(a.special_ad_categories) },
      budget: a.budget,
      adSet,
      creative: o.build(a, creativeOf(a), a.ad_name),
      adName: a.ad_name,
    });
  }

  return metaWrite({
    name: o.name,
    title: o.title,
    risk: "high_impact",
    description: `Creates a complete Meta ${o.what} campaign after approval by a second person: campaign, ad set, creative and ad, all PAUSED (nothing spends until someone activates them with update_meta_campaign / update_meta_ad_set / update_meta_ad). Uses only ${o.what === "video" ? "videos and thumbnails" : "images"} already in the ad account's library (discover_meta_assets); website destinations only. Objective and optimization goal: ${COMBO_TEXT}. Budget on the campaign (Advantage campaign budget) or the ad set, daily or lifetime (lifetime needs end_time), with lowest-cost bidding. Targeting: countries, optional regions and cities, age, genders and interests; special ad categories (HOUSING, EMPLOYMENT, FINANCIAL_PRODUCTS_SERVICES) enforce Meta's restrictions (age 18-65+, no gender, no interests, city radius at least 15 miles / 25 km). Automatic placements unless set (Instagram Explore and Messenger Stories are not available). Names must be unused. The four objects are created one by one and never retried; if a later step fails, the result lists every id already created (all PAUSED) and nothing is deleted automatically. Needs ads_management and pages_manage_ads.`,
    input,
    output: createdOut,
    permissions: perms,
    plan: async (a, ctx) => {
      const m = ctx.services.meta;
      await prepare(a, m);
      const ref = { resource: "campaign", id: "new", name: a.campaign_name };
      return {
        summary: `Create Meta ${o.what} campaign "${a.campaign_name}" (${a.objective}, PAUSED) with ad set "${a.ad_set_name}" (${a.optimization_goal}) and ad "${a.ad_name}", ${a.budget.type} budget ${a.budget.amount} on the ${a.budget.level === "campaign" ? "campaign" : "ad set"}, ${a.targeting.countries.join("/")}`,
        snapshot: { names_free: true, assets_present: true },
        changes: [create("campaign", a.campaign_name, a.objective), create("ad_set", a.ad_set_name, a.optimization_goal), create("ad_creative", a.ad_name, o.what), create("ad", a.ad_name, "PAUSED"), budgetChange(a.budget.level === "campaign" ? ref : { resource: "ad_set", id: "new", name: a.ad_set_name }, a.budget, m.currency)],
      };
    },
    execute: async (a, ctx) => {
      const m = ctx.services.meta;
      const ids = await runSteps(m, await prepare(a, m));
      return { campaign_id: ids.campaign!, ad_set_id: ids.ad_set!, creative_id: ids.creative!, ad_id: ids.ad!, status: "PAUSED" as const, next_step: "Review the ad in Ads Manager, then activate the campaign, ad set and ad with update_meta_campaign, update_meta_ad_set and update_meta_ad." };
    },
    verify: async (a, ctx) => verifyFullCreate(ctx.services.meta, a),
  });
}

export const createMetaImageCampaign = campaignCreator({
  name: "create_meta_image_campaign",
  title: "Create Meta image campaign",
  key: "image",
  creative: singleImage,
  what: "single-image",
  build: (d, c, n) => imageCreative(d, c, n),
  assets: (c) => ({ hashes: [c.image_hash], videos: [] }),
});
export const createMetaVideoCampaign = campaignCreator({
  name: "create_meta_video_campaign",
  title: "Create Meta video campaign",
  key: "video",
  creative: singleVideo,
  what: "video",
  build: (d, c, n) => videoCreative(d, c, n),
  assets: (c) => ({ hashes: [], videos: [c.video_id] }),
});
export const createMetaCarouselCampaign = campaignCreator({
  name: "create_meta_carousel_campaign",
  title: "Create Meta carousel campaign",
  key: "carousel",
  creative: carousel,
  what: "carousel",
  build: (d, c, n) => carouselCreative(d, c, n),
  assets: (c) => ({ hashes: c.cards.map((k) => k.image_hash!), videos: c.cards.flatMap((k) => (k.video_id ? [k.video_id] : [])) }),
});

// ------------------------------------------------------------------------------------------------------- add_meta_ad_set
const adSetInput = z.object({ account_id: accountId, campaign_id: metaId, ...adSetCore, budget: budgetInput.omit({ level: true }).optional().describe("Required when the campaign has no campaign budget; not allowed when it has one."), is_dynamic_creative: z.boolean().default(false) });

export const addMetaAdSet = metaWrite({
  name: "add_meta_ad_set",
  title: "Add Meta ad set",
  risk: "high_impact",
  description: `Adds a PAUSED ad set to an existing campaign of this ad account after approval by a second person. The campaign's objective must be one with a documented combination (${COMBO_TEXT}). If the campaign has a campaign budget the ad set gets none; otherwise give the ad set's daily or lifetime budget (lifetime needs end_time). Targeting and placements as in create_meta_image_campaign, including the special ad category restrictions of the campaign. Set is_dynamic_creative to prepare an ad set for create_meta_dco_ad (Meta then requires OFFSITE_CONVERSIONS). The name must be unused in the campaign. Needs ads_management and pages_manage_ads.`,
  input: adSetInput,
  output: z.object({ ad_set_id: z.string(), campaign_id: z.string(), status: z.literal("PAUSED") }),
  permissions: perms,
  plan: async (a, ctx) => {
    const m = ctx.services.meta;
    const p = await prepareAdSet(a, m);
    return { summary: `Add PAUSED ad set "${a.ad_set_name}" (${a.optimization_goal}) to campaign "${p.campaignName ?? a.campaign_id}" (${a.campaign_id})${a.budget ? `, ${a.budget.type} budget ${a.budget.amount}` : ", campaign budget"}`, snapshot: { names_free: true }, changes: [create("ad_set", a.ad_set_name, a.optimization_goal), ...(a.budget ? [budgetChange({ resource: "ad_set", id: "new", name: a.ad_set_name }, { level: "ad_set", ...a.budget }, m.currency)] : [])] };
  },
  execute: async (a, ctx) => {
    const m = ctx.services.meta;
    const p = await prepareAdSet(a, m);
    return { ad_set_id: await createOneAdSet(m, p.params), campaign_id: a.campaign_id, status: "PAUSED" as const };
  },
  verify: async (a, ctx) => verdict([{ key: "ad_set", label: "ad set", ids: await named(ctx.services.meta, `${a.campaign_id}/adsets`, a.ad_set_name) }]),
});

async function prepareAdSet(a: z.infer<typeof adSetInput>, m: MetaAdsClient) {
  const c = await m.getOwned(a.campaign_id, ["id", "name", "status", "objective", "daily_budget", "lifetime_budget", "special_ad_categories"], "campaign");
  requireUsable(s(c, "status"), "campaign");
  const objective = s(c, "objective") ?? "";
  if (!(OBJECTIVES as readonly string[]).includes(objective)) throw new ToolError("invalid_argument", `The campaign's objective ${objective || "(unknown)"} has no documented optimization-goal combination here. Supported: ${COMBO_TEXT}.`);
  const { lifetime } = adSetBudgetRule(c, a.budget);
  if (a.is_dynamic_creative && a.optimization_goal !== "OFFSITE_CONVERSIONS") throw new ToolError("invalid_argument", `Meta requires OFFSITE_CONVERSIONS for dynamic creative ad sets under ${objective}.`);
  const special = restrictedCategories(c); // only the categories with audience restrictions matter for targeting
  const params = adSetParams(a, objective, special, lifetime);
  await checkIdentity(m, { pixel_id: a.pixel_id });
  await requireFreeName(m, `${a.campaign_id}/adsets`, a.ad_set_name, "ad set in this campaign");
  return {
    campaignName: s(c, "name"),
    params: { ...params, campaign_id: a.campaign_id, ...(a.budget ? { ...budgetParams({ level: "ad_set", ...a.budget }, m.currency), bid_strategy: "LOWEST_COST_WITHOUT_CAP" } : {}), ...(a.is_dynamic_creative ? { is_dynamic_creative: "true" } : {}) },
  };
}

// ---------------------------------------------------------------------------------------------------------- add_meta_ad
async function usableAdSet(m: MetaAdsClient, adSetId: string): Promise<MetaRow> {
  const r = await m.getOwned(adSetId, ["id", "name", "status", "is_dynamic_creative"], "ad set");
  requireUsable(s(r, "status"), "ad set");
  return r;
}

const adInput = z
  .object({
    account_id: accountId,
    ad_set_id: metaId,
    ad_name: objName(100),
    creative_id: metaId.optional().describe("Use an existing creative of this ad account."),
    image: singleImage.optional().describe("Or build a new single-image creative."),
    video: singleVideo.optional().describe("Or build a new single-video creative."),
    page_id: destination.page_id.optional(),
    instagram_account_id: destination.instagram_account_id,
    link: httpsLink.optional(),
    url_tags: urlTags,
  })
  .refine((v) => [v.creative_id, v.image, v.video].filter((x) => x !== undefined).length === 1, "give exactly one of creative_id, image or video")
  .refine((v) => v.creative_id !== undefined || (v.page_id !== undefined && v.link !== undefined), "a new creative needs page_id and link");

async function prepareAd(a: z.infer<typeof adInput>, m: MetaAdsClient) {
  const set = await usableAdSet(m, a.ad_set_id);
  if (set.is_dynamic_creative === true || set.is_dynamic_creative === "true") throw new ToolError("invalid_argument", "This is a dynamic creative ad set: use create_meta_dco_ad.");
  await requireFreeName(m, `${a.ad_set_id}/ads`, a.ad_name, "ad in this ad set");
  const steps: Step[] = [];
  if (a.creative_id) await m.getOwned(a.creative_id, ["id"], "creative");
  else {
    const d = { page_id: a.page_id!, instagram_account_id: a.instagram_account_id, link: a.link!, url_tags: a.url_tags };
    await checkIdentity(m, d);
    await checkAssets(m, a.image ? [a.image.image_hash] : [], a.video ? [a.video.video_id] : []);
    await requireFreeName(m, `${m.adAccountId}/adcreatives`, a.ad_name, "creative");
    const creative = a.image ? imageCreative(d, a.image, a.ad_name) : videoCreative(d, a.video!, a.ad_name);
    steps.push({ key: "creative", label: "creative", post: () => ({ path: `${m.adAccountId}/adcreatives`, params: creative }) });
  }
  steps.push({ key: "ad", label: "ad", post: (ids) => ({ path: `${m.adAccountId}/ads`, params: { name: a.ad_name, adset_id: a.ad_set_id, creative: JSON.stringify({ creative_id: a.creative_id ?? ids.creative! }), status: "PAUSED" } }) });
  return { steps, setName: s(set, "name") };
}

export const addMetaAd = metaWrite({
  name: "add_meta_ad",
  title: "Add Meta ad",
  risk: "high_impact",
  description:
    "Adds a PAUSED ad to an existing ad set of this ad account after approval by a second person, with an existing creative (creative_id) or a new single-image or single-video creative built from the account's library (image hash or video id plus a thumbnail URL), a Page the account promotes and a website link. Dynamic creative ad sets are refused (use create_meta_dco_ad). The ad name (also the new creative's name) must be unused. The creative and the ad are created one after the other and never retried; if the ad step fails the new creative's id is reported. Needs ads_management and pages_manage_ads.",
  input: adInput,
  output: z.object({ ad_id: z.string(), creative_id: z.string(), ad_set_id: z.string(), status: z.literal("PAUSED") }),
  permissions: perms,
  plan: async (a, ctx) => {
    const p = await prepareAd(a, ctx.services.meta);
    return { summary: `Add PAUSED ad "${a.ad_name}" to ad set "${p.setName ?? a.ad_set_id}" (${a.ad_set_id}) with ${a.creative_id ? `creative ${a.creative_id}` : `a new ${a.image ? "image" : "video"} creative`}`, snapshot: { names_free: true }, changes: [...(a.creative_id ? [] : [create("ad_creative", a.ad_name, a.image ? "image" : "video")]), create("ad", a.ad_name, "PAUSED")] };
  },
  execute: async (a, ctx) => {
    const m = ctx.services.meta;
    const ids = await runSteps(m, (await prepareAd(a, m)).steps);
    return { ad_id: ids.ad!, creative_id: a.creative_id ?? ids.creative!, ad_set_id: a.ad_set_id, status: "PAUSED" as const };
  },
  verify: async (a, ctx) => {
    const m = ctx.services.meta;
    const found = [{ key: "ad", label: "ad", ids: await named(m, `${a.ad_set_id}/ads`, a.ad_name) }];
    if (!a.creative_id) found.unshift({ key: "creative", label: "creative", ids: await named(m, `${m.adAccountId}/adcreatives`, a.ad_name) });
    return verdict(found);
  },
});

// ----------------------------------------------------------------------------------------------------- create_meta_dco_ad
const dcoInput = z
  .object({
    account_id: accountId,
    ad_set_id: metaId.describe("An empty ad set with is_dynamic_creative (add_meta_ad_set with is_dynamic_creative: true)."),
    ad_name: objName(100),
    page_id: destination.page_id,
    instagram_account_id: destination.instagram_account_id,
    images: z.array(imageHash).min(1).max(10).optional(),
    videos: z.array(z.object({ video_id: metaId, thumbnail_url: httpsLink })).min(1).max(10).optional(),
    bodies: z.array(text(2200)).min(1).max(5),
    titles: z.array(text(255)).min(1).max(5),
    descriptions: z.array(text(255)).max(5).default([]),
    link_urls: z.array(httpsLink).min(1).max(5),
    call_to_action_types: z.array(z.enum(CTA)).min(1).max(5),
    url_tags: urlTags,
  })
  .refine((v) => (v.images === undefined) !== (v.videos === undefined), "give images or videos (one kind)");

async function prepareDco(a: z.infer<typeof dcoInput>, m: MetaAdsClient) {
  const set = await usableAdSet(m, a.ad_set_id);
  if (!(set.is_dynamic_creative === true || set.is_dynamic_creative === "true")) throw new ToolError("invalid_argument", "The ad set is not a dynamic creative ad set. Create one with add_meta_ad_set and is_dynamic_creative: true.");
  if ((await m.list(`${a.ad_set_id}/ads`, { fields: "id" }, 10, { partial: true })).length) throw new ToolError("invalid_argument", "Meta allows one ad per dynamic creative ad set, and this ad set already has one.");
  await checkIdentity(m, a);
  await checkAssets(m, a.images ?? [], (a.videos ?? []).map((v) => v.video_id));
  await requireFreeName(m, `${m.adAccountId}/adcreatives`, a.ad_name, "creative");
  const feed = {
    ...(a.images ? { images: a.images.map((h) => ({ hash: h })), ad_formats: ["SINGLE_IMAGE"] } : { videos: a.videos!.map((v) => ({ video_id: v.video_id, thumbnail_url: v.thumbnail_url })), ad_formats: ["SINGLE_VIDEO"] }),
    bodies: a.bodies.map((t) => ({ text: t })),
    titles: a.titles.map((t) => ({ text: t })),
    ...(a.descriptions.length ? { descriptions: a.descriptions.map((t) => ({ text: t })) } : {}),
    link_urls: a.link_urls.map((u) => ({ website_url: u })),
    call_to_action_types: a.call_to_action_types,
  };
  const creative = { name: a.ad_name, object_story_spec: JSON.stringify({ page_id: a.page_id, ...(a.instagram_account_id ? { instagram_user_id: a.instagram_account_id } : {}) }), asset_feed_spec: JSON.stringify(feed), ...(a.url_tags ? { url_tags: a.url_tags } : {}) };
  const steps: Step[] = [
    { key: "creative", label: "creative", post: () => ({ path: `${m.adAccountId}/adcreatives`, params: creative }) },
    { key: "ad", label: "ad", post: (ids) => ({ path: `${m.adAccountId}/ads`, params: { name: a.ad_name, adset_id: a.ad_set_id, creative: JSON.stringify({ creative_id: ids.creative! }), status: "PAUSED" } }) },
  ];
  return { steps, setName: s(set, "name") };
}

export const createMetaDcoAd = metaWrite({
  name: "create_meta_dco_ad",
  title: "Create Meta dynamic creative ad",
  risk: "high_impact",
  description:
    "Creates a PAUSED dynamic creative ad after approval by a second person: one creative with an asset_feed_spec (1-10 library images or 1-10 library videos with thumbnail URLs, 1-5 primary texts, 1-5 headlines, up to 5 descriptions, 1-5 website links and 1-5 call to action types) and one ad, in an empty ad set created with is_dynamic_creative (Meta allows one ad per such ad set; its optimization goal must be OFFSITE_CONVERSIONS for Sales, Engagement, Leads and Traffic). Meta then delivers the best-performing combinations. The ad name (also the creative's name) must be unused; the two objects are created in order, never retried, and a failed ad step reports the creative id. The 5 and 10 caps are this server's; Meta may reject some combinations. Needs ads_management and pages_manage_ads.",
  input: dcoInput,
  output: z.object({ ad_id: z.string(), creative_id: z.string(), ad_set_id: z.string(), status: z.literal("PAUSED") }),
  permissions: perms,
  plan: async (a, ctx) => {
    const p = await prepareDco(a, ctx.services.meta);
    return { summary: `Create PAUSED dynamic creative ad "${a.ad_name}" in ad set "${p.setName ?? a.ad_set_id}" (${a.ad_set_id}): ${a.images ? `${a.images.length} image(s)` : `${a.videos!.length} video(s)`}, ${a.bodies.length} text(s), ${a.titles.length} headline(s), ${a.link_urls.length} link(s)`, snapshot: { names_free: true, ad_set_empty: true }, changes: [create("ad_creative", a.ad_name, "dynamic creative"), create("ad", a.ad_name, "PAUSED")] };
  },
  execute: async (a, ctx) => {
    const m = ctx.services.meta;
    const ids = await runSteps(m, (await prepareDco(a, m)).steps);
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

export const createTools = [createMetaImageCampaign, createMetaVideoCampaign, createMetaCarouselCampaign, addMetaAdSet, addMetaAd, createMetaDcoAd];
