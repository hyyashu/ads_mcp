import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { createVerifier } from "../../mcp/pipeline";
import { riskOf } from "../../mcp/tool";
import { SAMPLE_UNSET_DATE } from "../../platforms/bing/api/blocking";
import { ISO_COUNTRIES } from "../../platforms/bing/api/geo";
import { BING_ERROR } from "../../platforms/bing/http";
import { geoTools } from "../../platforms/bing/tools/geo";
import { SectionState, geoRow } from "./blocking-fixtures";
import { FakeBing, SITE, bingErr, bingHarness, guardProtocol, type BingHarness } from "./fake-bing";

const fake = new FakeBing();
guardProtocol(fake);
const st = new SectionState();
let kit: BingHarness;
beforeAll(async () => {
  fake.reset();
  kit = await bingHarness("BGEO", fake, geoTools);
});
beforeEach(() => {
  fake.reset();
  st.reset();
  st.install(fake);
});

let n = 0;
/** A fresh directory per test, so approvals of earlier tests never de-duplicate a new request. */
const fresh = () => `${SITE}c${++n}/`;
const verify = (tool: string, args: Record<string, unknown>, snapshot: unknown) =>
  createVerifier(kit.deps)({ tool, tenantId: kit.tenantId, accountId: kit.accountId, args: { account_id: kit.accountId, ...args }, planSnapshot: snapshot, requestedBy: kit.owner, decidedBy: kit.second });
const err = (done: { result: unknown }) => (done.result as { error: { code: string; message: string } }).error;

describe("country targeting tool registry", () => {
  const TIERS: Record<string, string> = { list_bing_country_targeting: "read", add_bing_country_targeting: "high_impact", remove_bing_country_targeting: "destructive" };
  it("declares the inventory's risk for every tool and registers through the real registry", () => {
    const inv = loadInventory();
    expect(geoTools.map((t) => t.name).sort()).toEqual(Object.keys(TIERS).sort());
    for (const t of geoTools) {
      expect(riskOf(t), t.name).toBe(TIERS[t.name]);
      expect(riskOf(t), t.name).toBe(mapTool(inv.find((x) => x.name === t.name)!).risk);
      expect(kit.deps.registry.get(t.name)).toBe(t);
    }
    expect(ISO_COUNTRIES.size).toBe(249);
  });
});

describe("list_bing_country_targeting", () => {
  it("lists entries with documented level names, sorted by URL", async () => {
    st.geo.push(geoRow("https://nl.example.com/", 3, "NL"), geoRow(`${SITE}odd`, 9, "IT"));
    const r = await kit.run("list_bing_country_targeting");
    const d = r.data as any;
    expect(d.settings).toEqual([
      { url: "https://nl.example.com/", level: "subdomain", country_code: "NL", added_at: "2026-09-01T07:00:00.000Z" },
      { url: `${SITE}de/`, level: "directory", country_code: "DE", added_at: "2026-09-01T07:00:00.000Z" },
      { url: `${SITE}fr/landing`, level: "page", country_code: "FR", added_at: "2026-09-01T07:00:00.000Z" },
      { url: `${SITE}odd`, level: "unknown (9)", country_code: "IT", added_at: "2026-09-01T07:00:00.000Z" },
    ]);
    expect(d).toMatchObject({ returned: 4, total: 4, truncated: false });
    expect((await kit.run("list_bing_country_targeting", { limit: 1 })).data).toMatchObject({ returned: 1, total: 4, truncated: true });
    fake.handlers.GetCountryRegionSettings = () => bingErr(BING_ERROR.InvalidApiKey, "InvalidApiKey");
    expect((await kit.run("list_bing_country_targeting")).error?.code).toBe("auth_expired");
  });
});

