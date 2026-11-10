import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { createVerifier } from "../../mcp/pipeline";
import { riskOf } from "../../mcp/tool";
import { SAMPLE_UNSET_DATE } from "../../platforms/bing/api/blocking";
import { BING_ERROR } from "../../platforms/bing/http";
import { blockingTools } from "../../platforms/bing/tools/blocking";
import { SectionState, blockedRow, deepLinkRow, previewRow } from "./blocking-fixtures";
import { FakeBing, RO_SITE, SITE, bingErr, bingHarness, guardProtocol, type BingHarness } from "./fake-bing";

const fake = new FakeBing();
guardProtocol(fake);
const st = new SectionState();
let kit: BingHarness;
beforeAll(async () => {
  fake.reset();
  kit = await bingHarness("BBLK", fake, blockingTools);
});
beforeEach(() => {
  fake.reset();
  st.reset();
  st.install(fake);
});

let n = 0;
/** A fresh URL per test, so approvals of earlier tests never de-duplicate a new request. */
const fresh = (prefix = "p") => `${SITE}${prefix}${++n}`;
const verify = (tool: string, args: Record<string, unknown>, snapshot: unknown) =>
  createVerifier(kit.deps)({ tool, tenantId: kit.tenantId, accountId: kit.accountId, args: { account_id: kit.accountId, ...args }, planSnapshot: snapshot, requestedBy: kit.owner, decidedBy: kit.second });
const err = (done: { result: unknown }) => (done.result as { error: { code: string; message: string } }).error;

describe("blocking tool registry", () => {
  const TIERS: Record<string, string> = {
    list_bing_blocked_urls: "read",
    block_bing_url: "destructive",
    unblock_bing_url: "destructive",
    list_bing_preview_blocks: "read",
    remove_bing_preview_block: "destructive",
    list_bing_sitelink_blocks: "read",
    remove_bing_sitelink_block: "destructive",
  };
  it("declares the inventory's risk for every tool and registers through the real registry", () => {
    const inv = loadInventory();
    expect(blockingTools.map((t) => t.name).sort()).toEqual(Object.keys(TIERS).sort());
    for (const t of blockingTools) {
      expect(riskOf(t), t.name).toBe(TIERS[t.name]);
      expect(riskOf(t), t.name).toBe(mapTool(inv.find((x) => x.name === t.name)!).risk);
      expect(t.platform).toBe("bing_webmaster");
      expect(kit.deps.registry.get(t.name)).toBe(t);
    }
  });
});

describe("list_bing_blocked_urls", () => {
  it("lists blocks sorted by URL with documented enum names, dates and days left", async () => {
    st.blocked.push(blockedRow(`${SITE}a-odd`, { entity: 7, request: 9 }));
    const r = await kit.run("list_bing_blocked_urls");
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d.blocked).toEqual([
      { url: `${SITE}a-odd`, entity_type: "unknown (7)", block: "unknown (9)", blocked_at: "2026-10-01T07:00:00.000Z", days_to_expire: 51 },
      { url: `${SITE}old-page`, entity_type: "page", block: "url_and_cache", blocked_at: "2026-10-01T07:00:00.000Z", days_to_expire: 51 },
      { url: `${SITE}private/`, entity_type: "directory", block: "cache_only", blocked_at: "2026-10-01T07:00:00.000Z", days_to_expire: 12 },
    ]);
    expect(d).toMatchObject({ site_url: SITE, returned: 3, total: 3, truncated: false });
    expect(fake.calls.map((c) => `${c.http} ${c.method} ${c.params.get("siteUrl")}`)).toEqual([`GET GetBlockedUrls ${SITE}`]);
  });

  it("says when the list is cut, handles {d: null}, validates the limit and maps Bing errors", async () => {
    let r = await kit.run("list_bing_blocked_urls", { limit: 1 });
    expect(r.data).toMatchObject({ returned: 1, total: 2, truncated: true });
    fake.handlers.GetBlockedUrls = () => undefined;
    r = await kit.run("list_bing_blocked_urls");
    expect(r.data).toMatchObject({ blocked: [], total: 0 });
    expect((await kit.run("list_bing_blocked_urls", { limit: 0 })).error?.code).toBe("invalid_argument");
    fake.handlers.GetBlockedUrls = () => bingErr(BING_ERROR.NotAuthorized, "NotAuthorized");
    expect((await kit.run("list_bing_blocked_urls")).error?.code).toBe("platform_permission_denied");
    fake.handlers.GetBlockedUrls = () => bingErr(BING_ERROR.ThrottleUser, "ThrottleUser");
    expect((await kit.run("list_bing_blocked_urls")).error?.code).toBe("quota_exceeded");
  });
});

