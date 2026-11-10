import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { createVerifier } from "../../mcp/pipeline";
import { riskOf } from "../../mcp/tool";
import { BING_ERROR } from "../../platforms/bing/http";
import { sitemapTools } from "../../platforms/bing/tools/sitemaps";
import { type BingHarness, FakeBing, SITE, SITE2, bingErr, bingHarness, guardProtocol } from "./fake-bing";

const fake = new FakeBing();
guardProtocol(fake);
let kit: BingHarness;
beforeAll(async () => {
  fake.reset();
  kit = await bingHarness("BSMAP", fake, sitemapTools);
});

/** The fake's sitemap list per site; SubmitFeed adds or re-stamps, RemoveFeed removes (unless `ignoreWrites`). */
let feeds: Record<string, Record<string, unknown>[]>;
let ignoreWrites = false;
const CLOCK = "/Date(1762761600000-0800)/"; // 2025-11-10T08:00:00Z
const feed = (url: string, o: Record<string, unknown> = {}) => ({
  __type: "Feed:#Microsoft.Bing.Webmaster.Api",
  Compressed: false,
  FileSize: 1024,
  LastCrawled: "/Date(1315781995040-0700)/",
  Status: "Success",
  Submitted: "/Date(1316213995040-0700)/",
  Type: "Sitemap",
  Url: url,
  UrlCount: 1023,
  ...o,
});
beforeEach(() => {
  fake.reset();
  ignoreWrites = false;
  feeds = {};
  fake.handlers.GetFeeds = (c) => structuredClone(feeds[c.params.get("siteUrl")!] ?? []);
  fake.handlers.SubmitFeed = (c) => {
    if (ignoreWrites) return undefined;
    const list = (feeds[c.body!.siteUrl] ??= []);
    const f = list.find((x) => x.Url === c.body!.feedUrl);
    if (f) f.Submitted = CLOCK;
    else list.push({ __type: "Feed:#Microsoft.Bing.Webmaster.Api", Url: c.body!.feedUrl, Submitted: CLOCK, Status: "Pending", Type: null, UrlCount: 0, FileSize: 0, Compressed: false, LastCrawled: "/Date(-62135596800000)/" });
    return undefined;
  };
  fake.handlers.RemoveFeed = (c) => {
    if (!ignoreWrites) feeds[c.body!.siteUrl] = (feeds[c.body!.siteUrl] ?? []).filter((x) => x.Url !== c.body!.feedUrl);
    return undefined;
  };
});

let n = 0;
const url = (base = SITE) => `${base}sitemap-${++n}.xml`;
const verify = (tool: string, args: Record<string, unknown>, snapshot: unknown) =>
  createVerifier(kit.deps)({ tool, tenantId: kit.tenantId, accountId: kit.accountId, args: { account_id: kit.accountId, ...args }, planSnapshot: snapshot, requestedBy: kit.owner, decidedBy: kit.second });

describe("list_bing_sitemaps", () => {
  it("maps the documented Feed fields with WCF dates, sorted by URL, with honest totals", async () => {
    feeds[SITE] = [feed(`${SITE}z.xml`), feed(`${SITE}a.xml`, { LastCrawled: "/Date(-62135596800000)/", Compressed: true })];
    let d = (await kit.run("list_bing_sitemaps")).data as any;
    expect(d.sitemaps.map((s: any) => s.url)).toEqual([`${SITE}a.xml`, `${SITE}z.xml`]);
    expect(d.sitemaps[1]).toEqual({ url: `${SITE}z.xml`, type: "Sitemap", status: "Success", url_count: 1023, file_size_bytes: 1024, compressed: false, submitted: "2011-09-16T22:59:55.040Z", last_crawled: "2011-09-11T22:59:55.040Z" });
    expect(d.sitemaps[0]).toMatchObject({ compressed: true, last_crawled: null });
    expect(d).toMatchObject({ site_url: SITE, returned: 2, total: 2, truncated: false });
    d = (await kit.run("list_bing_sitemaps", { limit: 1 })).data as any;
    expect(d).toMatchObject({ returned: 1, total: 2, truncated: true });
    expect(fake.of("GetFeeds")[0]).toMatchObject({ http: "GET" });
  });

  it("no sitemaps is an empty list; a non-list answer is an error", async () => {
    fake.handlers.GetFeeds = () => undefined;
    expect((await kit.run("list_bing_sitemaps")).data).toMatchObject({ sitemaps: [], total: 0 });
    fake.handlers.GetFeeds = () => ({ Url: "x" });
    expect((await kit.run("list_bing_sitemaps")).error?.code).toBe("internal");
  });
});

