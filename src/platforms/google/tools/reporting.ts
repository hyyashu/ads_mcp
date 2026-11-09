import { z } from "zod";
import type { InternalServices, ReadTool } from "../../../mcp/tool";
import { Gaql, fromMicros, lit, num, pick } from "../gaql";
import { ADS_SCOPE, Money, accountId, campaignIds, dateClause, dateFields, datesMsg, datesOk, googleRead, nullable, ratio, round, str } from "./common";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { connectedAccount, platformConnection, usageCounter } from "../../../db/schema";

/** Upper bound for the extra totals query (the client's hard row cap). */
const TOTALS_CAP = 10_000;

/** An id field must exist: a row without one is a malformed response and fails output validation. */
const idStr = (row: Record<string, unknown>, f: string) => String(pick(row, f) ?? "");


// ---------------------------------------------------------------------------------------------------------------
export const listCampaigns = googleRead({
  name: "list_campaigns",
  title: "List campaigns",
  description: "Lists the campaigns in a Google Ads account with their type, status, bidding strategy, daily budget and dates. Removed campaigns are excluded. Fetched live from Google Ads.",
  input: z.object({
    account_id: accountId,
    status: z.enum(["ENABLED", "PAUSED"]).optional().describe("Only campaigns with this status."),
    name_contains: z.string().regex(/^[\w .-]{1,100}$/, "letters, numbers, spaces, . _ -").optional().describe("Only campaigns whose name contains this text."),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  output: z.object({
    campaigns: z.array(z.object({ id: z.string().min(1), name: z.string().nullable(), status: z.string().nullable(), channel_type: z.string().nullable(), bidding_strategy: z.string().nullable(), serving_status: z.string().nullable(), daily_budget: Money.nullable(), start_date_time: z.string().nullable(), end_date_time: z.string().nullable() })),
    returned: z.number(),
    truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const q = new Gaql()
      .select("campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type", "campaign.bidding_strategy_type", "campaign.serving_status", "campaign.start_date_time", "campaign.end_date_time", "campaign_budget.amount_micros")
      .from("campaign")
      .where("campaign.status != 'REMOVED'")
      .where(a.status && `campaign.status = ${lit.enumLit(a.status, ["ENABLED", "PAUSED"] as const)}`)
      .where(a.name_contains && `campaign.name LIKE ${lit.str(`%${a.name_contains}%`)}`)
      .orderBy("campaign.id")
      .limit(a.limit + 1);
    const rows = await ctx.services.ads.query(q, { maxRows: a.limit + 1, partial: true });
    const shown = rows.slice(0, a.limit);
    return {
      campaigns: shown.map((r) => ({
        id: idStr(r, "campaign.id"),
        name: str(r, "campaign.name"),
        status: str(r, "campaign.status"),
        channel_type: str(r, "campaign.advertising_channel_type"),
        bidding_strategy: str(r, "campaign.bidding_strategy_type"),
        serving_status: str(r, "campaign.serving_status"),
        daily_budget: pick(r, "campaign_budget.amount_micros") === undefined ? null : fromMicros(pick(r, "campaign_budget.amount_micros")),
        start_date_time: str(r, "campaign.start_date_time"),
        end_date_time: str(r, "campaign.end_date_time"),
      })),
      returned: shown.length,
      truncated: rows.length > a.limit,
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------
const perfRow = z.object({
  campaign_id: z.string().min(1),
  name: z.string().nullable(),
  status: z.string().nullable(),
  impressions: z.number(),
  clicks: z.number(),
  cost: Money,
  conversions: z.number(),
  conversion_value: z.number(),
  ctr: z.number().nullable().describe("clicks / impressions, or null with no impressions"),
  average_cpc: Money.nullable().describe("cost / clicks, or null with no clicks"),
  cost_per_conversion: Money.nullable().describe("cost / conversions, or null with no conversions"),
  roas: z.number().nullable().describe("conversion value / cost, or null with no cost"),
});

export const getCampaignPerformance = googleRead({
  name: "get_campaign_performance",
  title: "Campaign performance",
  description: "Campaign-level performance for a period: impressions, clicks, cost, conversions, conversion value, and the ratios CTR, average CPC, cost per conversion and ROAS calculated from those figures. Fetched live from Google Ads.",
  input: z.object({ account_id: accountId, ...dateFields, campaign_ids: campaignIds.optional(), order_by: z.enum(["cost", "clicks", "conversions", "impressions"]).default("cost"), limit: z.number().int().min(1).max(200).default(50) }).refine(datesOk, datesMsg),
  output: z.object({ period: z.string(), campaigns: z.array(perfRow), totals: perfRow.omit({ campaign_id: true, name: true, status: true }).describe("Over every matching campaign, not only the returned ones (see totals_scope)."), totals_scope: z.enum(["all_matching", "first_10000_campaigns"]), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const order = { cost: "metrics.cost_micros", clicks: "metrics.clicks", conversions: "metrics.conversions", impressions: "metrics.impressions" }[a.order_by];
    const q = new Gaql()
      .select("campaign.id", "campaign.name", "campaign.status", "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value")
      .from("campaign")
      .where("campaign.status != 'REMOVED'")
      .where(dateClause(a))
      .where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined)
      .orderBy(order, "DESC")
      .limit(a.limit + 1);
    const rows = await ctx.services.ads.query(q, { maxRows: a.limit + 1, partial: true });
    const shown = rows.slice(0, a.limit);
    const calc = (impressions: number, clicks: number, cost: number, conversions: number, conversion_value: number) => ({
      impressions, clicks, cost: round(cost, 2)!, conversions, conversion_value: round(conversion_value, 2)!,
      ctr: round(ratio(clicks, impressions)), average_cpc: round(ratio(cost, clicks), 2), cost_per_conversion: round(ratio(cost, conversions), 2), roas: round(ratio(conversion_value, cost)),
    });
    const campaigns = shown.map((r) => ({
      campaign_id: idStr(r, "campaign.id"),
      name: str(r, "campaign.name"),
      status: str(r, "campaign.status"),
      ...calc(num(pick(r, "metrics.impressions")), num(pick(r, "metrics.clicks")), fromMicros(pick(r, "metrics.cost_micros")), num(pick(r, "metrics.conversions")), num(pick(r, "metrics.conversions_value"))),
    }));
    const truncated = rows.length > a.limit;
    // Totals must describe every matching campaign, not just the page shown. When the page is truncated, read the metrics of
    // all matching campaigns (up to the client's 10,000-row cap) and say which scope the totals cover.
    let all = rows;
    if (truncated) {
      const tq = new Gaql()
        .select("campaign.id", "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value")
        .from("campaign")
        .where("campaign.status != 'REMOVED'")
        .where(dateClause(a))
        .where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined)
        .limit(TOTALS_CAP);
      all = await ctx.services.ads.query(tq, { maxRows: TOTALS_CAP });
    }
    const tot = (f: string, micros = false) => all.reduce((s, r) => s + (micros ? fromMicros(pick(r, f)) : num(pick(r, f))), 0);
    return {
      period: a.start_date && a.end_date ? `${a.start_date}..${a.end_date}` : a.date_range,
      campaigns,
      totals: calc(tot("metrics.impressions"), tot("metrics.clicks"), tot("metrics.cost_micros", true), tot("metrics.conversions"), tot("metrics.conversions_value")),
      totals_scope: all.length >= TOTALS_CAP ? ("first_10000_campaigns" as const) : ("all_matching" as const),
      returned: shown.length,
      truncated,
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------
export const listConversionActions = googleRead({
  name: "list_conversion_actions",
  title: "List conversion actions",
  description: "Lists the conversion actions defined in a Google Ads account: name, type, category, status, counting type and default value. Removed actions are excluded.",
  input: z.object({ account_id: accountId, limit: z.number().int().min(1).max(500).default(200) }),
  output: z.object({ conversion_actions: z.array(z.object({ id: z.string().min(1), name: z.string().nullable(), status: z.string().nullable(), type: z.string().nullable(), category: z.string().nullable(), counting_type: z.string().nullable(), primary_for_goal: z.boolean().nullable(), default_value: z.number().nullable() })), returned: z.number(), truncated: z.boolean().describe("True when more matched than limit; raise limit to see the rest.") }),
  handler: async (a, ctx) => {
    const q = new Gaql()
      .select("conversion_action.id", "conversion_action.name", "conversion_action.status", "conversion_action.type", "conversion_action.category", "conversion_action.counting_type", "conversion_action.primary_for_goal", "conversion_action.value_settings.default_value")
      .from("conversion_action")
      .where("conversion_action.status != 'REMOVED'")
      .orderBy("conversion_action.id")
      .limit(a.limit + 1);
    const fetched = await ctx.services.ads.query(q, { maxRows: a.limit + 1, partial: true });
    const rows = fetched.slice(0, a.limit);
    return {
      conversion_actions: rows.map((r) => ({
        id: idStr(r, "conversion_action.id"), name: str(r, "conversion_action.name"), status: str(r, "conversion_action.status"), type: str(r, "conversion_action.type"), category: str(r, "conversion_action.category"), counting_type: str(r, "conversion_action.counting_type"),
        primary_for_goal: typeof pick(r, "conversion_action.primary_for_goal") === "boolean" ? (pick(r, "conversion_action.primary_for_goal") as boolean) : null,
        default_value: pick(r, "conversion_action.value_settings.default_value") === undefined ? null : num(pick(r, "conversion_action.value_settings.default_value")),
      })),
      returned: rows.length, truncated: fetched.length > a.limit,
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------
export const listLabels = googleRead({
  name: "list_labels",
  title: "List labels",
  description: "Lists the labels defined in a Google Ads account, which can be attached to campaigns, ad groups, ads and keywords.",
  input: z.object({ account_id: accountId, limit: z.number().int().min(1).max(500).default(200) }),
  output: z.object({ labels: z.array(z.object({ id: z.string().min(1), name: z.string().nullable(), status: z.string().nullable() })), returned: z.number(), truncated: z.boolean().describe("True when more matched than limit; raise limit to see the rest.") }),
  handler: async (a, ctx) => {
    const fetched = await ctx.services.ads.query(new Gaql().select("label.id", "label.name", "label.status").from("label").where("label.status != 'REMOVED'").orderBy("label.id").limit(a.limit + 1), { maxRows: a.limit + 1, partial: true });
    const rows = fetched.slice(0, a.limit);
    return { labels: rows.map((r) => ({ id: idStr(r, "label.id"), name: str(r, "label.name"), status: str(r, "label.status") })), returned: rows.length, truncated: fetched.length > a.limit };
  },
});

export const listNegativeKeywordLists = googleRead({
  name: "list_negative_keyword_lists",
  title: "List negative keyword lists",
  description: "Lists the shared negative keyword lists in a Google Ads account, with how many keywords each holds.",
  input: z.object({ account_id: accountId, limit: z.number().int().min(1).max(500).default(200) }),
  output: z.object({ lists: z.array(z.object({ id: z.string().min(1), name: z.string().nullable(), status: z.string().nullable(), member_count: z.number().nullable() })), returned: z.number(), truncated: z.boolean().describe("True when more matched than limit; raise limit to see the rest.") }),
  handler: async (a, ctx) => {
    const q = new Gaql().select("shared_set.id", "shared_set.name", "shared_set.status", "shared_set.member_count").from("shared_set").where("shared_set.type = 'NEGATIVE_KEYWORDS'").where("shared_set.status = 'ENABLED'").orderBy("shared_set.id").limit(a.limit + 1);
    const fetched = await ctx.services.ads.query(q, { maxRows: a.limit + 1, partial: true });
    const rows = fetched.slice(0, a.limit);
    return { lists: rows.map((r) => ({ id: idStr(r, "shared_set.id"), name: str(r, "shared_set.name"), status: str(r, "shared_set.status"), member_count: pick(r, "shared_set.member_count") === undefined ? null : num(pick(r, "shared_set.member_count")) })), returned: rows.length, truncated: fetched.length > a.limit };
  },
});

// ---------------------------------------------------------------------------------------------------------------
export const getCampaignTracking = googleRead({
  name: "get_campaign_tracking",
  title: "Campaign tracking settings",
  description: "Shows the tracking URL template, final URL suffix and custom parameters set on campaigns, for auditing click tracking.",
  input: z.object({ account_id: accountId, campaign_ids: campaignIds.optional(), limit: z.number().int().min(1).max(500).default(200) }),
  output: z.object({ campaigns: z.array(z.object({ campaign_id: z.string().min(1), name: z.string().nullable(), tracking_url_template: z.string().nullable(), final_url_suffix: z.string().nullable(), custom_parameters: z.array(z.object({ key: z.string(), value: z.string() })) })), returned: z.number(), truncated: z.boolean().describe("True when more matched than limit; raise limit to see the rest.") }),
  handler: async (a, ctx) => {
    const q = new Gaql()
      .select("campaign.id", "campaign.name", "campaign.tracking_url_template", "campaign.final_url_suffix", "campaign.url_custom_parameters")
      .from("campaign")
      .where("campaign.status != 'REMOVED'")
      .where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined)
      .orderBy("campaign.id")
      .limit(a.limit + 1);
    const fetched = await ctx.services.ads.query(q, { maxRows: a.limit + 1, partial: true });
    const rows = fetched.slice(0, a.limit);
    return {
      campaigns: rows.map((r) => ({
        campaign_id: idStr(r, "campaign.id"), name: str(r, "campaign.name"), tracking_url_template: str(r, "campaign.tracking_url_template"), final_url_suffix: str(r, "campaign.final_url_suffix"),
        custom_parameters: ((pick(r, "campaign.url_custom_parameters") as { key?: string; value?: string }[] | undefined) ?? []).filter((p) => p.key).map((p) => ({ key: String(p.key), value: String(p.value ?? "") })),
      })),
      returned: rows.length, truncated: fetched.length > a.limit,
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------
export const getAdPolicyViolations = googleRead({
  name: "get_ad_policy_violations",
  title: "Ad policy violations",
  description: "Lists ads that are not fully approved (disapproved, approved with limits, or limited by audience) with Google's policy topics and review status. Policy text comes from Google.",
  input: z.object({ account_id: accountId, campaign_id: z.string().regex(/^\d{1,20}$/).optional(), limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({ ads: z.array(z.object({ ad_id: z.string().nullable(), ad_group_id: z.string().nullable(), campaign_id: z.string().nullable(), ad_status: z.string().nullable(), approval_status: z.string().nullable(), review_status: z.string().nullable(), policy_topics: z.array(z.object({ topic: z.string().nullable(), type: z.string().nullable() })) })), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const q = new Gaql()
      .select("ad_group_ad.ad.id", "ad_group_ad.status", "ad_group.id", "campaign.id", "ad_group_ad.policy_summary.approval_status", "ad_group_ad.policy_summary.review_status", "ad_group_ad.policy_summary.policy_topic_entries")
      .from("ad_group_ad")
      .where("ad_group_ad.status != 'REMOVED'")
      .where("ad_group_ad.policy_summary.approval_status IN ('DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY')")
      .where(a.campaign_id && `campaign.id = ${lit.id(a.campaign_id)}`)
      .limit(a.limit + 1);
    const rows = await ctx.services.ads.query(q, { maxRows: a.limit + 1, partial: true });
    const shown = rows.slice(0, a.limit);
    return {
      ads: shown.map((r) => ({
        ad_id: str(r, "ad_group_ad.ad.id"), ad_group_id: str(r, "ad_group.id"), campaign_id: str(r, "campaign.id"), ad_status: str(r, "ad_group_ad.status"),
        approval_status: str(r, "ad_group_ad.policy_summary.approval_status"), review_status: str(r, "ad_group_ad.policy_summary.review_status"),
        policy_topics: ((pick(r, "ad_group_ad.policy_summary.policy_topic_entries") as { topic?: string; type?: string }[] | undefined) ?? []).map((t) => ({ topic: nullable(t.topic) ?? null, type: nullable(t.type) ?? null })),
      })),
      returned: shown.length,
      truncated: rows.length > a.limit,
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------
export const analyzeWastedSpend = googleRead({
  name: "analyze_wasted_spend",
  title: "Analyze wasted spend",
  description:
    "Finds search terms that spent at least a minimum amount with zero conversions in the period. This is a fixed rule over real metrics (cost >= min_cost and conversions = 0), not a prediction: review each term before excluding it. Covers up to the top 1,000 search terms by cost.",
  input: z.object({ account_id: accountId, ...dateFields, min_cost: z.number().min(0).max(1_000_000).default(10).describe("Minimum cost, in the account's currency, for a term to be flagged."), limit: z.number().int().min(1).max(200).default(50) }).refine(datesOk, datesMsg),
  output: z.object({
    period: z.string(),
    rule: z.string(),
    terms_analyzed: z.number(),
    covers_all_spend: z.boolean().describe("False when the account has more search terms than the 1,000 analyzed."),
    flagged: z.array(z.object({ search_term: z.string().nullable(), campaign_id: z.string().nullable(), ad_group_id: z.string().nullable(), cost: Money, clicks: z.number(), impressions: z.number() })),
    flagged_cost: Money,
    analyzed_cost: Money,
    flagged_share_of_analyzed_cost: z.number().nullable(),
  }),
  handler: async (a, ctx) => {
    const MAX = 1000;
    const q = new Gaql()
      .select("search_term_view.search_term", "campaign.id", "ad_group.id", "metrics.cost_micros", "metrics.clicks", "metrics.impressions", "metrics.conversions")
      .from("search_term_view")
      .where(dateClause(a))
      .orderBy("metrics.cost_micros", "DESC")
      .limit(MAX);
    const rows = await ctx.services.ads.query(q, { maxRows: MAX });
    const parsed = rows.map((r) => ({ term: str(r, "search_term_view.search_term"), campaign: str(r, "campaign.id"), adGroup: str(r, "ad_group.id"), cost: fromMicros(pick(r, "metrics.cost_micros")), clicks: num(pick(r, "metrics.clicks")), impressions: num(pick(r, "metrics.impressions")), conversions: num(pick(r, "metrics.conversions")) }));
    const flaggedAll = parsed.filter((t) => t.cost >= a.min_cost && t.conversions === 0).sort((x, y) => y.cost - x.cost);
    const analyzed = parsed.reduce((s, t) => s + t.cost, 0);
    const flaggedCost = flaggedAll.reduce((s, t) => s + t.cost, 0);
    return {
      period: a.start_date && a.end_date ? `${a.start_date}..${a.end_date}` : a.date_range,
      rule: `cost >= ${a.min_cost} and conversions = 0`,
      terms_analyzed: parsed.length,
      covers_all_spend: rows.length < MAX,
      flagged: flaggedAll.slice(0, a.limit).map((t) => ({ search_term: t.term, campaign_id: t.campaign, ad_group_id: t.adGroup, cost: round(t.cost, 2)!, clicks: t.clicks, impressions: t.impressions })),
      flagged_cost: round(flaggedCost, 2)!,
      analyzed_cost: round(analyzed, 2)!,
      flagged_share_of_analyzed_cost: round(ratio(flaggedCost, analyzed)),
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------
const usageInput = z.object({ days: z.number().int().min(1).max(90).default(7) });
const usageOutput = z.object({
  period_days: z.number(),
  total_calls: z.number(),
  total_errors: z.number(),
  by_day: z.array(z.object({ day: z.string(), calls: z.number(), errors: z.number() })),
  top_tools: z.array(z.object({ tool: z.string(), calls: z.number(), errors: z.number() })),
  connections: z.record(z.string(), z.number()).describe("Connection counts by status (active, needs_reauth)."),
});

export const getUsageStatus: ReadTool<typeof usageInput, typeof usageOutput, InternalServices> = {
  kind: "read",
  name: "get_usage_status",
  platform: "google_ads",
  title: "Usage status",
  description: "Shows this workspace's tool usage (calls and errors per day and per tool) and the health of its connected ad accounts. Counts only: no request or result content is stored.",
  accountScope: "none",
  input: usageInput,
  output: usageOutput,
  permissions: { scope: "ads:read", platformPermissions: [], notes: "Internal: reads this server's own counters. Calls no ad platform." },
  handler: async (a, ctx) => {
    const { db } = ctx.services;
    const since = new Date(Date.now() - a.days * 86_400_000).toISOString().slice(0, 10);
    const rows = await db.select().from(usageCounter).where(and(eq(usageCounter.tenantId, ctx.tenantId), gte(usageCounter.day, since)));
    const byDay = new Map<string, { calls: number; errors: number }>();
    const byTool = new Map<string, { calls: number; errors: number }>();
    for (const r of rows) {
      for (const [m, k] of [[byDay, r.day], [byTool, r.tool]] as const) {
        const cur = m.get(k) ?? { calls: 0, errors: 0 };
        cur.calls += r.calls;
        cur.errors += r.errors;
        m.set(k, cur);
      }
    }
    const conns = await db.select({ status: platformConnection.status, n: sql<number>`count(*)::int` }).from(platformConnection).where(and(eq(platformConnection.tenantId, ctx.tenantId))).groupBy(platformConnection.status);
    return {
      period_days: a.days,
      total_calls: rows.reduce((s, r) => s + r.calls, 0),
      total_errors: rows.reduce((s, r) => s + r.errors, 0),
      by_day: [...byDay].map(([day, v]) => ({ day, ...v })).sort((x, y) => x.day.localeCompare(y.day)),
      top_tools: [...byTool].map(([tool, v]) => ({ tool, ...v })).sort((x, y) => y.calls - x.calls).slice(0, 20),
      connections: Object.fromEntries(conns.filter((c) => c.status !== "revoked").map((c) => [c.status, Number(c.n)])),
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------
const listAccountsInput = z.object({});
const listAccountsOutput = z.object({
  accounts: z.array(
    z.object({
      account_id: z.string().describe("This server's id for the account. Tools accept it or external_id."),
      platform: z.string(),
      name: z.string().describe("Account name as the ad platform reports it (untrusted text)."),
      external_id: z.string().describe("The platform's own id: Google Ads customer id (digits) or Meta act_ id. Tools accept it as account_id."),
      access: z.enum(["read", "write"]),
      status: z.string().describe("Connection status: active, or needs_reauth (reconnect on the Connections page)."),
      currency_code: z.string().nullable(),
      time_zone: z.string().nullable(),
    }),
  ),
});

export const listAccounts: ReadTool<typeof listAccountsInput, typeof listAccountsOutput, InternalServices> = {
  kind: "read",
  name: "list_accounts",
  platform: "google_ads",
  title: "List connected accounts",
  description:
    "Lists the ad accounts connected to this workspace (Google Ads and Meta Ads): name, account_id, platform id, access (read or write) and connection status. Other tools accept either the account_id or the platform id.",
  accountScope: "none",
  input: listAccountsInput,
  output: listAccountsOutput,
  permissions: { scope: "ads:read", platformPermissions: [], notes: "Internal: reads this workspace's connected accounts. Calls no ad platform." },
  handler: async (_a, ctx) => {
    const { db } = ctx.services;
    const rows = await db
      .select({
        id: connectedAccount.id,
        platform: connectedAccount.platform,
        name: connectedAccount.displayName,
        externalId: connectedAccount.externalId,
        access: connectedAccount.access,
        status: platformConnection.status,
        currencyCode: connectedAccount.currencyCode,
        timeZone: connectedAccount.timeZone,
      })
      .from(connectedAccount)
      .innerJoin(platformConnection, eq(platformConnection.id, connectedAccount.connectionId))
      .where(and(eq(connectedAccount.tenantId, ctx.tenantId), ne(platformConnection.status, "revoked")));
    rows.sort((x, y) => x.platform.localeCompare(y.platform) || x.name.localeCompare(y.name) || x.externalId.localeCompare(y.externalId));
    return {
      accounts: rows.map((r) => ({
        account_id: r.id,
        platform: r.platform,
        name: r.name,
        external_id: r.externalId,
        access: r.access === "write" ? ("write" as const) : ("read" as const),
        status: r.status,
        currency_code: r.currencyCode,
        time_zone: r.timeZone,
      })),
    };
  },
};

export const reportingTools = [listCampaigns, getCampaignPerformance, listConversionActions, listLabels, listNegativeKeywordLists, getCampaignTracking, getAdPolicyViolations, analyzeWastedSpend, getUsageStatus, listAccounts];
void ADS_SCOPE;
