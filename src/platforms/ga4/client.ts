import { ToolError } from "../../mcp/errors";
import { GoogleApiClient, type GoogleApiClientOptions, HARD_ROW_CAP, tooManyRows } from "../gapi/client";
import { type Discovery, MAX_DISCOVERED } from "../gapi/discovery";
import type {
  AccountSummary,
  AttributionSettings,
  Audience,
  AudienceCreate,
  ChangeHistoryEvent,
  ChangeHistoryQuery,
  CompatBody,
  CompatResponse,
  CountingMethod,
  CustomDimension,
  DataStream,
  DimensionScope,
  Ga4Metadata,
  Ga4Property,
  GoogleAdsLink,
  KeyEvent,
  RunFunnelBody,
  RunFunnelReportResponse,
  RunPivotBody,
  RunPivotReportResponse,
  RunRealtimeBody,
  RunRealtimeReportResponse,
  RunReportBody,
  RunReportResponse,
} from "./types";

export const GA4_ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
export const GA4_ADMIN_ALPHA_API = "https://analyticsadmin.googleapis.com/v1alpha";
export const GA4_DATA_API = "https://analyticsdata.googleapis.com/v1beta";
export const GA4_DATA_ALPHA_API = "https://analyticsdata.googleapis.com/v1alpha";

export const isPropertyName = (s: string) => /^properties\/\d{1,20}$/.test(s);

/** Rows of an Admin list read in one call. Lists past this refuse (row_cap) rather than work from part of the list. */
const ADMIN_LIST_CAP = 1_000;

/**
 * GA4 Data API quota message (Data API "Quotas", checked 2026-11-10): Standard properties get 40,000 tokens per hour and
 * 200,000 per day; daily quotas reset at midnight Pacific. The code and retry-after come from the transport (never retried).
 */
function ga4QuotaError(e: unknown): unknown {
  if (!(e instanceof ToolError) || e.code !== "quota_exceeded") return e;
  return new ToolError(
    "quota_exceeded",
    "Google Analytics reporting quota for this property is used up (Standard: 40,000 tokens per hour, 200,000 per day; daily quota resets at midnight Pacific). Try again later or narrow the report.",
    { retryAfterSeconds: e.opts.retryAfterSeconds ?? 60 },
  );
}

/** One GA4 property (connected_account.external_id = "properties/123"), with its reporting currency and time zone. */
export class Ga4Client extends GoogleApiClient {
  constructor(o: GoogleApiClientOptions & { property: string; currencyCode: string | null; timeZone: string | null }) {
    super(o);
    if (!isPropertyName(o.property)) throw new ToolError("internal", "Not a GA4 property name.");
    this.property = o.property;
    this.currencyCode = o.currencyCode;
    this.timeZone = o.timeZone;
  }
  /** "properties/123". */
  readonly property: string;
  /** The property's reporting currency (Admin API Property.currencyCode), as stored at connect time. */
  readonly currencyCode: string | null;
  /** The property's reporting time zone, the day boundary for reports (Property.timeZone). */
  readonly timeZone: string | null;

  /** A resource name of THIS property (e.g. properties/123/keyEvents/9). A name of another property can never be addressed. */
  private own(name: string, collection: string): string {
    const re = new RegExp(`^properties/\\d{1,20}/${collection}/[A-Za-z0-9_-]{1,100}$`);
    if (!re.test(name) || !name.startsWith(`${this.property}/`)) throw new ToolError("invalid_argument", `Not a ${collection} resource of ${this.property}.`);
    return name;
  }

