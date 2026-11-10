import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { createVerifier } from "../../mcp/pipeline";
import { riskOf } from "../../mcp/tool";
import { parseSiteMoves, parseSiteRoles, sameSiteUrl, userRole } from "../../platforms/bing/api/sites";
import { sitesTools } from "../../platforms/bing/tools/sites";
import { type BingHarness, FakeBing, SITE, SITE2, bingErr, bingHarness, guardProtocol } from "./fake-bing";

/**
 * Sites and access against a stand-in for Bing's documented JSON shapes (method pages fetched 2026-11-10): GetSiteRoles'
 * JSON sample (Role as a number, WCF dates, __type), AddSite / RemoveSite / AddSiteRoles / RemoveSiteRole answering
 * {"d": null}, VerifySite answering {"d": true|false}. GetSiteMoves / SubmitSiteMove have no samples; the fake follows the
 * SiteMoveSettings contract with enums as numbers.
 */
const fake = new FakeBing();
guardProtocol(fake);
let kit: BingHarness;

const ROLE_TYPE = "SiteRoles:#Microsoft.Bing.Webmaster.Api";
const wcf = (iso: string) => `/Date(${Date.parse(iso)}-0700)/`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const role = (o: { email: string; site?: string; role?: number; expired?: boolean; date?: string }) => ({
  __type: ROLE_TYPE,
  Date: wcf(o.date ?? "2026-10-01T10:00:00Z"),
  DelegatedCode: "DELEGATEDCODE9",
  DelegatedCodeOwnerEmail: "owner@example.com",
  DelegatorEmail: "owner@example.com",
  Email: o.email,
  Expired: o.expired ?? false,
  Role: o.role ?? 2,
  Site: o.site ?? "https://www.example.com",
  VerificationSite: "https://www.example.com",
});
const move = (o: { from: string; to: string; scope?: number; type?: number; date?: string }) => ({
  __type: "SiteMoveSettings:#Microsoft.Bing.Webmaster.Api",
  Date: wcf(o.date ?? daysAgo(10)),
  MoveScope: o.scope ?? 2,
  MoveType: o.type ?? 0,
  SourceUrl: o.from,
  TargetUrl: o.to,
});

/** Mutable upstream state behind the fake's handlers. */
let state: { roles: Record<string, unknown>[]; moves: Record<string, unknown>[]; verifyAnswer: boolean; verifyWorks: boolean; ignoreWrites: boolean };

function install() {
  state = { roles: [role({ email: "Analyst@Example.com", role: 1 }), role({ email: "dev@example.com", site: "https://blog.www.example.com", role: 0 })], moves: [], verifyAnswer: true, verifyWorks: true, ignoreWrites: false };
  const siteOf = (c: { body?: Record<string, any> }) => c.body?.siteUrl as string;
  fake.handlers.AddSite = (c, f) => {
    if (!state.ignoreWrites) f.sites.push({ Url: siteOf(c).replace(/\/$/, ""), IsVerified: false, AuthenticationCode: "NEWCODE", DnsVerificationCode: "newcode.example.net" });
    return undefined;
  };
  fake.handlers.VerifySite = (c, f) => {
    const s = f.sites.find((x) => x.Url === siteOf(c));
    if (!s) return bingErr(14, "NotAuthorized");
    if (state.verifyWorks) s.IsVerified = true;
    return state.verifyAnswer;
  };
  fake.handlers.RemoveSite = (c, f) => {
    if (!state.ignoreWrites) f.sites = f.sites.filter((s) => s.Url !== siteOf(c));
    return undefined;
  };
  fake.handlers.GetSiteRoles = () => state.roles;
  fake.handlers.AddSiteRoles = (c) => {
    const b = c.body!;
    if (!state.ignoreWrites) state.roles.push(role({ email: b.userEmail, site: b.delegatedUrl, role: b.isAdministrator ? 0 : b.isReadOnly ? 1 : 2, date: "2026-11-10T00:00:00Z" }));
    return undefined;
  };
  fake.handlers.RemoveSiteRole = (c) => {
    const r = c.body!.siteRole;
    if (!state.ignoreWrites) state.roles = state.roles.filter((x) => !(x.Email === r.Email && x.Site === r.Site));
    return undefined;
  };
  fake.handlers.GetSiteMoves = () => state.moves;
  fake.handlers.SubmitSiteMove = (c) => {
    if (!state.ignoreWrites) state.moves.push({ __type: "SiteMoveSettings:#Microsoft.Bing.Webmaster.Api", ...c.body!.settings });
    return undefined;
  };
}

