import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, fromMicros, lit, num, pick } from "../gaql";
import { Money, accountId, campaignIds, dateClause, dateFields, datesMsg, datesOk, googleRead, idSchema, ratio, round, str } from "./common";

// Field names in this file are checked against the v26 schema and field reference by the test harness.

/** Last id in a resource name: customers/1/campaigns/22 -> "22", customers/1/adGroupCriteria/3~4 -> "3~4". */
export const tailId = (resourceName: unknown): string | null => (typeof resourceName === "string" && resourceName ? resourceName.split("/").pop()! : null);
const n = (r: Row, f: string): number | null => (pick(r, f) === undefined || pick(r, f) === null ? null : num(pick(r, f)));
const money = (r: Row, f: string): number | null => (pick(r, f) === undefined ? null : fromMicros(pick(r, f)));

async function requireCampaign(ads: GoogleAdsClient, campaignId: string) {
  const [r] = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type").from("campaign").where(`campaign.id = ${lit.id(campaignId)}`).limit(1), { maxRows: 1 });
  if (!r) throw new ToolError("not_found", `No campaign ${campaignId} in this account.`);
  return { id: campaignId, name: str(r, "campaign.name"), status: str(r, "campaign.status"), channel: str(r, "campaign.advertising_channel_type") };
}

