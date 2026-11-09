/**
 * Shapes of the GA4 Data API (v1beta, v1alpha for funnels) and Admin API (v1beta, v1alpha for audiences and attribution
 * settings) objects this server reads and sends. Only fields confirmed on developers.google.com on 2026-11-10 are listed
 * (docs/VERIFICATION.md, "GA4 tools (2026-11-10)"). Everything is optional on the response side: a missing field is reported
 * as null, never invented.
 */

// ------------------------------------------------------------------------------------------------ Data API: requests
export interface Ga4DateRange {
  startDate: string;
  endDate: string;
  name?: string;
}

export type StringMatchType = "EXACT" | "BEGINS_WITH" | "ENDS_WITH" | "CONTAINS" | "FULL_REGEXP" | "PARTIAL_REGEXP";
export type NumericOperation = "EQUAL" | "LESS_THAN" | "LESS_THAN_OR_EQUAL" | "GREATER_THAN" | "GREATER_THAN_OR_EQUAL";
export type NumericValue = { int64Value: string } | { doubleValue: number };

export interface Ga4Filter {
  fieldName: string;
  stringFilter?: { matchType: StringMatchType; value: string; caseSensitive?: boolean };
  inListFilter?: { values: string[]; caseSensitive?: boolean };
  numericFilter?: { operation: NumericOperation; value: NumericValue };
  betweenFilter?: { fromValue: NumericValue; toValue: NumericValue };
  emptyFilter?: Record<string, never>;
}

export interface FilterExpression {
  andGroup?: { expressions: FilterExpression[] };
  orGroup?: { expressions: FilterExpression[] };
  notExpression?: FilterExpression;
  filter?: Ga4Filter;
}

export type OrderBy = { desc?: boolean; metric: { metricName: string } } | { desc?: boolean; dimension: { dimensionName: string; orderType?: "ALPHANUMERIC" | "CASE_INSENSITIVE_ALPHANUMERIC" | "NUMERIC" } };

export type MetricAggregation = "TOTAL" | "MINIMUM" | "MAXIMUM" | "COUNT";

export interface RunReportBody {
  dimensions?: { name: string }[];
  metrics: { name: string }[];
  dateRanges: Ga4DateRange[];
  dimensionFilter?: FilterExpression;
  metricFilter?: FilterExpression;
  offset?: number;
  limit: number;
  metricAggregations?: MetricAggregation[];
  orderBys?: OrderBy[];
  keepEmptyRows?: boolean;
}

export interface Pivot {
  fieldNames: string[];
  orderBys?: OrderBy[];
  offset?: number;
  limit: number;
  metricAggregations?: MetricAggregation[];
}

export interface RunPivotBody {
  dimensions: { name: string }[];
  metrics: { name: string }[];
  dateRanges: Ga4DateRange[];
  pivots: Pivot[];
  dimensionFilter?: FilterExpression;
  metricFilter?: FilterExpression;
  keepEmptyRows?: boolean;
}

export interface MinuteRange {
  startMinutesAgo?: number;
  endMinutesAgo?: number;
  name?: string;
}

export interface RunRealtimeBody {
  dimensions?: { name: string }[];
  metrics: { name: string }[];
  dimensionFilter?: FilterExpression;
  metricFilter?: FilterExpression;
  limit: number;
  metricAggregations?: MetricAggregation[];
  orderBys?: OrderBy[];
  minuteRanges?: MinuteRange[];
}

export interface FunnelStep {
  name: string;
  isDirectlyFollowedBy?: boolean;
  /** Duration such as "3.5s". */
  withinDurationFromPriorStep?: string;
  filterExpression: { funnelEventFilter: { eventName: string } };
}

export interface RunFunnelBody {
  dateRanges: Ga4DateRange[];
  funnel: { isOpenFunnel?: boolean; steps: FunnelStep[] };
  funnelBreakdown?: { breakdownDimension: { name: string }; limit?: string };
  funnelVisualizationType?: "STANDARD_FUNNEL" | "TRENDED_FUNNEL";
  limit?: string;
}

