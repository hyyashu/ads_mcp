import { ToolError } from "../../mcp/errors";
import { ratio, round, todayIn } from "../core/report-math";
import { keyEventOut, keyEventsByName, type KeyEventOut } from "./admin";
import type { Ga4Client } from "./client";
import type { FilterExpression, RunReportResponse } from "./types";
import { byMetric, combine, headerFrom, incompatibleFields, indexMetadata, inListFilter, type PeriodInput, type ReportHeader, type ResolvedPeriod, reportPeriod, runFixedReport, stringFilter } from "./report";

/**
 * Fixed-shape GA4 queries (Data API v1beta runReport with constant dimension and metric names from the API schema page,
 * checked 2026-11-10). Each returns typed rows plus the common report header (exact period, zone, currency, data quality,
 * quota) and paging info (`row_count` = GA4's count of all rows; `truncated` when more exist than were returned). Rates are
 * GA4's own, never recomputed from sums; totals are GA4's TOTAL aggregation over all rows. Used by the fixed GA4 tools and
 * exported (./api.ts) for the combined tools.
 */

interface Page {
  row_count: number;
  returned: number;
  truncated: boolean;
}
const n = (v: number | null | undefined) => (v === undefined ? null : v);

// ------------------------------------------------------------------------------------------------ channels
export interface ChannelRow {
  channel: string;
  sessions: number | null;
  engaged_sessions: number | null;
  engagement_rate: number | null;
  average_session_duration_seconds: number | null;
  total_users: number | null;
  new_users: number | null;
  key_events: number | null;
  session_key_event_rate: number | null;
  key_event_rate_for_event: number | null;
  total_revenue: number | null;
  share_of_sessions: number | null;
}
export interface ChannelTraffic extends ReportHeader, Page {
  channel_dimension: string;
  key_event: string | null;
  channels: ChannelRow[];
  totals: Record<string, number | null> | null;
}

/** Sessions, engagement, key events and revenue by default (or primary) channel group. */
export async function fetchChannelTraffic(ga4: Ga4Client, o: { period: PeriodInput; channel_group?: "default" | "primary"; key_event?: string; limit?: number }, now = new Date()): Promise<ChannelTraffic> {
  const dimension = o.channel_group === "primary" ? "sessionPrimaryChannelGroup" : "sessionDefaultChannelGroup";
  const metrics = ["sessions", "engagedSessions", "engagementRate", "averageSessionDuration", "totalUsers", "newUsers", "keyEvents", "sessionKeyEventRate", "totalRevenue"];
  const forEvent = o.key_event ? `sessionKeyEventRate:${o.key_event}` : null;
  if (o.key_event) {
    const keys = await keyEventsByName(ga4);
    if (!keys.has(o.key_event)) throw new ToolError("invalid_argument", `"${o.key_event}" is not a key event of this property.${keys.size ? ` Key events: ${[...keys.keys()].sort().join(", ")}.` : " The property has no key events."}`);
  }
  const r = await runFixedReport(ga4, { period: o.period, dimensions: [dimension], metrics: forEvent ? [...metrics, forEvent] : metrics, orderBys: [byMetric("sessions")], limit: o.limit ?? 100 }, now);
  const total = r.totals?.sessions ?? null;
  return {
    ...strip(r),
    channel_dimension: dimension,
    key_event: o.key_event ?? null,
    channels: r.rows.map((x) => ({
      channel: x.dimensions[dimension] ?? "",
      sessions: n(x.metrics.sessions),
      engaged_sessions: n(x.metrics.engagedSessions),
      engagement_rate: n(x.metrics.engagementRate),
      average_session_duration_seconds: n(x.metrics.averageSessionDuration),
      total_users: n(x.metrics.totalUsers),
      new_users: n(x.metrics.newUsers),
      key_events: n(x.metrics.keyEvents),
      session_key_event_rate: n(x.metrics.sessionKeyEventRate),
      key_event_rate_for_event: forEvent ? n(x.metrics[forEvent]) : null,
      total_revenue: n(x.metrics.totalRevenue),
      share_of_sessions: x.metrics.sessions != null && total != null ? round(ratio(x.metrics.sessions, total)) : null,
    })),
    totals: r.totals,
  };
}

/** Header + page fields of a fixed report, without its raw rows. */
function strip(r: Awaited<ReturnType<typeof runFixedReport>>): ReportHeader & Page {
  return { property: r.property, period: r.period, time_zone: r.time_zone, currency_code: r.currency_code, data_quality: r.data_quality, quota: r.quota, row_count: r.row_count, returned: r.returned, truncated: r.truncated };
}

