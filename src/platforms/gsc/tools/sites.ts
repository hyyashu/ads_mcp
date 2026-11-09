import { z } from "zod";
import { accountId, gscRead, permissionLabel, propertyType } from "./common";

// sites.list: GET webmasters/v3/sites → siteEntry[] {siteUrl, permissionLevel}; no paging documented.

// ------------------------------------------------------------------------------------------------ list_gsc_sites
export const listGscSites = gscRead({
  name: "list_gsc_sites",
  title: "List Search Console sites",
  description:
    "Lists every Search Console property the connected Google user can see (through the connection of the named site), with the user's permission level and whether ownership is verified. Each verified property is a separate account in list_accounts once Search Console is refreshed on the Connections page.",
  input: z.object({ account_id: accountId, limit: z.number().int().min(1).max(1000).default(200).describe("Most sites to return (sorted by site URL).") }),
  output: z.object({
    sites: z.array(
      z.object({
        site_url: z.string(),
        property_type: z.enum(["domain", "url_prefix"]),
        permission_level: z.string().describe("siteOwner, siteFullUser, siteRestrictedUser or siteUnverifiedUser, as Google reports it."),
        permission: z.string().describe("The permission level in plain words."),
        verified: z.boolean(),
        is_this_account: z.boolean().describe("True for the site named by account_id."),
      }),
    ),
    returned: z.number(),
    total: z.number(),
    truncated: z.boolean(),
    note: z.string(),
  }),
  handler: async (a, ctx) => {
    const all = (await ctx.services.gsc.listSites()).sort((x, y) => x.siteUrl.localeCompare(y.siteUrl));
    const sites = all.slice(0, a.limit).map((s) => ({
      site_url: s.siteUrl,
      property_type: propertyType(s.siteUrl),
      permission_level: s.permissionLevel,
      permission: permissionLabel(s.permissionLevel),
      verified: s.permissionLevel !== "siteUnverifiedUser",
      is_this_account: s.siteUrl === ctx.services.gsc.siteUrl,
    }));
    return {
      sites,
      returned: sites.length,
      total: all.length,
      truncated: all.length > sites.length,
      note: "These are the properties the connected Google user can see. Use list_accounts for the ones connected here; a property added or verified since the last connect appears there after Search Console is refreshed on the Connections page.",
    };
  },
});