// One workspace for the file: identical requests are deduplicated by the approval service, so each test uses its own arguments.
let n = 0;
beforeAll(async () => {
  fake.reset();
  kit = await bingHarness("BSITES", fake, sitesTools);
});
beforeEach(() => {
  fake.reset();
  install();
  n++;
});

const verify = (tool: string, args: Record<string, unknown>, snapshot: unknown = {}, accountId = kit.accountId) =>
  createVerifier(kit.deps)({ tool, tenantId: kit.tenantId, accountId, args: { account_id: accountId, ...args }, planSnapshot: snapshot, requestedBy: kit.owner, decidedBy: kit.second });
const approve = async (r: Awaited<ReturnType<BingHarness["run"]>>, by = kit.owner) => {
  expect(r.error, JSON.stringify(r.error)).toBeUndefined();
  expect(fake.mutations).toHaveLength(0); // nothing is sent before approval
  return kit.approveAs(r.approval!.approval_id, by);
};
const posts = () => fake.mutations.map((c) => c.method);

// ----------------------------------------------------------------------------------------------------- parsing
describe("Bing sites API parsing", () => {
  it("reads roles from numbers or names, dates in WCF form, and keeps the raw entry", () => {
    const [r] = parseSiteRoles([role({ email: "a@example.com", role: 0 })]);
    expect(r).toMatchObject({ email: "a@example.com", role: "Administrator", site: "https://www.example.com", date: "2026-10-01T10:00:00.000Z", expired: false });
    expect(r!.raw.__type).toBe(ROLE_TYPE);
    expect([0, 1, 2, "ReadWrite", 3, "Owner", null].map(userRole)).toEqual(["Administrator", "ReadOnly", "ReadWrite", "ReadWrite", null, null, null]);
    expect(parseSiteRoles(null)).toEqual([]);
    expect(() => parseSiteRoles({})).toThrow(/unexpected shape/);
  });

  it("reads site moves with enum numbers or names", () => {
    expect(parseSiteMoves([move({ from: "a", to: "b", scope: 0, type: 1 }), { SourceUrl: "c", TargetUrl: "d", MoveScope: "Host", MoveType: "Local", Date: "x" }])).toEqual([
      { sourceUrl: "a", targetUrl: "b", scope: "Domain", type: "Global", date: expect.any(String) },
      { sourceUrl: "c", targetUrl: "d", scope: "Host", type: "Local", date: null },
    ]);
  });

  it("compares site URLs ignoring host case and a trailing slash only", () => {
    expect(sameSiteUrl("http://Example.com", "http://example.com/")).toBe(true);
    expect(sameSiteUrl("https://example.com/", "http://example.com/")).toBe(false);
    expect(sameSiteUrl("https://example.com/A/", "https://example.com/a/")).toBe(false);
    expect(sameSiteUrl("not a url", "not a url")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------- list_bing_sites
describe("list_bing_sites", () => {
  it("lists every site of the Bing user with verification codes and marks this account", async () => {
    fake.sites.push({ Url: "http://unverified.example.org", IsVerified: false, AuthenticationCode: "C0DE", DnsVerificationCode: "c0de.unverified.example.org" });
    const r = await kit.run("list_bing_sites");
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d.sites.map((s: any) => s.site_url)).toEqual(["http://unverified.example.org", "https://ro.example.com/", "https://shop.example.com/", SITE]);
    expect(d.sites[0]).toEqual({ site_url: "http://unverified.example.org", verified: false, is_this_account: false, authentication_code: "C0DE", dns_verification_code: "c0de.unverified.example.org" });
    expect(d.sites[3]).toMatchObject({ verified: true, is_this_account: true, authentication_code: "AUTHCODE1" });
    expect(d).toMatchObject({ returned: 4, total: 4, truncated: false });
    expect(d.note).toContain("what the site owner places on the site");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ method: "GetUserSites", http: "GET" });
    expect(fake.calls[0]!.params.has("siteUrl")).toBe(false);
  });

  it("says when the list is cut, and maps a rejected token", async () => {
    let r = await kit.run("list_bing_sites", { limit: 2 });
    expect(r.data).toMatchObject({ returned: 2, total: 3, truncated: true });
    fake.fail = () => bingErr(3, "InvalidApiKey");
    r = await kit.run("list_bing_sites");
    expect(r.error).toMatchObject({ code: "auth_expired" });
  });

  it("works on a read-only connection", async () => {
    const r = await kit.run("list_bing_sites", { account_id: kit.readOnlyId });
    expect((r.data as any).sites.find((s: any) => s.is_this_account).site_url).toBe("https://ro.example.com/");
  });
});

// ------------------------------------------------------------------------------------------------ add_bing_site
describe("add_bing_site", () => {
  it("after approval sends AddSite for the new site only and returns its codes, unverified", async () => {
    const r = await kit.run("add_bing_site", { account_id: kit.site2Id, site_url: "https://new.example.net/" });
    expect(r.approval).toMatchObject({ risk: "write" });
    expect(r.approval!.summary).toContain(`Add https://new.example.net/ to the Bing Webmaster Tools sites of the Bing user connected through ${SITE2}`);
    expect(r.approval!.summary).toContain("starts unverified");
    const done = await approve(r);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([["AddSite", { siteUrl: "https://new.example.net/" }]]);
    // Bing spelled it without the trailing slash: still found by the read-back.
    expect(done.result).toMatchObject({ site_url: "https://new.example.net", verified: false, authentication_code: "NEWCODE", dns_verification_code: "newcode.example.net" });
    expect((done.result as any).next_steps).toContain("verify_bing_site");
  });

  it("refuses a site already in the list (any trailing slash or host case) and malformed URLs", async () => {
    let r = await kit.run("add_bing_site", { site_url: "https://SHOP.example.com" });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    expect(r.error!.message).toContain("already in this Bing user's sites (verified)");
    for (const bad of ["ftp://x.example/", "https://x.example/?a=1", "x.example", "https://x.example/#f"]) {
      r = await kit.run("add_bing_site", { site_url: bad });
      expect(r.error?.code, bad).toBe("invalid_argument");
    }
    expect(fake.mutations).toHaveLength(0);
  });

  it("a read-only connection cannot request it", async () => {
    const r = await kit.run("add_bing_site", { account_id: kit.readOnlyId, site_url: "https://new.example.net/" });
    expect(r.error?.code).toBe("permission_denied");
  });

  it("a site added between request and approval is refused when re-planned; nothing is sent", async () => {
    const r = await kit.run("add_bing_site", { site_url: "https://late.example.net/" });
    fake.sites.push({ Url: "https://late.example.net/", IsVerified: false });
    const done = await approve(r);
    expect(done.status).toBe("failed");
    expect(fake.mutations).toHaveLength(0);
  });

  it("a site that does not read back is an unknown outcome; a server error is too, sent once", async () => {
    let r = await kit.run("add_bing_site", { site_url: "https://a.example.net/" });
    state.ignoreWrites = true;
    expect((await approve(r)).status).toBe("unknown_outcome");
    fake.reset();
    install();
    r = await kit.run("add_bing_site", { site_url: "https://b.example.net/" });
    fake.handlers.AddSite = () => bingErr(1, "InternalError", 500);
    expect((await approve(r)).status).toBe("unknown_outcome");
    expect(posts()).toEqual(["AddSite"]);
  });

  it("verify: applied when listed, not_applied when not", async () => {
    expect(await verify("add_bing_site", { site_url: "https://v.example.net/" })).toEqual({ outcome: "not_applied" });
    fake.sites.push({ Url: "https://v.example.net", IsVerified: false });
    expect(await verify("add_bing_site", { site_url: "https://v.example.net/" })).toEqual({ outcome: "applied" });
  });
});

// --------------------------------------------------------------------------------------------- verify_bing_site
describe("verify_bing_site", () => {
  let U = "";
  beforeEach(() => {
    U = `http://pending${n}.example.org`;
    fake.sites.push({ Url: U, IsVerified: false, AuthenticationCode: "PEND" });
  });

  it("verifies an unverified site of the user (named through any site) and reads it back", async () => {
    const r = await kit.run("verify_bing_site", { site_url: `${U}/` });
    expect(r.approval).toMatchObject({ risk: "write" });
    expect(r.approval!.summary).toContain(`Ask Bing to verify ownership of ${U}`);
    const done = await approve(r);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([["VerifySite", { siteUrl: U }]]);
    expect(done.result).toMatchObject({ site_url: U, verified: true, bing_answer: true });
    expect((done.result as any).next_steps).toContain("Refresh Bing Webmaster on the Connections page");
  });

  it("when Bing cannot find the code, reports it unverified with what to do", async () => {
    state.verifyWorks = false;
    state.verifyAnswer = false;
    const done = await approve(await kit.run("verify_bing_site", { site_url: U }));
    expect(done.status).toBe("executed");
    expect(done.result).toMatchObject({ verified: false, bing_answer: false });
    expect((done.result as any).next_steps).toContain("did not find the verification code");
  });

  it("Bing answering true while its list still says unverified is an unknown outcome", async () => {
    state.verifyWorks = false;
    expect((await approve(await kit.run("verify_bing_site", { site_url: U }))).status).toBe("unknown_outcome");
  });

  it("refuses a site not in the list and one already verified", async () => {
    let r = await kit.run("verify_bing_site", { site_url: "https://nope.example.org/" });
    expect(r.error?.code).toBe("invalid_argument");
    expect(r.error!.message).toContain("add_bing_site");
    r = await kit.run("verify_bing_site", { site_url: SITE2 });
    expect(r.error!.message).toContain("already verified");
    expect(fake.mutations).toHaveLength(0);
  });

  it("Bing's NotAuthorized is a definite failure", async () => {
    const r = await kit.run("verify_bing_site", { site_url: U });
    fake.handlers.VerifySite = () => bingErr(14, "NotAuthorized");
    const done = await approve(r);
    expect(done.status).toBe("failed");
    expect((done.result as any).error.code).toBe("platform_permission_denied");
  });

  it("verify: applied once verified, not_applied before, indeterminate when the site is gone", async () => {
    expect(await verify("verify_bing_site", { site_url: U })).toEqual({ outcome: "not_applied" });
    fake.sites.find((s) => s.Url === U)!.IsVerified = true;
    expect(await verify("verify_bing_site", { site_url: U })).toEqual({ outcome: "applied" });
    fake.sites = fake.sites.filter((s) => s.Url !== U);
    expect((await verify("verify_bing_site", { site_url: U })).outcome).toBe("indeterminate");
  });
});

// --------------------------------------------------------------------------------------------- remove_bing_site
describe("remove_bing_site", () => {
  it("is destructive, needs the exact confirmation, then RemoveSite and a read-back", async () => {
    let r = await kit.run("remove_bing_site", { account_id: kit.site2Id, confirm_site_url: "https://shop.example.com" });
    expect(r.error?.code).toBe("invalid_argument");
    r = await kit.run("remove_bing_site", { account_id: kit.site2Id, confirm_site_url: SITE2 });
    expect(r.approval).toMatchObject({ risk: "destructive" });
    expect(r.approval!.summary).toContain(`Remove ${SITE2} from the Bing Webmaster Tools sites of the connected Bing user`);
    expect(r.approval!.summary).toContain("does not say what this does");
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ effect: "remove", before: "verified", after: null });
    const done = await approve(r, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([["RemoveSite", { siteUrl: SITE2 }]]);
    expect(done.result).toMatchObject({ site_url: SITE2, removed: true });
  });

  it("a site gone before approval fails without sending; still listed after RemoveSite is unknown", async () => {
    let r = await kit.run("remove_bing_site", { confirm_site_url: SITE });
    fake.sites = fake.sites.filter((s) => s.Url !== SITE);
    let done = await approve(r, kit.second);
    expect(done.status).toBe("failed");
    expect(fake.mutations).toHaveLength(0);
    fake.reset();
    install();
    r = await kit.run("remove_bing_site", { confirm_site_url: SITE });
    state.ignoreWrites = true;
    done = await approve(r, kit.second);
    expect(done.status).toBe("unknown_outcome");
  });

  it("verify: applied when gone, not_applied when present", async () => {
    expect(await verify("remove_bing_site", { confirm_site_url: SITE })).toEqual({ outcome: "not_applied" });
    fake.sites = fake.sites.filter((s) => s.Url !== SITE);
    expect(await verify("remove_bing_site", { confirm_site_url: SITE })).toEqual({ outcome: "applied" });
  });
});

// ----------------------------------------------------------------------------------------- list_bing_site_users
describe("list_bing_site_users", () => {
  it("lists users with role, site and dates, never the delegated code or other people's addresses", async () => {
    const r = await kit.run("list_bing_site_users");
    const d = r.data as any;
    expect(d.users).toEqual([
      { email: "dev@example.com", role: "Administrator", site: "https://blog.www.example.com", verification_site: "https://www.example.com", added: "2026-10-01T10:00:00.000Z", expired: false },
      { email: "Analyst@Example.com", role: "ReadOnly", site: "https://www.example.com", verification_site: "https://www.example.com", added: "2026-10-01T10:00:00.000Z", expired: false },
    ]);
    expect(JSON.stringify(d)).not.toContain("DELEGATEDCODE9");
    expect(JSON.stringify(d)).not.toContain("owner@example.com");
    expect(fake.calls[0]).toMatchObject({ method: "GetSiteRoles", http: "GET" });
    expect(Object.fromEntries(fake.calls[0]!.params)).toEqual({ siteUrl: SITE, includeAllSubdomains: "false" });
  });

  it("passes include_all_subdomains, cuts honestly and maps errors", async () => {
    let r = await kit.run("list_bing_site_users", { include_all_subdomains: true, limit: 1 });
    expect(fake.calls[0]!.params.get("includeAllSubdomains")).toBe("true");
    expect(r.data).toMatchObject({ returned: 1, total: 2, truncated: true });
    fake.handlers.GetSiteRoles = () => bingErr(14, "NotAuthorized");
    r = await kit.run("list_bing_site_users");
    expect(r.error?.code).toBe("platform_permission_denied");
  });
});

// ------------------------------------------------------------------------------------------ add_bing_site_user
describe("add_bing_site_user", () => {
  it("is high impact, says the person gets access to the site's Bing data, and sends the documented parameters", async () => {
    const r = await kit.run("add_bing_site_user", { user_email: "new.person@example.org", role: "read_only" });
    expect(r.approval).toMatchObject({ risk: "high_impact" });
    expect(r.approval!.summary).toContain(`Give new.person@example.org read-only (ReadOnly) access to the Bing Webmaster Tools data of ${SITE}`);
    expect(r.approval!.summary).toContain("This person gets access to the site's Bing data");
    expect(r.approval!.summary).not.toContain("AUTHCODE1");
    expect(JSON.stringify(r.approval)).not.toContain("AUTHCODE1");
    const done = await approve(r);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([
      ["AddSiteRoles", { siteUrl: SITE, delegatedUrl: SITE, userEmail: "new.person@example.org", authenticationCode: "AUTHCODE1", isAdministrator: false, isReadOnly: true }],
    ]);
    expect(done.result).toMatchObject({ user_email: "new.person@example.org", role: "ReadOnly", site: SITE });
  });

  it("maps each role to the two booleans and can give access to a subdomain", async () => {
    for (const [arg, flags] of [["administrator", [true, false]], ["read_write", [false, false]]] as const) {
      fake.reset();
      install();
      const r = await kit.run("add_bing_site_user", { user_email: `${arg}@example.org`, role: arg, delegated_url: "https://sub.www.example.com/" });
      expect(r.approval!.summary).toContain("(a subdomain of https://www.example.com/)");
      expect(r.approval!.summary).toContain("change the site's Bing settings");
      const done = await approve(r);
      expect(done.status).toBe("executed");
      expect([fake.mutations[0]!.body!.isAdministrator, fake.mutations[0]!.body!.isReadOnly]).toEqual(flags);
      expect(fake.mutations[0]!.body!.delegatedUrl).toBe("https://sub.www.example.com/");
    }
  });

  it("refuses someone who already has access (any letter case), a URL outside the site, and a site without a code", async () => {
    let r = await kit.run("add_bing_site_user", { user_email: "analyst@example.com", role: "read_write" });
    expect(r.error?.code).toBe("invalid_argument");
    expect(r.error!.message).toContain("already has read-only access");
    r = await kit.run("add_bing_site_user", { user_email: "x@example.org", role: "read_only", delegated_url: "https://other.example.org/" });
    expect(r.error!.message).toContain("neither the site");
    r = await kit.run("add_bing_site_user", { user_email: "x@example.org", role: "read_only", delegated_url: "https://www.example.com/dir/" });
    expect(r.error?.code).toBe("invalid_argument");
    r = await kit.run("add_bing_site_user", { account_id: kit.site2Id, user_email: "x@example.org", role: "read_only" });
    expect(r.error?.code).toBe("unsupported");
    r = await kit.run("add_bing_site_user", { user_email: "not-an-email", role: "read_only" });
    expect(r.error?.code).toBe("invalid_argument");
    expect(fake.mutations).toHaveLength(0);
  });

  it("an expired entry does not block giving access again", async () => {
    state.roles.push(role({ email: "old@example.org", site: SITE, expired: true }));
    const r = await kit.run("add_bing_site_user", { user_email: "old@example.org", role: "read_only" });
    expect(r.approval).toBeDefined();
  });

  it("access given by someone else between request and approval is refused; nothing is sent", async () => {
    const r = await kit.run("add_bing_site_user", { user_email: "race@example.org", role: "read_only" });
    state.roles.push(role({ email: "race@example.org", site: SITE, role: 1 }));
    const done = await approve(r);
    expect(done.status).toBe("failed");
    expect(fake.mutations).toHaveLength(0);
  });

  it("a read-only connection cannot request it; no read-back is an unknown outcome", async () => {
    let r = await kit.run("add_bing_site_user", { account_id: kit.readOnlyId, user_email: "x@example.org", role: "read_only" });
    expect(r.error?.code).toBe("permission_denied");
    r = await kit.run("add_bing_site_user", { user_email: "ghost@example.org", role: "read_only" });
    state.ignoreWrites = true;
    expect((await approve(r)).status).toBe("unknown_outcome");
    expect(posts()).toEqual(["AddSiteRoles"]);
  });

  it("verify: applied with the role, indeterminate with another, not_applied without", async () => {
    const args = { user_email: "v@example.org", role: "read_write" };
    expect(await verify("add_bing_site_user", args)).toEqual({ outcome: "not_applied" });
    state.roles.push(role({ email: "V@example.org", site: SITE, role: 1 }));
    expect((await verify("add_bing_site_user", args)).outcome).toBe("indeterminate");
    state.roles[state.roles.length - 1]!.Role = 2;
    expect(await verify("add_bing_site_user", args)).toEqual({ outcome: "applied" });
  });
});

// --------------------------------------------------------------------------------------- remove_bing_site_user
describe("remove_bing_site_user", () => {
  it("is destructive and sends the SiteRoles entry back exactly as Bing listed it", async () => {
    const r = await kit.run("remove_bing_site_user", { user_email: "analyst@example.com" });
    expect(r.approval).toMatchObject({ risk: "destructive" });
    expect(r.approval!.summary).toContain("Remove Analyst@Example.com's read-only access to the Bing Webmaster Tools data of https://www.example.com");
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ effect: "remove", before: "ReadOnly", after: null });
    expect(JSON.stringify(r.approval)).not.toContain("DELEGATEDCODE9");
    const done = await approve(r, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => c.method)).toEqual(["RemoveSiteRole"]);
    expect(fake.mutations[0]!.body).toEqual({ siteUrl: SITE, siteRole: role({ email: "Analyst@Example.com", role: 1 }) });
    expect(done.result).toEqual({ user_email: "Analyst@Example.com", site: "https://www.example.com", removed: true });
  });

  it("refuses someone without access, and asks which site when the person has several", async () => {
    let r = await kit.run("remove_bing_site_user", { user_email: "nobody@example.org" });
    expect(r.error?.code).toBe("not_found");
    state.roles.push(role({ email: "dev@example.com", site: "https://www.example.com" }));
    r = await kit.run("remove_bing_site_user", { user_email: "dev@example.com" });
    expect(r.error?.code).toBe("invalid_argument");
    expect(r.error!.message).toContain("Say which with delegated_url");
    r = await kit.run("remove_bing_site_user", { user_email: "dev@example.com", delegated_url: "https://blog.www.example.com/" });
    expect(r.approval).toBeDefined();
    expect(fake.mutations).toHaveLength(0);
  });

  it("a role changed between request and approval is refused; still present after the call is unknown", async () => {
    let r = await kit.run("remove_bing_site_user", { user_email: "dev@example.com" });
    state.roles[1]!.Role = 1;
    let done = await approve(r, kit.second);
    expect(done.status).toBe("failed");
    expect(fake.mutations).toHaveLength(0);
    fake.reset();
    install();
    state.roles.push(role({ email: "gone@example.org", site: SITE }));
    r = await kit.run("remove_bing_site_user", { user_email: "gone@example.org" });
    state.ignoreWrites = true;
    done = await approve(r, kit.second);
    expect(done.status).toBe("unknown_outcome");
  });

  it("verify: applied when gone, not_applied when present", async () => {
    const snap = { site: "https://www.example.com" };
    expect(await verify("remove_bing_site_user", { user_email: "analyst@example.com" }, snap)).toEqual({ outcome: "not_applied" });
    state.roles = state.roles.slice(1);
    expect(await verify("remove_bing_site_user", { user_email: "analyst@example.com" }, snap)).toEqual({ outcome: "applied" });
  });
});

