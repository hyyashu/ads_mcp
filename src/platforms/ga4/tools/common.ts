import { z } from "zod";
import { platformTools } from "../../core/tool-defs";
import { GA4_EDIT, GA4_READONLY } from "../../gapi/scopes";
import type { Ga4Services } from "../services";

export { GA4_EDIT, GA4_READONLY };

export const accountId = z.string().min(1).describe("GA4 property: properties/123 (or 123) or the account_id from list_accounts.");

const ga4 = platformTools<Ga4Services>("google_analytics", {
  read: { platformPermissions: [GA4_READONLY], notes: "Google Analytics connection. The Google Cloud project needs the Google Analytics Data API and Admin API enabled." },
  write: { platformPermissions: [GA4_READONLY, GA4_EDIT], notes: "Google Analytics connection with changes allowed (analytics.edit), and an Editor role or higher on the property." },
});
/** Declares a GA4 read tool. */
export const ga4Read = ga4.read;
/** Declares a GA4 write tool. Writes never run directly: the pipeline queues an approval first. */
export const ga4Write = ga4.write;