describe("get_bing_sitemap", () => {
  it("returns the top-level entry and what GetFeedDetails reports, passing feedUrl as a plain query value", async () => {
    const idx = `${SITE}sitemap_index.xml`;
    feeds[SITE] = [feed(idx)];
    fake.handlers.GetFeedDetails = () => [feed(`${SITE}s2.xml`, { UrlCount: 5 }), feed(`${SITE}s1.xml`)];
    const d = (await kit.run("get_bing_sitemap", { sitemap_url: idx })).data as any;
    expect(d.sitemap).toMatchObject({ url: idx, url_count: 1023 });
    expect(d.entries.map((e: any) => e.url)).toEqual([`${SITE}s1.xml`, `${SITE}s2.xml`]);
    expect(d).toMatchObject({ returned: 2, total: 2, truncated: false });
    expect(fake.of("GetFeedDetails")[0]!.params.get("feedUrl")).toBe(idx);
  });

  it("says when the sitemap is not top-level; maps NotFound", async () => {
    fake.handlers.GetFeedDetails = () => undefined;
    const d = (await kit.run("get_bing_sitemap", { sitemap_url: `${SITE}child.xml` })).data as any;
    expect(d.sitemap).toBeNull();
    expect(d.notes.join(" ")).toContain("not in this site's top-level sitemap list");
    fake.handlers.GetFeedDetails = () => bingErr(BING_ERROR.NotFound, "NotFound");
    expect((await kit.run("get_bing_sitemap", { sitemap_url: `${SITE}child.xml` })).error?.code).toBe("not_found");
    expect((await kit.run("get_bing_sitemap", { sitemap_url: "ftp://x/s.xml" })).error?.code).toBe("invalid_argument");
  });
});

describe("submit_bing_sitemap", () => {
  it("is a write: queues a neutral change and sends nothing; after approval one POST and a read-back", async () => {
    const u = url();
    const r = await kit.run("submit_bing_sitemap", { sitemap_url: u });
    expect(r.approval).toMatchObject({ status: "pending_approval", risk: "write" });
    expect(r.approval!.summary).toBe(`Submit sitemap ${u} to Bing for ${SITE}. Bingbot reads it later. Nothing changes on the website, and this does not by itself get any page indexed.`);
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ resource: "bing_sitemap", id: u, before: null, after: "submitted", effect: "neutral" });
    expect(fake.mutations).toHaveLength(0);
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([["SubmitFeed", { siteUrl: SITE, feedUrl: u }]]);
    expect(done.result).toEqual({ site_url: SITE, sitemap_url: u, resubmitted: false, submitted: "2025-11-10T08:00:00.000Z", status: "Pending" });
  });

  it("resubmitting a listed sitemap says so and describes it", async () => {
    const u = url();
    feeds[SITE] = [feed(u)];
    const r = await kit.run("submit_bing_sitemap", { sitemap_url: u });
    expect(r.approval!.summary).toContain(`Resubmit sitemap ${u} to Bing for ${SITE} (type Sitemap, status Success, 1,023 URLs, submitted 2011-09-16T22:59:55.040Z, last read 2011-09-11T22:59:55.040Z).`);
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ before: "2011-09-16T22:59:55.040Z", after: "resubmitted" });
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.result).toMatchObject({ resubmitted: true, submitted: "2025-11-10T08:00:00.000Z" });
  });

  it("refuses a sitemap outside the site and a read-only connection; nothing sent", async () => {
    expect((await kit.run("submit_bing_sitemap", { sitemap_url: `${SITE2}s.xml` })).error?.code).toBe("invalid_argument");
    expect((await kit.run("submit_bing_sitemap", { sitemap_url: "https://other.test/s.xml" })).error?.message).toContain("is not inside the Bing site");
    expect((await kit.run("submit_bing_sitemap", { account_id: kit.readOnlyId, sitemap_url: "https://ro.example.com/s.xml" })).error?.code).toBe("permission_denied");
    expect(fake.mutations).toHaveLength(0);
  });

  it("someone resubmitting between request and approval is a conflict; nothing is sent", async () => {
    const u = url();
    feeds[SITE] = [feed(u)];
    const r = await kit.run("submit_bing_sitemap", { sitemap_url: u });
    feeds[SITE]![0]!.Submitted = CLOCK;
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect((done.result as any).error.code).toBe("conflict");
    expect(fake.mutations).toHaveLength(0);
  });

  it("a server error is an unknown outcome sent once; a submission that does not read back is unknown too", async () => {
    let r = await kit.run("submit_bing_sitemap", { sitemap_url: url() });
    fake.handlers.SubmitFeed = () => bingErr(BING_ERROR.InternalError, "InternalError", 500);
    let done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect(fake.of("SubmitFeed")).toHaveLength(1);

    fake.handlers.SubmitFeed = () => undefined;
    r = await kit.run("submit_bing_sitemap", { sitemap_url: url() });
    done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect((done.result as any).error.message).toContain("not in the site's sitemap list yet");
  });

  it("an invalid URL rejected by Bing is a definite failure", async () => {
    const r = await kit.run("submit_bing_sitemap", { sitemap_url: url() });
    fake.handlers.SubmitFeed = () => bingErr(BING_ERROR.InvalidUrl, "InvalidUrl");
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect((done.result as any).error.code).toBe("invalid_argument");
  });

  it("verify: applied, not_applied, indeterminate", async () => {
    const u = url();
    expect(await verify("submit_bing_sitemap", { sitemap_url: u }, { site_url: SITE, existing: null })).toEqual({ outcome: "not_applied" });
    feeds[SITE] = [feed(u, { Submitted: CLOCK })];
    expect(await verify("submit_bing_sitemap", { sitemap_url: u }, { site_url: SITE, existing: null })).toEqual({ outcome: "applied" });
    expect(await verify("submit_bing_sitemap", { sitemap_url: u }, { site_url: SITE, existing: { submitted: "2011-09-16T22:59:55.040Z" } })).toEqual({ outcome: "applied" });
    expect((await verify("submit_bing_sitemap", { sitemap_url: u }, { site_url: SITE, existing: { submitted: "2025-11-10T08:00:00.000Z" } })).outcome).toBe("indeterminate");
  });
});

