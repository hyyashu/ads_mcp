import { z } from "zod";
import { asText, platformTools } from "../../core/tool-defs";
import type { MetaServices } from "../services";

export const ADS_READ = "ads_read";
export const ADS_MANAGEMENT = "ads_management";

export const accountId = z.string().min(1).describe("Connected Meta ad account id, as listed in your connections.");
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
