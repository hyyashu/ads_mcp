import { z } from "zod";
import { platformTools } from "../../core/tool-defs";
import { GSC_FULL, GSC_READONLY } from "../../gapi/scopes";
import type { GscServices } from "../services";

export { GSC_FULL, GSC_READONLY };

export const accountId = z.string().min(1).describe("Search Console site: the site URL exactly as Search Console shows it (https://example.com/ or sc-domain:example.com) or the account_id from list_accounts.");

const gsc = platformTools<GscServices>("google_search_console", {
  read: { platformPermissions: [GSC_READONLY], notes: "Search Console connection (read-only or allow changes; webmasters covers reads too). The Google Cloud project needs the Google Search Console API enabled." },
  write: { platformPermissions: [GSC_FULL], notes: "Search Console connection with changes allowed (webmasters scope), and an owner or full user permission on the site." },
});
/** Declares a Search Console read tool. */
export const gscRead = gsc.read;
/** Declares a Search Console write tool. Writes never run directly: the pipeline queues an approval first. */
export const gscWrite = gsc.write;
