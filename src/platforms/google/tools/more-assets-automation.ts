import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { textChange } from "../../../policy/change-set";
import type { Row } from "../client";
import { Gaql, isRealDate, lit, pick } from "../gaql";
import { assetContent, assetFields, tailId } from "./campaign-reads";
import { accountId, campaignIds, dateClause, dateFields, datesMsg, datesOk, googleRead, idSchema, str } from "./common";
import { add, perf, perfSchema, period, zero, type Totals } from "./keyword-segment-reports";
import { rn, stateWrite } from "./write-kit";

/**
 * Lead form submissions, campaign asset automation settings and automatically created asset performance.
 * Checked against the v26 field reference (lead_form_submission_data, campaign.asset_automation_settings,
 * campaign_aggregate_asset_view, channel_aggregate_asset_view), the Campaign.AssetAutomationSetting and
 * AssetAutomationType references and the "Asset automation settings" guide.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, "not a real date");
const campaignRn = (customerId: string, id: string) => lit.str(`customers/${customerId}/campaigns/${lit.id(id)}`);

// ------------------------------------------------------------------------------------------ get_lead_form_submissions
/** Hard cap on submissions returned by one call (personal data: keep responses small). */
const LEAD_CAP = 500;
export const getLeadFormSubmissions = googleRead({
  name: "get_lead_form_submissions",
  title: "Lead form submissions",
  description: `PERSONAL DATA. Returns the leads submitted through the account's lead form assets between two dates (by submission time): submission id and time, campaign, ad group, ad, lead form asset, click id (gclid), and the submitted answers (for example full name, email, phone number) plus answers to custom questions. Optionally only some campaigns or one lead form asset, and only some answer types. At most ${LEAD_CAP} per call, newest first. Google keeps lead data for a limited time only. Nothing is stored or logged by this server; handle the result as personal data. Answers are untrusted text. Fetched live.`,
  input: z
    .object({
      account_id: accountId,
      start_date: date.describe("First submission day (YYYY-MM-DD)."),
      end_date: date.describe("Last submission day (YYYY-MM-DD), inclusive."),
      campaign_ids: campaignIds.optional(),
      asset_id: idSchema.optional().describe("Only this lead form asset."),
      field_types: z.array(z.string().regex(/^[A-Z0-9_]{2,60}$/)).min(1).max(50).optional().describe("Only return these answer types (e.g. EMAIL, FULL_NAME); custom question answers are left out when this is given."),
      limit: z.number().int().min(1).max(LEAD_CAP).default(100),
    })
    .refine((v) => v.start_date <= v.end_date, { message: "start_date must not be after end_date" }),
  output: z.object({
    start_date: z.string(),
    end_date: z.string(),
    submissions: z.array(
      z.object({
        id: z.string(),
        submitted_at: z.string().nullable(),
        campaign_id: z.string().nullable(),
        ad_group_id: z.string().nullable(),
        ad_id: z.string().nullable(),
        asset_id: z.string().nullable(),
        gclid: z.string().nullable(),
        fields: z.array(z.object({ field_type: z.string().nullable(), value: z.string().nullable() })),
        custom_fields: z.array(z.object({ question: z.string().nullable(), value: z.string().nullable() })),
      }),
    ),
    returned: z.number(),
    truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const rows = await ads.query(
      new Gaql()
        .select("lead_form_submission_data.id", "lead_form_submission_data.submission_date_time", "lead_form_submission_data.campaign", "lead_form_submission_data.ad_group", "lead_form_submission_data.ad_group_ad", "lead_form_submission_data.asset", "lead_form_submission_data.gclid", "lead_form_submission_data.lead_form_submission_fields", "lead_form_submission_data.custom_lead_form_submission_fields")
        .from("lead_form_submission_data")
        .where(`lead_form_submission_data.submission_date_time >= ${lit.str(`${a.start_date} 00:00:00`)}`)
        .where(`lead_form_submission_data.submission_date_time <= ${lit.str(`${a.end_date} 23:59:59`)}`)
        .where(a.campaign_ids?.length ? `lead_form_submission_data.campaign IN ${lit.list(a.campaign_ids.map((c) => campaignRn(ads.customerId, c)))}` : undefined)
        .where(a.asset_id ? `lead_form_submission_data.asset = ${lit.str(rn(ads, "assets", a.asset_id))}` : undefined),
      { maxRows: 10_000 },
    );
    const want = a.field_types ? new Set(a.field_types) : null;
    const all = rows
      .map((r) => {
        const fields = ((pick(r, "lead_form_submission_data.lead_form_submission_fields") as Row[] | undefined) ?? []).map((f) => ({ field_type: str(f, "field_type"), value: str(f, "field_value") })).filter((f) => !want || (f.field_type !== null && want.has(f.field_type)));
        const custom = want ? [] : ((pick(r, "lead_form_submission_data.custom_lead_form_submission_fields") as Row[] | undefined) ?? []).map((f) => ({ question: str(f, "question_text"), value: str(f, "field_value") }));
        const adGroupAd = tailId(pick(r, "lead_form_submission_data.ad_group_ad"));
        return {
          id: str(r, "lead_form_submission_data.id") ?? "",
          submitted_at: str(r, "lead_form_submission_data.submission_date_time"),
          campaign_id: tailId(pick(r, "lead_form_submission_data.campaign")),
          ad_group_id: tailId(pick(r, "lead_form_submission_data.ad_group")),
          ad_id: adGroupAd ? (adGroupAd.split("~")[1] ?? null) : null,
          asset_id: tailId(pick(r, "lead_form_submission_data.asset")),
          gclid: str(r, "lead_form_submission_data.gclid"),
          fields,
          custom_fields: custom,
        };
      })
      .sort((x, y) => (y.submitted_at ?? "").localeCompare(x.submitted_at ?? "") || x.id.localeCompare(y.id));
    const submissions = all.slice(0, a.limit);
    return { start_date: a.start_date, end_date: a.end_date, submissions, returned: submissions.length, truncated: all.length > a.limit };
  },
});

// ------------------------------------------------------------------------------------- campaign asset automation
/**
 * Campaign-level automation types and the campaign types that support them, from the "Asset automation settings" guide
 * (v26). The other AssetAutomationType values are ad-level settings (Demand Gen ads) and are not set on campaigns.
 */
const SUPPORT = {
  TEXT_ASSET_AUTOMATION: ["PERFORMANCE_MAX", "SEARCH"],
  FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION: ["PERFORMANCE_MAX", "SEARCH"],
  GENERATE_ENHANCED_YOUTUBE_VIDEOS: ["PERFORMANCE_MAX"],
  GENERATE_IMAGE_ENHANCEMENT: ["PERFORMANCE_MAX"],
  GENERATE_IMAGE_EXTRACTION: ["PERFORMANCE_MAX"],
  AUTOMATED_VIDEO_CRAWL: ["PERFORMANCE_MAX"],
} as const;
type AutomationType = keyof typeof SUPPORT;
const AUTOMATION_TYPES = Object.keys(SUPPORT) as AutomationType[];
/** Google's defaults when a campaign has no explicit setting (same guide). */
const DEFAULTS: Record<AutomationType, string> = {
  TEXT_ASSET_AUTOMATION: "opted in for Performance Max, opted out for Search",
  FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION: "opted in for Performance Max, opted out for Search",
  GENERATE_ENHANCED_YOUTUBE_VIDEOS: "opted in",
  GENERATE_IMAGE_ENHANCEMENT: "opted in",
  GENERATE_IMAGE_EXTRACTION: "follows the account-level Dynamic Image Extension control (set in the Google Ads web interface)",
  AUTOMATED_VIDEO_CRAWL: "opted out",
};
const supported = (channel: string | null): AutomationType[] => AUTOMATION_TYPES.filter((t) => (SUPPORT[t] as readonly string[]).includes(channel ?? ""));

interface CampaignAutomation {
  id: string;
  name: string | null;
  status: string | null;
  channel: string | null;
  /** The settings exactly as Google returned them (sorted by type): updates send them back unchanged except the ones requested. */
  raw: Row[];
}
const toCampaign = (r: Row): CampaignAutomation => ({
  id: str(r, "campaign.id") ?? "",
  name: str(r, "campaign.name"),
  status: str(r, "campaign.status"),
  channel: str(r, "campaign.advertising_channel_type"),
  raw: [...((pick(r, "campaign.asset_automation_settings") as Row[] | undefined) ?? [])].sort((x, y) => String(x.assetAutomationType ?? "").localeCompare(String(y.assetAutomationType ?? ""))),
});
const AUTOMATION_SELECT = ["campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type", "campaign.asset_automation_settings"];
const settingView = (s: Row) => {
  const crawl = (pick(s, "automated_video_crawl_setting.automated_video_crawl_infos") as Row[] | undefined) ?? [];
  return { type: String(s.assetAutomationType ?? ""), status: (s.assetAutomationStatus as string | undefined) ?? null, ...(crawl.length ? { video_crawl_sources: crawl.map((c) => ({ url: str(c, "url"), source_platform: str(c, "source_platform"), enabled: pick(c, "enabled") === true })) } : {}) };
};
const settingSchema = z.object({ type: z.string(), status: z.string().nullable(), video_crawl_sources: z.array(z.object({ url: z.string().nullable(), source_platform: z.string().nullable(), enabled: z.boolean() })).optional() });

export const getAssetAutomationSettings = googleRead({
  name: "get_asset_automation_settings",
  title: "Asset automation settings",
  description: `Lists each campaign's asset automation settings (whether Google may generate or enhance assets automatically): for each automation type the campaign has set, OPTED_IN or OPTED_OUT, plus the campaign-level types its campaign type supports but has not set, which follow Google's defaults: ${AUTOMATION_TYPES.map((t) => `${t} (${DEFAULTS[t]})`).join("; ")}. For the given campaigns or all campaigns that are not removed. Fetched live.`,
  input: z.object({ account_id: accountId, campaign_ids: campaignIds.optional() }),
  output: z.object({
    campaigns: z.array(z.object({ campaign_id: z.string(), name: z.string().nullable(), status: z.string().nullable(), channel_type: z.string().nullable(), settings: z.array(settingSchema), unset_supported_types: z.array(z.object({ type: z.string(), default: z.string() })) })),
    returned: z.number(),
    not_found: z.array(z.string()).describe("Requested campaign ids that do not exist or are removed."),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const rows = await ads.query(new Gaql().select(...AUTOMATION_SELECT).from("campaign").where("campaign.status != 'REMOVED'").where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined), { maxRows: 5000 });
    const missing = [...new Set(a.campaign_ids ?? [])].filter((id) => !rows.some((r) => str(r, "campaign.id") === id)).sort();
    if (a.campaign_ids?.length && missing.length === new Set(a.campaign_ids).size) throw new ToolError("not_found", `No campaign ${missing.join(", ")} in this account (or it is removed).`);
    const campaigns = rows
      .map(toCampaign)
      .sort((x, y) => x.id.localeCompare(y.id))
      .map((c) => {
        const set = new Set(c.raw.map((s) => String(s.assetAutomationType ?? "")));
        return { campaign_id: c.id, name: c.name, status: c.status, channel_type: c.channel, settings: c.raw.map(settingView), unset_supported_types: supported(c.channel).filter((t) => !set.has(t)).map((t) => ({ type: t, default: DEFAULTS[t] })) };
      });
    return { campaigns, returned: campaigns.length, not_found: missing };
  },
});

export const updateAssetAutomationSettings = stateWrite({
  name: "update_asset_automation_settings",
  title: "Update asset automation settings",
  // Declared write (inventory/mapping.ts); the change set raises opt-ins to high impact (effect "enable").
  risk: "write",
  description: `Opts one campaign in or out of asset automation types after approval, for example letting Google write extra headlines and descriptions (TEXT_ASSET_AUTOMATION) or send traffic to other pages of the site with matching text (FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION). Campaign-level types and the campaign types that support them: ${AUTOMATION_TYPES.map((t) => `${t} (${SUPPORT[t].join(", ")})`).join("; ")}. The campaign's other automation settings are sent back unchanged. Final URL expansion cannot be opted in while text asset automation is opted out. Opting in to AUTOMATED_VIDEO_CRAWL needs confirm_video_rights (you own the rights to the videos found). Opting in is high impact (Google then changes what the whole campaign shows); opting out only is a normal write. Confirmed by re-reading.`,
  input: z
    .object({
      account_id: accountId,
      campaign_id: idSchema,
      settings: z
        .array(z.object({ type: z.enum(AUTOMATION_TYPES as [AutomationType, ...AutomationType[]]), status: z.enum(["OPTED_IN", "OPTED_OUT"]) }))
        .min(1)
        .max(AUTOMATION_TYPES.length),
      confirm_video_rights: z.boolean().default(false).describe("Required (true) to opt in to AUTOMATED_VIDEO_CRAWL: confirms you own all legal rights to the videos from the sources Google crawls and may share them with Google for advertising."),
    })
    .refine((v) => new Set(v.settings.map((s) => s.type)).size === v.settings.length, { message: "each type at most once" })
    .refine((v) => v.confirm_video_rights || !v.settings.some((s) => s.type === "AUTOMATED_VIDEO_CRAWL" && s.status === "OPTED_IN"), { message: "opting in to AUTOMATED_VIDEO_CRAWL needs confirm_video_rights: true" }),
  output: z.object({ campaign_id: z.string(), settings: z.array(settingSchema) }),
  read: async (a, ads) => {
    const [r] = await ads.query(new Gaql().select(...AUTOMATION_SELECT).from("campaign").where(`campaign.id = ${lit.id(a.campaign_id)}`).limit(1), { maxRows: 1 });
    if (!r) throw new ToolError("not_found", `No campaign ${a.campaign_id} in this account.`);
    const c = toCampaign(r);
    if (c.status === "REMOVED") throw new ToolError("invalid_argument", "The campaign is removed and cannot be changed.");
    return c;
  },
  build: (a, s, ads) => {
    const unsupported = a.settings.filter((x) => !supported(s.channel).includes(x.type));
    if (unsupported.length) throw new ToolError("invalid_argument", `Campaign "${s.name ?? a.campaign_id}" is a ${s.channel ?? "unknown"} campaign; ${unsupported.map((x) => `${x.type} is only for ${SUPPORT[x.type].join(" and ")} campaigns`).join("; ")}.`);
    const current = (t: string) => (s.raw.find((x) => x.assetAutomationType === t)?.assetAutomationStatus as string | undefined) ?? null;
    const changing = a.settings.filter((x) => current(x.type) !== x.status);
    if (!changing.length) throw new ToolError("invalid_argument", `Nothing would change: ${a.settings.map((x) => `${x.type} is already ${x.status}`).join(", ")}.`);
    // Repeated field: the update mask replaces the whole list, so every setting not asked about is sent back as read.
    const next: Row[] = s.raw.map((x) => {
      const c = changing.find((y) => y.type === x.assetAutomationType);
      return c ? { ...x, assetAutomationStatus: c.status } : x;
    });
    for (const c of changing) if (!s.raw.some((x) => x.assetAutomationType === c.type)) next.push({ assetAutomationType: c.type, assetAutomationStatus: c.status });
    const after = (t: string) => (next.find((x) => x.assetAutomationType === t)?.assetAutomationStatus as string | undefined) ?? null;
    if (changing.some((c) => c.type === "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION" || c.type === "TEXT_ASSET_AUTOMATION") && after("FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION") === "OPTED_IN" && after("TEXT_ASSET_AUTOMATION") === "OPTED_OUT")
      throw new ToolError("invalid_argument", "Final URL expansion also enables text asset automation: it cannot be OPTED_IN while TEXT_ASSET_AUTOMATION is OPTED_OUT. Change both together.");
    const ref = { resource: "campaign", id: a.campaign_id, name: s.name };
    return {
      summary: `Campaign "${s.name ?? a.campaign_id}" (${s.channel ?? "unknown type"}): ${changing.map((c) => `${c.type} ${current(c.type) ?? "default"} -> ${c.status}`).join("; ")}`,
      // Opting in lets Google generate or change what the campaign shows (enable: high impact); opting out only stops that (pause).
      changes: changing.map((c) => ({ ...textChange(ref, `asset_automation.${c.type.toLowerCase()}`, current(c.type), c.status), effect: c.status === "OPTED_IN" ? ("enable" as const) : ("pause" as const) })),
      ops: [{ campaignOperation: { update: { resourceName: rn(ads, "campaigns", a.campaign_id), assetAutomationSettings: next }, updateMask: "asset_automation_settings" } }],
    };
  },
  landed: (a, _b, after) => a.settings.every((x) => after.raw.some((y) => y.assetAutomationType === x.type && y.assetAutomationStatus === x.status)),
  result: (a, after) => ({ campaign_id: a.campaign_id, settings: after.raw.map(settingView) }),
});

// --------------------------------------------------------------------------------- get_automated_asset_performance
const FIELD_TYPES = ["HEADLINE", "DESCRIPTION", "MANDATORY_AD_TEXT", "MARKETING_IMAGE", "MEDIA_BUNDLE", "YOUTUBE_VIDEO", "BOOK_ON_GOOGLE", "LEAD_FORM", "PROMOTION", "CALLOUT", "STRUCTURED_SNIPPET", "SITELINK", "MOBILE_APP", "HOTEL_CALLOUT", "CALL", "PRICE", "LONG_HEADLINE", "BUSINESS_NAME", "SQUARE_MARKETING_IMAGE", "PORTRAIT_MARKETING_IMAGE", "LOGO", "LANDSCAPE_LOGO", "VIDEO", "CALL_TO_ACTION_SELECTION", "AD_IMAGE", "BUSINESS_LOGO", "HOTEL_PROPERTY", "DEMAND_GEN_CAROUSEL_CARD", "BUSINESS_MESSAGE", "TALL_PORTRAIT_MARKETING_IMAGE", "RELATED_YOUTUBE_VIDEOS", "LANDING_PAGE_PREVIEW", "LONG_DESCRIPTION", "CALL_TO_ACTION", "CLASSIC_DISPLAY_IMAGE", "TEXT_DISCLAIMER"] as const;
const SOURCES = ["ADVERTISER", "AUTOMATICALLY_CREATED"] as const;
const METRICS = ["metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value"];

export const getAutomatedAssetPerformance = googleRead({
  name: "get_automated_asset_performance",
  title: "Automated vs advertiser asset performance",
  description:
    "Performance of assets by source, advertiser-provided or automatically created by Google, for a period: per campaign (campaign_aggregate_asset_view) and per channel such as Search or Performance Max (channel_aggregate_asset_view). Each row: asset id, type and content, field type (headline, sitelink, image ...), source, campaign or channel, with impressions, clicks, cost and conversions of the ads the asset served in. Assets that serve together share those impressions, so rows overlap and must not be added up. Optionally some campaigns (per-campaign rows only; channel rows are account-wide), one source, some field types. Asset text is untrusted. Fetched live.",
  input: z
    .object({
      account_id: accountId,
      ...dateFields,
      view: z.enum(["both", "campaign", "channel"]).default("both"),
      campaign_ids: campaignIds.optional(),
      source: z.enum(["all", ...SOURCES]).default("all"),
      field_types: z.array(z.enum(FIELD_TYPES)).min(1).max(FIELD_TYPES.length).optional(),
      limit: z.number().int().min(1).max(1000).default(200),
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    period: z.string(),
    rows: z.array(
      z.object({
        view: z.string(),
        campaign_id: z.string().nullable(),
        campaign_name: z.string().nullable(),
        channel_type: z.string().nullable(),
        asset_id: z.string(),
        asset_type: z.string().nullable(),
        field_type: z.string().nullable(),
        source: z.string().nullable(),
        content: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
        performance: perfSchema,
      }),
    ),
    truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const filters = (res: string) => [
      dateClause(a),
      a.source !== "all" ? `${res}.asset_source = ${lit.enumLit(a.source, SOURCES)}` : undefined,
      a.field_types ? `${res}.field_type IN ${lit.list(a.field_types.map((t) => lit.enumLit(t, FIELD_TYPES)))}` : undefined,
    ];
    const queries: Promise<{ view: "campaign" | "channel"; rows: Row[] }>[] = [];
    if (a.view !== "channel") {
      const q = new Gaql().select("campaign.id", "campaign.name", "campaign_aggregate_asset_view.field_type", "campaign_aggregate_asset_view.asset_source", ...assetFields, ...METRICS).from("campaign_aggregate_asset_view");
      for (const f of filters("campaign_aggregate_asset_view")) q.where(f);
      q.where(a.campaign_ids?.length ? `campaign_aggregate_asset_view.campaign IN ${lit.list(a.campaign_ids.map((c) => campaignRn(ads.customerId, c)))}` : undefined);
      queries.push(ads.query(q, { maxRows: 10_000 }).then((rows) => ({ view: "campaign", rows })));
    }
    if (a.view !== "campaign") {
      const q = new Gaql().select("channel_aggregate_asset_view.advertising_channel_type", "channel_aggregate_asset_view.field_type", "channel_aggregate_asset_view.asset_source", ...assetFields, ...METRICS).from("channel_aggregate_asset_view");
      for (const f of filters("channel_aggregate_asset_view")) q.where(f);
      queries.push(ads.query(q, { maxRows: 10_000 }).then((rows) => ({ view: "channel", rows })));
    }
    type Acc = { view: string; campaign_id: string | null; campaign_name: string | null; channel_type: string | null; asset_id: string; asset_type: string | null; field_type: string | null; source: string | null; content: ReturnType<typeof assetContent>; t: Totals };
    const acc = new Map<string, Acc>();
    for (const { view, rows } of await Promise.all(queries)) {
      const res = `${view}_aggregate_asset_view`;
      for (const r of rows) {
        const g: Omit<Acc, "t" | "content"> = {
          view,
          campaign_id: view === "campaign" ? str(r, "campaign.id") : null,
          campaign_name: view === "campaign" ? str(r, "campaign.name") : null,
          channel_type: view === "channel" ? str(r, `${res}.advertising_channel_type`) : null,
          asset_id: String(pick(r, "asset.id") ?? ""),
          asset_type: str(r, "asset.type"),
          field_type: str(r, `${res}.field_type`),
          source: str(r, `${res}.asset_source`),
        };
        const key = [g.view, g.campaign_id, g.channel_type, g.asset_id, g.field_type, g.source].join("|");
        const cur = acc.get(key) ?? { ...g, content: assetContent(r), t: zero() };
        add(cur.t, r);
        acc.set(key, cur);
      }
    }
    const all = [...acc.values()]
      .map(({ t, ...g }) => ({ ...g, performance: perf(t) }))
      .sort((x, y) => y.performance.impressions - x.performance.impressions || y.performance.cost - x.performance.cost || x.asset_id.localeCompare(y.asset_id) || x.view.localeCompare(y.view));
    return { period: period(a), rows: all.slice(0, a.limit), truncated: all.length > a.limit };
  },
});

