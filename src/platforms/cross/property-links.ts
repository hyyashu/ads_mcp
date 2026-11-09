import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { accountLink, connectedAccount, platformConnection } from "../../db/schema";
import { PLATFORMS } from "../../inventory";
import type { InternalServices, ReadTool } from "../../mcp/tool";

const LinkedSide = z.object({
  account_id: z.string().describe("This server's id for the account. Tools accept it or external_id."),
  platform: z.enum(PLATFORMS),
  external_id: z.string().describe("The platform's own id: Google Ads customer id, Meta act_ id, Search Console site URL, GA4 properties/N or Tag Manager accounts/N/containers/N."),
  name: z.string().describe("Name as the platform reported it at connect time (untrusted text)."),
  status: z.string().describe("Connection status: active, or needs_reauth (reconnect on the Connections page)."),
});
const input = z.object({});
const output = z.object({
  links: z.array(z.object({ link_id: z.string(), created_at: z.string(), accounts: z.array(LinkedSide).length(2).describe("The two linked accounts; an ad account, when there is one, comes first.") })),
});

/** Ads first, then Search Console, GA4, Tag Manager: the order a person reads "this ad account uses that site". */
const order = (p: string) => PLATFORMS.indexOf(p as (typeof PLATFORMS)[number]);

/**
 * Workspace-level, like list_accounts (accountScope "none", no account_id): links are set by owners and admins on the
 * Connections page, and this only reads them, scoped to the caller's workspace. Calls no Google or Meta API.
 */
export const getPropertyLinks: ReadTool<typeof input, typeof output, InternalServices> = {
  kind: "read",
  name: "get_property_links",
  platform: "google_analytics",
  title: "Get property links",
  description:
    "Lists which Search Console site, GA4 property and Tag Manager container is linked to each ad account in this workspace (links are set on the Connections page). Each link names both accounts with platform, account_id, platform id and name. Combined tools use these links when no account is named explicitly.",
  accountScope: "none",
  input,
  output,
  permissions: { scope: "ads:read", platformPermissions: [], notes: "Internal: reads this workspace's account links. Calls no platform API." },
  handler: async (_a, ctx) => {
    const { db } = ctx.services;
    const links = await db.select().from(accountLink).where(eq(accountLink.tenantId, ctx.tenantId));
    if (!links.length) return { links: [] };
    const ids = [...new Set(links.flatMap((l) => [l.accountAId, l.accountBId]))];
    const accounts = await db
      .select({ id: connectedAccount.id, platform: connectedAccount.platform, externalId: connectedAccount.externalId, name: connectedAccount.displayName, status: platformConnection.status })
      .from(connectedAccount)
      .innerJoin(platformConnection, eq(platformConnection.id, connectedAccount.connectionId))
      .where(and(eq(connectedAccount.tenantId, ctx.tenantId), inArray(connectedAccount.id, ids)));
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const side = (id: string) => {
      const a = byId.get(id)!;
      return { account_id: a.id, platform: a.platform as (typeof PLATFORMS)[number], external_id: a.externalId, name: a.name, status: a.status };
    };
    const out = links
      // Both ends are foreign keys to this tenant's accounts (checked when the link was made), so both are always present.
      .filter((l) => byId.has(l.accountAId) && byId.has(l.accountBId))
      .map((l) => ({ link_id: l.id, created_at: l.createdAt.toISOString(), accounts: [side(l.accountAId), side(l.accountBId)].sort((x, y) => order(x.platform) - order(y.platform) || x.name.localeCompare(y.name)) }));
    out.sort((x, y) => x.accounts[0]!.name.localeCompare(y.accounts[0]!.name) || x.accounts[0]!.account_id.localeCompare(y.accounts[0]!.account_id) || order(x.accounts[1]!.platform) - order(y.accounts[1]!.platform) || x.link_id.localeCompare(y.link_id));
    return { links: out };
  },
};

/** Registered from src/platforms/index.ts (not part of crossTools, which the combined-tools builder owns). */
export const propertyLinkTools = [getPropertyLinks];