const ORDER_METRIC = { sessions: "sessions", key_events: "keyEvents", revenue: "totalRevenue", engagement_rate: "engagementRate" } as const;

// ------------------------------------------------------------------------------------------------ campaigns / UTM
export interface CampaignRow {
  source: string;
  medium: string;
  campaign: string;
  ad_content: string | null;
  term: string | null;
  sessions: number | null;
  engaged_sessions: number | null;
  engagement_rate: number | null;
  key_events: number | null;
  session_key_event_rate: number | null;
  total_revenue: number | null;
  total_users: number | null;
}
export interface CampaignTraffic extends ReportHeader, Page {
  utm_only: boolean;
  dimensions: string[];
  rows: CampaignRow[];
  totals: Record<string, number | null> | null;
}
export interface CampaignQuery {
  period: PeriodInput;
  /** true: only utm_* values (sessionManual*); false: sessionSource/Medium/CampaignName (Google Ads, UTM and other campaigns). */
  utm_only?: boolean;
  include_content_and_term?: boolean;
  source_contains?: string;
  medium_equals?: string;
  campaign_contains?: string;
  order_by?: "sessions" | "key_events" | "revenue";
  limit?: number;
}

/** Traffic by source / medium / campaign (optionally utm_content and utm_term). Case-insensitive filters. */
export async function fetchCampaignTraffic(ga4: Ga4Client, o: CampaignQuery, now = new Date()): Promise<CampaignTraffic> {
  const [src, med, camp] = o.utm_only ? ["sessionManualSource", "sessionManualMedium", "sessionManualCampaignName"] : ["sessionSource", "sessionMedium", "sessionCampaignName"];
  const dims = [src!, med!, camp!, ...(o.include_content_and_term ? ["sessionManualAdContent", "sessionManualTerm"] : [])];
  const filters: FilterExpression[] = [];
  if (o.source_contains) filters.push(stringFilter(src!, "CONTAINS", o.source_contains));
  if (o.medium_equals) filters.push(stringFilter(med!, "EXACT", o.medium_equals));
  if (o.campaign_contains) filters.push(stringFilter(camp!, "CONTAINS", o.campaign_contains));
  const dimensionFilter = combine(filters, "and");
  const r = await runFixedReport(
    ga4,
    {
      period: o.period,
      dimensions: dims,
      metrics: ["sessions", "engagedSessions", "engagementRate", "keyEvents", "sessionKeyEventRate", "totalRevenue", "totalUsers"],
      ...(dimensionFilter ? { dimensionFilter } : {}),
      orderBys: [byMetric(ORDER_METRIC[o.order_by ?? "sessions"])],
      limit: o.limit ?? 100,
    },
    now,
  );
  return {
    ...strip(r),
    utm_only: !!o.utm_only,
    dimensions: dims,
    rows: r.rows.map((x) => ({
      source: x.dimensions[src!] ?? "",
      medium: x.dimensions[med!] ?? "",
      campaign: x.dimensions[camp!] ?? "",
      ad_content: o.include_content_and_term ? (x.dimensions.sessionManualAdContent ?? "") : null,
      term: o.include_content_and_term ? (x.dimensions.sessionManualTerm ?? "") : null,
      sessions: n(x.metrics.sessions),
      engaged_sessions: n(x.metrics.engagedSessions),
      engagement_rate: n(x.metrics.engagementRate),
      key_events: n(x.metrics.keyEvents),
      session_key_event_rate: n(x.metrics.sessionKeyEventRate),
      total_revenue: n(x.metrics.totalRevenue),
      total_users: n(x.metrics.totalUsers),
    })),
    totals: r.totals,
  };
}

// ------------------------------------------------------------------------------------------------ landing pages
export interface LandingPageRow {
  landing_page: string;
  sessions: number | null;
  engaged_sessions: number | null;
  engagement_rate: number | null;
  bounce_rate: number | null;
  average_session_duration_seconds: number | null;
  key_events: number | null;
  session_key_event_rate: number | null;
  total_revenue: number | null;
}
export interface LandingPages extends ReportHeader, Page {
  dimension: string;
  rows: LandingPageRow[];
  totals: Record<string, number | null> | null;
  note: string | null;
}
export interface LandingPageQuery {
  period: PeriodInput;
  include_query_string?: boolean;
  page_contains?: string;
  /** Exact sessionDefaultChannelGroup value, e.g. "Paid Search". */
  channel?: string;
  min_sessions?: number;
  order_by?: "sessions" | "key_events" | "revenue" | "engagement_rate";
  limit?: number;
}

