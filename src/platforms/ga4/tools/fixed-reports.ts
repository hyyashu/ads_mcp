import { z } from "zod";
import { fetchCampaignTraffic, fetchChannelTraffic, fetchGoogleAdsTraffic, fetchKeyEventCounts, fetchLandingPages } from "../queries";
import { datesMsg, datesOk, eventName, pageShape, periodFields, reportHeaderShape, totalsOut } from "../report";
import { accountId, ga4Read } from "./common";
import { UNTRUSTED } from "./properties";

const nn = z.number().nullable();
const limit = (d: number) => z.number().int().min(1).max(1000).default(d);
const LIVE = "Fetched live from Google Analytics (Data API v1beta runReport).";
const PERIOD_NOTE = "Dates are resolved in the property's time zone and returned exactly. Rates are GA4's own; totals are GA4's totals over all rows.";

// ------------------------------------------------------------------------------------------------ get_traffic_by_channel
export const getTrafficByChannel = ga4Read({
  name: "get_traffic_by_channel",
  title: "GA4 traffic by channel",
  description: `${LIVE} Sessions, engaged sessions, engagement rate, users, key events, key event rate and revenue per default (or primary) channel group (Organic Search, Paid Search, Direct, ...), with each channel's share of sessions. Optionally the key event rate for one key event. ${PERIOD_NOTE} ${UNTRUSTED}`,
  input: z
    .object({
      account_id: accountId,
      ...periodFields,
      channel_group: z.enum(["default", "primary"]).default("default").describe("default: sessionDefaultChannelGroup; primary: sessionPrimaryChannelGroup."),
      key_event: eventName.optional().describe("A key event name: adds that event's session key event rate."),
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    ...reportHeaderShape,
    ...pageShape,
    channel_dimension: z.string(),
    key_event: z.string().nullable(),
    channels: z.array(
      z.object({
        channel: z.string(),
        sessions: nn,
        engaged_sessions: nn,
        engagement_rate: nn,
        average_session_duration_seconds: nn,
        total_users: nn,
        new_users: nn,
        key_events: nn,
        session_key_event_rate: nn,
        key_event_rate_for_event: nn,
        total_revenue: nn,
        share_of_sessions: nn.describe("This channel's sessions / GA4's total sessions."),
      }),
    ),
    totals: totalsOut,
  }),
  handler: (a, ctx) => fetchChannelTraffic(ctx.services.ga4, { period: a, channel_group: a.channel_group, ...(a.key_event ? { key_event: a.key_event } : {}) }),
});

// ------------------------------------------------------------------------------------------------ get_campaign_traffic
export const getCampaignTraffic = ga4Read({
  name: "get_campaign_traffic",
  title: "GA4 traffic by source, medium and campaign",
  description: `${LIVE} Sessions, engagement, key events and revenue by session source / medium / campaign. By default the campaign is sessionCampaignName, which includes Google Ads, manual (UTM) and other campaigns; utm_only reads only the utm_source / utm_medium / utm_campaign values (sessionManual*), e.g. to match Meta or email campaigns by their UTM tags. Filters are case-insensitive. "(not set)" rows are kept. ${PERIOD_NOTE} ${UNTRUSTED}`,
  input: z
    .object({
      account_id: accountId,
      ...periodFields,
      utm_only: z.boolean().default(false),
      include_content_and_term: z.boolean().default(false).describe("Adds utm_content (sessionManualAdContent) and utm_term (sessionManualTerm)."),
      source_contains: z.string().max(200).optional(),
      medium_equals: z.string().max(200).optional(),
      campaign_contains: z.string().max(200).optional(),
      order_by: z.enum(["sessions", "key_events", "revenue"]).default("sessions"),
      limit: limit(100),
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    ...reportHeaderShape,
    ...pageShape,
    utm_only: z.boolean(),
    dimensions: z.array(z.string()),
    rows: z.array(
      z.object({
        source: z.string(),
        medium: z.string(),
        campaign: z.string(),
        ad_content: z.string().nullable(),
        term: z.string().nullable(),
        sessions: nn,
        engaged_sessions: nn,
        engagement_rate: nn,
        key_events: nn,
        session_key_event_rate: nn,
        total_revenue: nn,
        total_users: nn,
      }),
    ),
    totals: totalsOut,
  }),
  handler: (a, ctx) => fetchCampaignTraffic(ctx.services.ga4, { ...a, period: a }),
});