describe("block_bing_url", () => {
  it("is destructive: the request is queued with a plain summary and nothing is sent", async () => {
    const u = fresh();
    const r = await kit.run("block_bing_url", { url: u, entity_type: "page", block: "url_and_cache" });
    expect(r.approval).toMatchObject({ status: "pending_approval", risk: "destructive" });
    expect(r.approval!.summary).toContain(`the page ${u} will disappear from Bing search results (with the cached copy) for 90 days`);
    expect(r.approval!.summary).toContain("lapses after 90 days unless someone extends it");
    expect(r.approval!.summary).toContain("noindex");
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ resource: "bing_blocked_url", id: u, before: null, after: "page, url_and_cache", effect: "remove" });
    expect(fake.mutations).toHaveLength(0);
  });

  it("after approval sends one AddBlockedUrl shaped like the documented sample and reads it back", async () => {
    const u = fresh();
    const r = await kit.run("block_bing_url", { url: u, entity_type: "page", block: "url_and_cache" });
    expect(fake.mutations).toHaveLength(0);
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => c.body)).toEqual([
      { siteUrl: SITE, blockedUrl: { __type: "BlockedUrl:#Microsoft.Bing.Webmaster.Api", Date: SAMPLE_UNSET_DATE, EntityType: 0, RequestType: 1, Url: u } },
    ]);
    expect(done.result).toMatchObject({ site_url: SITE, url: u, entity_type: "page", block: "url_and_cache", days_to_expire: 90 });
  });

  it("a cache-only directory block sends Directory/CacheOnly; the site root is called out as the whole site", async () => {
    const dir = `${fresh("dir")}/`;
    const r = await kit.run("block_bing_url", { url: dir, entity_type: "directory", block: "cache_only" });
    expect(r.approval!.summary).toContain(`the cached copy of the directory ${dir} and every page in it will no longer be shown by Bing for 90 days; the URL itself stays in results`);
    await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(fake.mutations[0]!.body!.blockedUrl).toMatchObject({ EntityType: 1, RequestType: 0, Url: dir });
    st.blocked = [];
    const root = await kit.run("block_bing_url", { url: SITE, entity_type: "directory", block: "url_and_cache" });
    expect(root.approval!.summary).toContain("the WHOLE SITE disappears from Bing results");
  });

  it("mentions a blocked directory that already covers the page", async () => {
    const r = await kit.run("block_bing_url", { url: `${SITE}private/${++n}`, entity_type: "page", block: "url_and_cache" });
    expect(r.approval!.summary).toContain(`Already covered by blocked directory ${SITE}private/.`);
  });

  it("refuses URLs outside the site, malformed directories, duplicates and bad input before queueing", async () => {
    const bad = async (args: Record<string, unknown>) => (await kit.run("block_bing_url", { entity_type: "page", block: "url_and_cache", ...args })).error;
    expect(await bad({ url: "https://other.example.org/x" })).toMatchObject({ code: "invalid_argument" });
    expect((await bad({ url: `${SITE}dir`, entity_type: "directory" }))?.message).toContain("must end with '/'");
    const dup = await bad({ url: `${SITE}old-page` });
    expect(dup).toMatchObject({ code: "invalid_argument" });
    expect(dup!.message).toContain("already blocked on Bing (page, the URL and its cached copy, 51 days left)");
    expect(await bad({ url: `${SITE}x`, block: "forever" })).toMatchObject({ code: "invalid_argument" });
    expect(await bad({ url: "not a url" })).toMatchObject({ code: "invalid_argument" });
    expect(fake.mutations).toHaveLength(0);
  });

  it("a read-only connection cannot request it", async () => {
    const r = await kit.run("block_bing_url", { account_id: kit.readOnlyId, url: `${RO_SITE}x`, entity_type: "page", block: "url_and_cache" });
    expect(r.error?.code).toBe("permission_denied");
    expect(fake.calls).toHaveLength(0);
  });

  it("a block made elsewhere between request and approval is drift: nothing is sent", async () => {
    const u = fresh();
    const r = await kit.run("block_bing_url", { url: u, entity_type: "page", block: "url_and_cache" });
    st.blocked.push(blockedRow(u));
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect(err(done).code).toBe("invalid_argument");
    const r2 = await kit.run("block_bing_url", { url: `${SITE}private/q${++n}`, entity_type: "page", block: "url_and_cache" });
    st.blocked = st.blocked.filter((b) => b.Url !== `${SITE}private/`); // the covering directory disappears
    const done2 = await kit.approveAs(r2.approval!.approval_id, kit.owner);
    expect(done2.status).toBe("failed");
    expect(err(done2).code).toBe("conflict");
    expect(fake.mutations).toHaveLength(0);
  });

  it("no read-back is an unknown outcome; a server error is sent once and never retried; a refusal fails", async () => {
    let r = await kit.run("block_bing_url", { url: fresh(), entity_type: "page", block: "url_and_cache" });
    st.ignoreWrites = true;
    let done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect(err(done).message).toContain("does not appear");
    st.ignoreWrites = false;

    r = await kit.run("block_bing_url", { url: fresh(), entity_type: "page", block: "url_and_cache" });
    fake.handlers.AddBlockedUrl = () => bingErr(BING_ERROR.InternalError, "InternalError", 500);
    done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect(fake.of("AddBlockedUrl")).toHaveLength(2); // one per approval above, none retried

    r = await kit.run("block_bing_url", { url: fresh(), entity_type: "page", block: "url_and_cache" });
    fake.handlers.AddBlockedUrl = () => bingErr(BING_ERROR.NotAllowed, "NotAllowed");
    done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect(err(done).code).toBe("platform_permission_denied");

    st.install(fake);
    r = await kit.run("block_bing_url", { url: fresh(), entity_type: "page", block: "url_and_cache" });
    const sent = fake.mutations.length;
    fake.fail = (c) => (c.method === "GetBlockedUrls" && fake.mutations.length > sent ? bingErr(BING_ERROR.ThrottleUser, "ThrottleUser") : undefined);
    done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect(err(done).message).toContain("reading it back failed");
  });

  it("verify: applied when the block is listed, not_applied otherwise", async () => {
    const u = fresh();
    const args = { url: u, entity_type: "page", block: "cache_only" };
    expect(await verify("block_bing_url", args, {})).toEqual({ outcome: "not_applied" });
    st.blocked.push(blockedRow(u, { request: 0 }));
    expect(await verify("block_bing_url", args, {})).toEqual({ outcome: "applied" });
    expect(await verify("block_bing_url", { ...args, block: "url_and_cache" }, {})).toEqual({ outcome: "not_applied" });
  });
});