// ------------------------------------------------------------------------------------------ get_bing_site_moves
describe("get_bing_site_moves", () => {
  it("lists moves newest first with the scope and type in words", async () => {
    state.moves = [move({ from: "https://www.example.com/old/", to: "https://www.example.com/new/", date: "2026-01-01T00:00:00Z" }), move({ from: "https://www.example.com/", to: "https://shop.example.com/", scope: 1, type: 1, date: "2026-06-01T00:00:00Z" })];
    const r = await kit.run("get_bing_site_moves");
    const d = r.data as any;
    expect(d.moves).toEqual([
      { source_url: "https://www.example.com/", target_url: "https://shop.example.com/", scope: "Host", type: "Global", meaning: "a whole host (subdomain), moved to another verified site", submitted: "2026-06-01T00:00:00.000Z" },
      { source_url: "https://www.example.com/old/", target_url: "https://www.example.com/new/", scope: "Directory", type: "Local", meaning: "a directory, moved within the same site", submitted: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(d).toMatchObject({ returned: 2, total: 2, truncated: false });
    expect(d.note).toContain("no descriptions");
    expect(Object.fromEntries(fake.calls[0]!.params)).toEqual({ siteUrl: SITE });
  });

  it("an empty list and an upstream error", async () => {
    let r = await kit.run("get_bing_site_moves");
    expect(r.data).toMatchObject({ moves: [], returned: 0, total: 0 });
    fake.handlers.GetSiteMoves = () => bingErr(4, "ThrottleUser");
    r = await kit.run("get_bing_site_moves");
    expect(r.error?.code).toBe("quota_exceeded");
  });
});

// ---------------------------------------------------------------------------------------- submit_bing_site_move
describe("submit_bing_site_move", () => {
  const global = { source_url: SITE, target_url: SITE2, move_type: "global", move_scope: "host" };
  /** The same move to a fresh verified site of the user, so each request is distinct. */
  const moveTo = (label: string) => {
    fake.sites.push({ Url: `https://${label}.example.net/`, IsVerified: true });
    return { ...global, target_url: `https://${label}.example.net/` };
  };

  it("is destructive, spells out that Bing treats the old site as moved, and sends SiteMoveSettings with enum numbers", async () => {
    const r = await kit.run("submit_bing_site_move", global);
    expect(r.approval).toMatchObject({ risk: "destructive" });
    const s = r.approval!.summary;
    expect(s).toContain(`Tell Bing that a whole host (subdomain) ${SITE} has permanently moved to ${SITE2} (Global Host move to the verified site ${SITE2})`);
    expect(s).toContain("Bing will treat the old location as moved");
    expect(s).toContain("301");
    expect(s).toContain("180 days");
    const done = await approve(r, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => c.method)).toEqual(["SubmitSiteMove"]);
    const body = fake.mutations[0]!.body!;
    expect(body).toEqual({ siteUrl: SITE, settings: { Date: expect.stringMatching(/^\/Date\(\d+\)\/$/), MoveScope: 1, MoveType: 1, SourceUrl: SITE, TargetUrl: SITE2 } });
    expect(done.result).toMatchObject({ source_url: SITE, target_url: SITE2, move_type: "Global", move_scope: "Host", listed: true });
  });

  it("a local directory move stays inside the site", async () => {
    const r = await kit.run("submit_bing_site_move", { source_url: `${SITE}old/`, target_url: `${SITE}new/`, move_type: "local", move_scope: "directory" });
    const done = await approve(r, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations[0]!.body!.settings).toMatchObject({ MoveScope: 2, MoveType: 0 });
  });

  it("refuses unless both sites are the user's and verified, and moves that do not fit the scope or type", async () => {
    const refuse = async (args: Record<string, unknown>, text: string) => {
      const r = await kit.run("submit_bing_site_move", { ...global, ...args });
      expect(r.error?.code, text).toBe("invalid_argument");
      expect(r.error!.message).toContain(text);
    };
    await refuse({ target_url: "https://elsewhere.example.org/" }, "not in any of the connected Bing user's sites");
    fake.sites.push({ Url: "https://unv.example.org", IsVerified: false });
    await refuse({ target_url: "https://unv.example.org/" }, "is not verified");
    await refuse({ source_url: "https://other.example.org/" }, "is not inside the Bing site");
    await refuse({ move_type: "local", source_url: `${SITE}a/`, target_url: `${SITE}b/` }, "can only be a directory move");
    await refuse({ move_type: "local", move_scope: "directory", source_url: `${SITE}a/`, target_url: `${SITE2}b/` }, "is not inside");
    await refuse({ move_scope: "directory", source_url: `${SITE}a/`, target_url: `${SITE}b/` }, "is inside https://www.example.com/ itself");
    await refuse({ move_scope: "directory", source_url: `${SITE}a`, target_url: `${SITE2}b/` }, "ending in /");
    await refuse({ source_url: `${SITE}a/` }, "goes from a root URL");
    await refuse({ target_url: SITE }, "the same location");
    await refuse({ target_url: `${SITE2}?x=1` }, "remove the ?query");
    fake.sites.find((s) => s.Url === SITE)!.IsVerified = false;
    await refuse({}, "is not a verified site");
    expect(fake.mutations).toHaveLength(0);
  });

  it("refuses a move overlapping one from the last 180 days; an older one does not block", async () => {
    state.moves = [move({ from: "https://x.example.org/", to: SITE2, date: daysAgo(30) })];
    let r = await kit.run("submit_bing_site_move", global);
    expect(r.error?.code).toBe("invalid_argument");
    expect(r.error!.message).toContain("at least 180 days");
    state.moves = [move({ from: SITE, to: "https://x.example.org/", date: daysAgo(200) })];
    r = await kit.run("submit_bing_site_move", moveTo("old-move"));
    expect(r.approval).toBeDefined();
  });

  it("the target losing verification before approval is refused; nothing is sent", async () => {
    const args = moveTo("drift");
    const r = await kit.run("submit_bing_site_move", args);
    fake.sites.find((s) => s.Url === args.target_url)!.IsVerified = false;
    const done = await approve(r, kit.second);
    expect(done.status).toBe("failed");
    expect(fake.mutations).toHaveLength(0);
  });

  it("not listed after the call is unknown; Bing's NotAllowed is a definite failure; read-only cannot request", async () => {
    let r = await kit.run("submit_bing_site_move", moveTo("unknown"));
    state.ignoreWrites = true;
    expect((await approve(r, kit.second)).status).toBe("unknown_outcome");
    fake.reset();
    install();
    r = await kit.run("submit_bing_site_move", moveTo("notallowed"));
    fake.handlers.SubmitSiteMove = () => bingErr(13, "NotAllowed");
    const done = await approve(r, kit.second);
    expect(done.status).toBe("failed");
    expect((done.result as any).error.code).toBe("platform_permission_denied");
    r = await kit.run("submit_bing_site_move", { ...global, account_id: kit.readOnlyId, source_url: "https://ro.example.com/" });
    expect(r.error?.code).toBe("permission_denied");
  });

  it("verify: applied when Bing lists the move, not_applied when not", async () => {
    expect(await verify("submit_bing_site_move", global)).toEqual({ outcome: "not_applied" });
    state.moves = [move({ from: "https://www.example.com", to: "https://shop.example.com", scope: 1, type: 1 })];
    expect(await verify("submit_bing_site_move", global)).toEqual({ outcome: "applied" });
  });
});

// ---------------------------------------------------------------------------------------------------- registry
describe("Bing sites and access tools", () => {
  const TIERS: Record<string, string> = {
    list_bing_sites: "read",
    add_bing_site: "write",
    verify_bing_site: "write",
    remove_bing_site: "destructive",
    list_bing_site_users: "read",
    add_bing_site_user: "high_impact",
    remove_bing_site_user: "destructive",
    get_bing_site_moves: "read",
    submit_bing_site_move: "destructive",
  };
  it("are the section's 9 tools, registered, with the inventory's risk tiers", () => {
    expect(sitesTools.map((t) => t.name).sort()).toEqual(Object.keys(TIERS).sort());
    const inv = loadInventory();
    for (const t of sitesTools) {
      expect(kit.deps.registry.get(t.name), t.name).toBeDefined();
      expect(riskOf(t), t.name).toBe(TIERS[t.name]);
      expect(mapTool(inv.find((x) => x.name === t.name)!).risk, t.name).toBe(riskOf(t));
      expect(t.platform).toBe("bing_webmaster");
    }
  });
});