// ------------------------------------------------------------------------------------------------ get_landing_page_performance
export const getLandingPagePerformance = ga4Read({
  name: "get_landing_page_performance",
  title: "GA4 landing page performance",
  description: `${LIVE} Sessions, engagement rate, bounce rate, average session duration, key events and revenue per landing page (the page path of each session's first pageview), optionally with the query string, filtered by page text, channel (exact sessionDefaultChannelGroup, e.g. "Paid Search") and a minimum number of sessions. ${PERIOD_NOTE} ${UNTRUSTED}`,
  input: z
    .object({
      account_id: accountId,
      ...periodFields,
      include_query_string: z.boolean().default(false).describe("Use landingPagePlusQueryString instead of landingPage."),
      page_contains: z.string().max(500).optional(),
      channel: z.string().max(100).optional().describe("Exact default channel group, e.g. Paid Search, Organic Search."),
      min_sessions: z.number().int().min(0).default(0),
      order_by: z.enum(["sessions", "key_events", "revenue", "engagement_rate"]).default("sessions"),
      limit: limit(100),
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    ...reportHeaderShape,
    ...pageShape,
    dimension: z.string(),
    rows: z.array(
      z.object({
        landing_page: z.string(),
        sessions: nn,
        engaged_sessions: nn,
        engagement_rate: nn,
        bounce_rate: nn,
        average_session_duration_seconds: nn,
        key_events: nn,
        session_key_event_rate: nn,
        total_revenue: nn,
      }),
    ),
    totals: totalsOut,
    note: z.string().nullable(),
  }),
  handler: (a, ctx) => fetchLandingPages(ctx.services.ga4, { ...a, period: a }),
});

// ------------------------------------------------------------------------------------------------ get_google_ads_traffic_in_ga4
export const getGoogleAdsTrafficInGa4 = ga4Read({
  name: "get_google_ads_traffic_in_ga4",
  title: "Google Ads traffic as GA4 sees it",
  description: `${LIVE} What Google Ads clicks did on the site according to GA4: sessions, engagement, key events and revenue by Google Ads campaign, ad group, keyword or search query, with Google Ads cost, clicks and ROAS as imported into GA4 when available (cost metrics blocked for you or incompatible with the level are left out and listed). Needs a Google Ads link on the property (get_ga4_ads_links) and auto-tagging. ${PERIOD_NOTE} ${UNTRUSTED}`,
  input: z
    .object({
      account_id: accountId,
      ...periodFields,
      level: z.enum(["campaign", "ad_group", "keyword", "query"]).default("campaign"),
      google_ads_customer_id: z.string().regex(/^\d{3}-?\d{3}-?\d{4}$/).optional().describe("Only this Google Ads account (123-456-7890 or 1234567890)."),
      campaign_id: z.string().regex(/^\d{1,20}$/).optional().describe("Only this Google Ads campaign id."),
      include_cost: z.boolean().default(true),
      order_by: z.enum(["sessions", "key_events", "revenue"]).default("sessions"),
      limit: limit(100),
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    ...reportHeaderShape,
    ...pageShape,
    level: z.string(),
    rows: z.array(
      z.object({
        campaign_id: z.string(),
        campaign: z.string(),
        ad_group_id: z.string().nullable(),
        ad_group: z.string().nullable(),
        keyword: z.string().nullable(),
        query: z.string().nullable(),
        sessions: nn,
        engaged_sessions: nn,
        engagement_rate: nn,
        key_events: nn,
        session_key_event_rate: nn,
        total_revenue: nn,
        ad_cost: nn.describe("advertiserAdCost in the property currency; null when omitted."),
        ad_clicks: nn,
        roas: nn.describe("returnOnAdSpend: total revenue / advertiser ad cost."),
      }),
    ),
    totals: totalsOut,
    omitted_metrics: z.array(z.object({ metric: z.string(), reason: z.string() })),
    note: z.string().nullable(),
  }),
  handler: (a, ctx) => fetchGoogleAdsTraffic(ctx.services.ga4, { ...a, period: a }),
});

// ------------------------------------------------------------------------------------------------ get_conversion_events
export const getConversionEvents = ga4Read({
  name: "get_conversion_events",
  title: "GA4 key events and how often they fired",
  description: `Fetched live from Google Analytics (Admin keyEvents.list, Data API runReport). Every key event (GA4's name for conversions) of the property with its counting method and default value, and how many times it fired in the period, so you can see which key events are recorded and which never fire. Key events count from the moment they were marked, not before: ones created during the period (created_during_period) or after it ended (created_after_period) are flagged. ${UNTRUSTED}`,
  input: z.object({ account_id: accountId, ...periodFields }).refine(datesOk, datesMsg),
  output: z.object({
    ...reportHeaderShape,
    key_events: z.array(
      z.object({
        key_event_id: z.string(),
        name: z.string(),
        event_name: z.string(),
        counting_method: z.string().nullable(),
        default_value: z.object({ value: z.number().nullable(), currency_code: z.string().nullable() }).nullable(),
        custom: z.boolean().nullable(),
        deletable: z.boolean().nullable(),
        create_time: z.string().nullable(),
        event_count: nn,
        key_event_count: nn,
        status: z.enum(["recorded", "no_events_in_period", "created_during_period", "created_after_period"]).describe("created_during_period: marked as a key event during the period, so counts are partial; created_after_period: marked after the period ended, so key_event_count does not reflect it."),
      }),
    ),
    summary: z.object({ total: z.number().int(), recorded: z.number().int(), not_recorded: z.number().int() }),
  }),
  handler: (a, ctx) => fetchKeyEventCounts(ctx.services.ga4, { period: a }),
});
