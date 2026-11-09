import { ToolError } from "../../mcp/errors";
import { GoogleApiClient, type GoogleApiClientOptions, HARD_ROW_CAP } from "../gapi/client";
import { type Discovery, MAX_DISCOVERED } from "../gapi/discovery";

export const GTM_API = "https://tagmanager.googleapis.com/tagmanager/v2";

export const isContainerPath = (s: string) => /^accounts\/\d{1,20}\/containers\/\d{1,20}$/.test(s);

/** One Tag Manager container (connected_account.external_id = "accounts/1/containers/2", the container's API path). */
export class GtmClient extends GoogleApiClient {
  constructor(o: GoogleApiClientOptions & { containerPath: string }) {
    super(o);
    if (!isContainerPath(o.containerPath)) throw new ToolError("internal", "Not a Tag Manager container path.");
    this.containerPath = o.containerPath;
  }
  readonly containerPath: string;

  /** `https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2`. */
  get containerBase(): string {
    return `${GTM_API}/${this.containerPath}`;
  }
}

/** Account and Container resources (tagmanager v2 reference): path, accountId / containerId, name, publicId. */
interface GtmAccount {
  path?: string;
  name?: string;
}
interface GtmContainer {
  path?: string;
  name?: string;
  publicId?: string;
}

/**
 * Connect-time discovery: accounts.list, then accounts.containers.list for each account (both page with pageToken).
 * An account whose containers answer not found or permission denied is skipped; other failures fail the connection.
 */
export async function discoverGtmContainers(api: GoogleApiClient): Promise<Discovery> {
  const { items: accounts } = await api.pages<GtmAccount>(`${GTM_API}/accounts`, {}, { itemsKey: "account", maxRows: HARD_ROW_CAP, partial: true });
  const out: Discovery["accounts"] = [];
  let skipped = 0;
  for (const a of accounts) {
    if (!a.path || !/^accounts\/\d{1,20}$/.test(a.path)) continue;
    let containers: GtmContainer[];
    try {
      containers = (await api.pages<GtmContainer>(`${GTM_API}/${a.path}/containers`, {}, { itemsKey: "container", maxRows: HARD_ROW_CAP, partial: true })).items;
    } catch (e) {
      if (e instanceof ToolError && (e.code === "not_found" || e.code === "platform_permission_denied")) {
        skipped++;
        continue;
      }
      throw e;
    }
    for (const c of containers) {
      if (!c.path || !isContainerPath(c.path)) continue;
      if (out.length >= MAX_DISCOVERED) {
        skipped++;
        continue;
      }
      const name = c.name ?? c.path;
      out.push({ externalId: c.path, displayName: `${c.publicId ? `${name} (${c.publicId})` : name}${a.name ? ` · ${a.name}` : ""}`, loginCustomerId: null, currencyCode: null, timeZone: null });
    }
  }
  return { accounts: out, skipped };
}
