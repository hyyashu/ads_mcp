import { ToolError } from "../../../mcp/errors";
import { type BingClient, type Row, asList, bingDate, bool, num, str } from "../client";

/**
 * Sites and access: the Bing user's site list, verification, users of a site and site moves.
 * Facts: docs/VERIFICATION.md, "Sites and access (2026-11-10)".
 *
 * - AddSite(siteUrl) / VerifySite(siteUrl) / RemoveSite(siteUrl): WebInvoke POST, body {"siteUrl"}. AddSite and RemoveSite
 *   answer {"d": null}; VerifySite answers {"d": true|false}. AddSite: "If the site was already added, the method will not
 *   throw exception." VerifySite: InvalidUrl if the URL is not valid, NotAuthorized "if the site was not added to user site list".
 * - GetSiteRoles(siteUrl, includeAllSubdomains): WebGet → SiteRoles[] {Date, DelegatedCode, DelegatedCodeOwnerEmail,
 *   DelegatorEmail, Email, Expired, Role, Site, VerificationSite}. Role is SiteRoles.UserRole: Administrator 0, ReadOnly 1,
 *   ReadWrite 2 (the JSON sample sends the number, the XML sample the name).
 * - AddSiteRoles(siteUrl, delegatedUrl, userEmail, authenticationCode, isAdministrator, isReadOnly): WebInvoke POST.
 * - RemoveSiteRole(siteUrl, siteRole: SiteRoles): WebInvoke POST; the sample sends the whole SiteRoles object (with __type).
 * - GetSiteMoves(siteUrl): WebGet → SiteMoveSettings[] {Date, MoveScope, MoveType, SourceUrl, TargetUrl}.
 *   SiteMoveSettings.Scope: Domain 0, Host 1, Directory 2. SiteMoveSettings.Type: Local 0, Global 1. No samples documented.
 * - SubmitSiteMove(siteUrl, settings: SiteMoveSettings): WebInvoke POST. No sample documented.
 */

// ------------------------------------------------------------------------------------------------------ helpers

/**
 * Whether two Bing site URLs name the same site: same scheme, host (any case) and port, and the same path once a trailing
 * slash is ignored. Bing may return "http://example.com" for a site added as "http://example.com/".
 */
