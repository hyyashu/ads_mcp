import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, fromMicros, lit, num, pick } from "../gaql";
import { mapCaps, tailId } from "./campaign-reads";
import { Money, accountId, campaignIds, googleRead, idSchema, str } from "./common";

const n = (r: Row, f: string): number | null => (pick(r, f) === undefined || pick(r, f) === null ? null : num(pick(r, f)));
const money = (r: Row, f: string): number | null => (pick(r, f) === undefined ? null : fromMicros(pick(r, f)));

export const AUDIENCE_TYPES = ["USER_LIST", "USER_INTEREST", "CUSTOM_AUDIENCE", "COMBINED_AUDIENCE"] as const;
export const DEMOGRAPHIC_TYPES = ["AGE_RANGE", "GENDER", "INCOME_RANGE", "PARENTAL_STATUS"] as const;
type Channel = "DISPLAY" | "DEMAND_GEN" | "SEARCH" | "VIDEO";

const scopeInput = {
  account_id: accountId,
  campaign_id: idSchema.optional().describe("Only ad groups of this campaign."),
  ad_group_ids: z.array(idSchema).max(50).optional().describe("Only these ad groups."),
};
const criterionRow = z.object({
  campaign_id: z.string().nullable(),
  ad_group_id: z.string().nullable(),
  criterion_id: z.string().min(1),
  type: z.string(),
  negative: z.boolean().describe("True = excluded."),
  status: z.string().nullable(),
  bid_modifier: z.number().nullable(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
});
export type CriterionRow = z.infer<typeof criterionRow>;

/**
 * Reads ad-group-level criteria of the given types (optionally limited to a campaign, ad groups or a channel) with a
 * type-specific detail. Custom audience names come from a second query: custom_audience cannot be joined.
 */
export async function adGroupCriteria(ads: GoogleAdsClient, o: { types: readonly string[]; campaignId?: string; adGroupIds?: string[]; channel?: Channel }): Promise<CriterionRow[]> {
  const c = "ad_group_criterion";
  const rows = await ads.query(
    new Gaql()
      .select(
        "campaign.id", "ad_group.id", `${c}.criterion_id`, `${c}.type`, `${c}.negative`, `${c}.status`, `${c}.bid_modifier`,
        `${c}.user_list.user_list`, "user_list.name", `${c}.user_interest.user_interest_category`, "user_interest.name", `${c}.custom_audience.custom_audience`, `${c}.combined_audience.combined_audience`,
        `${c}.age_range.type`, `${c}.gender.type`, `${c}.income_range.type`, `${c}.parental_status.type`,
        `${c}.keyword.text`, `${c}.keyword.match_type`, `${c}.placement.url`, `${c}.mobile_application.app_id`, `${c}.topic.topic_constant`, `${c}.topic.path`, `${c}.display_name`,
      )
      .from(c)
      .where(`${c}.type IN ${lit.list(o.types.map((t) => `'${t}'`))}`)
      .where(`${c}.status != 'REMOVED'`)
      .where(o.campaignId && `campaign.id = ${lit.id(o.campaignId)}`)
      .where(o.adGroupIds?.length ? `ad_group.id IN ${lit.list(o.adGroupIds.map(lit.id))}` : undefined)
      .where(o.channel && `campaign.advertising_channel_type = '${o.channel}'`),
    { maxRows: 10_000 },
  );
  const customIds = [...new Set(rows.map((r) => tailId(pick(r, `${c}.custom_audience.custom_audience`))).filter((x): x is string => !!x))];
  const customNames = new Map<string, string | null>();
  if (customIds.length) {
    for (const r of await ads.query(new Gaql().select("custom_audience.id", "custom_audience.name").from("custom_audience").where(`custom_audience.id IN ${lit.list(customIds.slice(0, 1000).map(lit.id))}`), { maxRows: 1000 })) {
      customNames.set(String(pick(r, "custom_audience.id")), str(r, "custom_audience.name"));
    }
  }
  return rows.map((r) => {
    const type = String(pick(r, `${c}.type`) ?? "");
    const d: Record<string, string | number | null> = {};
    if (type === "USER_LIST") (d.user_list_id = tailId(pick(r, `${c}.user_list.user_list`))), (d.name = str(r, "user_list.name"));
    else if (type === "USER_INTEREST") (d.user_interest_id = tailId(pick(r, `${c}.user_interest.user_interest_category`))), (d.name = str(r, "user_interest.name"));
    else if (type === "CUSTOM_AUDIENCE") {
      const id = tailId(pick(r, `${c}.custom_audience.custom_audience`));
      d.custom_audience_id = id;
      d.name = id ? customNames.get(id) ?? null : null;
    } else if (type === "COMBINED_AUDIENCE") d.combined_audience_id = tailId(pick(r, `${c}.combined_audience.combined_audience`));
    else if (type === "AGE_RANGE") d.age_range = str(r, `${c}.age_range.type`);
    else if (type === "GENDER") d.gender = str(r, `${c}.gender.type`);
    else if (type === "INCOME_RANGE") d.income_range = str(r, `${c}.income_range.type`);
    else if (type === "PARENTAL_STATUS") d.parental_status = str(r, `${c}.parental_status.type`);
    else if (type === "KEYWORD") (d.text = str(r, `${c}.keyword.text`)), (d.match_type = str(r, `${c}.keyword.match_type`));
    else if (type === "PLACEMENT") d.url = str(r, `${c}.placement.url`);
    else if (type === "MOBILE_APPLICATION") d.app_id = str(r, `${c}.mobile_application.app_id`);
    else if (type === "TOPIC") (d.topic_id = tailId(pick(r, `${c}.topic.topic_constant`))), (d.path = ((pick(r, `${c}.topic.path`) as string[] | undefined) ?? []).join(" > ") || null);
    if (d.name === undefined && str(r, `${c}.display_name`)) d.display_name = str(r, `${c}.display_name`);
    return { campaign_id: str(r, "campaign.id"), ad_group_id: str(r, "ad_group.id"), criterion_id: String(pick(r, `${c}.criterion_id`) ?? ""), type, negative: pick(r, `${c}.negative`) === true, status: str(r, `${c}.status`), bid_modifier: n(r, `${c}.bid_modifier`), detail: d };
  });
}

const needScope = (a: { campaign_id?: string; ad_group_ids?: string[] }) => {
  if (!a.campaign_id && !a.ad_group_ids?.length) throw new ToolError("invalid_argument", "Give campaign_id or ad_group_ids.");
};
const criteriaTool = (name: string, title: string, description: string, types: readonly string[], channel?: Channel, requireScope = true) =>
  googleRead({
    name,
    title,
    description,
    input: z.object(scopeInput),
    output: z.object({ criteria: z.array(criterionRow), returned: z.number() }),
    handler: async (a, ctx) => {
      if (requireScope) needScope(a);
      const criteria = await adGroupCriteria(ctx.services.ads, { types, campaignId: a.campaign_id, adGroupIds: a.ad_group_ids, channel });
      return { criteria, returned: criteria.length };
    },
  });

export const getAdGroupAudiences = criteriaTool("get_ad_group_audiences", "Ad group audiences", "Lists the audiences on ad groups (your data segments, affinity and in-market segments, custom and combined audiences) with names, and whether each is targeted or excluded. Give campaign_id or ad_group_ids. Fetched live.", AUDIENCE_TYPES);
export const getAdGroupDemographics = criteriaTool("get_ad_group_demographics", "Ad group demographics", "Lists the demographic criteria on ad groups (age range, gender, household income, parental status), whether each is excluded, and its bid adjustment. Give campaign_id or ad_group_ids. Fetched live.", DEMOGRAPHIC_TYPES);
export const getDisplayAudiences = criteriaTool("get_display_audiences", "Display audiences", "Lists audience targeting and exclusions on Display campaign ad groups, with names. Optionally one campaign or some ad groups; otherwise every Display campaign. Fetched live.", AUDIENCE_TYPES, "DISPLAY", false);
export const getDisplayDemographics = criteriaTool("get_display_demographics", "Display demographics", "Lists demographic targeting and exclusions (age, gender, income, parental status) on Display campaign ad groups. Optionally one campaign or some ad groups. Fetched live.", DEMOGRAPHIC_TYPES, "DISPLAY", false);
export const getDisplayKeywords = criteriaTool("get_display_keywords", "Display keywords", "Lists the content keywords on Display campaign ad groups (keywords that choose pages to show on, not search queries). Optionally one campaign or some ad groups. Fetched live.", ["KEYWORD"], "DISPLAY", false);
export const getDisplayTopics = criteriaTool("get_display_topics", "Display topics", "Lists the topics targeted or excluded on Display campaign ad groups, with the topic path (for example Arts & Entertainment > Music). Optionally one campaign or some ad groups. Fetched live.", ["TOPIC"], "DISPLAY", false);
export const getDemandgenAudiences = criteriaTool("get_demandgen_audiences", "Demand Gen audiences", "Lists audience targeting and exclusions on Demand Gen campaign ad groups, with names. Optionally one campaign or some ad groups. Fetched live.", AUDIENCE_TYPES, "DEMAND_GEN", false);

// -------------------------------------------------------------------------------------------- get_display_placements
export const getDisplayPlacements = googleRead({
  name: "get_display_placements",
  title: "Display placements",
  description: "Lists the managed placements (websites, apps, YouTube channels and videos chosen by you) on Display ad groups, and placement exclusions at ad group and campaign level. For where ads actually showed, use get_placement_performance. Fetched live.",
  input: z.object(scopeInput),
  output: z.object({ ad_group_placements: z.array(criterionRow), campaign_exclusions: z.array(z.object({ campaign_id: z.string().nullable(), criterion_id: z.string().min(1), type: z.string(), url: z.string().nullable(), app_id: z.string().nullable(), youtube_channel_id: z.string().nullable(), youtube_video_id: z.string().nullable() })) }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const placementTypes = ["PLACEMENT", "MOBILE_APPLICATION", "YOUTUBE_CHANNEL", "YOUTUBE_VIDEO"];
    const [groups, camp] = await Promise.all([
      adGroupCriteria(ads, { types: placementTypes, campaignId: a.campaign_id, adGroupIds: a.ad_group_ids, channel: "DISPLAY" }),
      ads.query(
        new Gaql()
          .select("campaign.id", "campaign_criterion.criterion_id", "campaign_criterion.type", "campaign_criterion.placement.url", "campaign_criterion.mobile_application.app_id", "campaign_criterion.youtube_channel.channel_id", "campaign_criterion.youtube_video.video_id")
          .from("campaign_criterion")
          .where(`campaign_criterion.type IN ${lit.list(placementTypes.map((t) => `'${t}'`))}`)
          .where("campaign_criterion.negative = TRUE")
          .where("campaign.advertising_channel_type = 'DISPLAY'")
          .where(a.campaign_id && `campaign.id = ${lit.id(a.campaign_id)}`),
        { maxRows: 10_000 },
      ),
    ]);
    return {
      ad_group_placements: groups,
      campaign_exclusions: camp.map((r) => ({ campaign_id: str(r, "campaign.id"), criterion_id: String(pick(r, "campaign_criterion.criterion_id") ?? ""), type: String(pick(r, "campaign_criterion.type") ?? ""), url: str(r, "campaign_criterion.placement.url"), app_id: str(r, "campaign_criterion.mobile_application.app_id"), youtube_channel_id: str(r, "campaign_criterion.youtube_channel.channel_id"), youtube_video_id: str(r, "campaign_criterion.youtube_video.video_id") })),
    };
  },
});

// ------------------------------------------------------------------------------------ get_ad_group_device_bid_modifiers
export const getAdGroupDeviceBidModifiers = googleRead({
  name: "get_ad_group_device_bid_modifiers",
  title: "Ad group device bid adjustments",
  description: "Shows device bid adjustments on ad groups (mobile, desktop, tablet, connected TV). 1.0 = no change, 1.2 = +20%, 0 = do not show on that device. Devices without an adjustment are not listed. Give campaign_id or ad_group_ids. Fetched live.",
  input: z.object(scopeInput),
  output: z.object({ modifiers: z.array(z.object({ ad_group_id: z.string().nullable(), criterion_id: z.string().nullable(), device: z.string().nullable(), bid_modifier: z.number().nullable() })) }),
  handler: async (a, ctx) => {
    needScope(a);
    const rows = await ctx.services.ads.query(
      new Gaql()
        .select("ad_group.id", "ad_group_bid_modifier.criterion_id", "ad_group_bid_modifier.device.type", "ad_group_bid_modifier.bid_modifier")
        .from("ad_group_bid_modifier")
        .where("ad_group_bid_modifier.device.type IN ('MOBILE', 'DESKTOP', 'TABLET', 'CONNECTED_TV')")
        .where(a.campaign_id && `campaign.id = ${lit.id(a.campaign_id)}`)
        .where(a.ad_group_ids?.length ? `ad_group.id IN ${lit.list(a.ad_group_ids.map(lit.id))}` : undefined),
      { maxRows: 5000 },
    );
    return { modifiers: rows.map((r) => ({ ad_group_id: str(r, "ad_group.id"), criterion_id: str(r, "ad_group_bid_modifier.criterion_id"), device: str(r, "ad_group_bid_modifier.device.type"), bid_modifier: n(r, "ad_group_bid_modifier.bid_modifier") })) };
  },
});

// ------------------------------------------------------------------------------------- get_display_ad_group_settings
export const getDisplayAdGroupSettings = googleRead({
  name: "get_display_ad_group_settings",
  title: "Display ad group settings",
  description: "Shows Display ad group settings: status, bids (CPC, CPM, target CPA), optimized targeting, and targeting restrictions (whether each criterion type narrows reach or is observation only). Optionally one campaign or some ad groups. Fetched live.",
  input: z.object(scopeInput),
  output: z.object({ ad_groups: z.array(z.object({ ad_group_id: z.string().min(1), campaign_id: z.string().nullable(), name: z.string().nullable(), status: z.string().nullable(), cpc_bid: Money.nullable(), cpm_bid: Money.nullable(), target_cpa: Money.nullable(), optimized_targeting: z.boolean().nullable(), target_restrictions: z.array(z.object({ dimension: z.string().nullable(), bid_only: z.boolean().nullable() })) })) }),
  handler: async (a, ctx) => {
    const rows = await ctx.services.ads.query(
      new Gaql()
        .select("ad_group.id", "campaign.id", "ad_group.name", "ad_group.status", "ad_group.cpc_bid_micros", "ad_group.cpm_bid_micros", "ad_group.target_cpa_micros", "ad_group.optimized_targeting_enabled", "ad_group.targeting_setting.target_restrictions")
        .from("ad_group")
        .where("campaign.advertising_channel_type = 'DISPLAY'")
        .where("ad_group.status != 'REMOVED'")
        .where(a.campaign_id && `campaign.id = ${lit.id(a.campaign_id)}`)
        .where(a.ad_group_ids?.length ? `ad_group.id IN ${lit.list(a.ad_group_ids.map(lit.id))}` : undefined),
      { maxRows: 1000 },
    );
    return {
      ad_groups: rows.map((r) => ({
        ad_group_id: String(pick(r, "ad_group.id") ?? ""),
        campaign_id: str(r, "campaign.id"),
        name: str(r, "ad_group.name"),
        status: str(r, "ad_group.status"),
        cpc_bid: money(r, "ad_group.cpc_bid_micros"),
        cpm_bid: money(r, "ad_group.cpm_bid_micros"),
        target_cpa: money(r, "ad_group.target_cpa_micros"),
        optimized_targeting: pick(r, "ad_group.optimized_targeting_enabled") === undefined ? null : pick(r, "ad_group.optimized_targeting_enabled") === true,
        target_restrictions: ((pick(r, "ad_group.targeting_setting.target_restrictions") as Row[] | undefined) ?? []).map((t) => ({ dimension: str(t, "targeting_dimension"), bid_only: pick(t, "bid_only") === undefined ? null : pick(t, "bid_only") === true })),
      })),
    };
  },
});

// ------------------------------------------------------------------------------------- get_display_frequency_caps
export const getDisplayFrequencyCaps = googleRead({
  name: "get_display_frequency_caps",
  title: "Display frequency caps",
  description: "Shows the frequency caps (maximum impressions per person per day, week or month) on Display campaigns. Optionally only given campaigns. Fetched live.",
  input: z.object({ account_id: accountId, campaign_ids: campaignIds.optional() }),
  output: z.object({ campaigns: z.array(z.object({ campaign_id: z.string().min(1), name: z.string().nullable(), frequency_caps: z.array(z.object({ level: z.string().nullable(), event_type: z.string().nullable(), time_unit: z.string().nullable(), time_length: z.number().nullable(), cap: z.number().nullable() })) })) }),
  handler: async (a, ctx) => {
    const rows = await ctx.services.ads.query(
      new Gaql().select("campaign.id", "campaign.name", "campaign.frequency_caps").from("campaign").where("campaign.advertising_channel_type = 'DISPLAY'").where("campaign.status != 'REMOVED'").where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined),
      { maxRows: 1000 },
    );
    return { campaigns: rows.map((r) => ({ campaign_id: String(pick(r, "campaign.id") ?? ""), name: str(r, "campaign.name"), frequency_caps: mapCaps(pick(r, "campaign.frequency_caps")) })) };
  },
});

