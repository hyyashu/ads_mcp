import { ToolError } from "../../mcp/errors";
import { GoogleApiClient, type GoogleApiClientOptions, HARD_ROW_CAP } from "../gapi/client";
import { type Discovery, MAX_DISCOVERED } from "../gapi/discovery";

export const GA4_ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
export const GA4_ADMIN_ALPHA_API = "https://analyticsadmin.googleapis.com/v1alpha";
export const GA4_DATA_API = "https://analyticsdata.googleapis.com/v1beta";
export const GA4_DATA_ALPHA_API = "https://analyticsdata.googleapis.com/v1alpha";

export const isPropertyName = (s: string) => /^properties\/\d{1,20}$/.test(s);

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
}

interface AccountSummary {
  displayName?: string;
  propertySummaries?: { property?: string; displayName?: string }[];
}
interface Property {
  name?: string;
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
          return { p, prop: await api.read<Property>(`${GA4_ADMIN_API}/${p.property}`) };
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