export function sameSiteUrl(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const p = (u: URL) => (u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname);
    return x.protocol === y.protocol && x.hostname.toLowerCase() === y.hostname.toLowerCase() && x.port === y.port && p(x) === p(y);
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------------- sites

/** AddSite: adds a site to the connected Bing user's list (unverified until VerifySite succeeds). */
export async function addSite(bing: BingClient, siteUrl: string): Promise<void> {
  await bing.send("AddSite", { siteUrl }, { site: false });
}

/** VerifySite: asks Bing to check the site's verification code now. Returns Bing's answer, null if it sent no boolean. */
export async function verifySite(bing: BingClient, siteUrl: string): Promise<boolean | null> {
  return bool(await bing.send("VerifySite", { siteUrl }, { site: false }));
}

/** RemoveSite: removes the client's own site from the connected Bing user's list. */
export async function removeSite(bing: BingClient): Promise<void> {
  await bing.send("RemoveSite");
}

// -------------------------------------------------------------------------------------------------- site roles

export const USER_ROLES = ["Administrator", "ReadOnly", "ReadWrite"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** SiteRoles.UserRole from the JSON number (0, 1, 2) or the name; anything else is null. */
export function userRole(v: unknown): UserRole | null {
  const n = num(v);
  if (n !== null && Number.isInteger(n) && n >= 0 && n < USER_ROLES.length) return USER_ROLES[n]!;
  return typeof v === "string" && (USER_ROLES as readonly string[]).includes(v) ? (v as UserRole) : null;
}

export interface SiteRole {
  /** The site (or subdomain) access was given to. */
  site: string;
  /** The verified site the access was given through. */
  verificationSite: string | null;
  email: string;
  role: UserRole | null;
  date: string | null;
  expired: boolean | null;
  /** The entry exactly as Bing returned it: RemoveSiteRole takes it back unchanged. Never returned to callers. */
  raw: Row;
}

export function parseSiteRoles(d: unknown): SiteRole[] {
  return asList(d, "the site's users")
    .filter((r) => typeof r.Email === "string" && typeof r.Site === "string")
    .map((r) => ({ site: r.Site as string, verificationSite: str(r.VerificationSite), email: r.Email as string, role: userRole(r.Role), date: bingDate(r.Date), expired: bool(r.Expired), raw: r }));
}

/** GetSiteRoles: users with access to the site (and, with includeAllSubdomains, to its subdomains). */
export async function getSiteRoles(bing: BingClient, includeAllSubdomains: boolean): Promise<SiteRole[]> {
  return parseSiteRoles(await bing.read("GetSiteRoles", { includeAllSubdomains }));
}

/**
 * AddSiteRoles. The reference describes none of the parameters; the reading used (recorded in VERIFICATION.md):
 * delegatedUrl is the site or subdomain access is given to (sample: host1.example.com under example.com), authenticationCode is
 * the verified site's AuthenticationCode from GetUserSites (the sample's value equals GetUserSites' sample code), and the two
 * booleans select SiteRoles.UserRole: Administrator = (true, false), ReadOnly = (false, true), ReadWrite = (false, false).
 */
export const ROLE_FLAGS: Record<UserRole, { isAdministrator: boolean; isReadOnly: boolean }> = {
  Administrator: { isAdministrator: true, isReadOnly: false },
  ReadOnly: { isAdministrator: false, isReadOnly: true },
  ReadWrite: { isAdministrator: false, isReadOnly: false },
};
export async function addSiteRoles(bing: BingClient, o: { delegatedUrl: string; userEmail: string; authenticationCode: string; role: UserRole }): Promise<void> {
  await bing.send("AddSiteRoles", { delegatedUrl: o.delegatedUrl, userEmail: o.userEmail, authenticationCode: o.authenticationCode, ...ROLE_FLAGS[o.role] });
}

/** RemoveSiteRole: sends the SiteRoles entry back exactly as GetSiteRoles returned it (as the documented sample does). */
export async function removeSiteRole(bing: BingClient, role: SiteRole): Promise<void> {
  await bing.send("RemoveSiteRole", { siteRole: role.raw });
}

// -------------------------------------------------------------------------------------------------- site moves

export const MOVE_SCOPES = ["Domain", "Host", "Directory"] as const;
export type MoveScope = (typeof MOVE_SCOPES)[number];
export const MOVE_TYPES = ["Local", "Global"] as const;
export type MoveType = (typeof MOVE_TYPES)[number];

const enumOf = <T extends string>(names: readonly T[], v: unknown): T | null => {
  const n = num(v);
  if (n !== null && Number.isInteger(n) && n >= 0 && n < names.length) return names[n]!;
  return typeof v === "string" && (names as readonly string[]).includes(v) ? (v as T) : null;
};

export interface SiteMove {
  sourceUrl: string;
  targetUrl: string;
  scope: MoveScope | null;
  type: MoveType | null;
  date: string | null;
}

export function parseSiteMoves(d: unknown): SiteMove[] {
  return asList(d, "the site moves")
    .filter((r) => typeof r.SourceUrl === "string" && typeof r.TargetUrl === "string")
    .map((r) => ({ sourceUrl: r.SourceUrl as string, targetUrl: r.TargetUrl as string, scope: enumOf(MOVE_SCOPES, r.MoveScope), type: enumOf(MOVE_TYPES, r.MoveType), date: bingDate(r.Date) }));
}

/** GetSiteMoves: the moves submitted for the site. */
export async function getSiteMoves(bing: BingClient): Promise<SiteMove[]> {
  return parseSiteMoves(await bing.read("GetSiteMoves"));
}

/**
 * SubmitSiteMove. Enum values are sent as their documented numbers (WCF JSON serializes enums as numbers, as the SiteRoles
 * JSON sample shows for Role). Date is a non-nullable DateTime in the contract; the submission time is sent.
 */
export async function submitSiteMove(bing: BingClient, m: { sourceUrl: string; targetUrl: string; scope: MoveScope; type: MoveType }, now = Date.now()): Promise<void> {
  if (!Number.isFinite(now)) throw new ToolError("internal", "Invalid clock.");
  await bing.send("SubmitSiteMove", {
    settings: { Date: `/Date(${now})/`, MoveScope: MOVE_SCOPES.indexOf(m.scope), MoveType: MOVE_TYPES.indexOf(m.type), SourceUrl: m.sourceUrl, TargetUrl: m.targetUrl },
  });
}