// -------------------------------------------------------------------------------- get_demandgen_channel_controls
const CHANNELS = ["youtube_in_stream", "youtube_in_feed", "youtube_shorts", "discover", "gmail", "display", "maps"] as const;
export const getDemandgenChannelControls = googleRead({
  name: "get_demandgen_channel_controls",
  title: "Demand Gen channel controls",
  description: "Shows where each Demand Gen ad group may serve. channel_config is CHANNEL_STRATEGY (then channel_strategy is ALL_CHANNELS or ALL_OWNED_AND_OPERATED_CHANNELS) or SELECTED_CHANNELS (then selected_channels lists YouTube in-stream, in-feed and Shorts, Discover, Gmail, Display, Maps). Optionally one campaign or some ad groups. Fetched live.",
  input: z.object(scopeInput),
  output: z.object({ ad_groups: z.array(z.object({ ad_group_id: z.string().min(1), campaign_id: z.string().nullable(), name: z.string().nullable(), channel_strategy: z.string().nullable(), channel_config: z.string().nullable(), selected_channels: z.record(z.string(), z.boolean().nullable()) })) }),
  handler: async (a, ctx) => {
    const p = "ad_group.demand_gen_ad_group_settings.channel_controls";
    const rows = await ctx.services.ads.query(
      new Gaql()
        .select("ad_group.id", "campaign.id", "ad_group.name", `${p}.channel_strategy`, `${p}.channel_config`, ...CHANNELS.map((c) => `${p}.selected_channels.${c}`))
        .from("ad_group")
        .where("campaign.advertising_channel_type = 'DEMAND_GEN'")
        .where("ad_group.status != 'REMOVED'")
        .where(a.campaign_id && `campaign.id = ${lit.id(a.campaign_id)}`)
        .where(a.ad_group_ids?.length ? `ad_group.id IN ${lit.list(a.ad_group_ids.map(lit.id))}` : undefined),
      { maxRows: 1000 },
    );
    return {
      ad_groups: rows.map((r) => ({
        ad_group_id: String(pick(r, "ad_group.id") ?? ""),
        campaign_id: str(r, "campaign.id"),
        name: str(r, "ad_group.name"),
        channel_strategy: str(r, `${p}.channel_strategy`),
        channel_config: str(r, `${p}.channel_config`),
        selected_channels: Object.fromEntries(CHANNELS.map((c) => [c, pick(r, `${p}.selected_channels.${c}`) === undefined ? null : pick(r, `${p}.selected_channels.${c}`) === true])),
      })),
    };
  },
});