describe("add_bing_country_targeting", () => {
  it("is high impact with a plain summary; after approval sends a CountryRegionSettings and reads it back", async () => {
    const u = fresh();
    const r = await kit.run("add_bing_country_targeting", { url: u, level: "directory", country_code: "at" });
    expect(r.approval).toMatchObject({ status: "pending_approval", risk: "high_impact" });
    expect(r.approval!.summary).toContain(`Tell Bing that the directory and every page in it ${u} (site ${SITE}) is meant for an audience in country AT.`);
    expect(r.approval!.summary).toContain("not for content aimed at several countries");
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ resource: "bing_country_targeting", id: `directory:${u}`, before: null, after: "AT", effect: "create" });
    expect(fake.mutations).toHaveLength(0);
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([
      ["AddCountryRegionSettings", { siteUrl: SITE, settings: { __type: "CountryRegionSettings:#Microsoft.Bing.Webmaster.Api", Date: SAMPLE_UNSET_DATE, TwoLetterIsoCountryCode: "AT", Type: 1, Url: u } }],
    ]);
    expect(done.result).toMatchObject({ site_url: SITE, setting: { url: u, level: "directory", country_code: "AT" } });
  });

  it("domain level is the host root and the summary carries Microsoft's caveat", async () => {
    st.geo = [];
    const r = await kit.run("add_bing_country_targeting", { url: SITE, level: "domain", country_code: "US" });
    expect(r.approval!.summary).toContain("works only on geo-targetable domains such as .com, .org or .net");
    await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(fake.mutations[0]!.body!.settings).toMatchObject({ Type: 2, Url: SITE });
  });

  it("validates codes, levels and URLs, and refuses an entry that already exists", async () => {
    const bad = async (args: Record<string, unknown>) => (await kit.run("add_bing_country_targeting", { url: fresh(), level: "directory", country_code: "DE", ...args })).error;
    for (const code of ["XX", "D", "DEU", "1A", "UK"]) expect((await bad({ country_code: code }))?.code, code).toBe("invalid_argument");
    expect((await bad({ level: "country" }))?.code).toBe("invalid_argument");
    expect((await bad({ url: "https://other.example.org/" }))?.code).toBe("invalid_argument");
    expect((await bad({ url: `${SITE}de` }))?.message).toContain("must end with '/'");
    expect((await bad({ url: `${SITE}x/`, level: "subdomain" }))?.message).toContain("root of the host");
    const dup = await bad({ url: `${SITE}de/`, country_code: "AT" });
    expect(dup).toMatchObject({ code: "invalid_argument" });
    expect(dup!.message).toContain("already targets DE");
    const other = await kit.run("add_bing_country_targeting", { url: `${SITE}fr/landing`, level: "directory", country_code: "FR" });
    expect(other.error?.message).toContain("must end with '/'");
    expect((await kit.run("add_bing_country_targeting", { account_id: kit.readOnlyId, url: "https://ro.example.com/a/", level: "directory", country_code: "DE" })).error?.code).toBe("permission_denied");
    expect(fake.mutations).toHaveLength(0);
  });

  it("drift is refused; not read back is an unknown outcome; Bing's refusal fails; verify", async () => {
    let u = fresh();
    let r = await kit.run("add_bing_country_targeting", { url: u, level: "directory", country_code: "DE" });
    st.geo.push(geoRow(u, 1, "CH"));
    let done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("failed");
    expect(fake.mutations).toHaveLength(0);

    u = fresh();
    r = await kit.run("add_bing_country_targeting", { url: u, level: "directory", country_code: "DE" });
    st.ignoreWrites = true;
    done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("unknown_outcome");
    st.ignoreWrites = false;

    u = fresh();
    r = await kit.run("add_bing_country_targeting", { url: u, level: "directory", country_code: "DE" });
    fake.handlers.AddCountryRegionSettings = () => bingErr(BING_ERROR.NotAllowed, "NotAllowed");
    done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("failed");
    expect(err(done).code).toBe("platform_permission_denied");

    const args = { url: u, level: "directory", country_code: "de" };
    expect(await verify("add_bing_country_targeting", args, {})).toEqual({ outcome: "not_applied" });
    st.geo.push(geoRow(u, 1, "de"));
    expect(await verify("add_bing_country_targeting", args, {})).toEqual({ outcome: "applied" });
  });
});

describe("remove_bing_country_targeting", () => {
  it("is destructive and sends the stored settings back exactly as listed", async () => {
    const u = fresh();
    st.geo.push(geoRow(u, 1, "AT"));
    const r = await kit.run("remove_bing_country_targeting", { url: u });
    expect(r.approval).toMatchObject({ risk: "destructive" });
    expect(r.approval!.summary).toBe(`Remove Bing's country targeting of the directory and every page in it ${u} (level directory, country AT) on ${SITE}. Bing then judges the intended country from its other signals only, which can change in which countries' results these pages rank.`);
    expect(fake.mutations).toHaveLength(0);
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([["RemoveCountryRegionSettings", { siteUrl: SITE, settings: geoRow(u, 1, "AT") }]]);
    expect(st.geo.some((g) => g.Url === u)).toBe(false);
  });

  it("refuses a missing entry, asks which one when ambiguous, and disambiguates by level and country", async () => {
    expect((await kit.run("remove_bing_country_targeting", { url: fresh() })).error?.code).toBe("not_found");
    const u = fresh();
    st.geo.push(geoRow(u, 1, "AT"), geoRow(u, 0, "CH"));
    expect((await kit.run("remove_bing_country_targeting", { url: u })).error?.message).toContain("has 2 country/region entries");
    expect((await kit.run("remove_bing_country_targeting", { url: u, country_code: "DE" })).error?.code).toBe("not_found");
    const r = await kit.run("remove_bing_country_targeting", { url: u, country_code: "ch" });
    await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(fake.mutations[0]!.body!.settings).toEqual(geoRow(u, 0, "CH"));
    expect(st.geo.filter((g) => g.Url === u)).toEqual([geoRow(u, 1, "AT")]);
  });

  it("a change of country between request and approval is drift; still listed is an unknown outcome; verify", async () => {
    let u = fresh();
    st.geo.push(geoRow(u, 1, "AT"));
    let r = await kit.run("remove_bing_country_targeting", { url: u });
    st.geo[st.geo.length - 1]!.TwoLetterIsoCountryCode = "CH";
    let done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(err(done).code).toBe("conflict");
    expect(fake.mutations).toHaveLength(0);
    u = fresh();
    st.geo.push(geoRow(u, 1, "AT"));
    r = await kit.run("remove_bing_country_targeting", { url: u });
    st.ignoreWrites = true;
    done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("unknown_outcome");
    const stored = geoRow(u, 1, "AT");
    expect(await verify("remove_bing_country_targeting", { url: u }, { stored })).toEqual({ outcome: "not_applied" });
    st.geo.pop();
    expect(await verify("remove_bing_country_targeting", { url: u }, { stored })).toEqual({ outcome: "applied" });
    expect((await verify("remove_bing_country_targeting", { url: u }, null)).outcome).toBe("indeterminate");
  });
});
