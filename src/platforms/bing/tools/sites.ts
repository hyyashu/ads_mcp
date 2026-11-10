import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { AnyTool } from "../../../mcp/tool";
import type { Change } from "../../../policy/change-set";
import {
  type MoveScope,
  type MoveType,
  type SiteMove,
  type SiteRole,
  type UserRole,
  addSite,
  addSiteRoles,
  getSiteMoves,
  getSiteRoles,
  removeSite,
  removeSiteRole,
  sameSiteUrl,
  submitSiteMove,
  verifySite,
} from "../api/sites";
import { type BingSite, isBingSiteUrl } from "../client";
import { accountId, bingRead, bingWrite, httpUrl, page, readBack, requireWithinSite, withinSite } from "./common";

// Sites and access. Facts: docs/VERIFICATION.md, "Sites and access (2026-11-10)".

const REFRESH = "Refresh Bing Webmaster on the Connections page to update the accounts available here.";
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** A Bing site URL argument: http(s), a host and an optional path, no query or fragment (as GetUserSites returns them). */
const bingSiteUrl = z.string().min(1).max(2048).refine(isBingSiteUrl, "expected a site URL such as https://www.example.com/ (http or https, no query or #fragment)");

const findLoose = (sites: BingSite[], url: string) => sites.find((s) => sameSiteUrl(s.url, url)) ?? null;

const SiteOut = z.object({
  site_url: z.string().describe("The site URL exactly as Bing returns it (untrusted text)."),
  verified: z.boolean(),
  is_this_account: z.boolean().describe("True for the site named by account_id."),
  authentication_code: z.string().nullable().describe("Bing's verification code for the site (AuthenticationCode): what the site owner places on the site so Bing can confirm ownership (untrusted text)."),
  dns_verification_code: z.string().nullable().describe("Bing's DNS verification value for the site (DnsVerificationCode), for verifying through the site's DNS instead (untrusted text)."),
});
const siteOut = (s: BingSite, thisSite: string): z.infer<typeof SiteOut> => ({
  site_url: s.url,
  verified: s.isVerified,
  is_this_account: s.url === thisSite,
  authentication_code: s.authenticationCode,
  dns_verification_code: s.dnsVerificationCode,
});
const VERIFY_HOW =
  "Verification codes are what the site owner places on the site (or, for the DNS value, in the site's DNS) so Bing can confirm ownership; Bing Webmaster Tools explains each method. Once a code is in place, verify_bing_site asks Bing to check it.";

// ------------------------------------------------------------------------------------------------ list_bing_sites
// GetUserSites: GET, no parameters → Site[] {AuthenticationCode, DnsVerificationCode, IsVerified, Url}.
export const listBingSites = bingRead({
  name: "list_bing_sites",
  title: "List Bing Webmaster sites",
  description:
    "Lists every site in the Bing Webmaster Tools account of the Bing user behind the named site's connection, verified or not, marking which one is this account. For each site it returns Bing's verification codes: what the site owner places on the site (or in its DNS) so Bing can confirm ownership. Only verified sites have data and become accounts here (after Bing is refreshed on the Connections page).",
  input: z.object({ account_id: accountId, limit: z.number().int().min(1).max(1000).default(200).describe("Most sites to return (sorted by site URL).") }),
  output: z.object({ sites: z.array(SiteOut), returned: z.number(), total: z.number(), truncated: z.boolean(), note: z.string() }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const all = (await bing.listSites()).sort((x, y) => x.url.localeCompare(y.url));
    const p = page(all, a.limit);
    return {
      sites: p.rows.map((s) => siteOut(s, bing.siteUrl)),
      returned: p.returned,
      total: p.total,
      truncated: p.truncated,
      note: `These are the sites of the connected Bing user. Use list_accounts for the ones connected here; a site added or verified since the last connect appears there after a refresh. ${VERIFY_HOW}`,
    };
  },
});