  private async data<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw ga4QuotaError(e);
    }
  }

  // ---------------------------------------------------------------------------------------------- Admin API v1beta
  getProperty(): Promise<Ga4Property> {
    return this.read<Ga4Property>(`${GA4_ADMIN_API}/${this.property}`);
  }

  /** Every account and property the connected Google user can see (pageSize max 200). Partial past maxRows, with `truncated`. */
  listAccountSummaries(maxRows = ADMIN_LIST_CAP): Promise<{ items: AccountSummary[]; truncated: boolean }> {
    return this.pages<AccountSummary>(`${GA4_ADMIN_API}/accountSummaries`, { pageSize: 200 }, { itemsKey: "accountSummaries", maxRows, partial: true });
  }

  async listDataStreams(): Promise<DataStream[]> {
    return (await this.pages<DataStream>(`${GA4_ADMIN_API}/${this.property}/dataStreams`, { pageSize: 200 }, { itemsKey: "dataStreams", maxRows: 200, what: "data streams" })).items;
  }

  async listKeyEvents(): Promise<KeyEvent[]> {
    return (await this.pages<KeyEvent>(`${GA4_ADMIN_API}/${this.property}/keyEvents`, { pageSize: 200 }, { itemsKey: "keyEvents", maxRows: ADMIN_LIST_CAP, what: "key events" })).items;
  }

  /** keyEvents.create (scope analytics.edit). Sent once, never retried. */
  createKeyEvent(body: { eventName: string; countingMethod: CountingMethod; defaultValue?: { numericValue: number; currencyCode: string } }): Promise<KeyEvent> {
    return this.send<KeyEvent>("POST", `${GA4_ADMIN_API}/${this.property}/keyEvents`, body);
  }

  /** keyEvents.delete: empty body and response. Only a key event of this property. */
  async deleteKeyEvent(name: string): Promise<void> {
    await this.send("DELETE", `${GA4_ADMIN_API}/${this.own(name, "keyEvents")}`);
  }

  async listCustomDimensions(): Promise<CustomDimension[]> {
    return (await this.pages<CustomDimension>(`${GA4_ADMIN_API}/${this.property}/customDimensions`, { pageSize: 200 }, { itemsKey: "customDimensions", maxRows: ADMIN_LIST_CAP, what: "custom dimensions" })).items;
  }

  createCustomDimension(body: { parameterName: string; displayName: string; scope: DimensionScope; description?: string; disallowAdsPersonalization?: boolean }): Promise<CustomDimension> {
    return this.send<CustomDimension>("POST", `${GA4_ADMIN_API}/${this.property}/customDimensions`, body);
  }

  async listGoogleAdsLinks(): Promise<GoogleAdsLink[]> {
    return (await this.pages<GoogleAdsLink>(`${GA4_ADMIN_API}/${this.property}/googleAdsLinks`, { pageSize: 200 }, { itemsKey: "googleAdsLinks", maxRows: ADMIN_LIST_CAP, what: "Google Ads links" })).items;
  }

  /**
   * accounts:searchChangeHistoryEvents (v1beta). A POST that only reads, paged with pageToken in the body (pageSize max 200).
   * Google accepts only the analytics.edit scope for it. Reads up to maxRows and reports `truncated` when more exist.
   */
  async searchChangeHistory(account: string, body: ChangeHistoryQuery, o: { maxRows: number }): Promise<{ items: ChangeHistoryEvent[]; truncated: boolean }> {
    if (!/^accounts\/\d{1,20}$/.test(account)) throw new ToolError("internal", "Not a GA4 account name.");
    const maxRows = Math.max(1, Math.min(o.maxRows, HARD_ROW_CAP));
    const items: ChangeHistoryEvent[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.query<{ changeHistoryEvents?: ChangeHistoryEvent[]; nextPageToken?: string }>(`${GA4_ADMIN_API}/${account}:searchChangeHistoryEvents`, {
        ...body,
        pageSize: Math.min(200, maxRows - items.length),
        ...(pageToken ? { pageToken } : {}),
      });
      items.push(...(res.changeHistoryEvents ?? []));
      pageToken = res.nextPageToken || undefined;
    } while (pageToken && items.length < maxRows);
    return { items: items.slice(0, maxRows), truncated: items.length > maxRows || !!pageToken };
  }

  // ---------------------------------------------------------------------------------------------- Admin API v1alpha
  /** properties.getAttributionSettings (v1alpha: Google may change it without notice). */
  getAttributionSettings(): Promise<AttributionSettings> {
    return this.read<AttributionSettings>(`${GA4_ADMIN_ALPHA_API}/${this.property}/attributionSettings`);
  }

  async listAudiences(): Promise<Audience[]> {
    return (await this.pages<Audience>(`${GA4_ADMIN_ALPHA_API}/${this.property}/audiences`, { pageSize: 200 }, { itemsKey: "audiences", maxRows: ADMIN_LIST_CAP, what: "audiences" })).items;
  }

  /** properties.audiences.create (v1alpha). Sent once, never retried. */
  createAudience(body: AudienceCreate): Promise<Audience> {
    return this.send<Audience>("POST", `${GA4_ADMIN_ALPHA_API}/${this.property}/audiences`, body);
  }

  // ---------------------------------------------------------------------------------------------- Data API
  /** The property's dimensions and metrics, including its custom definitions. */
  getMetadata(): Promise<Ga4Metadata> {
    return this.data(() => this.read<Ga4Metadata>(`${GA4_DATA_API}/${this.property}/metadata`));
  }

  checkCompatibility(body: CompatBody): Promise<CompatResponse> {
    return this.data(() => this.query<CompatResponse>(`${GA4_DATA_API}/${this.property}:checkCompatibility`, body));
  }

  /** One runReport page. `limit` must be 1..HARD_ROW_CAP (Google allows 250,000; this server reads at most 10,000 per call). */
  runReport(body: RunReportBody): Promise<RunReportResponse> {
    if (!(Number.isInteger(body.limit) && body.limit > 0 && body.limit <= HARD_ROW_CAP)) throw new ToolError("internal", "runReport limit out of range.");
    return this.data(() => this.query<RunReportResponse>(`${GA4_DATA_API}/${this.property}:runReport`, { ...body, returnPropertyQuota: true }));
  }

  /**
   * Every row of a report, paged by offset. Refuses with row_cap (nothing partial) when GA4 says the result has more than
   * maxRows rows (`rowCount` counts all rows, independent of limit and offset).
   */
  async reportAll(body: Omit<RunReportBody, "offset" | "limit">, o: { maxRows: number; what: string }): Promise<RunReportResponse> {
    const maxRows = Math.max(1, Math.min(o.maxRows, HARD_ROW_CAP));
    const first = await this.runReport({ ...body, limit: maxRows, offset: 0 });
    const total = first.rowCount ?? first.rows?.length ?? 0;
    if (total > maxRows) throw tooManyRows(maxRows, o.what);
    const rows = [...(first.rows ?? [])];
    while (rows.length < total) {
      const next = await this.runReport({ ...body, limit: maxRows, offset: rows.length });
      if (!next.rows?.length) break;
      rows.push(...next.rows);
    }
    return { ...first, rows };
  }

  runPivotReport(body: RunPivotBody): Promise<RunPivotReportResponse> {
    return this.data(() => this.query<RunPivotReportResponse>(`${GA4_DATA_API}/${this.property}:runPivotReport`, { ...body, returnPropertyQuota: true }));
  }

  runRealtimeReport(body: RunRealtimeBody): Promise<RunRealtimeReportResponse> {
    return this.data(() => this.query<RunRealtimeReportResponse>(`${GA4_DATA_API}/${this.property}:runRealtimeReport`, { ...body, returnPropertyQuota: true }));
  }

  /** runFunnelReport (Data API v1alpha: Google may change it without notice). */
  runFunnelReport(body: RunFunnelBody): Promise<RunFunnelReportResponse> {
    return this.data(() => this.query<RunFunnelReportResponse>(`${GA4_DATA_ALPHA_API}/${this.property}:runFunnelReport`, { ...body, returnPropertyQuota: true }));
  }
}