describe("unblock_bing_url", () => {
  it("is destructive and sends the stored BlockedUrl back exactly as Bing listed it", async () => {
    const u = fresh();
    st.blocked.push(blockedRow(u, { days: 33 }));
    const r = await kit.run("unblock_bing_url", { url: u });
    expect(r.approval).toMatchObject({ risk: "destructive" });
    expect(r.approval!.summary).toBe(`Lift Bing's block on ${u} (it hides the URL and its cached copy; 33 days left). Bing may show it in search results again if it is still indexed and not marked noindex; changes can take time to show.`);
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ before: "page, url_and_cache", after: null, effect: "remove" });
    expect(fake.mutations).toHaveLength(0);
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => c.body)).toEqual([{ siteUrl: SITE, blockedUrl: blockedRow(u, { days: 33 }) }]);
    expect(done.result).toMatchObject({ url: u, unblocked: true });
    expect(st.blocked.some((b) => b.Url === u)).toBe(false);
  });

  it("refuses a URL that is not blocked, and asks which entry when a URL has several", async () => {
    expect((await kit.run("unblock_bing_url", { url: fresh() })).error?.code).toBe("not_found");
    const u = fresh();
    st.blocked.push(blockedRow(u), blockedRow(u, { request: 0 }));
    const amb = await kit.run("unblock_bing_url", { url: u });
    expect(amb.error).toMatchObject({ code: "invalid_argument" });
    expect(amb.error!.message).toContain("has 2 block entries");
    const r = await kit.run("unblock_bing_url", { url: u, block: "cache_only" });
    await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(fake.mutations[0]!.body!.blockedUrl).toMatchObject({ Url: u, RequestType: 0 });
    expect(st.blocked.filter((b) => b.Url === u)).toEqual([blockedRow(u)]);
  });

  it("already lifted at approval time fails without sending; still listed afterwards is an unknown outcome", async () => {
    let u = fresh();
    st.blocked.push(blockedRow(u));
    let r = await kit.run("unblock_bing_url", { url: u });
    st.blocked.pop();
    let done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(err(done).code).toBe("not_found");
    expect(fake.mutations).toHaveLength(0);
    u = fresh();
    st.blocked.push(blockedRow(u));
    r = await kit.run("unblock_bing_url", { url: u });
    st.ignoreWrites = true;
    done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("unknown_outcome");
  });

  it("verify compares with the stored entry", async () => {
    const u = fresh();
    const stored = blockedRow(u);
    expect(await verify("unblock_bing_url", { url: u }, { stored })).toEqual({ outcome: "applied" });
    st.blocked.push(stored);
    expect(await verify("unblock_bing_url", { url: u }, { stored })).toEqual({ outcome: "not_applied" });
    expect((await verify("unblock_bing_url", { url: u }, null)).outcome).toBe("indeterminate");
  });
});

