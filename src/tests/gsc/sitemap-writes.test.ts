import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createVerifier } from "../../mcp/pipeline";
import { FakeGsc, gErr, guardBodies, gscHarness, type GscHarness } from "./fake-gsc";

const fake = new FakeGsc();
guardBodies(fake);
let kit: GscHarness;
beforeAll(async () => {
  fake.reset();
  kit = await gscHarness("GSCW", fake);
});
beforeEach(() => fake.reset());

let n = 0;
/** A fresh sitemap URL per test, so approvals of earlier tests never de-duplicate a new request. */
const url = (host = "https://example.com") => `${host}/sitemap-${++n}.xml`;
const writes = () => fake.calls.filter((c) => c.method === "PUT" || c.method === "DELETE");
const verify = (tool: string, args: Record<string, unknown>, snapshot: unknown, accountId = kit.accountId) =>
  createVerifier(kit.deps)({ tool, tenantId: kit.tenantId, accountId, args: { account_id: accountId, ...args }, planSnapshot: snapshot, requestedBy: kit.owner, decidedBy: kit.second });

describe("submit_sitemap", () => {
  it("is a write-tier tool; requesting queues an approval with a neutral change and sends nothing", async () => {
    const t = kit.deps.registry.get("submit_sitemap")!;
    expect(t.kind === "write" && t.risk).toBe("write");
    const u = url();
    const r = await kit.run("submit_sitemap", { sitemap_url: u });
    expect(r.approval).toMatchObject({ status: "pending_approval", risk: "write" });
    expect(r.approval!.summary).toBe(`Submit sitemap ${u} to Search Console property sc-domain:example.com. Google reads it later; this does not request indexing of any page.`);
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ resource: "sitemap", id: u, before: null, after: "submitted", effect: "neutral" });
    expect(writes()).toHaveLength(0);
  });

  it("after approval sends one body-less PUT to the encoded path, reads it back and reports it", async () => {
    const u = url("https://www.example.com");
    const r = await kit.run("submit_sitemap", { sitemap_url: u });
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
    expect(writes().map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`PUT /webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/${encodeURIComponent(u)}`]);
    expect(done.result).toEqual({ site_url: "sc-domain:example.com", sitemap_url: u, resubmitted: false, last_submitted: fake.clock, is_pending: true });
  });

  it("resubmitting an existing sitemap says so in the summary", async () => {
    const u = url();
    fake.sitemaps["sc-domain:example.com"] = [{ path: u, lastSubmitted: "2026-10-01T00:00:00Z", type: "sitemap", lastDownloaded: "2026-10-02T00:00:00Z", errors: "1", warnings: "0", contents: [{ type: "web", submitted: "40" }] }];
    const r = await kit.run("submit_sitemap", { sitemap_url: u });
    expect(r.approval!.summary).toContain("Resubmit sitemap");
    expect(r.approval!.summary).toContain("last submitted 2026-10-01T00:00:00Z; type sitemap, 40 URLs submitted, last read 2026-10-02T00:00:00Z, 1 errors, 0 warnings");
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.result).toMatchObject({ resubmitted: true, last_submitted: fake.clock });
  });

  it("refuses a sitemap outside the property, and restricted or unverified users, before queueing", async () => {
    expect((await kit.run("submit_sitemap", { sitemap_url: "https://other.test/s.xml" })).error?.code).toBe("invalid_argument");
    fake.sites[0]!.permissionLevel = "siteRestrictedUser";
    let r = await kit.run("submit_sitemap", { sitemap_url: url() });
    expect(r.error).toMatchObject({ code: "platform_permission_denied" });
    expect(r.error!.message).toContain("restricted users cannot submit sitemaps");
    fake.sites[0]!.permissionLevel = "siteUnverifiedUser";
    r = await kit.run("submit_sitemap", { sitemap_url: url() });
    expect(r.error!.message).toContain("verify it in Search Console");
    expect(writes()).toHaveLength(0);
  });

  it("a read-only connection cannot request it", async () => {
    const r = await kit.run("submit_sitemap", { account_id: kit.readOnlyId, sitemap_url: "https://ro.example.com/s.xml" });
    expect(r.error?.code).toBe("permission_denied");
  });

  it("someone resubmitting between request and approval is a conflict; nothing is sent", async () => {
    const u = url();
    fake.sitemaps["sc-domain:example.com"] = [{ path: u, lastSubmitted: "2026-10-01T00:00:00Z" }];
    const r = await kit.run("submit_sitemap", { sitemap_url: u });
    fake.sitemaps["sc-domain:example.com"]![0]!.lastSubmitted = "2026-11-09T00:00:00Z";
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect((done.result as any).error.code).toBe("conflict");
    expect(writes()).toHaveLength(0);
  });

  it("a server error on the PUT is an unknown outcome, sent once and never retried", async () => {
    const u = url();
    const r = await kit.run("submit_sitemap", { sitemap_url: u });
    fake.fail = (c) => (c.method === "PUT" ? gErr(500, "backend", "internalError") : undefined);
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect(writes()).toHaveLength(1);
  });

  it("a PUT that does not read back is an unknown outcome", async () => {
    const r = await kit.run("submit_sitemap", { sitemap_url: url() });
    fake.ignoreWrites = true;
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect((done.result as any).error.message).toContain("does not read back");
  });

  it("a read-back GET that fails with 403 or 429 after a successful PUT is an unknown outcome, never a failure", async () => {
    for (const err of [() => gErr(403, "User does not have sufficient permission", "forbidden"), () => gErr(429, "Rate limit exceeded", "rateLimitExceeded")]) {
      fake.reset();
      const r = await kit.run("submit_sitemap", { sitemap_url: url() });
      fake.fail = (c) => (c.method === "GET" && writes().length > 0 ? err() : undefined);
      const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
      expect(done.status).toBe("unknown_outcome");
      expect((done.result as any).error.message).toContain("reading it back failed");
      expect(writes()).toHaveLength(1);
    }
  });

  it("verify: applied, not_applied, indeterminate", async () => {
    const u = url();
    expect(await verify("submit_sitemap", { sitemap_url: u }, { existing: null })).toEqual({ outcome: "not_applied" });
    fake.sitemaps["sc-domain:example.com"] = [{ path: u, lastSubmitted: "2026-11-10T08:00:00Z" }];
    expect(await verify("submit_sitemap", { sitemap_url: u }, { existing: null })).toEqual({ outcome: "applied" });
    expect(await verify("submit_sitemap", { sitemap_url: u }, { existing: { last_submitted: "2026-10-01T00:00:00Z" } })).toEqual({ outcome: "applied" });
    expect((await verify("submit_sitemap", { sitemap_url: u }, { existing: { last_submitted: "2026-11-10T08:00:00Z" } })).outcome).toBe("indeterminate");
  });
});