interface DiscoveredProperty {
  displayName?: string;
  currencyCode?: string;
  timeZone?: string;
}

/**
 * Connect-time discovery: Admin API accountSummaries.list (pageSize up to 200) for every property the user can reach, then
 * properties.get for each one's currencyCode and timeZone. A property that answers not found or permission denied is
 * skipped; any other failure (outage, quota) fails the connection rather than storing half a result.
 */
export async function discoverGa4Properties(api: GoogleApiClient): Promise<Discovery> {
  const { items } = await api.pages<AccountSummary>(`${GA4_ADMIN_API}/accountSummaries`, { pageSize: 200 }, { itemsKey: "accountSummaries", maxRows: HARD_ROW_CAP, partial: true });
  const found = items.flatMap((a) => (a.propertySummaries ?? []).map((p) => ({ ...p, account: a.displayName ?? "" }))).filter((p) => p.property && isPropertyName(p.property));
  let skipped = Math.max(0, found.length - MAX_DISCOVERED);
  const accounts: Discovery["accounts"] = [];
  const todo = found.slice(0, MAX_DISCOVERED);
  // A few at a time: fast enough at connect time without bursting the Admin API quota.
  for (let i = 0; i < todo.length; i += 5) {
    const batch = await Promise.all(
      todo.slice(i, i + 5).map(async (p) => {
        try {
          return { p, prop: await api.read<DiscoveredProperty>(`${GA4_ADMIN_API}/${p.property}`) };
        } catch (e) {
          if (e instanceof ToolError && (e.code === "not_found" || e.code === "platform_permission_denied")) return { p, prop: null };
          throw e;
        }
      }),
    );
    for (const { p, prop } of batch) {
      if (!prop) {
        skipped++;
        continue;
      }
      const name = prop.displayName ?? p.displayName ?? p.property!;
      accounts.push({ externalId: p.property!, displayName: p.account ? `${name} (${p.account})` : name, loginCustomerId: null, currencyCode: prop.currencyCode ?? null, timeZone: prop.timeZone ?? null });
    }
  }
  return { accounts, skipped };
}
