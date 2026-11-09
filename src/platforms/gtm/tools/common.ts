import { z } from "zod";
import { platformTools } from "../../core/tool-defs";
import { GTM_EDIT_CONTAINERS, GTM_EDIT_VERSIONS, GTM_PUBLISH, GTM_READONLY } from "../../gapi/scopes";
import type { GtmServices } from "../services";

export { GTM_EDIT_CONTAINERS, GTM_EDIT_VERSIONS, GTM_PUBLISH, GTM_READONLY };

export const accountId = z.string().min(1).describe("Tag Manager container: its path accounts/1/containers/2 or the account_id from list_accounts.");

const gtm = platformTools<GtmServices>("google_tag_manager", {
  read: { platformPermissions: [GTM_READONLY], notes: "Tag Manager connection. The Google Cloud project needs the Tag Manager API enabled." },
  // Each write tool names the one scope its method needs (edit.containers, edit.containerversions or publish).
  write: { platformPermissions: [GTM_EDIT_CONTAINERS], notes: "Tag Manager connection with changes allowed, and matching container permissions for the connected user (edit, approve, publish)." },
});
/** Declares a Tag Manager read tool. */
export const gtmRead = gtm.read;
/** Declares a Tag Manager write tool. Writes never run directly: the pipeline queues an approval first. Override platformPermissions per method. */
export const gtmWrite = gtm.write;
