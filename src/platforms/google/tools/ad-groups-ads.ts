import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change, Effect } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, pick } from "../gaql";
import type { ImageFieldType } from "../media";
import { accountId, idSchema, str, toMicros } from "./common";
import { imageData, rn, stateWrite, temp, withImages } from "./write-kit";

/**
 * Ad groups and ads for Search, Shopping, Display, Demand Gen and App campaigns.
 * Responsive display ads (v26 "Create responsive display ads" guide, checked 2026-11-04): final URL; 1-5 headlines (30);
 * long headline (90); 1-5 descriptions (90); business name (25); at least one landscape (1.91:1, 600x314) and one square
 * (1:1, 300x300) marketing image, up to 15 combined. Demand Gen multi-asset ads (DemandGenMultiAssetAdInfo reference):
 * business name (25, required); 1-5 headlines (30); 1-5 descriptions (90); 1-5 logos (1:1, 128x128); landscape or
 * square images, up to 20 combined. App ads: text limits are not stated in the AppAdInfo reference; 30/90 characters and
 * up to 5 each are used here [unverified] and Google enforces its own limits.
 */
const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");
const httpsUrl = z.string().url().max(2048).refine((u) => u.startsWith("https://"), "https URL");
const change = (ref: { resource: string; id: string; name?: string | null }, field: string, before: string | null, after: string | null, effect: Effect): Change => ({ ...ref, field, before, after, unit: "text", effect });

interface CampaignGroups {
  campaign: { id: string; name: string | null; status: string; channel: string | null };
  groups: { id: string; name: string }[];
}
async function readCampaignGroups(ads: GoogleAdsClient, campaignId: string, channel: string): Promise<CampaignGroups> {
  const [c] = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type").from("campaign").where(`campaign.id = ${lit.id(campaignId)}`).limit(1), { maxRows: 1 });
  if (!c) throw new ToolError("not_found", `No campaign ${campaignId} in this account.`);
  if (str(c, "campaign.advertising_channel_type") !== channel) throw new ToolError("invalid_argument", `Campaign ${campaignId} is a ${str(c, "campaign.advertising_channel_type")} campaign; this tool is for ${channel}.`);
  if (str(c, "campaign.status") === "REMOVED") throw new ToolError("invalid_argument", "The campaign is removed and cannot be changed.");
  const rows = await ads.query(new Gaql().select("ad_group.id", "ad_group.name").from("ad_group").where(`campaign.id = ${lit.id(campaignId)}`).where("ad_group.status != 'REMOVED'").orderBy("ad_group.id"), { maxRows: 10_000 });
  return { campaign: { id: campaignId, name: str(c, "campaign.name"), status: str(c, "campaign.status")!, channel }, groups: rows.map((r) => ({ id: String(pick(r, "ad_group.id")), name: str(r, "ad_group.name") ?? "" })) };
}
const findGroup = (s: CampaignGroups, name: string) => s.groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
/** A new enabled ad group in an enabled campaign can start serving at once; in a paused campaign it cannot. */
const groupEffect = (s: CampaignGroups, status: string): Effect => (status === "ENABLED" && s.campaign.status === "ENABLED" ? "create" : "neutral");

