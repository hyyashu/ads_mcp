import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import { accountId, gscRead, gscWrite, permissionLabel, propertyType, readBack, siteUrlSchema } from "./common";

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

const REFRESH = "Refresh Search Console on the Connections page to update the accounts available here.";

// -------------------------------------------------------------------------------------------------- add_gsc_site
// sites.add: PUT webmasters/v3/sites/{siteUrl}, no body, scope webmasters. account_id only selects the Google user (any site
// account of the same Search Console connection).
export const addGscSite = gscWrite({
  name: "add_gsc_site",
  title: "Add a Search Console property",
  risk: "write",
  description:
    "Adds a property (sc-domain:example.com or a URL prefix ending in /) to the connected Google user's Search Console after approval. account_id is any site of the same Search Console connection; it only selects the Google user. Ownership is not verified by this: until it is verified in Search Console the property is unverified and has no data. Refuses a property the user already has.",
  input: z.object({ account_id: accountId.describe("Any Search Console site of the connection whose Google user should get the new property."), site_url: siteUrlSchema }),
  output: z.object({ site_url: z.string(), permission_level: z.string(), verified: z.boolean(), next_steps: z.string() }),
  plan: async (a, ctx) => {
    const gsc = ctx.services.gsc;
    const found = await gsc.findSite(a.site_url);
    if (found) throw new ToolError("invalid_argument", `${a.site_url} is already in this user's Search Console (permission: ${permissionLabel(found.permissionLevel)}). Nothing to add.`);
    const changes: Change[] = [{ resource: "search_console_property", id: a.site_url, name: null, field: "in_search_console", before: null, after: "added (unverified)", unit: "text", effect: "neutral" }];
    return {
      summary: `Add ${a.site_url} to the Search Console of the Google user connected through ${gsc.siteUrl}. This does not verify ownership: until ownership is verified in Search Console the property shows as unverified and has no data. After verifying, ${REFRESH.charAt(0).toLowerCase()}${REFRESH.slice(1)}`,
      changes,
      snapshot: { site_url: a.site_url, present: false },
    };
  },
  execute: async (a, ctx) => {
    const gsc = ctx.services.gsc;
    await gsc.addSite(a.site_url);
    const got = await readBack(() => gsc.findSite(a.site_url));
    if (!got) throw new ToolError("unknown_outcome", "Google accepted the request but the property is not in the user's list yet. Check list_gsc_sites before trying again.");
    const verified = got.permissionLevel !== "siteUnverifiedUser";
    return {
      site_url: got.siteUrl,
      permission_level: got.permissionLevel,
      verified,
      next_steps: verified ? `The property is verified. ${REFRESH}` : `Verify ownership of ${got.siteUrl} in Search Console, then ${REFRESH.charAt(0).toLowerCase()}${REFRESH.slice(1)}`,
    };
  },
  verify: async (a, ctx) => ((await ctx.services.gsc.findSite(a.site_url)) ? { outcome: "applied" } : { outcome: "not_applied" }),
});

// ----------------------------------------------------------------------------------------------- remove_gsc_site
// sites.delete: DELETE webmasters/v3/sites/{siteUrl}, no body, scope webmasters. Google's docs: "Removes a site from the set of
// the user's Search Console sites"; they do not say what happens to verification, other users or data.
export const removeGscSite = gscWrite({
  name: "remove_gsc_site",
  title: "Remove a Search Console property",
  risk: "destructive",
  description:
    "Removes the property named by account_id from the connected Google user's list of Search Console properties, after approval by a person. confirm_site_url must repeat the property exactly. Google's API docs do not say what this does to the property's other users, its verification or its data.",
  input: z.object({ account_id: accountId, confirm_site_url: z.string().min(1).max(2048).describe("The property's site URL exactly as Search Console shows it (e.g. sc-domain:example.com), to confirm.") }),
  output: z.object({ site_url: z.string(), removed: z.literal(true), note: z.string() }),
  plan: async (a, ctx) => {
    const gsc = ctx.services.gsc;
    if (a.confirm_site_url !== gsc.siteUrl) throw new ToolError("invalid_argument", `confirm_site_url must be exactly ${gsc.siteUrl}, the property named by account_id.`);
    const { permissionLevel } = await gsc.getSite();
    const changes: Change[] = [{ resource: "search_console_property", id: gsc.siteUrl, name: null, field: "in_search_console", before: permissionLevel || "present", after: null, unit: "text", effect: "remove" }];
    return {
      summary: `Remove ${gsc.siteUrl} from the connected Google user's list of Search Console properties (their permission: ${permissionLabel(permissionLevel)}). Google's API docs do not say what this does to the property's other users, its verification or its data; check in Search Console first. Its sitemaps and data stop being reachable through this connection.`,
      changes,
      snapshot: { site_url: gsc.siteUrl, permission_level: permissionLevel },
    };
  },
  execute: async (_a, ctx) => {
    const gsc = ctx.services.gsc;
    await gsc.deleteSite();
    if (await readBack(() => gsc.findSite(gsc.siteUrl))) throw new ToolError("unknown_outcome", "Google accepted the request but the property is still in the user's list. Check list_gsc_sites before trying again.");
    return { site_url: gsc.siteUrl, removed: true as const, note: `${REFRESH} This account stops working here once the connection is refreshed.` };
  },
  verify: async (_a, ctx) => ((await ctx.services.gsc.findSite(ctx.services.gsc.siteUrl)) ? { outcome: "not_applied" } : { outcome: "applied" }),
});