describe("list_bing_preview_blocks / list_bing_sitelink_blocks", () => {
  it("return each entry in Bing's order with Bing's own field names (contract undocumented), dates converted, __type dropped", async () => {
    st.previews.push({ ...previewRow(`${SITE}b`), Extra: { nested: true } });
    const r = await kit.run("list_bing_preview_blocks");
    const d = r.data as any;
    expect(d.entries).toEqual([
      { fields: { Url: `${SITE}leak`, BlockReason: 1, BlockDate: "2026-10-05T07:00:00.000Z" }, skipped_fields: [] },
      { fields: { Url: `${SITE}b`, BlockReason: 1, BlockDate: "2026-10-05T07:00:00.000Z" }, skipped_fields: ["Extra"] },
    ]);
    expect(d.note).toContain("Microsoft does not document");
    const s = await kit.run("list_bing_sitelink_blocks", { limit: 1 });
    expect(s.data).toMatchObject({ returned: 1, total: 2, truncated: true });
    expect((s.data as any).entries[0].fields).toEqual({ Market: "", SearchUrl: "", DeepLinkUrl: `${SITE}about`, BlockDate: "2026-10-07T07:00:00.000Z" });
    fake.handlers.GetDeepLinkBlocks = () => ({ not: "a list" });
    expect((await kit.run("list_bing_sitelink_blocks")).error?.code).toBe("internal");
  });
});