export interface CompatBody {
  dimensions?: { name: string }[];
  metrics?: { name: string }[];
  dimensionFilter?: FilterExpression;
  metricFilter?: FilterExpression;
}

// ------------------------------------------------------------------------------------------------ Data API: responses
export interface MetricHeader {
  name?: string;
  type?: string;
}
export interface Ga4Row {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}
export interface QuotaStatus {
  consumed?: number;
  remaining?: number;
}
export interface PropertyQuota {
  tokensPerDay?: QuotaStatus;
  tokensPerHour?: QuotaStatus;
  concurrentRequests?: QuotaStatus;
  serverErrorsPerProjectPerHour?: QuotaStatus;
  potentiallyThresholdedRequestsPerHour?: QuotaStatus;
  tokensPerProjectPerHour?: QuotaStatus;
}
export interface ResponseMetaData {
  dataLossFromOtherRow?: boolean;
  currencyCode?: string;
  timeZone?: string;
  emptyReason?: string;
  subjectToThresholding?: boolean;
  samplingMetadatas?: { samplesReadCount?: string | number; samplingSpaceSize?: string | number }[];
}
export interface RunReportResponse {
  dimensionHeaders?: { name?: string }[];
  metricHeaders?: MetricHeader[];
  rows?: Ga4Row[];
  totals?: Ga4Row[];
  rowCount?: number;
  metadata?: ResponseMetaData;
  propertyQuota?: PropertyQuota;
  kind?: string;
}
export interface RunPivotReportResponse {
  pivotHeaders?: { pivotDimensionHeaders?: { dimensionValues?: { value?: string }[] }[]; rowCount?: number }[];
  dimensionHeaders?: { name?: string }[];
  metricHeaders?: MetricHeader[];
  rows?: Ga4Row[];
  aggregates?: Ga4Row[];
  metadata?: ResponseMetaData;
  propertyQuota?: PropertyQuota;
}
export interface RunRealtimeReportResponse {
  dimensionHeaders?: { name?: string }[];
  metricHeaders?: MetricHeader[];
  rows?: Ga4Row[];
  totals?: Ga4Row[];
  rowCount?: number;
  propertyQuota?: PropertyQuota;
}
export interface FunnelSubReport {
  dimensionHeaders?: { name?: string }[];
  metricHeaders?: MetricHeader[];
  rows?: Ga4Row[];
  metadata?: { samplingMetadatas?: { samplesReadCount?: string | number; samplingSpaceSize?: string | number }[] };
}
export interface RunFunnelReportResponse {
  funnelTable?: FunnelSubReport;
  funnelVisualization?: FunnelSubReport;
  propertyQuota?: PropertyQuota;
}

export interface DimensionMetadata {
  apiName?: string;
  uiName?: string;
  description?: string;
  deprecatedApiNames?: string[];
  customDefinition?: boolean;
  category?: string;
}
export interface MetricMetadata extends DimensionMetadata {
  type?: string;
  expression?: string;
  blockedReasons?: string[];
}
export interface Ga4Metadata {
  name?: string;
  dimensions?: DimensionMetadata[];
  metrics?: MetricMetadata[];
}
export interface CompatResponse {
  dimensionCompatibilities?: { dimensionMetadata?: DimensionMetadata; compatibility?: string }[];
  metricCompatibilities?: { metricMetadata?: MetricMetadata; compatibility?: string }[];
}