// ----------------------------------------------------------------------------------------- list_google_languages
export const listGoogleLanguages = googleRead({
  name: "list_google_languages",
  title: "Google Ads languages",
  description: "Lists the languages Google Ads can target, with the language constant id to use in targeting, the language code and whether it is targetable. Optionally filtered by name. Fetched live.",
  input: z.object({ account_id: accountId, name_contains: z.string().regex(/^[\p{L} -]{1,50}$/u).optional() }),
  output: z.object({ languages: z.array(z.object({ language_constant_id: z.string().min(1), name: z.string().nullable(), code: z.string().nullable(), targetable: z.boolean() })) }),
  handler: async (a, ctx) => {
    const rows = await ctx.services.ads.query(new Gaql().select("language_constant.id", "language_constant.name", "language_constant.code", "language_constant.targetable").from("language_constant").where(a.name_contains && `language_constant.name LIKE ${lit.str(`%${a.name_contains}%`)}`).orderBy("language_constant.name"), { maxRows: 500 });
    return { languages: rows.map((r) => ({ language_constant_id: String(pick(r, "language_constant.id") ?? ""), name: str(r, "language_constant.name"), code: str(r, "language_constant.code"), targetable: pick(r, "language_constant.targetable") === true })) };
  },
});

// -------------------------------------------------------------------------------------- resolve_google_locations
export const resolveGoogleLocations = googleRead({
  name: "resolve_google_locations",
  title: "Find Google Ads locations",
  description: "Turns place names (cities, regions, countries, postal codes) into Google Ads location ids for targeting, with the full canonical name, type, country and estimated reach, using Google's location suggestion service. Check the canonical name: names can be ambiguous. Fetched live.",
  input: z.object({ account_id: accountId, names: z.array(z.string().trim().min(1).max(100)).min(1).max(25), country_code: z.string().regex(/^[A-Z]{2}$/).optional().describe("Two-letter country code to bias results, e.g. US."), locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("en") }),
  output: z.object({ suggestions: z.array(z.object({ search_term: z.string().nullable(), geo_target_id: z.string().nullable(), name: z.string().nullable(), canonical_name: z.string().nullable(), target_type: z.string().nullable(), country_code: z.string().nullable(), status: z.string().nullable(), reach: z.number().nullable() })) }),
  handler: async (a, ctx) => {
    const res = await ctx.services.ads.rpc<{ geoTargetConstantSuggestions?: Row[] }>("geoTargetConstants:suggest", { locale: a.locale, ...(a.country_code ? { countryCode: a.country_code } : {}), locationNames: { names: a.names } });
    return {
      suggestions: (res.geoTargetConstantSuggestions ?? []).map((s) => ({
        search_term: str(s, "searchTerm"),
        geo_target_id: str(s, "geoTargetConstant.id"),
        name: str(s, "geoTargetConstant.name"),
        canonical_name: str(s, "geoTargetConstant.canonicalName"),
        target_type: str(s, "geoTargetConstant.targetType"),
        country_code: str(s, "geoTargetConstant.countryCode"),
        status: str(s, "geoTargetConstant.status"),
        reach: pick(s, "reach") === undefined ? null : num(pick(s, "reach")),
      })),
    };
  },
});

