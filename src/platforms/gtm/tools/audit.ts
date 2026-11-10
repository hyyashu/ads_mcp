import { z } from "zod";
import { AuditSchema, auditContainer, readLiveForAudit } from "../audit";
import { UNTRUSTED, accountId, gtmRead } from "./common";

export const auditGtmContainer = gtmRead({
  name: "audit_gtm_container",
  title: "Audit a Tag Manager container",
  description: `Checks the live version of a Tag Manager container against fixed rules: nothing published, tags that never fire or block themselves, paused or expired tags, duplicate tags (double counting), unused triggers, consent settings, GA4 Measurement IDs, Google Ads conversion and remarketing tags, the Meta pixel (custom HTML recognised by Meta's documented base code) and an inventory of custom HTML tags with the hosts they load from. Read-only (2 requests). ${UNTRUSTED}`,
  input: z.object({ account_id: accountId, include_info: z.boolean().default(true).describe("Include info-level findings (inventory and notes), not only problems.") }),
  output: AuditSchema,
  handler: async (a, ctx) => auditContainer(await readLiveForAudit(ctx.services.gtm), new Date(), { includeInfo: a.include_info }),
});