function addGroupTool<I extends z.ZodObject>(o: { name: string; title: string; description: string; channel: string; input: I; group: (a: z.infer<I>) => Row; extra?: (a: z.infer<I>, ads: GoogleAdsClient, group: string) => Row[] }) {
  return stateWrite({
    name: o.name,
    title: o.title,
    risk: "write",
    description: o.description,
    input: o.input,
    output: z.object({ ad_group_id: z.string(), campaign_id: z.string(), name: z.string(), status: z.string() }),
    read: (a, ads) => readCampaignGroups(ads, (a as { campaign_id: string }).campaign_id, o.channel),
    build: (a, s, ads) => {
      const args = a as { name: string; status: string; campaign_id: string };
      if (findGroup(s, args.name)) throw new ToolError("invalid_argument", `The campaign already has an ad group named "${args.name}".`);
      const group = temp(ads, "adGroups", 1);
      const ops: Row[] = [{ adGroupOperation: { create: { resourceName: group, campaign: rn(ads, "campaigns", args.campaign_id), name: args.name, status: args.status, ...o.group(a) } } }, ...(o.extra ? o.extra(a, ads, group) : [])];
      return { summary: `Create ${o.channel} ad group "${args.name}" (${args.status}) in campaign "${s.campaign.name ?? args.campaign_id}" (${s.campaign.status})`, changes: [change({ resource: "campaign", id: args.campaign_id, name: s.campaign.name }, "ad_group", null, `${args.name} (${args.status})`, groupEffect(s, args.status))], ops };
    },
    landed: (a, _b, after) => !!findGroup(after, (a as { name: string }).name),
    result: (a, after) => {
      const args = a as { name: string; status: string; campaign_id: string };
      return { ad_group_id: findGroup(after, args.name)!.id, campaign_id: args.campaign_id, name: args.name, status: args.status };
    },
  });
}
const groupBase = { account_id: accountId, campaign_id: idSchema, name: text(255), status: z.enum(["ENABLED", "PAUSED"]).default("ENABLED") };

export const addSearchAdGroup = addGroupTool({
  name: "add_search_ad_group",
  title: "Create Search ad group",
  description: "Creates a standard Search ad group in a Search campaign, optionally with a default max CPC bid, after approval. In an enabled campaign a new enabled ad group can serve once it has keywords and ads, so that is high impact. Add keywords (add_keywords) and an ad (create_ad) next. Confirmed by re-reading.",
  channel: "SEARCH",
  input: z.object({ ...groupBase, cpc_bid: z.number().positive().max(10_000).optional() }),
  group: (a) => ({ type: "SEARCH_STANDARD", ...(a.cpc_bid ? { cpcBidMicros: String(toMicros(a.cpc_bid)) } : {}) }),
});
export const addDisplayAdGroup = addGroupTool({
  name: "add_display_ad_group",
  title: "Create Display ad group",
  description: "Creates a standard Display ad group in a Display campaign, optionally with a default max CPC or CPM bid, after approval. Add targeting and a responsive display ad (add_display_ad) next. Confirmed by re-reading.",
  channel: "DISPLAY",
  input: z.object({ ...groupBase, cpc_bid: z.number().positive().max(10_000).optional(), cpm_bid: z.number().positive().max(10_000).optional() }),
  group: (a) => ({ type: "DISPLAY_STANDARD", ...(a.cpc_bid ? { cpcBidMicros: String(toMicros(a.cpc_bid)) } : {}), ...(a.cpm_bid ? { cpmBidMicros: String(toMicros(a.cpm_bid)) } : {}) }),
});
export const addDemandgenAdGroup = addGroupTool({
  name: "add_demandgen_ad_group",
  title: "Create Demand Gen ad group",
  description: "Creates a Demand Gen ad group (no ad group type, as Google requires) with optional location and language targeting at ad group level, after approval. Serves on all eligible channels until changed with update_demandgen_channel_controls. Add an ad with add_demandgen_ad. Confirmed by re-reading.",
  channel: "DEMAND_GEN",
  input: z.object({ ...groupBase, location_ids: z.array(idSchema).max(100).default([]), language_ids: z.array(idSchema).max(50).default([]) }),
  group: () => ({}),
  extra: (a, _ads, group) => [
    ...[...new Set(a.location_ids)].map((g) => ({ adGroupCriterionOperation: { create: { adGroup: group, location: { geoTargetConstant: `geoTargetConstants/${g}` } } } })),
    ...[...new Set(a.language_ids)].map((l) => ({ adGroupCriterionOperation: { create: { adGroup: group, language: { languageConstant: `languageConstants/${l}` } } } })),
  ],
});
export const addShoppingAdGroup = addGroupTool({
  name: "add_shopping_ad_group",
  title: "Create Shopping ad group",
  description: "Creates a Standard Shopping ad group with its product ad and a single product group covering all products at the given max CPC bid, in one atomic request after approval. Subdivide the product group later with add_product_group. Confirmed by re-reading.",
  channel: "SHOPPING",
  input: z.object({ ...groupBase, cpc_bid: z.number().positive().max(10_000) }),
  group: () => ({ type: "SHOPPING_PRODUCT_ADS" }),
  extra: (a, _ads, group) => [
    { adGroupCriterionOperation: { create: { adGroup: group, status: "ENABLED", listingGroup: { type: "UNIT" }, cpcBidMicros: String(toMicros(a.cpc_bid)) } } },
    { adGroupAdOperation: { create: { adGroup: group, status: "ENABLED", ad: { shoppingProductAd: {} } } } },
  ],
});