// ---------------------------------------------------------------------------------------- get_campaign_structure
export const getCampaignStructure = googleRead({
  name: "get_campaign_structure",
  title: "Campaign structure",
  description: "Shows one campaign's ad groups with their status and type, and how many ads and keywords each contains (removed ones excluded). Use it to understand how a campaign is organised before changing it. Fetched live.",
  input: z.object({ account_id: accountId, campaign_id: idSchema }),
  output: z.object({
    campaign: z.object({ id: z.string(), name: z.string().nullable(), status: z.string().nullable(), channel_type: z.string().nullable() }),
    ad_groups: z.array(z.object({ ad_group_id: z.string().min(1), name: z.string().nullable(), status: z.string().nullable(), type: z.string().nullable(), ads: z.number(), keywords: z.number() })),
    counts_capped: z.boolean().describe("True when an account has more than 10,000 ads or keywords in this campaign, so counts stop there."),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const campaign = await requireCampaign(ads, a.campaign_id);
    const inCampaign = `campaign.id = ${lit.id(a.campaign_id)}`;
    const [groups, adRows, kwRows] = await Promise.all([
      ads.query(new Gaql().select("ad_group.id", "ad_group.name", "ad_group.status", "ad_group.type").from("ad_group").where(inCampaign).where("ad_group.status != 'REMOVED'").orderBy("ad_group.id").limit(1000), { maxRows: 1000 }),
      ads.query(new Gaql().select("ad_group.id", "ad_group_ad.ad.id").from("ad_group_ad").where(inCampaign).where("ad_group_ad.status != 'REMOVED'"), { maxRows: 10_000 }),
      ads.query(new Gaql().select("ad_group.id", "ad_group_criterion.criterion_id").from("ad_group_criterion").where(inCampaign).where("ad_group_criterion.type = 'KEYWORD'").where("ad_group_criterion.negative = FALSE").where("ad_group_criterion.status != 'REMOVED'"), { maxRows: 10_000 }),
    ]);
    const count = (rows: Row[]) => rows.reduce((m, r) => m.set(String(pick(r, "ad_group.id")), (m.get(String(pick(r, "ad_group.id"))) ?? 0) + 1), new Map<string, number>());
    const adCount = count(adRows);
    const kwCount = count(kwRows);
    return {
      campaign: { id: campaign.id, name: campaign.name, status: campaign.status, channel_type: campaign.channel },
      ad_groups: groups.map((g) => {
        const id = String(pick(g, "ad_group.id") ?? "");
        return { ad_group_id: id, name: str(g, "ad_group.name"), status: str(g, "ad_group.status"), type: str(g, "ad_group.type"), ads: adCount.get(id) ?? 0, keywords: kwCount.get(id) ?? 0 };
      }),
      counts_capped: adRows.length >= 10_000 || kwRows.length >= 10_000,
    };
  },
});

// ---------------------------------------------------------------------------------------- get_campaign_targeting
const CRITERIA_TYPES = ["LOCATION", "PROXIMITY", "LANGUAGE", "AD_SCHEDULE", "DEVICE", "AGE_RANGE", "GENDER", "INCOME_RANGE", "PARENTAL_STATUS", "IP_BLOCK"] as const;
export const getCampaignTargeting = googleRead({
  name: "get_campaign_targeting",
  title: "Campaign targeting",
  description: "Shows a campaign's targeting: locations (with names) and proximity radiuses, languages, ad schedule, device bid adjustments, demographic exclusions and blocked IPs, plus whether locations match presence or interest. Negative (excluded) criteria are marked. Fetched live.",
  input: z.object({ account_id: accountId, campaign_id: idSchema }),
  output: z.object({
    campaign_id: z.string(),
    location_match: z.object({ positive: z.string().nullable(), negative: z.string().nullable() }).describe("PRESENCE (people in the location) or PRESENCE_OR_INTEREST."),
    criteria: z.array(
      z.object({
        criterion_id: z.string().min(1),
        type: z.string(),
        negative: z.boolean(),
        bid_modifier: z.number().nullable().describe("1.0 = no change, 1.2 = +20%, 0 = excluded (device)."),
        detail: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
      }),
    ),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const [c] = await ads.query(new Gaql().select("campaign.id", "campaign.geo_target_type_setting.positive_geo_target_type", "campaign.geo_target_type_setting.negative_geo_target_type").from("campaign").where(`campaign.id = ${lit.id(a.campaign_id)}`).limit(1), { maxRows: 1 });
    if (!c) throw new ToolError("not_found", `No campaign ${a.campaign_id} in this account.`);
    const rows = await ads.query(
      new Gaql()
        .select(
          "campaign_criterion.criterion_id", "campaign_criterion.type", "campaign_criterion.negative", "campaign_criterion.bid_modifier",
          "campaign_criterion.location.geo_target_constant", "campaign_criterion.language.language_constant",
          "campaign_criterion.proximity.radius", "campaign_criterion.proximity.radius_units", "campaign_criterion.proximity.address.city_name", "campaign_criterion.proximity.address.postal_code", "campaign_criterion.proximity.address.country_code", "campaign_criterion.proximity.geo_point.latitude_in_micro_degrees", "campaign_criterion.proximity.geo_point.longitude_in_micro_degrees",
          "campaign_criterion.ad_schedule.day_of_week", "campaign_criterion.ad_schedule.start_hour", "campaign_criterion.ad_schedule.start_minute", "campaign_criterion.ad_schedule.end_hour", "campaign_criterion.ad_schedule.end_minute",
          "campaign_criterion.device.type", "campaign_criterion.age_range.type", "campaign_criterion.gender.type", "campaign_criterion.income_range.type", "campaign_criterion.parental_status.type", "campaign_criterion.ip_block.ip_address",
        )
        .from("campaign_criterion")
        .where(`campaign.id = ${lit.id(a.campaign_id)}`)
        .where(`campaign_criterion.type IN ${lit.list(CRITERIA_TYPES.map((t) => `'${t}'`))}`)
        .where("campaign_criterion.status != 'REMOVED'"),
      { maxRows: 5000 },
    );
    // Location names come from geo_target_constant, which cannot be joined in the same query.
    const geoIds = [...new Set(rows.map((r) => tailId(pick(r, "campaign_criterion.location.geo_target_constant"))).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    for (let i = 0; i < geoIds.length; i += 500) {
      const chunk = geoIds.slice(i, i + 500);
      const geo = await ads.query(new Gaql().select("geo_target_constant.id", "geo_target_constant.canonical_name", "geo_target_constant.target_type").from("geo_target_constant").where(`geo_target_constant.id IN ${lit.list(chunk.map(lit.id))}`), { maxRows: 500 });
      for (const g of geo) names.set(String(pick(g, "geo_target_constant.id")), `${str(g, "geo_target_constant.canonical_name") ?? ""} (${str(g, "geo_target_constant.target_type") ?? ""})`);
    }
    const p = (r: Row, f: string) => pick(r, `campaign_criterion.${f}`);
    return {
      campaign_id: a.campaign_id,
      location_match: { positive: str(c, "campaign.geo_target_type_setting.positive_geo_target_type"), negative: str(c, "campaign.geo_target_type_setting.negative_geo_target_type") },
      criteria: rows.map((r) => {
        const type = String(p(r, "type") ?? "");
        const detail: Record<string, string | number | null> = {};
        if (type === "LOCATION") {
          const id = tailId(p(r, "location.geo_target_constant"));
          detail.geo_target_id = id;
          detail.name = id ? names.get(id) ?? null : null;
        } else if (type === "LANGUAGE") detail.language_constant_id = tailId(p(r, "language.language_constant"));
        else if (type === "PROXIMITY") {
          detail.radius = n(r, "campaign_criterion.proximity.radius");
          detail.radius_units = str(r, "campaign_criterion.proximity.radius_units");
          detail.city = str(r, "campaign_criterion.proximity.address.city_name");
          detail.postal_code = str(r, "campaign_criterion.proximity.address.postal_code");
          detail.country_code = str(r, "campaign_criterion.proximity.address.country_code");
          const lat = n(r, "campaign_criterion.proximity.geo_point.latitude_in_micro_degrees");
          const lng = n(r, "campaign_criterion.proximity.geo_point.longitude_in_micro_degrees");
          detail.latitude = lat === null ? null : lat / 1e6;
          detail.longitude = lng === null ? null : lng / 1e6;
        } else if (type === "AD_SCHEDULE") {
          detail.day_of_week = str(r, "campaign_criterion.ad_schedule.day_of_week");
          detail.start = `${n(r, "campaign_criterion.ad_schedule.start_hour") ?? 0}:${str(r, "campaign_criterion.ad_schedule.start_minute") ?? "ZERO"}`;
          detail.end = `${n(r, "campaign_criterion.ad_schedule.end_hour") ?? 0}:${str(r, "campaign_criterion.ad_schedule.end_minute") ?? "ZERO"}`;
        } else if (type === "DEVICE") detail.device = str(r, "campaign_criterion.device.type");
        else if (type === "AGE_RANGE") detail.age_range = str(r, "campaign_criterion.age_range.type");
        else if (type === "GENDER") detail.gender = str(r, "campaign_criterion.gender.type");
        else if (type === "INCOME_RANGE") detail.income_range = str(r, "campaign_criterion.income_range.type");
        else if (type === "PARENTAL_STATUS") detail.parental_status = str(r, "campaign_criterion.parental_status.type");
        else if (type === "IP_BLOCK") detail.ip_address = str(r, "campaign_criterion.ip_block.ip_address");
        return { criterion_id: String(p(r, "criterion_id") ?? ""), type, negative: p(r, "negative") === true, bid_modifier: n(r, "campaign_criterion.bid_modifier"), detail };
      }),
    };
  },
});

// ------------------------------------------------------------------------------------------- get_campaign_labels
export const getCampaignLabels = googleRead({
  name: "get_campaign_labels",
  title: "Campaign labels",
  description: "Lists the labels attached to campaigns (optionally only the given campaigns), and every label defined in the account. Fetched live.",
  input: z.object({ account_id: accountId, campaign_ids: campaignIds.optional() }),
  output: z.object({
    campaign_labels: z.array(z.object({ campaign_id: z.string().min(1), campaign_name: z.string().nullable(), label_id: z.string().min(1), label_name: z.string().nullable() })),
    labels: z.array(z.object({ label_id: z.string().min(1), name: z.string().nullable(), status: z.string().nullable(), description: z.string().nullable() })),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const [links, labels] = await Promise.all([
      ads.query(new Gaql().select("campaign.id", "campaign.name", "label.id", "label.name").from("campaign_label").where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined).limit(10_000), { maxRows: 10_000 }),
      ads.query(new Gaql().select("label.id", "label.name", "label.status", "label.text_label.description").from("label").where("label.status != 'REMOVED'").orderBy("label.name").limit(1000), { maxRows: 1000 }),
    ]);
    return {
      campaign_labels: links.map((r) => ({ campaign_id: String(pick(r, "campaign.id") ?? ""), campaign_name: str(r, "campaign.name"), label_id: String(pick(r, "label.id") ?? ""), label_name: str(r, "label.name") })),
      labels: labels.map((r) => ({ label_id: String(pick(r, "label.id") ?? ""), name: str(r, "label.name"), status: str(r, "label.status"), description: str(r, "label.text_label.description") })),
    };
  },
});

// ---------------------------------------------------------------------------------- get_campaign_frequency_caps
const capSchema = z.object({ level: z.string().nullable(), event_type: z.string().nullable(), time_unit: z.string().nullable(), time_length: z.number().nullable(), cap: z.number().nullable() });
export const mapCaps = (raw: unknown): z.infer<typeof capSchema>[] =>
  (Array.isArray(raw) ? raw : []).map((e: Row) => ({
    level: str(e, "key.level"),
    event_type: str(e, "key.event_type"),
    time_unit: str(e, "key.time_unit"),
    time_length: n(e, "key.time_length"),
    cap: n(e, "cap"),
  }));
export const getCampaignFrequencyCaps = googleRead({
  name: "get_campaign_frequency_caps",
  title: "Campaign frequency caps",
  description: "Shows the frequency caps (how often the same person may see ads) on campaigns, optionally only the given ones. Frequency caps apply to Display and Video campaigns; others have none. Fetched live.",
  input: z.object({ account_id: accountId, campaign_ids: campaignIds.optional() }),
  output: z.object({ campaigns: z.array(z.object({ campaign_id: z.string().min(1), name: z.string().nullable(), channel_type: z.string().nullable(), frequency_caps: z.array(capSchema) })) }),
  handler: async (a, ctx) => {
    const rows = await ctx.services.ads.query(
      new Gaql().select("campaign.id", "campaign.name", "campaign.advertising_channel_type", "campaign.frequency_caps").from("campaign").where("campaign.status != 'REMOVED'").where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined).limit(1000),
      { maxRows: 1000 },
    );
    return { campaigns: rows.map((r) => ({ campaign_id: String(pick(r, "campaign.id") ?? ""), name: str(r, "campaign.name"), channel_type: str(r, "campaign.advertising_channel_type"), frequency_caps: mapCaps(pick(r, "campaign.frequency_caps")) })) };
  },
});

// -------------------------------------------------------------------------------------- list_campaign_extensions
// AssetFieldType values (v26). Image extensions are AD_IMAGE; location extensions are linked through asset sets, not a field type.
const EXTENSION_FIELD_TYPES = ["SITELINK", "CALLOUT", "STRUCTURED_SNIPPET", "CALL", "PRICE", "PROMOTION", "LEAD_FORM", "MOBILE_APP", "AD_IMAGE", "BUSINESS_NAME", "BUSINESS_LOGO"] as const;
const assetFields = ["asset.id", "asset.name", "asset.type", "asset.final_urls", "asset.sitelink_asset.link_text", "asset.sitelink_asset.description1", "asset.sitelink_asset.description2", "asset.callout_asset.callout_text", "asset.structured_snippet_asset.header", "asset.structured_snippet_asset.values", "asset.call_asset.phone_number", "asset.call_asset.country_code", "asset.text_asset.text", "asset.image_asset.full_size.url", "asset.policy_summary.approval_status"];
/** A compact, type-specific description of an asset's content. */
export function assetContent(r: Row): Record<string, string | string[] | null> {
  const t = str(r, "asset.type");
  if (t === "SITELINK") return { link_text: str(r, "asset.sitelink_asset.link_text"), description1: str(r, "asset.sitelink_asset.description1"), description2: str(r, "asset.sitelink_asset.description2"), final_urls: (pick(r, "asset.final_urls") as string[] | undefined) ?? [] };
  if (t === "CALLOUT") return { text: str(r, "asset.callout_asset.callout_text") };
  if (t === "STRUCTURED_SNIPPET") return { header: str(r, "asset.structured_snippet_asset.header"), values: (pick(r, "asset.structured_snippet_asset.values") as string[] | undefined) ?? [] };
  if (t === "CALL") return { phone_number: str(r, "asset.call_asset.phone_number"), country_code: str(r, "asset.call_asset.country_code") };
  if (t === "TEXT") return { text: str(r, "asset.text_asset.text") };
  if (t === "IMAGE") return { url: str(r, "asset.image_asset.full_size.url") };
  return {};
}
const extension = z.object({
  level: z.enum(["account", "campaign"]),
  campaign_id: z.string().nullable(),
  asset_id: z.string().min(1),
  field_type: z.string().nullable(),
  status: z.string().nullable(),
  asset_type: z.string().nullable(),
  approval: z.string().nullable(),
  content: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
});
export const listCampaignExtensions = googleRead({
  name: "list_campaign_extensions",
  title: "Campaign extensions (assets)",
  description: "Lists the extensions (sitelinks, callouts, structured snippets, calls, images and more, which Google now calls assets) linked to campaigns and to the whole account, with their text and approval status. Optionally only for given campaigns or one type. Fetched live.",
  input: z.object({ account_id: accountId, campaign_ids: campaignIds.optional(), field_type: z.enum(EXTENSION_FIELD_TYPES).optional(), include_account_level: z.boolean().default(true) }),
  output: z.object({ extensions: z.array(extension), returned: z.number() }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const types = a.field_type ? [a.field_type] : [...EXTENSION_FIELD_TYPES];
    const typeCond = (res: string) => `${res}.field_type IN ${lit.list(types.map((t) => `'${t}'`))}`;
    const [camp, acct] = await Promise.all([
      ads.query(new Gaql().select("campaign_asset.campaign", "campaign_asset.field_type", "campaign_asset.status", ...assetFields).from("campaign_asset").where(typeCond("campaign_asset")).where("campaign_asset.status != 'REMOVED'").where(a.campaign_ids?.length ? `campaign_asset.campaign IN ${lit.list(a.campaign_ids.map((c) => lit.str(`customers/${ads.customerId}/campaigns/${lit.id(c)}`)))}` : undefined), { maxRows: 5000 }),
      a.include_account_level ? ads.query(new Gaql().select("customer_asset.field_type", "customer_asset.status", ...assetFields).from("customer_asset").where(typeCond("customer_asset")).where("customer_asset.status != 'REMOVED'"), { maxRows: 5000 }) : Promise.resolve([] as Row[]),
    ]);
    const row = (r: Row, level: "account" | "campaign", res: string) => ({
      level,
      campaign_id: level === "campaign" ? tailId(pick(r, "campaign_asset.campaign")) : null,
      asset_id: String(pick(r, "asset.id") ?? ""),
      field_type: str(r, `${res}.field_type`),
      status: str(r, `${res}.status`),
      asset_type: str(r, "asset.type"),
      approval: str(r, "asset.policy_summary.approval_status"),
      content: assetContent(r),
    });
    const extensions = [...camp.map((r) => row(r, "campaign", "campaign_asset")), ...acct.map((r) => row(r, "account", "customer_asset"))];
    return { extensions, returned: extensions.length };
  },
});

// ------------------------------------------------------------------------------------------------ list_call_assets
export const listCallAssets = googleRead({
  name: "list_call_assets",
  title: "Call assets",
  description: "Lists the call assets (phone numbers shown with ads) in the account, with country, call conversion reporting, approval status, and where each is linked (account, campaigns, ad groups). Fetched live.",
  input: z.object({ account_id: accountId }),
  output: z.object({
    call_assets: z.array(z.object({ asset_id: z.string().min(1), phone_number: z.string().nullable(), country_code: z.string().nullable(), call_conversion_reporting: z.string().nullable(), approval: z.string().nullable(), linked_to: z.array(z.object({ level: z.enum(["account", "campaign", "ad_group"]), id: z.string().nullable(), status: z.string().nullable() })) })),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const fields = ["asset.id", "asset.call_asset.phone_number", "asset.call_asset.country_code", "asset.call_asset.call_conversion_reporting_state", "asset.policy_summary.approval_status"];
    const [assets, cust, camp, grp] = await Promise.all([
      ads.query(new Gaql().select(...fields).from("asset").where("asset.type = 'CALL'"), { maxRows: 2000 }),
      ads.query(new Gaql().select("asset.id", "customer_asset.status").from("customer_asset").where("customer_asset.field_type = 'CALL'").where("customer_asset.status != 'REMOVED'"), { maxRows: 2000 }),
      ads.query(new Gaql().select("asset.id", "campaign_asset.campaign", "campaign_asset.status").from("campaign_asset").where("campaign_asset.field_type = 'CALL'").where("campaign_asset.status != 'REMOVED'"), { maxRows: 5000 }),
      ads.query(new Gaql().select("asset.id", "ad_group_asset.ad_group", "ad_group_asset.status").from("ad_group_asset").where("ad_group_asset.field_type = 'CALL'").where("ad_group_asset.status != 'REMOVED'"), { maxRows: 5000 }),
    ]);
    const links = new Map<string, { level: "account" | "campaign" | "ad_group"; id: string | null; status: string | null }[]>();
    const add = (assetId: unknown, l: { level: "account" | "campaign" | "ad_group"; id: string | null; status: string | null }) => links.set(String(assetId), [...(links.get(String(assetId)) ?? []), l]);
    for (const r of cust) add(pick(r, "asset.id"), { level: "account", id: null, status: str(r, "customer_asset.status") });
    for (const r of camp) add(pick(r, "asset.id"), { level: "campaign", id: tailId(pick(r, "campaign_asset.campaign")), status: str(r, "campaign_asset.status") });
    for (const r of grp) add(pick(r, "asset.id"), { level: "ad_group", id: tailId(pick(r, "ad_group_asset.ad_group")), status: str(r, "ad_group_asset.status") });
    return {
      call_assets: assets.map((r) => ({ asset_id: String(pick(r, "asset.id") ?? ""), phone_number: str(r, "asset.call_asset.phone_number"), country_code: str(r, "asset.call_asset.country_code"), call_conversion_reporting: str(r, "asset.call_asset.call_conversion_reporting_state"), approval: str(r, "asset.policy_summary.approval_status"), linked_to: links.get(String(pick(r, "asset.id"))) ?? [] })),
    };
  },
});

// ----------------------------------------------------------------------------- get_conversion_action_performance
export const getConversionActionPerformance = googleRead({
  name: "get_conversion_action_performance",
  title: "Conversion action performance",
  description: "Conversions and conversion value per conversion action for a period, with each action's category, status, whether it counts as a primary goal, and counting type. 'conversions' counts only actions included in the Conversions column; 'all_conversions' counts every action. Fetched live.",
  input: z.object({ account_id: accountId, ...dateFields, campaign_ids: campaignIds.optional() }).refine(datesOk, datesMsg),
  output: z.object({
    period: z.string(),
    actions: z.array(z.object({ conversion_action_id: z.string().nullable(), name: z.string().nullable(), category: z.string().nullable(), status: z.string().nullable(), primary_for_goal: z.boolean().nullable(), counting_type: z.string().nullable(), conversions: z.number(), conversion_value: z.number(), all_conversions: z.number(), all_conversion_value: z.number() })),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const [perf, meta] = await Promise.all([
      ads.query(new Gaql().select("segments.conversion_action", "segments.conversion_action_name", "metrics.conversions", "metrics.conversions_value", "metrics.all_conversions", "metrics.all_conversions_value").from("campaign").where(dateClause(a)).where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined), { maxRows: 10_000 }),
      ads.query(new Gaql().select("conversion_action.id", "conversion_action.name", "conversion_action.category", "conversion_action.status", "conversion_action.primary_for_goal", "conversion_action.counting_type").from("conversion_action").where("conversion_action.status != 'REMOVED'"), { maxRows: 2000 }),
    ]);
    // Rows are per campaign and action: add them up per action.
    const by = new Map<string, { name: string | null; c: number; v: number; ac: number; av: number }>();
    for (const r of perf) {
      const id = tailId(pick(r, "segments.conversion_action"));
      if (!id) continue;
      const cur = by.get(id) ?? { name: str(r, "segments.conversion_action_name"), c: 0, v: 0, ac: 0, av: 0 };
      cur.c += num(pick(r, "metrics.conversions"));
      cur.v += num(pick(r, "metrics.conversions_value"));
      cur.ac += num(pick(r, "metrics.all_conversions"));
      cur.av += num(pick(r, "metrics.all_conversions_value"));
      by.set(id, cur);
    }
    const info = new Map(meta.map((m) => [String(pick(m, "conversion_action.id")), m]));
    const ids = new Set([...by.keys(), ...info.keys()]);
    return {
      period: a.start_date ? `${a.start_date}..${a.end_date}` : a.date_range,
      actions: [...ids]
        .map((id) => {
          const p = by.get(id);
          const m = info.get(id);
          return {
            conversion_action_id: id,
            name: m ? str(m, "conversion_action.name") : p?.name ?? null,
            category: m ? str(m, "conversion_action.category") : null,
            status: m ? str(m, "conversion_action.status") : null,
            primary_for_goal: m && pick(m, "conversion_action.primary_for_goal") !== undefined ? pick(m, "conversion_action.primary_for_goal") === true : null,
            counting_type: m ? str(m, "conversion_action.counting_type") : null,
            conversions: round(p?.c ?? 0, 2)!,
            conversion_value: round(p?.v ?? 0, 2)!,
            all_conversions: round(p?.ac ?? 0, 2)!,
            all_conversion_value: round(p?.av ?? 0, 2)!,
          };
        })
        .sort((x, y) => y.all_conversions - x.all_conversions),
    };
  },
});

// ------------------------------------------------------------------------------------- get_placement_performance
export const getPlacementPerformance = googleRead({
  name: "get_placement_performance",
  title: "Placement performance",
  description: "Where Display and Video ads actually showed (websites, apps, YouTube channels and videos) and how each placement performed in a period, sorted by cost. Use it to find placements to exclude. Fetched live.",
  input: z.object({ account_id: accountId, ...dateFields, campaign_ids: campaignIds.optional(), min_impressions: z.number().int().min(0).max(1_000_000).default(1), limit: z.number().int().min(1).max(500).default(100) }).refine(datesOk, datesMsg),
  output: z.object({
    period: z.string(),
    placements: z.array(z.object({ placement: z.string().nullable(), display_name: z.string().nullable(), type: z.string().nullable(), target_url: z.string().nullable(), campaign_id: z.string().nullable(), impressions: z.number(), clicks: z.number(), cost: Money, conversions: z.number(), ctr: z.number().nullable(), cost_per_conversion: Money.nullable() })),
    returned: z.number(),
    truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const rows = await ctx.services.ads.query(
      new Gaql()
        .select("detail_placement_view.placement", "detail_placement_view.display_name", "detail_placement_view.placement_type", "detail_placement_view.target_url", "campaign.id", "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions")
        .from("detail_placement_view")
        .where(dateClause(a))
        .where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined)
        .where(a.min_impressions > 0 && `metrics.impressions >= ${lit.int(a.min_impressions)}`)
        .orderBy("metrics.cost_micros", "DESC")
        .limit(a.limit + 1),
      { maxRows: a.limit + 1 },
    );
    const shown = rows.slice(0, a.limit).map((r) => {
      const imp = num(pick(r, "metrics.impressions")), clicks = num(pick(r, "metrics.clicks")), cost = fromMicros(pick(r, "metrics.cost_micros")), conv = num(pick(r, "metrics.conversions"));
      return { placement: str(r, "detail_placement_view.placement"), display_name: str(r, "detail_placement_view.display_name"), type: str(r, "detail_placement_view.placement_type"), target_url: str(r, "detail_placement_view.target_url"), campaign_id: str(r, "campaign.id"), impressions: imp, clicks, cost: round(cost, 2)!, conversions: conv, ctr: round(ratio(clicks, imp)), cost_per_conversion: round(ratio(cost, conv), 2) };
    });
    return { period: a.start_date ? `${a.start_date}..${a.end_date}` : a.date_range, placements: shown, returned: shown.length, truncated: rows.length > a.limit };
  },
});

// -------------------------------------------------------------------------------------- get_merchant_center_links
export const getMerchantCenterLinks = googleRead({
  name: "get_merchant_center_links",
  title: "Merchant Center links",
  description: "Lists the Merchant Center accounts linked to this Google Ads account (needed for Shopping and Performance Max with a product feed). In API v26 these are product links; the older merchant center link resource no longer exists. Fetched live.",
  input: z.object({ account_id: accountId }),
  output: z.object({ links: z.array(z.object({ product_link_id: z.string().nullable(), merchant_center_id: z.string().nullable() })) }),
  handler: async (_a, ctx) => {
    const rows = await ctx.services.ads.query(new Gaql().select("product_link.product_link_id", "product_link.type", "product_link.merchant_center.merchant_center_id").from("product_link").where("product_link.type = 'MERCHANT_CENTER'"), { maxRows: 500 });
    return { links: rows.map((r) => ({ product_link_id: str(r, "product_link.product_link_id"), merchant_center_id: str(r, "product_link.merchant_center.merchant_center_id") })) };
  },
});

// ---------------------------------------------------------------------------------------- get_shopping_settings
export const getShoppingSettings = googleRead({
  name: "get_shopping_settings",
  title: "Shopping settings",
  description: "Shows the shopping settings of Shopping and Performance Max campaigns: Merchant Center account, feed label, campaign priority, local inventory and vehicle inventory. Fetched live.",
  input: z.object({ account_id: accountId, campaign_ids: campaignIds.optional() }),
  output: z.object({ campaigns: z.array(z.object({ campaign_id: z.string().min(1), name: z.string().nullable(), channel_type: z.string().nullable(), merchant_id: z.string().nullable(), feed_label: z.string().nullable(), campaign_priority: z.number().nullable(), enable_local: z.boolean().nullable(), use_vehicle_inventory: z.boolean().nullable() })) }),
  handler: async (a, ctx) => {
    const rows = await ctx.services.ads.query(
      new Gaql()
        .select("campaign.id", "campaign.name", "campaign.advertising_channel_type", "campaign.shopping_setting.merchant_id", "campaign.shopping_setting.feed_label", "campaign.shopping_setting.campaign_priority", "campaign.shopping_setting.enable_local", "campaign.shopping_setting.use_vehicle_inventory")
        .from("campaign")
        .where("campaign.advertising_channel_type IN ('SHOPPING', 'PERFORMANCE_MAX')")
        .where("campaign.status != 'REMOVED'")
        .where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined)
        .limit(1000),
      { maxRows: 1000 },
    );
    const b = (r: Row, f: string) => (pick(r, f) === undefined ? null : pick(r, f) === true);
    return {
      campaigns: rows.map((r) => ({ campaign_id: String(pick(r, "campaign.id") ?? ""), name: str(r, "campaign.name"), channel_type: str(r, "campaign.advertising_channel_type"), merchant_id: str(r, "campaign.shopping_setting.merchant_id"), feed_label: str(r, "campaign.shopping_setting.feed_label"), campaign_priority: n(r, "campaign.shopping_setting.campaign_priority"), enable_local: b(r, "campaign.shopping_setting.enable_local"), use_vehicle_inventory: b(r, "campaign.shopping_setting.use_vehicle_inventory") })),
    };
  },
});

// ----------------------------------------------------------------------------------------------- get_product_groups
export const getProductGroups = googleRead({
  name: "get_product_groups",
  title: "Product groups",
  description: "Shows the product group tree (listing groups) of a Standard Shopping ad group: each node's parent, whether it is a subdivision or a unit, the dimension it splits on, its value, and its max CPC bid. Fetched live.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema }),
  output: z.object({ ad_group_id: z.string(), nodes: z.array(z.object({ criterion_id: z.string().min(1), parent_criterion_id: z.string().nullable(), type: z.string().nullable(), negative: z.boolean(), dimension: z.string().nullable(), value: z.string().nullable(), cpc_bid: Money.nullable() })) }),
  handler: async (a, ctx) => {
    const cv = "ad_group_criterion.listing_group.case_value";
    const dims: [string, string][] = [
      ["product_brand", `${cv}.product_brand.value`], ["product_item_id", `${cv}.product_item_id.value`], ["product_condition", `${cv}.product_condition.condition`],
      ["product_type", `${cv}.product_type.value`], ["product_category", `${cv}.product_category.category_id`], ["product_channel", `${cv}.product_channel.channel`],
      ["product_custom_attribute", `${cv}.product_custom_attribute.value`],
    ];
    const rows = await ctx.services.ads.query(
      new Gaql()
        .select("ad_group_criterion.criterion_id", "ad_group_criterion.listing_group.type", "ad_group_criterion.listing_group.parent_ad_group_criterion", "ad_group_criterion.negative", "ad_group_criterion.cpc_bid_micros", ...dims.map((d) => d[1]))
        .from("ad_group_criterion")
        .where(`ad_group.id = ${lit.id(a.ad_group_id)}`)
        .where("ad_group_criterion.type = 'LISTING_GROUP'")
        .where("ad_group_criterion.status != 'REMOVED'"),
      { maxRows: 5000 },
    );
    return {
      ad_group_id: a.ad_group_id,
      nodes: rows.map((r) => {
        const d = dims.find(([, f]) => pick(r, f) !== undefined);
        const parent = tailId(pick(r, "ad_group_criterion.listing_group.parent_ad_group_criterion"));
        return {
          criterion_id: String(pick(r, "ad_group_criterion.criterion_id") ?? ""),
          parent_criterion_id: parent ? parent.split("~").pop()! : null,
          type: str(r, "ad_group_criterion.listing_group.type"),
          negative: pick(r, "ad_group_criterion.negative") === true,
          dimension: d ? d[0] : null, // null on the root ("all products") and "everything else" nodes
          value: d ? String(pick(r, d[1])) : null,
          cpc_bid: money(r, "ad_group_criterion.cpc_bid_micros"),
        };
      }),
    };
  },
});

// -------------------------------------------------------------------------------------- discover_existing_assets
const ASSET_TYPES = ["TEXT", "IMAGE", "YOUTUBE_VIDEO", "SITELINK", "CALLOUT", "STRUCTURED_SNIPPET", "CALL", "LEAD_FORM", "PRICE", "PROMOTION", "MOBILE_APP"] as const;
export const discoverExistingAssets = googleRead({
  name: "discover_existing_assets",
  title: "Existing assets",
  description: "Lists assets already in the account's asset library (text, images, YouTube videos, sitelinks, callouts and more) with their content and approval status, so they can be reused instead of uploaded again. Optionally one type or a name filter. Fetched live.",
  input: z.object({ account_id: accountId, type: z.enum(ASSET_TYPES).optional(), name_contains: z.string().regex(/^[\w .-]{1,100}$/).optional(), limit: z.number().int().min(1).max(500).default(200) }),
  output: z.object({ assets: z.array(z.object({ asset_id: z.string().min(1), name: z.string().nullable(), type: z.string().nullable(), approval: z.string().nullable(), youtube_video_id: z.string().nullable(), image: z.object({ url: z.string().nullable(), width: z.number().nullable(), height: z.number().nullable(), mime_type: z.string().nullable() }).nullable(), content: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])) })), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const rows = await ctx.services.ads.query(
      new Gaql()
        .select(...assetFields, "asset.youtube_video_asset.youtube_video_id", "asset.image_asset.full_size.width_pixels", "asset.image_asset.full_size.height_pixels", "asset.image_asset.mime_type")
        .from("asset")
        .where(`asset.type IN ${lit.list((a.type ? [a.type] : [...ASSET_TYPES]).map((t) => `'${t}'`))}`)
        .where(a.name_contains && `asset.name LIKE ${lit.str(`%${a.name_contains}%`)}`)
        .orderBy("asset.id", "DESC")
        .limit(a.limit + 1),
      { maxRows: a.limit + 1 },
    );
    const shown = rows.slice(0, a.limit).map((r) => ({
      asset_id: String(pick(r, "asset.id") ?? ""),
      name: str(r, "asset.name"),
      type: str(r, "asset.type"),
      approval: str(r, "asset.policy_summary.approval_status"),
      youtube_video_id: str(r, "asset.youtube_video_asset.youtube_video_id"),
      image: str(r, "asset.type") === "IMAGE" ? { url: str(r, "asset.image_asset.full_size.url"), width: n(r, "asset.image_asset.full_size.width_pixels"), height: n(r, "asset.image_asset.full_size.height_pixels"), mime_type: str(r, "asset.image_asset.mime_type") } : null,
      content: assetContent(r),
    }));
    return { assets: shown, returned: shown.length, truncated: rows.length > a.limit };
  },
});

export const campaignReadTools = [getCampaignStructure, getCampaignTargeting, getCampaignLabels, getCampaignFrequencyCaps, listCampaignExtensions, listCallAssets, getConversionActionPerformance, getPlacementPerformance, getMerchantCenterLinks, getShoppingSettings, getProductGroups, discoverExistingAssets];
