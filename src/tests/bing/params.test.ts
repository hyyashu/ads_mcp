import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { createVerifier } from "../../mcp/pipeline";
import { riskOf } from "../../mcp/tool";
import { BING_ERROR } from "../../platforms/bing/http";
import { paramTools } from "../../platforms/bing/tools/params";
import { SectionState, paramRow } from "./blocking-fixtures";
import { FakeBing, SITE, bingErr, bingHarness, guardProtocol, type BingHarness } from "./fake-bing";

const fake = new FakeBing();
guardProtocol(fake);
const st = new SectionState();
let kit: BingHarness;
beforeAll(async () => {
  fake.reset();
  kit = await bingHarness("BPRM", fake, paramTools);
});
beforeEach(() => {
  fake.reset();
  st.reset();
  st.install(fake);
});

let n = 0;
/** A fresh parameter name per test, so approvals of earlier tests never de-duplicate a new request. */
const fresh = () => `utm_x${++n}`;
const verify = (tool: string, args: Record<string, unknown>, snapshot: unknown) =>
  createVerifier(kit.deps)({ tool, tenantId: kit.tenantId, accountId: kit.accountId, args: { account_id: kit.accountId, ...args }, planSnapshot: snapshot, requestedBy: kit.owner, decidedBy: kit.second });
const err = (done: { result: unknown }) => (done.result as { error: { code: string; message: string } }).error;

describe("URL parameter tool registry", () => {
  const TIERS: Record<string, string> = { list_bing_url_parameters: "read", add_bing_url_parameter: "high_impact", update_bing_url_parameter: "high_impact", remove_bing_url_parameter: "destructive" };
  it("declares the inventory's risk for every tool and registers through the real registry", () => {
    const inv = loadInventory();
    expect(paramTools.map((t) => t.name).sort()).toEqual(Object.keys(TIERS).sort());
    for (const t of paramTools) {
      expect(riskOf(t), t.name).toBe(TIERS[t.name]);
      expect(riskOf(t), t.name).toBe(mapTool(inv.find((x) => x.name === t.name)!).risk);
      expect(kit.deps.registry.get(t.name)).toBe(t);
    }
  });
});

describe("list_bing_url_parameters", () => {
  it("parses the documented sample shape, sorted by name", async () => {
    st.params.push({ __type: "QueryParameter:#Microsoft.Bing.Webmaster.Api", Date: "/Date(1303514052179-0700)/", IsEnabled: false, Parameter: "x:test", Source: 1 });
    const r = await kit.run("list_bing_url_parameters");
    const d = r.data as any;
    expect(d.parameters.map((p: any) => p.parameter)).toEqual(["cart", "sessionid", "x:test"]);
    expect(d.parameters[0]).toEqual({ parameter: "cart", enabled: false, source: 1, added_at: "2011-08-22T16:40:58.933Z" });
    expect(d.parameters[2].added_at).toBe("2011-04-22T23:14:12.179Z");
    expect(d).toMatchObject({ site_url: SITE, returned: 3, total: 3, truncated: false });
    expect(d.note).toContain("treats URLs that differ only in it as one page");
    expect((await kit.run("list_bing_url_parameters", { limit: 2 })).data).toMatchObject({ returned: 2, truncated: true });
    fake.handlers.GetQueryParameters = () => bingErr(BING_ERROR.UserBlocked, "UserBlocked");
    expect((await kit.run("list_bing_url_parameters")).error?.code).toBe("platform_permission_denied");
  });
});

describe("add_bing_url_parameter", () => {
  it("is high impact, explains the effect plainly and sends nothing before approval", async () => {
    const p = fresh();
    const r = await kit.run("add_bing_url_parameter", { parameter: p });
    expect(r.approval).toMatchObject({ status: "pending_approval", risk: "high_impact" });
    expect(r.approval!.summary).toContain(`URLs that differ only in ${p} will be treated as one page (e.g. ${SITE}page?${p}=1 and ${SITE}page?${p}=2 become one)`);
    expect(r.approval!.summary).toContain("Bing can drop real pages from its index");
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ resource: "bing_url_parameter", id: p, before: null, after: "added", effect: "create" });
    expect(fake.mutations).toHaveLength(0);
  });

  it("after approval sends one AddQueryParameter and reads it back", async () => {
    const p = fresh();
    const r = await kit.run("add_bing_url_parameter", { parameter: p });
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([["AddQueryParameter", { siteUrl: SITE, queryParameter: p }]]);
    expect(done.result).toMatchObject({ site_url: SITE, parameter: { parameter: p, enabled: true, source: 0 } });
  });

  it("validates the name as documented, refuses duplicates and warns about a case twin", async () => {
    for (const bad of ["a b", "a=b", "?x", "x&y", "", "é", "x".repeat(129)]) expect((await kit.run("add_bing_url_parameter", { parameter: bad })).error?.code, bad).toBe("invalid_argument");
    const dup = await kit.run("add_bing_url_parameter", { parameter: "sessionid" });
    expect(dup.error).toMatchObject({ code: "invalid_argument" });
    expect(dup.error!.message).toContain("already in Bing's URL parameter list");
    const twin = await kit.run("add_bing_url_parameter", { parameter: "SessionID" });
    expect(twin.approval!.summary).toContain('The list already has "sessionid", which differs only in letter case.');
    expect((await kit.run("add_bing_url_parameter", { parameter: "ref:link.v2_~-" })).approval).toBeTruthy();
    expect((await kit.run("add_bing_url_parameter", { account_id: kit.readOnlyId, parameter: fresh() })).error?.code).toBe("permission_denied");
    expect(fake.mutations).toHaveLength(0);
  });

  it("drift is refused; Bing's limit error fails; no read-back is an unknown outcome", async () => {
    let p = fresh();
    let r = await kit.run("add_bing_url_parameter", { parameter: p });
    st.params.push(paramRow(p));
    let done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("failed");
    expect(fake.mutations).toHaveLength(0);

    p = fresh();
    r = await kit.run("add_bing_url_parameter", { parameter: p });
    fake.handlers.AddQueryParameter = () => bingErr(BING_ERROR.InvalidParameter, "Too many parameters");
    done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("failed");
    expect(err(done)).toMatchObject({ code: "invalid_argument", message: "Too many parameters" });

    st.install(fake);
    p = fresh();
    r = await kit.run("add_bing_url_parameter", { parameter: p });
    st.ignoreWrites = true;
    done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("unknown_outcome");
    expect(fake.of("AddQueryParameter")).toHaveLength(2);
  });

  it("verify", async () => {
    const p = fresh();
    expect(await verify("add_bing_url_parameter", { parameter: p }, {})).toEqual({ outcome: "not_applied" });
    st.params.push(paramRow(p));
    expect(await verify("add_bing_url_parameter", { parameter: p }, {})).toEqual({ outcome: "applied" });
  });
});