// -------------------------------------------------------------------------------------------------- search_audiences
export const searchAudiences = googleRead({
  name: "search_audiences",
  title: "Search audiences",
  description: "Searches the audiences you can target by name: Google's affinity, in-market and life event segments (user interests), your own data segments (remarketing and customer lists, with size), and custom audiences. Returns the ids to use when adding audiences. Fetched live.",
  input: z.object({ account_id: accountId, query: z.string().trim().min(2).max(80).regex(/^[^\u0000-\u001f%_]+$/, "no control characters, % or _"), kinds: z.array(z.enum(["user_interest", "user_list", "custom_audience"])).min(1).max(3).default(["user_interest", "user_list", "custom_audience"]), limit: z.number().int().min(1).max(200).default(50) }),
  output: z.object({ audiences: z.array(z.object({ kind: z.enum(["user_interest", "user_list", "custom_audience"]), id: z.string().min(1), name: z.string().nullable(), subtype: z.string().nullable(), size_for_display: z.number().nullable(), size_for_search: z.number().nullable(), status: z.string().nullable() })), truncated: z.boolean().describe("True when some kind had more matches than limit; use a more specific query.") }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const like = lit.str(`%${a.query}%`);
    const out: { kind: "user_interest" | "user_list" | "custom_audience"; id: string; name: string | null; subtype: string | null; size_for_display: number | null; size_for_search: number | null; status: string | null }[] = [];
    const [ui, ul, ca] = await Promise.all([
      a.kinds.includes("user_interest") ? ads.query(new Gaql().select("user_interest.user_interest_id", "user_interest.name", "user_interest.taxonomy_type").from("user_interest").where(`user_interest.name LIKE ${like}`).limit(a.limit + 1), { maxRows: a.limit + 1, partial: true }) : [],
      a.kinds.includes("user_list") ? ads.query(new Gaql().select("user_list.id", "user_list.name", "user_list.type", "user_list.size_for_display", "user_list.size_for_search", "user_list.membership_status").from("user_list").where(`user_list.name LIKE ${like}`).limit(a.limit + 1), { maxRows: a.limit + 1, partial: true }) : [],
      a.kinds.includes("custom_audience") ? ads.query(new Gaql().select("custom_audience.id", "custom_audience.name", "custom_audience.type", "custom_audience.status").from("custom_audience").where(`custom_audience.name LIKE ${like}`).where("custom_audience.status = 'ENABLED'").limit(a.limit + 1), { maxRows: a.limit + 1, partial: true }) : [],
    ]);
    const truncated = [ui, ul, ca].some((rows) => rows.length > a.limit);
    for (const r of ui.slice(0, a.limit)) out.push({ kind: "user_interest", id: String(pick(r, "user_interest.user_interest_id") ?? ""), name: str(r, "user_interest.name"), subtype: str(r, "user_interest.taxonomy_type"), size_for_display: null, size_for_search: null, status: null });
    for (const r of ul.slice(0, a.limit)) out.push({ kind: "user_list", id: String(pick(r, "user_list.id") ?? ""), name: str(r, "user_list.name"), subtype: str(r, "user_list.type"), size_for_display: n(r, "user_list.size_for_display"), size_for_search: n(r, "user_list.size_for_search"), status: str(r, "user_list.membership_status") });
    for (const r of ca.slice(0, a.limit)) out.push({ kind: "custom_audience", id: String(pick(r, "custom_audience.id") ?? ""), name: str(r, "custom_audience.name"), subtype: str(r, "custom_audience.type"), size_for_display: null, size_for_search: null, status: str(r, "custom_audience.status") });
    return { audiences: out.filter((x) => x.id), truncated };
  },
});

export const targetingReadTools = [getAdGroupAudiences, getAdGroupDemographics, getAdGroupDeviceBidModifiers, getDisplayAdGroupSettings, getDisplayAudiences, getDisplayDemographics, getDisplayFrequencyCaps, getDisplayKeywords, getDisplayPlacements, getDisplayTopics, getDemandgenAudiences, getDemandgenChannelControls, listGoogleLanguages, resolveGoogleLocations, searchAudiences];