// -------------------------------------------------------------------------------------------------- add_bing_site
// AddSite: POST {"siteUrl"} → {"d": null}. "If the site was already added, the method will not throw exception."
export const addBingSite = bingWrite({
  name: "add_bing_site",
  title: "Add a site to Bing Webmaster Tools",
  risk: "write",
  description:
    "Adds a site to the Bing Webmaster Tools account of the Bing user behind the named site's connection, after approval. account_id is any Bing site of that connection; it only selects the Bing user. The new site starts unverified and has no data: place the returned verification code on the site, then run verify_bing_site. Refuses a site already in the user's list.",
  input: z.object({ account_id: accountId.describe("Any Bing site of the connection whose Bing user should get the new site."), site_url: bingSiteUrl.describe("The site to add, e.g. https://www.example.com/.") }),
  output: z.object({ site_url: z.string(), verified: z.boolean(), authentication_code: z.string().nullable(), dns_verification_code: z.string().nullable(), next_steps: z.string() }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    const found = findLoose(await bing.listSites(), a.site_url);
    if (found) throw new ToolError("invalid_argument", `${found.url} is already in this Bing user's sites (${found.isVerified ? "verified" : "not verified"}). Nothing to add.`);
    const changes: Change[] = [{ resource: "bing_site", id: a.site_url, name: null, field: "in_bing_webmaster", before: null, after: "added (unverified)", unit: "text", effect: "neutral" }];
    return {
      summary: `Add ${a.site_url} to the Bing Webmaster Tools sites of the Bing user connected through ${bing.siteUrl}. It starts unverified: Bing shows no data for it and nothing changes in Bing search until the owner places Bing's verification code on the site and it is verified (verify_bing_site). After that, ${lowerFirst(REFRESH)}`,
      changes,
      snapshot: { site_url: a.site_url, present: false },
    };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    await addSite(bing, a.site_url);
    const got = findLoose(await readBack(() => bing.listSites()), a.site_url);
    if (!got) throw new ToolError("unknown_outcome", "Bing accepted the request but the site is not in the user's list yet. Check list_bing_sites before trying again.");
    return {
      site_url: got.url,
      verified: got.isVerified,
      authentication_code: got.authenticationCode,
      dns_verification_code: got.dnsVerificationCode,
      next_steps: got.isVerified ? `The site is already verified. ${REFRESH}` : `${VERIFY_HOW} Then ${lowerFirst(REFRESH)}`,
    };
  },
  verify: async (a, ctx) => (findLoose(await ctx.services.bing.listSites(), a.site_url) ? { outcome: "applied" } : { outcome: "not_applied" }),
});

// ----------------------------------------------------------------------------------------------- verify_bing_site
// VerifySite: POST {"siteUrl"} → {"d": true|false}. NotAuthorized "if the site was not added to user site list".
export const verifyBingSite = bingWrite({
  name: "verify_bing_site",
  title: "Verify a Bing Webmaster site",
  risk: "write",
  description:
    "Asks Bing to check the verification code of a site in the connected Bing user's list (any site, including an unverified one; account_id only selects the Bing user), after approval. Bing looks for the code the owner placed on the site; nothing on the site changes. Returns whether the site is now verified, read back from Bing. A newly verified site becomes an account here only after Bing is refreshed on the Connections page.",
  input: z.object({ account_id: accountId.describe("Any Bing site of the connection whose Bing user has the site."), site_url: bingSiteUrl.describe("The site to verify, as list_bing_sites shows it.") }),
  output: z.object({ site_url: z.string(), verified: z.boolean(), bing_answer: z.boolean().nullable().describe("What VerifySite answered (true/false), null if it answered nothing."), next_steps: z.string() }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    const found = findLoose(await bing.listSites(), a.site_url);
    if (!found) throw new ToolError("invalid_argument", `${a.site_url} is not in this Bing user's sites. Add it first with add_bing_site.`);
    if (found.isVerified) throw new ToolError("invalid_argument", `${found.url} is already verified. Nothing to do. ${REFRESH}`);
    const changes: Change[] = [{ resource: "bing_site", id: found.url, name: null, field: "verified", before: false, after: true, unit: "text", effect: "neutral" }];
    return {
      summary: `Ask Bing to verify ownership of ${found.url} (in the Bing Webmaster Tools of the Bing user connected through ${bing.siteUrl}). Bing checks for the verification code the owner placed on the site; nothing on the site or in Bing search changes. If it succeeds, the site's Bing data becomes available; ${lowerFirst(REFRESH)}`,
      changes,
      snapshot: { site_url: found.url, verified: false },
    };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    const target = findLoose(await bing.listSites(), a.site_url);
    if (!target) throw new ToolError("conflict", `${a.site_url} is no longer in this Bing user's sites. Nothing was sent.`);
    const answer = await verifySite(bing, target.url);
    const got = findLoose(await readBack(() => bing.listSites()), target.url);
    if (!got) throw new ToolError("unknown_outcome", "The site is no longer in the Bing user's list after the verification request. Check list_bing_sites.");
    if (got.isVerified) return { site_url: got.url, verified: true, bing_answer: answer, next_steps: `The site is verified. ${REFRESH}` };
    if (answer === true) throw new ToolError("unknown_outcome", "Bing answered that the site is verified, but its site list still shows it unverified. Check list_bing_sites in a few minutes.");
    return {
      site_url: got.url,
      verified: false,
      bing_answer: answer,
      next_steps: `Bing could not verify the site: it did not find the verification code. ${VERIFY_HOW}`,
    };
  },
  verify: async (a, ctx) => {
    const got = findLoose(await ctx.services.bing.listSites(), a.site_url);
    if (!got) return { outcome: "indeterminate", detail: "the site is no longer in the Bing user's list" };
    return got.isVerified ? { outcome: "applied" } : { outcome: "not_applied" };
  },
});