/** Sessions, engagement and key events by landing page (path of the session's first pageview). */
export async function fetchLandingPages(ga4: Ga4Client, o: LandingPageQuery, now = new Date()): Promise<LandingPages> {
  const dimension = o.include_query_string ? "landingPagePlusQueryString" : "landingPage";
  const filters: FilterExpression[] = [];
  if (o.page_contains) filters.push(stringFilter(dimension, "CONTAINS", o.page_contains));
  if (o.channel) filters.push(stringFilter("sessionDefaultChannelGroup", "EXACT", o.channel));
  const dimensionFilter = combine(filters, "and");
  const metricFilter: FilterExpression | undefined = o.min_sessions ? { filter: { fieldName: "sessions", numericFilter: { operation: "GREATER_THAN_OR_EQUAL", value: { int64Value: String(o.min_sessions) } } } } : undefined;
  const r = await runFixedReport(
    ga4,
    {
      period: o.period,
      dimensions: [dimension],
      metrics: ["sessions", "engagedSessions", "engagementRate", "bounceRate", "averageSessionDuration", "keyEvents", "sessionKeyEventRate", "totalRevenue"],
      ...(dimensionFilter ? { dimensionFilter } : {}),
      ...(metricFilter ? { metricFilter } : {}),
      orderBys: [byMetric(ORDER_METRIC[o.order_by ?? "sessions"])],
      limit: o.limit ?? 100,
    },
    now,
  );
  return {
    ...strip(r),
    dimension,
    rows: r.rows.map((x) => ({
      landing_page: x.dimensions[dimension] ?? "",
      sessions: n(x.metrics.sessions),
      engaged_sessions: n(x.metrics.engagedSessions),
      engagement_rate: n(x.metrics.engagementRate),
      bounce_rate: n(x.metrics.bounceRate),
      average_session_duration_seconds: n(x.metrics.averageSessionDuration),
      key_events: n(x.metrics.keyEvents),
      session_key_event_rate: n(x.metrics.sessionKeyEventRate),
      total_revenue: n(x.metrics.totalRevenue),
    })),
    totals: r.totals,
    note: r.data_quality.other_row ? "Landing pages have many distinct values: GA4 grouped some of them into '(other)', so the per-page figures do not cover all sessions. Narrow the period or filter by page or channel." : null,
  };
}

// ------------------------------------------------------------------------------------------------ Google Ads traffic
export type AdsLevel = "campaign" | "ad_group" | "keyword" | "query";
export interface AdsTrafficRow {
  campaign_id: string;
  campaign: string;
  ad_group_id: string | null;
  ad_group: string | null;
  keyword: string | null;
  query: string | null;
  sessions: number | null;
  engaged_sessions: number | null;
  engagement_rate: number | null;
  key_events: number | null;
  session_key_event_rate: number | null;
  total_revenue: number | null;
  ad_cost: number | null;
  ad_clicks: number | null;
  roas: number | null;
}
export interface AdsTraffic extends ReportHeader, Page {
  level: AdsLevel;
  rows: AdsTrafficRow[];
  totals: Record<string, number | null> | null;
  omitted_metrics: { metric: string; reason: string }[];
  note: string | null;
}
export interface AdsTrafficQuery {
  period: PeriodInput;
  level?: AdsLevel;
  /** Google Ads customer id, with or without hyphens; filtered as 10 digits. */
  google_ads_customer_id?: string;
  campaign_id?: string;
  include_cost?: boolean;
  order_by?: "sessions" | "key_events" | "revenue";
  limit?: number;
}

const ADS_DIMS: Record<AdsLevel, string[]> = {
  campaign: ["sessionGoogleAdsCampaignId", "sessionGoogleAdsCampaignName"],
  ad_group: ["sessionGoogleAdsCampaignId", "sessionGoogleAdsCampaignName", "sessionGoogleAdsAdGroupId", "sessionGoogleAdsAdGroupName"],
  keyword: ["sessionGoogleAdsCampaignId", "sessionGoogleAdsCampaignName", "sessionGoogleAdsAdGroupId", "sessionGoogleAdsAdGroupName", "sessionGoogleAdsKeyword"],
  query: ["sessionGoogleAdsCampaignId", "sessionGoogleAdsCampaignName", "sessionGoogleAdsQuery"],
};
const COST_METRICS = ["advertiserAdCost", "advertiserAdClicks", "returnOnAdSpend"];