describe("remove_bing_sitemap", () => {
  it("is destructive: summary keeps the file, after approval one POST and it is gone", async () => {
    const u = url();
    feeds[SITE] = [feed(u)];
    const r = await kit.run("remove_bing_sitemap", { sitemap_url: u });
    expect(r.approval).toMatchObject({ risk: "destructive" });
    expect(r.approval!.summary).toContain(`Remove sitemap ${u} from Bing Webmaster Tools for ${SITE}`);
    expect(r.approval!.summary).toContain("The file on the website is not changed.");
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ effect: "remove", after: null });
    expect(fake.mutations).toHaveLength(0);
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(done.result).toEqual({ site_url: SITE, sitemap_url: u, removed: true });
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([["RemoveFeed", { siteUrl: SITE, feedUrl: u }]]);
    expect(feeds[SITE]).toEqual([]);
  });

  it("a sitemap that is not in the list is not_found; nothing sent", async () => {
    expect((await kit.run("remove_bing_sitemap", { sitemap_url: url() })).error?.code).toBe("not_found");
    expect(fake.mutations).toHaveLength(0);
  });

  it("removed by someone else before approval: refused, nothing sent", async () => {
    const u = url();
    feeds[SITE] = [feed(u)];
    const r = await kit.run("remove_bing_sitemap", { sitemap_url: u });
    feeds[SITE] = [];
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("failed");
    expect(fake.mutations).toHaveLength(0);
  });

  it("still listed after the POST is an unknown outcome; verify reads the list", async () => {
    const u = url();
    feeds[SITE] = [feed(u)];
    const r = await kit.run("remove_bing_sitemap", { sitemap_url: u });
    ignoreWrites = true;
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("unknown_outcome");
    expect(await verify("remove_bing_sitemap", { sitemap_url: u }, {})).toEqual({ outcome: "not_applied" });
    feeds[SITE] = [];
    expect(await verify("remove_bing_sitemap", { sitemap_url: u }, {})).toEqual({ outcome: "applied" });
  });
});

describe("sitemap tool registry", () => {
  it("declares the inventory's risk tiers", () => {
    const inv = loadInventory();
    const want: Record<string, string> = { list_bing_sitemaps: "read", get_bing_sitemap: "read", submit_bing_sitemap: "write", remove_bing_sitemap: "destructive" };
    expect(sitemapTools.map((t) => t.name).sort()).toEqual(Object.keys(want).sort());
    for (const t of sitemapTools) {
      expect(riskOf(t), t.name).toBe(want[t.name]);
      expect(mapTool(inv.find((x) => x.name === t.name)!).risk, t.name).toBe(riskOf(t));
    }
  });
});