// --------------------------------------------------------------------------------------------- ads in ad groups
interface GroupAds {
  group: { id: string; name: string | null; status: string; channel: string | null; campaign_status: string };
  ads: { ad_id: string; type: string; status: string; final_url: string | null; headlines: string[]; descriptions: string[]; long_headline: string | null }[];
}
async function readGroupAds(ads: GoogleAdsClient, adGroupId: string, channel: string): Promise<GroupAds> {
  const [g] = await ads.query(new Gaql().select("ad_group.id", "ad_group.name", "ad_group.status", "campaign.status", "campaign.advertising_channel_type").from("ad_group").where(`ad_group.id = ${lit.id(adGroupId)}`).limit(1), { maxRows: 1 });
  if (!g) throw new ToolError("not_found", `No ad group ${adGroupId} in this account.`);
  if (str(g, "campaign.advertising_channel_type") !== channel) throw new ToolError("invalid_argument", `Ad group ${adGroupId} is in a ${str(g, "campaign.advertising_channel_type")} campaign; this tool is for ${channel}.`);
  if (str(g, "ad_group.status") === "REMOVED") throw new ToolError("invalid_argument", "The ad group is removed and cannot be changed.");
  const rows = await ads.query(
    new Gaql()
      .select("ad_group_ad.ad.id", "ad_group_ad.ad.type", "ad_group_ad.status", "ad_group_ad.ad.final_urls", "ad_group_ad.ad.responsive_display_ad.headlines", "ad_group_ad.ad.responsive_display_ad.descriptions", "ad_group_ad.ad.responsive_display_ad.long_headline", "ad_group_ad.ad.demand_gen_multi_asset_ad.headlines", "ad_group_ad.ad.app_ad.headlines", "ad_group_ad.ad.app_ad.descriptions")
      .from("ad_group_ad")
      .where(`ad_group.id = ${lit.id(adGroupId)}`)
      .where("ad_group_ad.status != 'REMOVED'")
      .orderBy("ad_group_ad.ad.id"),
    { maxRows: 500 },
  );
  const texts = (r: Row, f: string) => ((pick(r, f) as Row[] | undefined) ?? []).map((t) => String(t.text ?? ""));
  return {
    group: { id: adGroupId, name: str(g, "ad_group.name"), status: str(g, "ad_group.status")!, channel, campaign_status: str(g, "campaign.status") ?? "" },
    ads: rows.map((r) => {
      const type = str(r, "ad_group_ad.ad.type") ?? "";
      const app = type === "APP_AD";
      return {
        ad_id: String(pick(r, "ad_group_ad.ad.id")),
        type,
        status: str(r, "ad_group_ad.status") ?? "",
        final_url: ((pick(r, "ad_group_ad.ad.final_urls") as string[] | undefined) ?? [])[0] ?? null,
        headlines: app ? texts(r, "ad_group_ad.ad.app_ad.headlines") : texts(r, "ad_group_ad.ad.responsive_display_ad.headlines").concat(texts(r, "ad_group_ad.ad.demand_gen_multi_asset_ad.headlines")),
        descriptions: app ? texts(r, "ad_group_ad.ad.app_ad.descriptions") : texts(r, "ad_group_ad.ad.responsive_display_ad.descriptions"),
        long_headline: str(r, "ad_group_ad.ad.responsive_display_ad.long_headline.text"),
      };
    }),
  };
}
const adEffect = (s: GroupAds, status: string): Effect => (status === "ENABLED" && s.group.status === "ENABLED" && s.group.campaign_status === "ENABLED" ? "create" : "neutral");
const adKeyOf = (headlines: string[], finalUrl: string | null) => `${(finalUrl ?? "").toLowerCase()}|${headlines.map((h) => h.toLowerCase()).sort().join("|")}`;

