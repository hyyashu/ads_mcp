import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { asText, platformTools } from "../../core/tool-defs";
import type { MetaServices } from "../services";

export const ADS_READ = "ads_read";
export const ADS_MANAGEMENT = "ads_management";

export const accountId = z.string().min(1).describe("Meta ad account: the ad account id (e.g. act_1234567890) or the account_id from list_accounts.");
export const metaId = z.string().regex(/^\d{1,25}$/, "numeric Meta object id");

const meta = platformTools<MetaServices>("meta_ads", {
  read: { platformPermissions: [ADS_READ], notes: "The Meta app needs the ads_read permission (Marketing API)." },
  write: { platformPermissions: [ADS_MANAGEMENT], notes: "The Meta app needs ads_management, and the connected user needs an advertiser role on the ad account." },
});
/** Declares a Meta read tool. */
export const metaRead = meta.read;
/** Declares a Meta write tool. Writes never run directly: the pipeline queues an approval first. */
export const metaWrite = meta.write;

/** A Graph API field (Meta's JSON keeps snake_case keys, so no name conversion) as text, or null when absent. */
export const s = (row: Record<string, unknown>, k: string): string | null => asText(row[k]);

// Permissions beyond ads_read, as Meta's v27 reference states them for each endpoint (checked 2026-11-05). Tools declare them
// with `permissions: { platformPermissions: [...] }`; the OAuth consent already requests all of these (META_SCOPES).
export const PAGES_SHOW_LIST = "pages_show_list";
export const PAGES_READ_ENGAGEMENT = "pages_read_engagement";
export const INSTAGRAM_BASIC = "instagram_basic";
export const LEADS_RETRIEVAL = "leads_retrieval";
/** Builds a read tool's permission block with the extra permissions and a note naming them for the Meta app. */
export const needs = (...extra: string[]) => ({ platformPermissions: [ADS_READ, ...extra], notes: `The Meta app needs ${[ADS_READ, ...extra].join(", ")}.` });

/** Rows read from one listing edge before filtering. Above this a result says truncated. */
export const EDGE_CAP = 5_000;

/**
 * An id is accepted only if it appears on one of this ad account's own edges (pixels on /adspixels, Pages on /promote_pages, ...).
 * Used where the object itself has no documented account_id field to check. Refused ids are not_found, like getOwned.
 */
export async function requireOnEdge(m: import("../client").MetaAdsClient, edge: string, id: string, label: string): Promise<void> {
  if (!/^\d{1,25}$/.test(id)) throw new ToolError("invalid_argument", `${label} id must be numeric.`);
  const rows = await m.list(`${m.adAccountId}/${edge}`, { fields: "id" }, EDGE_CAP);
  if (!rows.some((r) => String(r.id) === id)) throw new ToolError("not_found", `No ${label} ${id} available to this ad account.`);
}

/** The Page must be one this ad account promotes (GET /{act}/promote_pages). */
export const requirePromotablePage = (m: import("../client").MetaAdsClient, pageId: string) => requireOnEdge(m, "promote_pages", pageId, "Page");