// ----------------------------------------------------------------------------------------------- remove_bing_site
// RemoveSite: POST {"siteUrl"} → {"d": null}. The reference says only "Remove user site".
export const removeBingSite = bingWrite({
  name: "remove_bing_site",
  title: "Remove a Bing Webmaster site",
  risk: "destructive",
  description:
    "Removes the site named by account_id from the connected Bing user's Bing Webmaster Tools sites, after approval by a person. confirm_site_url must repeat the site exactly as Bing shows it. Bing's API reference does not say what this does to the site's other users, its verification or its data. It is not a request to remove pages from Bing search (that is block_bing_url).",
  input: z.object({ account_id: accountId, confirm_site_url: z.string().min(1).max(2048).describe("The site's URL exactly as Bing Webmaster Tools shows it (e.g. https://www.example.com/), to confirm.") }),
  output: z.object({ site_url: z.string(), removed: z.literal(true), note: z.string() }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    if (a.confirm_site_url !== bing.siteUrl) throw new ToolError("invalid_argument", `confirm_site_url must be exactly ${bing.siteUrl}, the site named by account_id.`);
    const site = await bing.findSite(bing.siteUrl);
    if (!site) throw new ToolError("not_found", `${bing.siteUrl} is no longer in the connected Bing user's sites. ${REFRESH}`);
    const changes: Change[] = [{ resource: "bing_site", id: site.url, name: null, field: "in_bing_webmaster", before: site.isVerified ? "verified" : "unverified", after: null, unit: "text", effect: "remove" }];
    return {
      summary: `Remove ${site.url} from the Bing Webmaster Tools sites of the connected Bing user. Bing's API reference does not say what this does to the site's other users, its verification or its data; check in Bing Webmaster Tools first. Its Bing data, sitemaps and settings stop being reachable through this connection. It does not ask Bing to remove the site's pages from search.`,
      changes,
      snapshot: { site_url: site.url, verified: site.isVerified },
    };
  },
  execute: async (_a, ctx) => {
    const bing = ctx.services.bing;
    await removeSite(bing);
    if (findLoose(await readBack(() => bing.listSites()), bing.siteUrl)) throw new ToolError("unknown_outcome", "Bing accepted the request but the site is still in the user's list. Check list_bing_sites before trying again.");
    return { site_url: bing.siteUrl, removed: true as const, note: `${REFRESH} This account stops working here once the connection is refreshed.` };
  },
  verify: async (_a, ctx) => (findLoose(await ctx.services.bing.listSites(), ctx.services.bing.siteUrl) ? { outcome: "not_applied" } : { outcome: "applied" }),
});

// ------------------------------------------------------------------------------------------ list_bing_site_users
// GetSiteRoles: GET ?siteUrl&includeAllSubdomains → SiteRoles[]. DelegatedCode and the delegator/code-owner emails are not
// returned: the first is a verification code, the others are other people's addresses this tool's purpose does not need.
const ROLE_LABEL: Record<UserRole, string> = { Administrator: "administrator", ReadOnly: "read-only", ReadWrite: "read-write" };
const ROLE_ARG = { read_only: "ReadOnly", read_write: "ReadWrite", administrator: "Administrator" } as const satisfies Record<string, UserRole>;
const ROLE_NOTE = "Bing's API reference does not describe what each role allows; Bing names them Administrator, ReadWrite and ReadOnly.";