export const addShoppingProductAd = stateWrite({
  name: "add_shopping_product_ad",
  title: "Add Shopping product ad",
  risk: "write",
  description: "Adds the product ad to a Standard Shopping ad group (Shopping ads are built from the Merchant Center feed; the ad itself has no text), after approval. An ad group needs one. Refused if the ad group already has one. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, status: z.enum(["ENABLED", "PAUSED"]).default("ENABLED") }),
  output: z.object({ ad_group_id: z.string(), ad_id: z.string() }),
  read: (a, ads) => readGroupAds(ads, a.ad_group_id, "SHOPPING"),
  build: (a, s, ads) => {
    if (s.ads.some((x) => x.type === "SHOPPING_PRODUCT_AD")) throw new ToolError("invalid_argument", "Nothing would change: the ad group already has a product ad.");
    return { summary: `Add a product ad (${a.status}) to Shopping ad group "${s.group.name ?? a.ad_group_id}"`, changes: [change({ resource: "ad_group", id: a.ad_group_id, name: s.group.name }, "ad", null, `SHOPPING_PRODUCT_AD (${a.status})`, adEffect(s, a.status))], ops: [{ adGroupAdOperation: { create: { adGroup: rn(ads, "adGroups", a.ad_group_id), status: a.status, ad: { shoppingProductAd: {} } } } }] };
  },
  landed: (_a, _b, after) => after.ads.some((x) => x.type === "SHOPPING_PRODUCT_AD"),
  result: (a, after) => ({ ad_group_id: a.ad_group_id, ad_id: after.ads.find((x) => x.type === "SHOPPING_PRODUCT_AD")!.ad_id }),
});