// ------------------------------------------------------------------------------------------------ Admin API
export interface Ga4Property {
  name?: string;
  propertyType?: string;
  createTime?: string;
  updateTime?: string;
  parent?: string;
  displayName?: string;
  industryCategory?: string;
  timeZone?: string;
  currencyCode?: string;
  serviceLevel?: string;
  deleteTime?: string;
  expireTime?: string;
  account?: string;
}
export interface AccountSummary {
  name?: string;
  account?: string;
  displayName?: string;
  propertySummaries?: { property?: string; displayName?: string; propertyType?: string; parent?: string }[];
}
export interface DataStream {
  name?: string;
  type?: string;
  displayName?: string;
  createTime?: string;
  updateTime?: string;
  webStreamData?: { measurementId?: string; firebaseAppId?: string; defaultUri?: string };
  androidAppStreamData?: { firebaseAppId?: string; packageName?: string };
  iosAppStreamData?: { firebaseAppId?: string; bundleId?: string };
}
export type CountingMethod = "ONCE_PER_EVENT" | "ONCE_PER_SESSION";
export interface KeyEvent {
  name?: string;
  eventName?: string;
  createTime?: string;
  deletable?: boolean;
  custom?: boolean;
  countingMethod?: string;
  defaultValue?: { numericValue?: number; currencyCode?: string };
}
export type DimensionScope = "EVENT" | "USER" | "ITEM";
export interface CustomDimension {
  name?: string;
  parameterName?: string;
  displayName?: string;
  description?: string;
  scope?: string;
  disallowAdsPersonalization?: boolean;
}
export interface GoogleAdsLink {
  name?: string;
  customerId?: string;
  canManageClients?: boolean;
  adsPersonalizationEnabled?: boolean;
  createTime?: string;
  updateTime?: string;
  creatorEmailAddress?: string;
}
export interface AttributionSettings {
  name?: string;
  acquisitionConversionEventLookbackWindow?: string;
  otherConversionEventLookbackWindow?: string;
  reportingAttributionModel?: string;
  adsWebConversionDataExportScope?: string;
}

/** The reduced, event-only Audience this server creates (v1alpha). See tools/audiences.ts. */
export interface AudienceEventFilter {
  eventFilter: { eventName: string };
}
export interface AudienceFilterClause {
  clauseType: "INCLUDE" | "EXCLUDE";
  simpleFilter: {
    scope: "AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS";
    filterExpression: { andGroup: { expressions: { orGroup: { expressions: AudienceEventFilter[] } }[] } };
  };
}
export interface AudienceCreate {
  displayName: string;
  description: string;
  membershipDurationDays: number;
  filterClauses: AudienceFilterClause[];
  exclusionDurationMode?: "EXCLUDE_TEMPORARILY" | "EXCLUDE_PERMANENTLY";
}
export interface Audience {
  name?: string;
  displayName?: string;
  description?: string;
  membershipDurationDays?: number;
  adsPersonalizationEnabled?: boolean;
  exclusionDurationMode?: string;
  createTime?: string;
}

export interface ChangeHistoryQuery {
  property?: string;
  resourceType?: string[];
  action?: string[];
  earliestChangeTime?: string;
  latestChangeTime?: string;
}
/**
 * Admin API v1beta ChangeHistoryResource: a union with exactly these members (checked 2026-11-10). Other resource types
 * (custom dimensions, attribution settings, ...) appear in change history with only their resource name and action.
 */
export interface ChangeHistoryResource {
  account?: Record<string, unknown>;
  property?: Record<string, unknown>;
  firebaseLink?: Record<string, unknown>;
  googleAdsLink?: Record<string, unknown>;
  conversionEvent?: Record<string, unknown>;
  measurementProtocolSecret?: Record<string, unknown>;
  dataRetentionSettings?: Record<string, unknown>;
  dataStream?: Record<string, unknown>;
}
export interface ChangeHistoryEvent {
  id?: string;
  changeTime?: string;
  actorType?: string;
  userActorEmail?: string;
  changesFiltered?: boolean;
  changes?: { resource?: string; action?: string; resourceBeforeChange?: ChangeHistoryResource; resourceAfterChange?: ChangeHistoryResource }[];
}
