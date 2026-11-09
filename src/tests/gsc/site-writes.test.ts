import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { createVerifier } from "../../mcp/pipeline";
import { ToolRegistry, reconcile } from "../../mcp/registry";
import { riskOf } from "../../mcp/tool";
import { allTools } from "../../platforms";
import { gscTools } from "../../platforms/gsc";
import { FakeGsc, gErr, guardBodies, gscHarness, type GscHarness } from "./fake-gsc";

const fake = new FakeGsc();
guardBodies(fake);
let kit: GscHarness;
beforeAll(async () => {
  fake.reset();
  kit = await gscHarness("GSCS", fake);
});
beforeEach(() => fake.reset());

let n = 0;
const newSite = () => `sc-domain:new${++n}.example`;
const writes = () => fake.calls.filter((c) => c.method === "PUT" || c.method === "DELETE");
const verify = (tool: string, args: Record<string, unknown>, accountId = kit.accountId) =>
  createVerifier(kit.deps)({ tool, tenantId: kit.tenantId, accountId, args: { account_id: accountId, ...args }, planSnapshot: {}, requestedBy: kit.owner, decidedBy: kit.second });

describe("add_gsc_site", () => {
  it("named through another site of the same connection; after approval sends a body-less PUT and reports the unverified property", async () => {
    const s = newSite();
    const r = await kit.run("add_gsc_site", { account_id: kit.shopId, site_url: s });
    expect(r.approval).toMatchObject({ risk: "write" });
    expect(r.approval!.summary).toContain(`Add ${s} to the Search Console of the Google user connected through https://shop.example.com/`);
    expect(r.approval!.summary).toContain("does not verify ownership");
    expect(writes()).toHaveLength(0);
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
    expect(writes().map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`PUT /webmasters/v3/sites/${encodeURIComponent(s)}`]);
    expect(done.result).toMatchObject({ site_url: s, permission_level: "siteUnverifiedUser", verified: false });
    expect((done.result as any).next_steps).toContain(`Verify ownership of ${s} in Search Console`);
  });

  it("refuses a property already present and a URL prefix without the trailing slash", async () => {
    let r = await kit.run("add_gsc_site", { site_url: "https://shop.example.com/" });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    expect(r.error!.message).toContain("already in this user's Search Console (permission: full user)");
    r = await kit.run("add_gsc_site", { site_url: "https://www.new.example" });
    expect(r.error?.code).toBe("invalid_argument");
    expect(r.error!.message).toContain("https://www.new.example/");
    expect(writes()).toHaveLength(0);
  });

  it("a PUT that does not read back is an unknown outcome; a 5xx is too, sent once", async () => {
    let r = await kit.run("add_gsc_site", { site_url: newSite() });
    fake.ignoreWrites = true;
    expect((await kit.approveAs(r.approval!.approval_id, kit.owner)).status).toBe("unknown_outcome");
    fake.reset();
    r = await kit.run("add_gsc_site", { site_url: newSite() });
    fake.fail = (c) => (c.method === "PUT" ? gErr(503, "backend", "backendError") : undefined);
    expect((await kit.approveAs(r.approval!.approval_id, kit.owner)).status).toBe("unknown_outcome");
    expect(writes()).toHaveLength(1);
  });

  it("a property that appears between request and approval is refused when re-planned: nothing is sent", async () => {
    const s = newSite();
    const r = await kit.run("add_gsc_site", { site_url: s });
    fake.sites.push({ siteUrl: s, permissionLevel: "siteOwner" });
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect(writes()).toHaveLength(0);
  });

  it("verify: applied when listed, not_applied when not", async () => {
    const s = newSite();
    expect(await verify("add_gsc_site", { site_url: s })).toEqual({ outcome: "not_applied" });
    fake.sites.push({ siteUrl: s, permissionLevel: "siteUnverifiedUser" });
    expect(await verify("add_gsc_site", { site_url: s })).toEqual({ outcome: "applied" });
  });
});

describe("remove_gsc_site", () => {
  it("is destructive, needs the exact confirmation, and a second approver; DELETE then read back", async () => {
    let r = await kit.run("remove_gsc_site", { account_id: kit.shopId, confirm_site_url: "https://shop.example.com" });
    expect(r.error?.code).toBe("invalid_argument");
    r = await kit.run("remove_gsc_site", { account_id: kit.shopId, confirm_site_url: "https://shop.example.com/" });
    expect(r.approval).toMatchObject({ risk: "destructive" });
    expect(r.approval!.summary).toContain("Remove https://shop.example.com/ from the connected Google user's list of Search Console properties (their permission: full user)");
    expect(r.approval!.summary).toContain("do not say what this does");
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ effect: "remove", before: "siteFullUser", after: null });
    await expect(kit.approveAs(r.approval!.approval_id, kit.owner)).rejects.toMatchObject({ code: "permission_denied" });
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(writes().map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["DELETE /webmasters/v3/sites/https%3A%2F%2Fshop.example.com%2F"]);
    expect(done.result).toMatchObject({ site_url: "https://shop.example.com/", removed: true });
    expect(fake.sites.map((s) => s.siteUrl)).not.toContain("https://shop.example.com/");
  });

  it("a permission change between request and approval is a conflict; still listed after DELETE is unknown", async () => {
    let r = await kit.run("remove_gsc_site", { confirm_site_url: "sc-domain:example.com" });
    fake.sites[0]!.permissionLevel = "siteFullUser";
    let done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect((done.result as any).error.code).toBe("conflict");
    expect(writes()).toHaveLength(0);
    fake.reset();
    r = await kit.run("remove_gsc_site", { confirm_site_url: "sc-domain:example.com" });
    fake.ignoreWrites = true;
    done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("unknown_outcome");
  });

  it("verify: applied when gone, not_applied when present", async () => {
    expect(await verify("remove_gsc_site", { confirm_site_url: "sc-domain:example.com" })).toEqual({ outcome: "not_applied" });
    fake.sites = fake.sites.filter((s) => s.siteUrl !== "sc-domain:example.com");
    expect(await verify("remove_gsc_site", { confirm_site_url: "sc-domain:example.com" })).toEqual({ outcome: "applied" });
  });
});

describe("Search Console tool registry", () => {
  const TIERS: Record<string, string> = {
    list_gsc_sites: "read", get_search_performance: "read", get_top_queries: "read", get_top_pages: "read", compare_search_periods: "read", get_search_appearance: "read", inspect_url: "read", list_sitemaps: "read",
    submit_sitemap: "write", add_gsc_site: "write", delete_sitemap: "destructive", remove_gsc_site: "destructive",
  };
  it("registers all 12 tools with the design's risk tiers, matching the inventory plan, and they reconcile as implemented", () => {
    expect(gscTools.map((t) => t.name).sort()).toEqual(Object.keys(TIERS).sort());
    const inv = loadInventory();
    for (const t of gscTools) {
      expect(riskOf(t), t.name).toBe(TIERS[t.name]);
      expect(mapTool(inv.find((x) => x.name === t.name)!).risk, t.name).toBe(TIERS[t.name]);
      expect(t.platform).toBe("google_search_console");
    }
    const rec = reconcile(inv, new ToolRegistry(inv).registerAll(allTools()), {});
    expect(rec.errors).toEqual([]);
    for (const name of Object.keys(TIERS)) expect(rec.rows.find((r) => r.name === name)?.status, name).toBe("implemented");
  });
});