const image = z.object({ url: httpsUrl, field_type: z.enum(["MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "LOGO", "LANDSCAPE_LOGO", "PORTRAIT_MARKETING_IMAGE"]) });
function imageOps(ads: GoogleAdsClient, s: object & { image_sha256: Record<string, string> }, images: z.infer<typeof image>[], start: number) {
  const ops: Row[] = [];
  const refs: Record<string, { asset: string }[]> = {};
  images.forEach((im, k) => {
    const t = temp(ads, "assets", start + k);
    ops.push({ assetOperation: { create: { resourceName: t, name: `${im.field_type.toLowerCase()}-${s.image_sha256[im.url]!.slice(0, 16)}-${Date.now().toString(36)}${k}`, imageAsset: { data: imageData(s, im.url).data } } } });
    (refs[im.field_type] ??= []).push({ asset: t });
  });
  return { ops, refs };
}

export const addDisplayAd = stateWrite({
  name: "add_display_ad",
  title: "Create responsive display ad",
  risk: "write",
  description:
    "Creates a responsive display ad in a Display ad group after approval: final URL, 1-5 headlines (30), a long headline (90), 1-5 descriptions (90), business name (25), at least one landscape (1.91:1) and one square (1:1) image (up to 15 combined) and optional logos, from https URLs. Images are downloaded and checked against Google's specs; the exact bytes are pinned at approval. In a serving ad group an enabled ad is high impact. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, final_url: httpsUrl, headlines: z.array(text(30)).min(1).max(5), long_headline: text(90), descriptions: z.array(text(90)).min(1).max(5), business_name: text(25), images: z.array(image).min(2).max(20), status: z.enum(["ENABLED", "PAUSED"]).default("ENABLED") }),
  output: z.object({ ad_group_id: z.string(), ad_id: z.string() }),
  timeoutMs: 120_000,
  read: async (a, ads, svc) => withImages(await readGroupAds(ads, a.ad_group_id, "DISPLAY"), svc, a.images.map((i) => ({ url: i.url, field: i.field_type as ImageFieldType }))),
  build: (a, s, ads) => {
    const per = (f: string) => a.images.filter((i) => i.field_type === f).length;
    if (!per("MARKETING_IMAGE") || !per("SQUARE_MARKETING_IMAGE")) throw new ToolError("invalid_argument", "A responsive display ad needs at least one MARKETING_IMAGE (1.91:1) and one SQUARE_MARKETING_IMAGE (1:1).");
    if (per("MARKETING_IMAGE") + per("SQUARE_MARKETING_IMAGE") > 15) throw new ToolError("invalid_argument", "At most 15 marketing and square images combined.");
    if (per("PORTRAIT_MARKETING_IMAGE")) throw new ToolError("invalid_argument", "Responsive display ads do not take PORTRAIT_MARKETING_IMAGE.");
    if (s.ads.some((x) => adKeyOf(x.headlines, x.final_url) === adKeyOf(a.headlines, a.final_url))) throw new ToolError("invalid_argument", "Nothing would change: an ad with these headlines and URL already exists in this ad group.");
    const { ops, refs } = imageOps(ads, s, a.images, 1);
    const rda: Row = { headlines: a.headlines.map((t) => ({ text: t })), longHeadline: { text: a.long_headline }, descriptions: a.descriptions.map((t) => ({ text: t })), businessName: a.business_name, marketingImages: refs.MARKETING_IMAGE, squareMarketingImages: refs.SQUARE_MARKETING_IMAGE, ...(refs.LOGO ? { squareLogoImages: refs.LOGO } : {}), ...(refs.LANDSCAPE_LOGO ? { logoImages: refs.LANDSCAPE_LOGO } : {}) };
    ops.push({ adGroupAdOperation: { create: { adGroup: rn(ads, "adGroups", a.ad_group_id), status: a.status, ad: { finalUrls: [a.final_url], responsiveDisplayAd: rda } } } });
    return { summary: `Create responsive display ad (${a.status}) in ad group "${s.group.name ?? a.ad_group_id}": "${a.headlines[0]}" / "${a.long_headline}" -> ${a.final_url}, ${a.images.length} images`, changes: [change({ resource: "ad_group", id: a.ad_group_id, name: s.group.name }, "ad", null, `RESPONSIVE_DISPLAY_AD "${a.headlines[0]}" (${a.status})`, adEffect(s, a.status))], ops };
  },
  landed: (a, _b, after) => after.ads.some((x) => adKeyOf(x.headlines, x.final_url) === adKeyOf(a.headlines, a.final_url)),
  result: (a, after) => ({ ad_group_id: a.ad_group_id, ad_id: after.ads.find((x) => adKeyOf(x.headlines, x.final_url) === adKeyOf(a.headlines, a.final_url))!.ad_id }),
});

export const updateDisplayAdCreative = stateWrite({
  name: "update_display_ad_creative",
  title: "Update responsive display ad text",
  risk: "write",
  description: "Replaces the headlines (1-5, 30 chars), long headline (90) and/or descriptions (1-5, 90 chars) of a responsive display ad in place, after approval. Images are unchanged. The ad goes back through Google's review. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, ad_id: idSchema, headlines: z.array(text(30)).min(1).max(5).optional(), long_headline: text(90).optional(), descriptions: z.array(text(90)).min(1).max(5).optional() }).refine((v) => v.headlines || v.long_headline || v.descriptions, "give headlines, long_headline or descriptions"),
  output: z.object({ ad_id: z.string(), headlines: z.array(z.string()), long_headline: z.string().nullable(), descriptions: z.array(z.string()) }),
  read: (a, ads) => readGroupAds(ads, a.ad_group_id, "DISPLAY"),
  build: (a, s, ads) => {
    const ad = s.ads.find((x) => x.ad_id === a.ad_id);
    if (!ad) throw new ToolError("not_found", `No ad ${a.ad_id} in ad group ${a.ad_group_id}.`);
    if (ad.type !== "RESPONSIVE_DISPLAY_AD") throw new ToolError("invalid_argument", `Ad ${a.ad_id} is a ${ad.type}; only responsive display ads can be edited here.`);
    const update: Row = { resourceName: rn(ads, "ads", a.ad_id), responsiveDisplayAd: {} };
    const rda = update.responsiveDisplayAd as Row;
    const mask: string[] = [];
    const changes: Change[] = [];
    const ref = { resource: "ad", id: a.ad_id };
    if (a.headlines && JSON.stringify(a.headlines) !== JSON.stringify(ad.headlines)) (rda.headlines = a.headlines.map((t) => ({ text: t }))), mask.push("responsive_display_ad.headlines"), changes.push(change(ref, "headlines", ad.headlines.join(" | "), a.headlines.join(" | "), "neutral"));
    if (a.long_headline && a.long_headline !== ad.long_headline) (rda.longHeadline = { text: a.long_headline }), mask.push("responsive_display_ad.long_headline"), changes.push(change(ref, "long_headline", ad.long_headline, a.long_headline, "neutral"));
    if (a.descriptions && JSON.stringify(a.descriptions) !== JSON.stringify(ad.descriptions)) (rda.descriptions = a.descriptions.map((t) => ({ text: t }))), mask.push("responsive_display_ad.descriptions"), changes.push(change(ref, "descriptions", ad.descriptions.join(" | "), a.descriptions.join(" | "), "neutral"));
    if (!mask.length) throw new ToolError("invalid_argument", "Nothing would change.");
    return { summary: `Responsive display ad ${a.ad_id}: ${changes.map((c) => c.field).join(", ")} updated`, changes, ops: [{ adOperation: { update, updateMask: mask.join(",") } }] };
  },
  landed: (a, _b, after) => {
    const ad = after.ads.find((x) => x.ad_id === a.ad_id);
    return !!ad && (!a.headlines || JSON.stringify(ad.headlines) === JSON.stringify(a.headlines)) && (!a.long_headline || ad.long_headline === a.long_headline) && (!a.descriptions || JSON.stringify(ad.descriptions) === JSON.stringify(a.descriptions));
  },
  result: (a, after) => {
    const ad = after.ads.find((x) => x.ad_id === a.ad_id)!;
    return { ad_id: a.ad_id, headlines: ad.headlines, long_headline: ad.long_headline, descriptions: ad.descriptions };
  },
});

export const addDemandgenAd = stateWrite({
  name: "add_demandgen_ad",
  title: "Create Demand Gen image ad",
  risk: "write",
  description:
    "Creates a Demand Gen multi-asset (image) ad after approval: final URL, business name (25), 1-5 headlines (30), 1-5 descriptions (90), 1-5 logos (1:1) and landscape (1.91:1), square (1:1) or portrait (4:5) images (at least one landscape or square, up to 20), from https URLs, with an optional call to action text. Images are checked against Google's specs and pinned at approval. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, final_url: httpsUrl, business_name: text(25), headlines: z.array(text(30)).min(1).max(5), descriptions: z.array(text(90)).min(1).max(5), images: z.array(image).min(2).max(25), call_to_action_text: text(30).optional(), status: z.enum(["ENABLED", "PAUSED"]).default("ENABLED") }),
  output: z.object({ ad_group_id: z.string(), ad_id: z.string() }),
  timeoutMs: 120_000,
  read: async (a, ads, svc) => withImages(await readGroupAds(ads, a.ad_group_id, "DEMAND_GEN"), svc, a.images.map((i) => ({ url: i.url, field: i.field_type as ImageFieldType }))),
  build: (a, s, ads) => {
    const per = (f: string) => a.images.filter((i) => i.field_type === f).length;
    if (!per("LOGO") || per("LOGO") > 5) throw new ToolError("invalid_argument", "A Demand Gen image ad needs 1 to 5 LOGO images (1:1).");
    if (!per("MARKETING_IMAGE") && !per("SQUARE_MARKETING_IMAGE")) throw new ToolError("invalid_argument", "Give at least one MARKETING_IMAGE (1.91:1) or SQUARE_MARKETING_IMAGE (1:1).");
    if (per("MARKETING_IMAGE") + per("SQUARE_MARKETING_IMAGE") + per("PORTRAIT_MARKETING_IMAGE") > 20) throw new ToolError("invalid_argument", "At most 20 marketing images combined.");
    if (per("LANDSCAPE_LOGO")) throw new ToolError("invalid_argument", "Demand Gen image ads take square LOGO images, not LANDSCAPE_LOGO.");
    if (s.ads.some((x) => adKeyOf(x.headlines, x.final_url) === adKeyOf(a.headlines, a.final_url))) throw new ToolError("invalid_argument", "Nothing would change: an ad with these headlines and URL already exists in this ad group.");
    const { ops, refs } = imageOps(ads, s, a.images, 1);
    const ad: Row = { businessName: a.business_name, headlines: a.headlines.map((t) => ({ text: t })), descriptions: a.descriptions.map((t) => ({ text: t })), logoImages: refs.LOGO, ...(refs.MARKETING_IMAGE ? { marketingImages: refs.MARKETING_IMAGE } : {}), ...(refs.SQUARE_MARKETING_IMAGE ? { squareMarketingImages: refs.SQUARE_MARKETING_IMAGE } : {}), ...(refs.PORTRAIT_MARKETING_IMAGE ? { portraitMarketingImages: refs.PORTRAIT_MARKETING_IMAGE } : {}), ...(a.call_to_action_text ? { callToActionText: a.call_to_action_text } : {}) };
    ops.push({ adGroupAdOperation: { create: { adGroup: rn(ads, "adGroups", a.ad_group_id), status: a.status, ad: { finalUrls: [a.final_url], demandGenMultiAssetAd: ad } } } });
    return { summary: `Create Demand Gen image ad (${a.status}) in ad group "${s.group.name ?? a.ad_group_id}": "${a.headlines[0]}" -> ${a.final_url}, ${a.images.length} images`, changes: [change({ resource: "ad_group", id: a.ad_group_id, name: s.group.name }, "ad", null, `DEMAND_GEN_MULTI_ASSET_AD "${a.headlines[0]}" (${a.status})`, adEffect(s, a.status))], ops };
  },
  landed: (a, _b, after) => after.ads.some((x) => adKeyOf(x.headlines, x.final_url) === adKeyOf(a.headlines, a.final_url)),
  result: (a, after) => ({ ad_group_id: a.ad_group_id, ad_id: after.ads.find((x) => adKeyOf(x.headlines, x.final_url) === adKeyOf(a.headlines, a.final_url))!.ad_id }),
});

// ---------------------------------------------------------------------------------------------- app ad assets
async function readAppAd(ads: GoogleAdsClient, adGroupId: string) {
  const [g] = await ads.query(new Gaql().select("ad_group.id", "campaign.advertising_channel_sub_type").from("ad_group").where(`ad_group.id = ${lit.id(adGroupId)}`).limit(1), { maxRows: 1 });
  if (!g) throw new ToolError("not_found", `No ad group ${adGroupId} in this account.`);
  if (str(g, "campaign.advertising_channel_sub_type") !== "APP_CAMPAIGN") throw new ToolError("invalid_argument", "This ad group is not in an App campaign.");
  const s = await readGroupAds(ads, adGroupId, "MULTI_CHANNEL");
  const app = s.ads.filter((x) => x.type === "APP_AD");
  if (app.length !== 1) throw new ToolError("invalid_argument", `Expected one app ad in the ad group, found ${app.length}.`);
  return { ad_id: app[0]!.ad_id, headlines: app[0]!.headlines, descriptions: app[0]!.descriptions };
}
const appInput = z.object({ account_id: accountId, ad_group_id: idSchema, headlines: z.array(text(30)).max(5).default([]), descriptions: z.array(text(90)).max(5).default([]) }).refine((v) => v.headlines.length + v.descriptions.length > 0, "give headlines or descriptions");
const appOut = z.object({ ad_id: z.string(), headlines: z.array(z.string()), descriptions: z.array(z.string()) });
const appUpdate = (ads: GoogleAdsClient, adId: string, h: string[], d: string[]) => ({ adOperation: { update: { resourceName: rn(ads, "ads", adId), appAd: { headlines: h.map((t) => ({ text: t })), descriptions: d.map((t) => ({ text: t })) } }, updateMask: "app_ad.headlines,app_ad.descriptions" } });
export const addAppAdAsset = stateWrite({
  name: "add_app_ad_asset",
  title: "Add App ad text",
  risk: "write",
  description: "Adds headlines (30 chars) and/or descriptions (90 chars) to the app ad of an App campaign ad group, up to 5 of each, after approval. Existing texts are kept and duplicates skipped. Confirmed by re-reading.",
  input: appInput,
  output: appOut,
  read: (a, ads) => readAppAd(ads, a.ad_group_id),
  build: (a, s, ads) => {
    const merge = (cur: string[], add: string[]) => [...cur, ...add.filter((t) => !cur.some((c) => c.toLowerCase() === t.toLowerCase()))];
    const h = merge(s.headlines, a.headlines);
    const d = merge(s.descriptions, a.descriptions);
    if (h.length === s.headlines.length && d.length === s.descriptions.length) throw new ToolError("invalid_argument", "Nothing would change: these texts are already in the ad.");
    if (h.length > 5 || d.length > 5) throw new ToolError("invalid_argument", "An app ad takes at most 5 headlines and 5 descriptions.");
    return { summary: `App ad ${s.ad_id}: ${h.length} headlines, ${d.length} descriptions`, changes: [change({ resource: "ad", id: s.ad_id }, "texts", [...s.headlines, ...s.descriptions].join(" | "), [...h, ...d].join(" | "), "neutral")], ops: [appUpdate(ads, s.ad_id, h, d)] };
  },
  landed: (a, _b, x) => a.headlines.every((t) => x.headlines.some((c) => c.toLowerCase() === t.toLowerCase())) && a.descriptions.every((t) => x.descriptions.some((c) => c.toLowerCase() === t.toLowerCase())),
  result: (_a, x) => x,
});
export const removeAppAdAsset = stateWrite({
  name: "remove_app_ad_asset",
  title: "Remove App ad text",
  risk: "destructive",
  description: "Removes headlines and/or descriptions from the app ad of an App campaign ad group, after a person approves it. At least one headline and one description must remain. Confirmed by re-reading.",
  input: appInput,
  output: appOut,
  read: (a, ads) => readAppAd(ads, a.ad_group_id),
  build: (a, s, ads) => {
    const drop = (cur: string[], rm: string[]) => cur.filter((c) => !rm.some((t) => t.toLowerCase() === c.toLowerCase()));
    const missing = [...a.headlines.filter((t) => !s.headlines.some((c) => c.toLowerCase() === t.toLowerCase())), ...a.descriptions.filter((t) => !s.descriptions.some((c) => c.toLowerCase() === t.toLowerCase()))];
    if (missing.length) throw new ToolError("invalid_argument", `Not in the ad: ${missing.join("; ")}`);
    const h = drop(s.headlines, a.headlines);
    const d = drop(s.descriptions, a.descriptions);
    if (!h.length || !d.length) throw new ToolError("invalid_argument", "At least one headline and one description must remain.");
    return { summary: `App ad ${s.ad_id}: remove ${[...a.headlines, ...a.descriptions].join("; ")}`, changes: [change({ resource: "ad", id: s.ad_id }, "texts", [...s.headlines, ...s.descriptions].join(" | "), [...h, ...d].join(" | "), "remove")], ops: [appUpdate(ads, s.ad_id, h, d)] };
  },
  landed: (a, _b, x) => !a.headlines.some((t) => x.headlines.some((c) => c.toLowerCase() === t.toLowerCase())) && !a.descriptions.some((t) => x.descriptions.some((c) => c.toLowerCase() === t.toLowerCase())),
  result: (_a, x) => x,
});

export const adGroupAdTools = [addSearchAdGroup, addDisplayAdGroup, addDemandgenAdGroup, addShoppingAdGroup, addShoppingProductAd, addDisplayAd, updateDisplayAdCreative, addDemandgenAd, addAppAdAsset, removeAppAdAsset];
