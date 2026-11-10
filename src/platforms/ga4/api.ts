/**
 * Public GA4 helpers for other builders (combined tools in src/platforms/cross/). Import from here, not from the files
 * behind it. Every helper calls Google live (Data API v1beta / Admin API v1beta) through the property's `Ga4Client`
 * (`ctx.services.ga4`, or `(await ctx.linked<Ga4Services>("google_analytics"))[i].services.ga4`); nothing is stored.
 * All report helpers resolve periods to explicit dates in the property's time zone, request GA4's TOTAL aggregation, keep
 * GA4's data-quality flags (sampling, thresholding, "(other)" row, empty reason) and quota, and never cut rows silently
 * (`row_count` is GA4's count of all rows; `truncated` when more exist). Quota exhaustion is `quota_exceeded` with a GA4
 * message and retry-after, never retried. Alpha APIs (funnels, attribution settings, audiences) are deliberately not here.
 *
 * Periods
 *   resolvePeriod(v: PeriodInput, tz: string | null, now?): ResolvedPeriod                  pure; explicit YYYY-MM-DD dates
 *   reportPeriod(ga4, v: PeriodInput, now?): Promise<{ period, timeZone, notes }>           reads the zone once if not stored
 *   periodFields / datesOk / datesMsg                                                       zod fields for a tool's input
 *
 * Generic report (names validated against metadata + checkCompatibility)
 *   runGa4Report(ga4, req: Ga4ReportRequest, now?): Promise<Ga4ReportResult>
 *   validateFields(ga4, req: FieldRequest): Promise<CheckedFields>
 *   incompatibleFields(ga4, { dimensions, metrics, dimensionFilter?, metricFilter? }): Promise<string[]>
 *
 * Fixed-shape queries (constant names from the API schema; typed rows)
 *   fetchChannelTraffic(ga4, { period, channel_group?, key_event?, limit? }, now?): Promise<ChannelTraffic>
 *   fetchCampaignTraffic(ga4, CampaignQuery, now?): Promise<CampaignTraffic>                 traffic by source/medium/campaign;
 *                                                                                           utm_only reads utm_* (sessionManual*)
 *   fetchLandingPages(ga4, LandingPageQuery, now?): Promise<LandingPages>
 *   fetchGoogleAdsTraffic(ga4, AdsTrafficQuery, now?): Promise<AdsTraffic>                   cost metrics optional, omissions listed
 *   fetchKeyEventCounts(ga4, { period }, now?): Promise<KeyEventCounts>                      every key event + counts (row_cap refusal)
 *   eventCountsLast28Days(ga4, names, now?): Promise<{ counts: Map<name, { event_count, key_events }>, period }>
 *   runFixedReport(ga4, { period, dimensions, metrics, dimensionFilter?, metricFilter?, orderBys?, limit }, now?): Promise<FixedReport>
 *
 * Admin
 *   keyEventsByName(ga4): Promise<Map<eventName, KeyEvent>>;  keyEventOut(k): KeyEventOut
 *   formatCustomerId(id): "123-456-7890";  STANDARD_LIMITS;  isStandard(property)
 *   Ga4Client methods: getProperty, listDataStreams, listKeyEvents, listCustomDimensions, listGoogleAdsLinks, getMetadata,
 *   runReport (limit ≤ 10,000), reportAll(body, { maxRows, what }) (all rows or row_cap).
 *
 * Output schemas for tools that embed GA4 results: reportHeaderShape, pageShape, totalsOut, dataQualityOut, quotaOut, periodOut.
 */
export { formatCustomerId, isStandard, keyEventOut, keyEventsByName, STANDARD_LIMITS, type KeyEventOut } from "./admin";
export { Ga4Client } from "./client";
export {
  type AdsLevel,
  type AdsTraffic,
  type AdsTrafficQuery,
  type AdsTrafficRow,
  type CampaignQuery,
  type CampaignRow,
  type CampaignTraffic,
  type ChannelRow,
  type ChannelTraffic,
  eventCountsLast28Days,
  fetchCampaignTraffic,
  fetchChannelTraffic,
  fetchGoogleAdsTraffic,
  fetchKeyEventCounts,
  fetchLandingPages,
  type KeyEventCount,
  type KeyEventCounts,
  type LandingPageQuery,
  type LandingPageRow,
  type LandingPages,
} from "./queries";
export {
  type CheckedFields,
  type DataQuality,
  dataQualityOut,
  datesMsg,
  datesOk,
  type FieldRequest,
  type FixedReport,
  type Ga4ReportRequest,
  type Ga4ReportResult,
  incompatibleFields,
  pageShape,
  type PeriodInput,
  periodFields,
  periodOut,
  quotaOut,
  type ReportHeader,
  reportHeaderShape,
  reportPeriod,
  type ResolvedPeriod,
  resolvePeriod,
  runFixedReport,
  runGa4Report,
  type ShapedRow,
  totalsOut,
  validateFields,
} from "./report";
export type { Ga4Services } from "./services";