describe("update_bing_url_parameter", () => {
  it("enables a disabled parameter after approval and reads the flag back", async () => {
    const p = fresh();
    st.params.push(paramRow(p, false));
    const r = await kit.run("update_bing_url_parameter", { parameter: p, enabled: true });
    expect(r.approval).toMatchObject({ risk: "high_impact" });
    expect(r.approval!.summary).toContain("Microsoft does not document it");
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ field: "enabled", before: "false", after: "true", effect: "create" });
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => c.body)).toEqual([{ siteUrl: SITE, queryParameter: p, isEnabled: true }]);
    expect(done.result).toMatchObject({ parameter: { parameter: p, enabled: true } });
  });

  it("disabling stays high impact and says what is not documented", async () => {
    const p = fresh();
    st.params.push(paramRow(p, true));
    const r = await kit.run("update_bing_url_parameter", { parameter: p, enabled: false });
    expect(r.approval).toMatchObject({ risk: "high_impact" });
    expect(r.approval!.summary).toContain("Microsoft does not document what a disabled entry does");
    await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(fake.mutations[0]!.body).toEqual({ siteUrl: SITE, queryParameter: p, isEnabled: false });
  });

  it("refuses an unlisted parameter or a no-op; not read back is an unknown outcome; verify", async () => {
    expect((await kit.run("update_bing_url_parameter", { parameter: fresh(), enabled: true })).error?.code).toBe("not_found");
    expect((await kit.run("update_bing_url_parameter", { parameter: "sessionid", enabled: true })).error?.message).toContain("already enabled");
    expect((await kit.run("update_bing_url_parameter", { parameter: "cart", enabled: "yes" })).error?.code).toBe("invalid_argument");
    const p = fresh();
    st.params.push(paramRow(p, false));
    const r = await kit.run("update_bing_url_parameter", { parameter: p, enabled: true });
    st.ignoreWrites = true;
    expect((await kit.approveAs(r.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
    expect(await verify("update_bing_url_parameter", { parameter: p, enabled: true }, {})).toEqual({ outcome: "not_applied" });
    st.params.find((x) => x.Parameter === p)!.IsEnabled = true;
    expect(await verify("update_bing_url_parameter", { parameter: p, enabled: true }, {})).toEqual({ outcome: "applied" });
    st.params.pop();
    expect((await verify("update_bing_url_parameter", { parameter: p, enabled: true }, {})).outcome).toBe("indeterminate");
  });
});

describe("remove_bing_url_parameter", () => {
  it("is destructive, says duplicates may come back, and removes after approval", async () => {
    const p = fresh();
    st.params.push(paramRow(p));
    const r = await kit.run("remove_bing_url_parameter", { parameter: p });
    expect(r.approval).toMatchObject({ risk: "destructive" });
    expect(r.approval!.summary).toContain("they may be crawled and indexed as separate, duplicate pages again");
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ before: "listed (enabled)", after: null, effect: "remove" });
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([["RemoveQueryParameter", { siteUrl: SITE, queryParameter: p }]]);
    expect(st.params.some((x) => x.Parameter === p)).toBe(false);
  });

  it("refuses an unlisted parameter; a disable between request and approval is drift; unknown outcome; verify", async () => {
    expect((await kit.run("remove_bing_url_parameter", { parameter: fresh() })).error?.code).toBe("not_found");
    let p = fresh();
    st.params.push(paramRow(p));
    let r = await kit.run("remove_bing_url_parameter", { parameter: p });
    st.params.find((x) => x.Parameter === p)!.IsEnabled = false;
    let done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(err(done).code).toBe("conflict");
    expect(fake.mutations).toHaveLength(0);
    p = fresh();
    st.params.push(paramRow(p));
    r = await kit.run("remove_bing_url_parameter", { parameter: p });
    fake.handlers.RemoveQueryParameter = () => bingErr(BING_ERROR.InternalError, "InternalError", 500);
    done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("unknown_outcome");
    expect(fake.of("RemoveQueryParameter")).toHaveLength(1);
    expect(await verify("remove_bing_url_parameter", { parameter: p }, {})).toEqual({ outcome: "not_applied" });
    st.params.pop();
    expect(await verify("remove_bing_url_parameter", { parameter: p }, {})).toEqual({ outcome: "applied" });
  });
});