describe("remove_bing_preview_block", () => {
  it("removes a listed preview block after approval and reads it back", async () => {
    const u = fresh();
    st.previews.push(previewRow(u));
    const r = await kit.run("remove_bing_preview_block", { url: u });
    expect(r.approval).toMatchObject({ risk: "destructive" });
    expect(r.approval!.summary).toContain("Bing may again show the stored preview image (a screenshot of the page)");
    expect(fake.mutations).toHaveLength(0);
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([["RemovePagePreviewBlock", { siteUrl: SITE, url: u }]]);
  });

  it("refuses an unlisted URL or one outside the site; no read-back change is an unknown outcome; verify", async () => {
    expect((await kit.run("remove_bing_preview_block", { url: fresh() })).error?.code).toBe("not_found");
    expect((await kit.run("remove_bing_preview_block", { url: "https://elsewhere.example.net/leak" })).error?.code).toBe("invalid_argument");
    const u = fresh();
    st.previews.push(previewRow(u));
    const r = await kit.run("remove_bing_preview_block", { url: u });
    st.ignoreWrites = true;
    expect((await kit.approveAs(r.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
    expect(await verify("remove_bing_preview_block", { url: u }, {})).toEqual({ outcome: "not_applied" });
    st.previews.pop();
    expect(await verify("remove_bing_preview_block", { url: u }, {})).toEqual({ outcome: "applied" });
  });
});

describe("remove_bing_sitelink_block", () => {
  it("removes the entry whose values match exactly, sending market, searchUrl and deepLinkUrl", async () => {
    const link = fresh("job");
    st.deepLinks.push(deepLinkRow(link, SITE, "en-GB"));
    const r = await kit.run("remove_bing_sitelink_block", { deep_link_url: link, search_url: SITE, market: "en-GB" });
    expect(r.approval).toMatchObject({ risk: "destructive" });
    expect(r.approval!.summary).toBe(`Remove the sitelink block on ${link} under the search result ${SITE} in market en-GB (site ${SITE}). Bing may show this link below the site's search results again; changes can take time to show.`);
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => c.body)).toEqual([{ siteUrl: SITE, market: "en-GB", searchUrl: SITE, deepLinkUrl: link }]);
  });

  it("an entry with no search URL or market is matched with empty values", async () => {
    const link = fresh("all");
    st.deepLinks.push(deepLinkRow(link));
    const r = await kit.run("remove_bing_sitelink_block", { deep_link_url: link });
    expect(r.approval!.summary).toContain("under any of the site's top search results");
    await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(fake.mutations[0]!.body).toEqual({ siteUrl: SITE, market: "", searchUrl: "", deepLinkUrl: link });
  });

  it("refuses values that do not match an entry exactly; unknown outcome; verify", async () => {
    const link = fresh("x");
    st.deepLinks.push(deepLinkRow(link, SITE, "en-US"));
    expect((await kit.run("remove_bing_sitelink_block", { deep_link_url: link })).error?.code).toBe("not_found");
    expect((await kit.run("remove_bing_sitelink_block", { deep_link_url: link, search_url: SITE, market: "de-DE" })).error?.code).toBe("not_found");
    expect((await kit.run("remove_bing_sitelink_block", { deep_link_url: "https://elsewhere.example.net/a" })).error?.code).toBe("invalid_argument");
    const args = { deep_link_url: link, search_url: SITE, market: "en-US" };
    const r = await kit.run("remove_bing_sitelink_block", args);
    st.ignoreWrites = true;
    expect((await kit.approveAs(r.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
    expect(await verify("remove_bing_sitelink_block", args, {})).toEqual({ outcome: "not_applied" });
    st.deepLinks.pop();
    expect(await verify("remove_bing_sitelink_block", args, {})).toEqual({ outcome: "applied" });
    expect(fake.mutations).toHaveLength(1);
  });
});