/**
 * Google Ads traffic as GA4 sees it (sessions from auto-tagged Google Ads clicks, needs a Google Ads link). Cost metrics
 * (advertiserAd*) are optional: blocked for you or incompatible with the level → dropped and listed in omitted_metrics.
 */
export async function fetchGoogleAdsTraffic(ga4: Ga4Client, o: AdsTrafficQuery, now = new Date()): Promise<AdsTraffic> {
  const level = o.level ?? "campaign";
  const dims = ADS_DIMS[level];
  const base = ["sessions", "engagedSessions", "engagementRate", "keyEvents", "sessionKeyEventRate", "totalRevenue"];
  const filters: FilterExpression[] = [];
  const customer = o.google_ads_customer_id?.replace(/-/g, "");
  if (customer) filters.push(stringFilter("sessionGoogleAdsCustomerId", "EXACT", customer, true));
  if (o.campaign_id) filters.push(stringFilter("sessionGoogleAdsCampaignId", "EXACT", o.campaign_id, true));
  const dimensionFilter = combine(filters, "and");
  const omitted: { metric: string; reason: string }[] = [];
  let cost: string[] = [];
  if (o.include_cost !== false) {
    const meta = indexMetadata(await ga4.getMetadata());
    for (const m of COST_METRICS) {
      const md = meta.metrics.get(m);
      if (!md) omitted.push({ metric: m, reason: "not available on this property" });
      else if (md.blockedReasons?.length) omitted.push({ metric: m, reason: `blocked for you on this property (${md.blockedReasons.join(", ")})` });
      else cost.push(m);
    }
    if (cost.length) {
      const bad = await incompatibleFields(ga4, { dimensions: dims, metrics: [...base, ...cost], ...(dimensionFilter ? { dimensionFilter } : {}) });
      for (const m of cost.filter((c) => bad.includes(c))) omitted.push({ metric: m, reason: `GA4 cannot combine it with the ${level} dimensions` });
      cost = cost.filter((c) => !bad.includes(c));
    }
  }
  const r = await runFixedReport(ga4, { period: o.period, dimensions: dims, metrics: [...base, ...cost], ...(dimensionFilter ? { dimensionFilter } : {}), orderBys: [byMetric(ORDER_METRIC[o.order_by ?? "sessions"])], limit: o.limit ?? 100 }, now);
  const has = (m: string) => cost.includes(m);
  const notes: string[] = [];
  if (!r.rows.length) notes.push("No Google Ads sessions. This needs a Google Ads link on the property (get_ga4_ads_links) and auto-tagging; it is not proof that ads sent no traffic.");
  if (customer) notes.push(`Filtered on sessionGoogleAdsCustomerId = "${customer}" (digits only; how GA4 stores this id is not documented, so an empty result may mean the format differs: try without google_ads_customer_id).`);
  return {
    ...strip(r),
    level,
    rows: r.rows.map((x) => ({
      campaign_id: x.dimensions.sessionGoogleAdsCampaignId ?? "",
      campaign: x.dimensions.sessionGoogleAdsCampaignName ?? "",
      ad_group_id: x.dimensions.sessionGoogleAdsAdGroupId ?? null,
      ad_group: x.dimensions.sessionGoogleAdsAdGroupName ?? null,
      keyword: x.dimensions.sessionGoogleAdsKeyword ?? null,
      query: x.dimensions.sessionGoogleAdsQuery ?? null,
      sessions: n(x.metrics.sessions),
      engaged_sessions: n(x.metrics.engagedSessions),
      engagement_rate: n(x.metrics.engagementRate),
      key_events: n(x.metrics.keyEvents),
      session_key_event_rate: n(x.metrics.sessionKeyEventRate),
      total_revenue: n(x.metrics.totalRevenue),
      ad_cost: has("advertiserAdCost") ? n(x.metrics.advertiserAdCost) : null,
      ad_clicks: has("advertiserAdClicks") ? n(x.metrics.advertiserAdClicks) : null,
      roas: has("returnOnAdSpend") ? n(x.metrics.returnOnAdSpend) : null,
    })),
    totals: r.totals,
    omitted_metrics: omitted,
    note: notes.length ? notes.join(" ") : null,
  };
}

// ------------------------------------------------------------------------------------------------ key events
export interface KeyEventCount extends KeyEventOut {
  event_count: number | null;
  key_event_count: number | null;
  /** created_during_period / created_after_period: the key event was created after the period started, so counts are partial or describe the event before it became a key event. */
  status: "recorded" | "no_events_in_period" | "created_during_period" | "created_after_period";
}
export interface KeyEventCounts extends ReportHeader {
  key_events: KeyEventCount[];
  summary: { total: number; recorded: number; not_recorded: number };
}