export const listBingSiteUsers = bingRead({
  name: "list_bing_site_users",
  title: "List users of a Bing Webmaster site",
  description: `Lists the people who have been given access to the site in Bing Webmaster Tools: their email, role (Administrator, ReadWrite or ReadOnly), the site or subdomain the access covers, the verified site it was given through, when it was given and whether it has expired. ${ROLE_NOTE}`,
  input: z.object({
    account_id: accountId,
    include_all_subdomains: z.boolean().default(false).describe("Also list users given access to the site's subdomains (Bing's includeAllSubdomains)."),
    limit: z.number().int().min(1).max(1000).default(200).describe("Most users to return (sorted by site, then email)."),
  }),
  output: z.object({
    site_url: z.string(),
    users: z.array(
      z.object({
        email: z.string().describe("The user's email address (untrusted text)."),
        role: z.enum(["Administrator", "ReadOnly", "ReadWrite"]).nullable().describe("Bing's role; null if Bing sent a value it does not document."),
        site: z.string().describe("The site or subdomain the access covers (untrusted text)."),
        verification_site: z.string().nullable().describe("The verified site the access was given through (untrusted text)."),
        added: z.string().nullable().describe("When the access was given (ISO timestamp)."),
        expired: z.boolean().nullable(),
      }),
    ),
    returned: z.number(),
    total: z.number(),
    truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const all = (await getSiteRoles(bing, a.include_all_subdomains)).sort((x, y) => x.site.localeCompare(y.site) || x.email.localeCompare(y.email));
    const p = page(all, a.limit);
    return {
      site_url: bing.siteUrl,
      users: p.rows.map((r) => ({ email: r.email, role: r.role, site: r.site, verification_site: r.verificationSite, added: r.date, expired: r.expired })),
      returned: p.returned,
      total: p.total,
      truncated: p.truncated,
    };
  },
});

const email = z.string().trim().min(3).max(254).email();
const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const matchRole = (roles: SiteRole[], userEmail: string, site: string) => roles.filter((r) => sameEmail(r.email, userEmail) && sameSiteUrl(r.site, site));

/**
 * Where access may be given: the account's site itself, or (for a site that is a whole host) one of its subdomains, as the
 * AddSiteRoles sample delegates http://host1.example.com through http://example.com.
 */
function requireDelegatable(siteUrl: string, url: string): void {
  if (sameSiteUrl(siteUrl, url)) return;
  const s = new URL(siteUrl);
  const u = new URL(url);
  const root = s.pathname === "/" || s.pathname === "";
  const sub = u.hostname.toLowerCase().endsWith(`.${s.hostname.toLowerCase()}`) && (u.pathname === "/" || u.pathname === "");
  if (!(root && sub && u.protocol === s.protocol)) throw new ToolError("invalid_argument", `${url} is neither the site ${siteUrl} nor one of its subdomains. Give access through the site it belongs to.`, { definite: true });
}

// ------------------------------------------------------------------------------------------- add_bing_site_user
// AddSiteRoles: POST {"siteUrl","delegatedUrl","userEmail","authenticationCode","isAdministrator","isReadOnly"} → {"d": null}.
// None of the parameters is described; see api/sites.ts ROLE_FLAGS and VERIFICATION.md for the reading used.
export const addBingSiteUser = bingWrite({
  name: "add_bing_site_user",
  title: "Give someone access to a Bing Webmaster site",
  risk: "high_impact",
  description: `Gives another person access to the site's Bing Webmaster Tools data (or to one of its subdomains), after approval by a person: role read_only, read_write or administrator. That person can then see the site's Bing search data in Bing Webmaster Tools, and with read_write or administrator presumably change its Bing settings. ${ROLE_NOTE} Uses the site's own Bing verification code, so the site must be verified. Refuses someone who already has access to the same site.`,
  input: z.object({
    account_id: accountId,
    user_email: email.describe("Email address of the person (their Microsoft account) to give access."),
    role: z.enum(["read_only", "read_write", "administrator"]).describe("Bing role: read_only (ReadOnly), read_write (ReadWrite) or administrator (Administrator)."),
    delegated_url: bingSiteUrl.optional().describe("The site or subdomain to give access to (Bing's delegatedUrl). Default: the site named by account_id."),
  }),
  output: z.object({ user_email: z.string(), role: z.enum(["Administrator", "ReadOnly", "ReadWrite"]), site: z.string(), note: z.string() }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    const delegated = a.delegated_url ?? bing.siteUrl;
    requireDelegatable(bing.siteUrl, delegated);
    const site = await bing.findSite(bing.siteUrl);
    if (!site?.isVerified) throw new ToolError("invalid_argument", `${bing.siteUrl} is not a verified site of the connected Bing user, so it cannot give access. ${REFRESH}`);
    if (!site.authenticationCode) throw new ToolError("unsupported", "Bing did not report a verification code for this site, which giving access needs. Give access in Bing Webmaster Tools instead.");
    const role = ROLE_ARG[a.role];
    const existing = matchRole(await getSiteRoles(bing, true), a.user_email, delegated).find((r) => r.expired !== true);
    if (existing) throw new ToolError("invalid_argument", `${a.user_email} already has ${existing.role ? ROLE_LABEL[existing.role] : "some"} access to ${existing.site}. Remove it first (remove_bing_site_user) to change the role.`);
    const changes: Change[] = [{ resource: "bing_site_user", id: `${delegated} ${a.user_email.toLowerCase()}`, name: a.user_email, field: "role", before: null, after: role, unit: "text", effect: "create" }];
    return {
      summary: `Give ${a.user_email} ${ROLE_LABEL[role]} (${role}) access to the Bing Webmaster Tools data of ${delegated}${sameSiteUrl(delegated, bing.siteUrl) ? "" : ` (a subdomain of ${bing.siteUrl})`}. This person gets access to the site's Bing data: its search traffic, queries, pages, crawl and index information${role === "ReadOnly" ? "" : ", and presumably the ability to change the site's Bing settings"}. ${ROLE_NOTE} Access stays until it is removed.`,
      changes,
      snapshot: { site_url: bing.siteUrl, delegated_url: delegated, user_email: a.user_email.toLowerCase(), role, present: false },
    };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    const delegated = a.delegated_url ?? bing.siteUrl;
    const role = ROLE_ARG[a.role];
    const site = await bing.findSite(bing.siteUrl);
    if (!site?.authenticationCode) throw new ToolError("conflict", "The site's Bing verification code is no longer available. Nothing was sent.");
    await addSiteRoles(bing, { delegatedUrl: delegated, userEmail: a.user_email, authenticationCode: site.authenticationCode, role });
    const got = matchRole(await readBack(() => getSiteRoles(bing, true)), a.user_email, delegated).find((r) => r.expired !== true);
    if (!got || got.role !== role) throw new ToolError("unknown_outcome", `Bing accepted the request but ${a.user_email} does not show ${role} access yet. Check list_bing_site_users before trying again.`);
    return { user_email: got.email, role, site: got.site, note: `${got.email} now has ${ROLE_LABEL[role]} access. Remove it with remove_bing_site_user.` };
  },
  verify: async (a, ctx) => {
    const bing = ctx.services.bing;
    const got = matchRole(await getSiteRoles(bing, true), a.user_email, a.delegated_url ?? bing.siteUrl).find((r) => r.expired !== true);
    if (!got) return { outcome: "not_applied" };
    return got.role === ROLE_ARG[a.role] ? { outcome: "applied" } : { outcome: "indeterminate", detail: `the user has ${got.role ?? "an unknown"} access instead` };
  },
});

// ---------------------------------------------------------------------------------------- remove_bing_site_user
// RemoveSiteRole: POST {"siteUrl", "siteRole": SiteRoles} → {"d": null}. The entry is sent back exactly as Bing listed it.
function pickRole(roles: SiteRole[], userEmail: string, delegated: string | undefined): SiteRole {
  const mine = roles.filter((r) => sameEmail(r.email, userEmail) && (delegated === undefined || sameSiteUrl(r.site, delegated)));
  if (!mine.length) throw new ToolError("not_found", `${userEmail} has no access to ${delegated ?? "this site or its subdomains"} in Bing Webmaster Tools. Check list_bing_site_users.`);
  if (mine.length > 1) throw new ToolError("invalid_argument", `${userEmail} has access to ${mine.length} sites here (${mine.map((r) => r.site).join(", ")}). Say which with delegated_url.`);
  return mine[0]!;
}

export const removeBingSiteUser = bingWrite({
  name: "remove_bing_site_user",
  title: "Remove someone's access to a Bing Webmaster site",
  risk: "destructive",
  description:
    "Removes a person's access to the site's Bing Webmaster Tools data (or to one of its subdomains), after approval by a person. The person must currently have access (list_bing_site_users). If the person has access to more than one of the site's subdomains, delegated_url says which.",
  input: z.object({
    account_id: accountId,
    user_email: email.describe("Email address of the person whose access to remove, as list_bing_site_users shows it."),
    delegated_url: bingSiteUrl.optional().describe("The site or subdomain the access covers (the `site` from list_bing_site_users). Needed only when the person has access to several."),
  }),
  output: z.object({ user_email: z.string(), site: z.string(), removed: z.literal(true) }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    const r = pickRole(await getSiteRoles(bing, true), a.user_email, a.delegated_url);
    const changes: Change[] = [{ resource: "bing_site_user", id: `${r.site} ${r.email.toLowerCase()}`, name: r.email, field: "role", before: r.role ?? "unknown", after: null, unit: "text", effect: "remove" }];
    return {
      summary: `Remove ${r.email}'s ${r.role ? `${ROLE_LABEL[r.role]} ` : ""}access to the Bing Webmaster Tools data of ${r.site}${r.expired ? " (Bing already marks it expired)" : ""}. They will no longer see the site's Bing data. If this is the address of the Bing user behind this connection, the connection may lose the site.`,
      changes,
      snapshot: { site: r.site, user_email: r.email.toLowerCase(), role: r.role, expired: r.expired, added: r.date },
    };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    const r = pickRole(await getSiteRoles(bing, true), a.user_email, a.delegated_url);
    await removeSiteRole(bing, r);
    const still = matchRole(await readBack(() => getSiteRoles(bing, true)), r.email, r.site);
    if (still.length) throw new ToolError("unknown_outcome", `Bing accepted the request but ${r.email} still shows access to ${r.site}. Check list_bing_site_users before trying again.`);
    return { user_email: r.email, site: r.site, removed: true as const };
  },
  verify: async (a, ctx, run) => {
    const snap = (run.snapshot ?? {}) as { site?: string };
    const roles = await getSiteRoles(ctx.services.bing, true);
    const site = snap.site ?? a.delegated_url;
    const still = roles.filter((r) => sameEmail(r.email, a.user_email) && (site === undefined || sameSiteUrl(r.site, site)));
    return still.length ? { outcome: "not_applied" } : { outcome: "applied" };
  },
});

// ------------------------------------------------------------------------------------------- get_bing_site_moves
// GetSiteMoves: GET ?siteUrl → SiteMoveSettings[] {Date, MoveScope, MoveType, SourceUrl, TargetUrl}. No sample documented.
const SCOPE_WORDS: Record<MoveScope, string> = { Domain: "the whole domain", Host: "a whole host (subdomain)", Directory: "a directory" };
const TYPE_WORDS: Record<MoveType, string> = { Local: "within the same site", Global: "to another verified site" };
const MOVE_MEANING =
  "Bing's API reference gives no descriptions for the move values; scope is Domain, Host or Directory and type Local or Global. Bing's Site Move help describes moves within the current site (Local) and to another site the user has verified (Global), at domain, subdomain or directory level.";

const MoveOut = z.object({
  source_url: z.string().describe("Where the content moved from (untrusted text)."),
  target_url: z.string().describe("Where it moved to (untrusted text)."),
  scope: z.enum(["Domain", "Host", "Directory"]).nullable(),
  type: z.enum(["Local", "Global"]).nullable(),
  meaning: z.string().nullable().describe("The scope and type in plain words."),
  submitted: z.string().nullable().describe("When the move was submitted (ISO timestamp)."),
});
const moveOut = (m: SiteMove): z.infer<typeof MoveOut> => ({
  source_url: m.sourceUrl,
  target_url: m.targetUrl,
  scope: m.scope,
  type: m.type,
  meaning: m.scope && m.type ? `${SCOPE_WORDS[m.scope]}, moved ${TYPE_WORDS[m.type]}` : null,
  submitted: m.date,
});

export const getBingSiteMoves = bingRead({
  name: "get_bing_site_moves",
  title: "List Bing site moves",
  description: `Lists the site moves submitted to Bing for the site: where content moved from and to, the scope (Domain, Host or Directory), the type (Local or Global) and when it was submitted. ${MOVE_MEANING}`,
  input: z.object({ account_id: accountId, limit: z.number().int().min(1).max(1000).default(200).describe("Most moves to return (newest first).") }),
  output: z.object({ site_url: z.string(), moves: z.array(MoveOut), returned: z.number(), total: z.number(), truncated: z.boolean(), note: z.string() }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const all = (await getSiteMoves(bing)).sort((x, y) => (y.date ?? "").localeCompare(x.date ?? ""));
    const p = page(all, a.limit);
    return { site_url: bing.siteUrl, moves: p.rows.map(moveOut), returned: p.returned, total: p.total, truncated: p.truncated, note: MOVE_MEANING };
  },
});

// ----------------------------------------------------------------------------------------- submit_bing_site_move
// SubmitSiteMove: POST {"siteUrl", "settings": SiteMoveSettings}. No sample and no descriptions. Rules below come from Bing's
// Site Move help (recorded in VERIFICATION.md): moves to another site only to a site the user has verified; Domain only between
// sites; 301 redirects are still needed; a submitted move cannot be edited; neither location can be moved again for 180 days.
const LOCK_DAYS = 180;
const DAY_MS = 86_400_000;
const isRoot = (u: URL) => u.pathname === "/" || u.pathname === "";

export const submitBingSiteMove = bingWrite({
  name: "submit_bing_site_move",
  title: "Tell Bing a site has moved",
  risk: "destructive",
  description:
    "Tells Bing that content of the named site has permanently moved, after approval by a person: Bing then treats the old location as moved to the new one. move_type local moves a directory within the same site; global moves to another site, which must be in the connected Bing user's sites and verified (as must this one). move_scope: domain (whole domain, global only), host (a whole host) or directory. Keep 301 redirects from the old URLs in place for months. Per Bing's help, a submitted move cannot be edited and neither location can be moved again for at least 180 days. Refuses a move that repeats or overlaps a recent one.",
  input: z.object({
    account_id: accountId,
    source_url: httpUrl.describe("The old location, inside the site named by account_id: its root for domain or host moves, a directory ending in / for directory moves."),
    target_url: httpUrl.describe("The new location: a root for domain or host moves, a directory ending in / for directory moves."),
    move_type: z.enum(["local", "global"]).describe("local: within the same site. global: to another site of the same Bing user, which must be verified."),
    move_scope: z.enum(["domain", "host", "directory"]).describe("domain: the whole domain (global only). host: a whole host. directory: one directory."),
  }),
  output: z.object({ source_url: z.string(), target_url: z.string(), move_type: z.enum(["Local", "Global"]), move_scope: z.enum(["Domain", "Host", "Directory"]), listed: z.literal(true), note: z.string() }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    const type: MoveType = a.move_type === "local" ? "Local" : "Global";
    const scope: MoveScope = a.move_scope === "domain" ? "Domain" : a.move_scope === "host" ? "Host" : "Directory";
    const bad = (m: string) => new ToolError("invalid_argument", m, { definite: true });
    requireWithinSite(bing.siteUrl, a.source_url, "source URL");
    const src = new URL(a.source_url);
    const dst = new URL(a.target_url);
    if (src.search || dst.search) throw bad("Site moves name locations, not pages: remove the ?query from the URLs.");
    if (sameSiteUrl(a.source_url, a.target_url)) throw bad("source_url and target_url are the same location.");
    if (type === "Local" && scope !== "Directory") throw bad("A local move stays within the site, so it can only be a directory move. Use move_type global to move to another site.");
    if (scope === "Directory") {
      if (isRoot(src) || !src.pathname.endsWith("/") || !dst.pathname.endsWith("/")) throw bad("A directory move needs a source directory below the site root and a target directory, both ending in /.");
    } else if (!isRoot(src) || !isRoot(dst)) throw bad(`A ${a.move_scope} move goes from a root URL (https://host/) to a root URL.`);

    const sites = await bing.listSites();
    const own = findLoose(sites, bing.siteUrl);
    if (!own?.isVerified) throw bad(`${bing.siteUrl} is not a verified site of the connected Bing user. ${REFRESH}`);
    if (scope === "Domain" && !isRoot(new URL(bing.siteUrl))) throw bad(`${bing.siteUrl} is not a whole domain, so it cannot make a domain move.`);
    let targetSite: BingSite = own;
    if (type === "Local") {
      if (!withinSite(bing.siteUrl, a.target_url)) throw bad(`${a.target_url} is not inside ${bing.siteUrl}. A move to another site is move_type global.`);
    } else {
      if (withinSite(bing.siteUrl, a.target_url)) throw bad(`${a.target_url} is inside ${bing.siteUrl} itself. A move within the site is move_type local.`);
      const t = sites.filter((s) => !sameSiteUrl(s.url, bing.siteUrl) && withinSite(s.url, a.target_url)).sort((x, y) => y.url.length - x.url.length)[0];
      if (!t) throw bad(`${a.target_url} is not in any of the connected Bing user's sites. Add and verify the new site first (add_bing_site, verify_bing_site).`);
      if (!t.isVerified) throw bad(`The new site ${t.url} is not verified. Bing only accepts moves to a site the user has verified (verify_bing_site).`);
      targetSite = t;
    }

    const moves = await getSiteMoves(bing);
    const since = Date.now() - LOCK_DAYS * DAY_MS;
    const clash = moves.find((m) => [m.sourceUrl, m.targetUrl].some((u) => sameSiteUrl(u, a.source_url) || sameSiteUrl(u, a.target_url)) && (m.date === null || Date.parse(m.date) >= since));
    if (clash) throw bad(`Bing already has a move from ${clash.sourceUrl} to ${clash.targetUrl}${clash.date ? ` (submitted ${clash.date.slice(0, 10)})` : ""}. Per Bing's help, neither location can be part of another move for at least ${LOCK_DAYS} days.`);

    const changes: Change[] = [{ resource: "bing_site_move", id: a.source_url, name: null, field: "moved_to", before: null, after: a.target_url, unit: "text", effect: "neutral" }];
    return {
      summary: `Tell Bing that ${SCOPE_WORDS[scope]} ${a.source_url} has permanently moved to ${a.target_url} (${type} ${scope} move${type === "Global" ? ` to the verified site ${targetSite.url}` : ""}). Bing will treat the old location as moved to the new one, much like a permanent (301) redirect, for its index. The old URLs must keep 301 redirects to the new ones for several months. Per Bing's help a submitted move cannot be edited, neither location can be part of another move for at least ${LOCK_DAYS} days, and Bing gives no time by which its index reflects the move. Bing documents no way to undo it.`,
      changes,
      snapshot: { site_url: bing.siteUrl, source_url: a.source_url, target_url: a.target_url, type, scope, target_site: targetSite.url, target_verified: targetSite.isVerified, moves: moves.length },
    };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    const type: MoveType = a.move_type === "local" ? "Local" : "Global";
    const scope: MoveScope = a.move_scope === "domain" ? "Domain" : a.move_scope === "host" ? "Host" : "Directory";
    await submitSiteMove(bing, { sourceUrl: a.source_url, targetUrl: a.target_url, scope, type });
    const listed = (await readBack(() => getSiteMoves(bing))).some((m) => sameSiteUrl(m.sourceUrl, a.source_url) && sameSiteUrl(m.targetUrl, a.target_url));
    if (!listed) throw new ToolError("unknown_outcome", "Bing accepted the move but does not list it yet. Check get_bing_site_moves before trying again; do not submit it twice.");
    return { source_url: a.source_url, target_url: a.target_url, move_type: type, move_scope: scope, listed: true as const, note: "Bing lists the move. Keep 301 redirects from the old URLs to the new ones in place for several months." };
  },
  verify: async (a, ctx) =>
    (await getSiteMoves(ctx.services.bing)).some((m) => sameSiteUrl(m.sourceUrl, a.source_url) && sameSiteUrl(m.targetUrl, a.target_url)) ? { outcome: "applied" } : { outcome: "not_applied" },
});

export const sitesTools: AnyTool[] = [listBingSites, addBingSite, verifyBingSite, removeBingSite, listBingSiteUsers, addBingSiteUser, removeBingSiteUser, getBingSiteMoves, submitBingSiteMove] as AnyTool[];