describe("delete_sitemap", () => {
  const seed = (u: string, extra: Record<string, unknown> = {}) => {
    fake.sitemaps["sc-domain:example.com"] = [{ path: u, lastSubmitted: "2026-10-01T00:00:00Z", type: "sitemap", lastDownloaded: "2026-10-03T00:00:00Z", errors: "0", warnings: "2", contents: [{ type: "web", submitted: "120" }], ...extra }];
  };

  it("is destructive: the requester cannot approve it; a second person can, and it is removed and checked", async () => {
    const u = url();
    seed(u);
    const r = await kit.run("delete_sitemap", { sitemap_url: u });
    expect(r.approval).toMatchObject({ risk: "destructive" });
    expect(r.approval!.summary).toBe(`Remove sitemap ${u} from Search Console property sc-domain:example.com (type sitemap, 120 URLs submitted, last read 2026-10-03T00:00:00Z, 0 errors, 2 warnings). The file on the website is not changed. Google's API docs do not say whether Google stops reading the URLs it lists.`);
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ effect: "remove", after: null });
    await expect(kit.approveAs(r.approval!.approval_id, kit.owner)).rejects.toMatchObject({ code: "permission_denied" });
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(done.result).toEqual({ site_url: "sc-domain:example.com", sitemap_url: u, removed: true });
    expect(writes().map((c) => c.method)).toEqual(["DELETE"]);
    expect(fake.sitemaps["sc-domain:example.com"]).toEqual([]);
  });

  it("a sitemap that is not in the list is not_found; an index is described without claiming a cascade", async () => {
    expect((await kit.run("delete_sitemap", { sitemap_url: url() })).error?.code).toBe("not_found");
    const u = url();
    seed(u, { isSitemapsIndex: true });
    const r = await kit.run("delete_sitemap", { sitemap_url: u });
    expect(r.approval!.summary).toContain("It is a sitemap index covering other sitemaps.");
  });

  it("still listed after the DELETE is an unknown outcome", async () => {
    const u = url();
    seed(u);
    const r = await kit.run("delete_sitemap", { sitemap_url: u });
    fake.ignoreWrites = true;
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("unknown_outcome");
  });

  it("a read-back GET that fails with 403 or 429 after a successful DELETE is an unknown outcome, never a failure", async () => {
    for (const err of [() => gErr(403, "User does not have sufficient permission", "forbidden"), () => gErr(429, "Rate limit exceeded", "rateLimitExceeded")]) {
      fake.reset();
      const u = url();
      seed(u);
      const r = await kit.run("delete_sitemap", { sitemap_url: u });
      fake.fail = (c) => (c.method === "GET" && writes().length > 0 ? err() : undefined);
      const done = await kit.approveAs(r.approval!.approval_id, kit.second);
      expect(done.status).toBe("unknown_outcome");
      expect((done.result as any).error.message).toContain("reading it back failed");
      expect(writes()).toHaveLength(1);
    }
  });

  it("a resubmission between request and approval is a conflict; already gone is not_found; nothing is sent", async () => {
    let u = url();
    seed(u);
    let r = await kit.run("delete_sitemap", { sitemap_url: u });
    fake.sitemaps["sc-domain:example.com"]![0]!.lastSubmitted = "2026-11-09T00:00:00Z";
    let done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect((done.result as any).error.code).toBe("conflict");
    u = url();
    seed(u);
    r = await kit.run("delete_sitemap", { sitemap_url: u });
    fake.sitemaps["sc-domain:example.com"] = [];
    done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("failed");
    expect((done.result as any).error.code).toBe("not_found");
    expect(writes()).toHaveLength(0);
  });

  it("verify: applied when gone, not_applied when present", async () => {
    const u = url();
    expect(await verify("delete_sitemap", { sitemap_url: u }, {})).toEqual({ outcome: "applied" });
    seed(u);
    expect(await verify("delete_sitemap", { sitemap_url: u }, {})).toEqual({ outcome: "not_applied" });
  });
});