/** Every key event of the property with how often it fired in the period (all rows, refuses past 1,000). */
export async function fetchKeyEventCounts(ga4: Ga4Client, o: { period: PeriodInput }, now = new Date()): Promise<KeyEventCounts> {
  const list = (await ga4.listKeyEvents()).filter((k) => k.eventName);
  const { period, timeZone, notes } = await reportPeriod(ga4, o.period, now);
  let res: RunReportResponse | null = null;
  const counts = new Map<string, { events: number | null; keys: number | null }>();
  if (list.length) {
    res = await ga4.reportAll(
      { dateRanges: [{ startDate: period.start_date, endDate: period.end_date }], dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "keyEvents" }], dimensionFilter: inListFilter("eventName", list.map((k) => k.eventName!)) },
      { maxRows: 1_000, what: "key event rows" },
    );
    const headers = res.metricHeaders ?? [];
    const mi = (name: string) => headers.findIndex((h) => h.name === name);
    const [ie, ik] = [mi("eventCount"), mi("keyEvents")];
    for (const r of res.rows ?? []) {
      const name = r.dimensionValues?.[0]?.value ?? "";
      const v = (i: number) => (i < 0 ? null : Number.isFinite(Number(r.metricValues?.[i]?.value)) ? Number(r.metricValues?.[i]?.value) : null);
      counts.set(name, { events: v(ie), keys: v(ik) });
    }
  }
  const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const explicitStart = isDate(period.start_date) ? period.start_date : null;
  const explicitEnd = isDate(period.end_date) ? period.end_date : null;
  const key_events = list
    .map((k): KeyEventCount => {
      const c = counts.get(k.eventName!);
      const created = k.createTime && explicitStart && timeZone ? todayIn(timeZone, new Date(k.createTime)) : null;
      const recorded = !!c && (c.events ?? 0) > 0;
      return {
        ...keyEventOut(k),
        event_count: c ? c.events : 0,
        key_event_count: c ? c.keys : 0,
        status:
          created && explicitEnd && created > explicitEnd
            ? "created_after_period"
            : created && created > explicitStart!
              ? "created_during_period"
              : recorded
                ? "recorded"
                : "no_events_in_period",
      };
    })
    .sort((a, b) => a.event_name.localeCompare(b.event_name));
  const recorded = key_events.filter((k) => (k.event_count ?? 0) > 0).length;
  const header = headerFrom(ga4, period, timeZone, notes, res);
  if (key_events.some((k) => k.status === "no_events_in_period")) header.data_quality.notes.push("A key event with no events may mean the tag is missing or the event name differs; compare with get_ga4_metadata and the Tag Manager tools.");
  if (!list.length) header.data_quality.notes.push("The property has no key events, so no report was run.");
  return { ...header, key_events, summary: { total: key_events.length, recorded, not_recorded: key_events.length - recorded } };
}


// ------------------------------------------------------------------------------------------------ event counts (write plans)
/**
 * How often each of `names` fired in the last 28 complete days (eventCount and keyEvents per eventName). Names that did not
 * fire are absent from GA4's answer and reported as 0. Used by write plans to tell the approver whether an event is real.
 */
export async function eventCountsLast28Days(ga4: Ga4Client, names: string[], now = new Date()): Promise<{ counts: Map<string, { event_count: number; key_events: number }>; period: ResolvedPeriod }> {
  const { period } = await reportPeriod(ga4, { date_range: "LAST_28_DAYS" }, now);
  const counts = new Map(names.map((x) => [x, { event_count: 0, key_events: 0 }]));
  if (!names.length) return { counts, period };
  const res = await ga4.runReport({
    dateRanges: [{ startDate: period.start_date, endDate: period.end_date }],
    dimensions: [{ name: "eventName" }],
    metrics: [{ name: "eventCount" }, { name: "keyEvents" }],
    dimensionFilter: inListFilter("eventName", names),
    limit: Math.max(1, names.length),
  });
  const headers = (res.metricHeaders ?? []).map((h) => h.name);
  for (const r of res.rows ?? []) {
    const name = r.dimensionValues?.[0]?.value ?? "";
    if (!counts.has(name)) continue;
    const v = (m: string) => Number(r.metricValues?.[headers.indexOf(m)]?.value ?? 0) || 0;
    counts.set(name, { event_count: v("eventCount"), key_events: v("keyEvents") });
  }
  return { counts, period };
}
