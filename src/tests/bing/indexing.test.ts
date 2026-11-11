import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { createVerifier } from "../../mcp/pipeline";
import { riskOf } from "../../mcp/tool";
import { filterProperties } from "../../platforms/bing/api/indexing";
import { buildHttpMessage, indexingTools } from "../../platforms/bing/tools/indexing";
import { FakeBing, RO_SITE, SITE, bingErr, bingHarness, guardProtocol, type BingHarness } from "./fake-bing";
import { type IndexState, P, info, installIndexHandlers, newIndexState, traffic } from "./indexing-fixtures";

const fake = new FakeBing();
guardProtocol(fake);
let kit: BingHarness;
let s: IndexState;
beforeAll(async () => {
  kit = await bingHarness("BIDX", fake, indexingTools);
});
beforeEach(() => {
  fake.reset();
  s = newIndexState();
  installIndexHandlers(fake, s);
});

let n = 0;
/** A fresh page URL per test, so approvals of earlier tests never de-duplicate a new request. */
const fresh = () => P(`page-${++n}.html`);
const verify = (tool: string, args: Record<string, unknown>, snapshot: unknown) =>
  createVerifier(kit.deps)({ tool, tenantId: kit.tenantId, accountId: kit.accountId, args: { account_id: kit.accountId, ...args }, planSnapshot: snapshot, requestedBy: kit.owner, decidedBy: kit.second });

describe("risk tiers", () => {
  it("each tool declares the risk inventory/mapping.ts assigns", () => {
    const inv = loadInventory();
    for (const t of indexingTools) expect(riskOf(t), t.name).toBe(mapTool(inv.find((x) => x.name === t.name)!).risk);
    expect(indexingTools.map((t) => t.name).sort()).toEqual(["get_bing_directory_index", "get_bing_submission_quota", "inspect_bing_url", "submit_bing_content", "submit_bing_urls"]);
  });
});

describe("inspect_bing_url", () => {
  it("reads GetUrlInfo and GetUrlTrafficInfo (GET, siteUrl + url) and explains the fields", async () => {
    const u = P("shoes");
    s.urlInfo[u] = info(u, { AnchorCount: 50, TotalChildUrlCount: 3 });
    s.traffic[u] = traffic(u, 10, 100);
    const r = await kit.run("inspect_bing_url", { url: u });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      site_url: SITE,
      url: u,
      bing_url: u,
      known_to_bing: true,
      is_page: true,
      http_status: 200,
      discovery_date: "2026-09-01T07:00:00.000Z",
      last_crawled_date: "2026-11-01T07:00:00.000Z",
      document_size: 5120,
      anchor_count: 50,
      total_child_url_count: 3,
      clicks: 10,
      impressions: 100,
    });
    expect((r.data as any).notes.join(" ")).toContain("no documented period");
    for (const m of ["GetUrlInfo", "GetUrlTrafficInfo"]) {
      const c = fake.of(m)[0]!;
      expect(c.http).toBe("GET");
      expect(c.params.get("siteUrl")).toBe(SITE);
      expect(c.params.get("url")).toBe(u);
    }
    expect(fake.mutations).toHaveLength(0);
  });

  it("a directory's HttpStatus 0 is null; {\"d\": null} means Bing knows nothing about the URL", async () => {
    s.urlInfo[SITE] = info("example.com", { IsPage: false, HttpStatus: 0, DocumentSize: 0, TotalChildUrlCount: 100 });
    let r = await kit.run("inspect_bing_url", { url: SITE });
    expect(r.data).toMatchObject({ is_page: false, http_status: null, total_child_url_count: 100, clicks: null, bing_url: "example.com" });
    r = await kit.run("inspect_bing_url", { url: P("never-seen") });
    expect(r.data).toMatchObject({ known_to_bing: false, bing_url: null, discovery_date: null, clicks: null });
    expect((r.data as any).notes[0]).toContain("may not have discovered it");
  });

  it("refuses URLs outside the site and malformed URLs before calling Bing", async () => {
    for (const url of ["https://other.example.org/a", RO_SITE, "ftp://www.example.com/a", "not a url", `${SITE}#frag`]) {
      const r = await kit.run("inspect_bing_url", { url });
      expect(r.error?.code, url).toBe("invalid_argument");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("maps Bing errors: NotFound, throttling, InvalidUrl", async () => {
    fake.handlers.GetUrlInfo = () => bingErr(11, "NotFound");
    expect((await kit.run("inspect_bing_url", { url: P("a") })).error?.code).toBe("not_found");
    fake.handlers.GetUrlInfo = () => bingErr(4, "ThrottleUser");
    expect((await kit.run("inspect_bing_url", { url: P("a") })).error?.code).toBe("quota_exceeded");
    fake.handlers.GetUrlInfo = () => bingErr(7, "InvalidUrl");
    expect((await kit.run("inspect_bing_url", { url: P("a") })).error?.code).toBe("invalid_argument");
  });

  it("works on a read-only connection", async () => {
    const u = `${RO_SITE}x`;
    s.urlInfo[u] = info(u);
    const r = await kit.run("inspect_bing_url", { account_id: kit.readOnlyId, url: u });
    expect(r.ok).toBe(true);
    expect(fake.of("GetUrlInfo")[0]!.params.get("siteUrl")).toBe(RO_SITE);
  });
});

describe("get_bing_directory_index", () => {
  const dir = P("blog/");
  const kids = (from: number, count: number) => Array.from({ length: count }, (_, i) => info(P(`blog/post-${from + i}`), { LastCrawledDate: "/Date(-62135596800000)/" }));

  it("reads pages until an empty one, POSTs GetChildrenUrlInfo with documented FilterProperties, merges traffic", async () => {
    s.urlInfo[dir] = info(dir, { IsPage: false, HttpStatus: 0, TotalChildUrlCount: 3 });
    s.children[dir] = { info: [kids(0, 2), kids(2, 1)], traffic: [[traffic(P("blog/post-0"), 4, 40)], [traffic(P("blog/post-2"), 1, 9)]] };
    const r = await kit.run("get_bing_directory_index", { directory_url: dir, max_pages: 5 });
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d).toMatchObject({ total_child_url_count: 3, first_page: 0, pages_read: 3, next_page: null, returned: 3, total: 3, truncated: false });
    expect(d.children.map((c: any) => [c.url, c.clicks, c.last_crawled_date])).toEqual([
      [P("blog/post-0"), 4, null],
      [P("blog/post-1"), null, null],
      [P("blog/post-2"), 1, null],
    ]);
    const posts = fake.of("GetChildrenUrlInfo");
    expect(posts.map((c) => c.http)).toEqual(["POST", "POST", "POST"]);
    expect(posts[0]!.body).toEqual({ siteUrl: SITE, url: dir, page: 0, filterProperties: { __type: "FilterProperties:#Microsoft.Bing.Webmaster.Api", CrawlDateFilter: 0, DiscoveredDateFilter: 0, DocFlagsFilters: 0, HttpCodeFilters: 0 } });
    expect(posts.map((c) => c.body!.page)).toEqual([0, 1, 2]);
    // Traffic is read (GET) only for non-empty pages.
    expect(fake.of("GetChildrenUrlTrafficInfo").map((c) => [c.http, c.params.get("page")])).toEqual([
      ["GET", "0"],
      ["GET", "1"],
    ]);
  });

  it("says when more pages may exist and which page is next; limit truncates honestly", async () => {
    s.children[dir] = { info: [kids(0, 3), kids(3, 3), kids(6, 3)], traffic: [] };
    let d = (await kit.run("get_bing_directory_index", { directory_url: dir, page: 1, max_pages: 1 })).data as any;
    expect(d).toMatchObject({ first_page: 1, pages_read: 1, next_page: 2, returned: 3, total: 3, truncated: true, total_child_url_count: null });
    expect(d.notes[0]).toBe("More URLs may exist: ask again with page 2.");
    d = (await kit.run("get_bing_directory_index", { directory_url: dir, max_pages: 3, limit: 4 })).data as any;
    expect(d).toMatchObject({ pages_read: 3, next_page: 3, returned: 4, total: 9, truncated: true });
  });

  it("sends filters as the documented enum numbers, OR-ing the [Flags] lists", async () => {
    s.children[dir] = { info: [[]], traffic: [] };
    const r = await kit.run("get_bing_directory_index", { directory_url: dir, crawl_date: "last_three_weeks", discovered_date: "last_month", doc_flags: ["blocked_by_robots_txt", "malware"], http_codes: ["4xx", "5xx", "301"] });
    expect(r.data).toMatchObject({ pages_read: 1, next_page: null, returned: 0, truncated: false });
    expect(fake.of("GetChildrenUrlInfo")[0]!.body!.filterProperties).toMatchObject({ CrawlDateFilter: 4, DiscoveredDateFilter: 2, DocFlagsFilters: 3, HttpCodeFilters: 52 });
    expect((r.data as any).notes).toContain("Filters narrow the index details only; total_child_url_count is unfiltered.");
    expect(filterProperties({ crawlDate: "last_week", discoveredDate: "any", docFlags: [], httpCodes: ["2xx", "3xx", "302", "all_others"] })).toMatchObject({ CrawlDateFilter: 1, HttpCodeFilters: 75 });
  });

  it("validates input: inside the site, bounded pages, known filter values", async () => {
    expect((await kit.run("get_bing_directory_index", { directory_url: "https://elsewhere.example.net/" })).error?.code).toBe("invalid_argument");
    expect((await kit.run("get_bing_directory_index", { directory_url: dir, max_pages: 11 })).error?.code).toBe("invalid_argument");
    expect((await kit.run("get_bing_directory_index", { directory_url: dir, page: 70_000 })).error?.code).toBe("invalid_argument");
    expect((await kit.run("get_bing_directory_index", { directory_url: dir, http_codes: ["418"] })).error?.code).toBe("invalid_argument");
    expect(fake.calls).toHaveLength(0);
  });

  it("a list in an unexpected shape is refused, not guessed", async () => {
    fake.handlers.GetChildrenUrlInfo = () => ({ Url: "x" });
    expect((await kit.run("get_bing_directory_index", { directory_url: dir })).error?.code).toBe("internal");
  });
});

describe("get_bing_submission_quota", () => {
  it("reads both quotas (GET) and labels them as what is left", async () => {
    const r = await kit.run("get_bing_submission_quota");
    expect(r.data).toMatchObject({ site_url: SITE, url_submission: { daily_remaining: 10, monthly_remaining: 300 }, content_submission: { daily_remaining: 100, monthly_remaining: 3000 } });
    expect((r.data as any).notes[0]).toContain("does not describe DailyQuota");
    expect(fake.calls.map((c) => `${c.http} ${c.method}`).sort()).toEqual(["GET GetContentSubmissionQuota", "GET GetUrlSubmissionQuota"]);
  });

  it("missing fields are null, a rejected token is auth_expired", async () => {
    fake.handlers.GetUrlSubmissionQuota = () => ({ __type: "UrlSubmissionQuota:#Microsoft.Bing.Webmaster.Api" });
    expect((await kit.run("get_bing_submission_quota")).data).toMatchObject({ url_submission: { daily_remaining: null, monthly_remaining: null } });
    fake.handlers.GetContentSubmissionQuota = () => bingErr(3, "InvalidApiKey");
    expect((await kit.run("get_bing_submission_quota")).error?.code).toBe("auth_expired");
  });
});

describe("submit_bing_urls", () => {
  it("is a write; requesting queues an approval with one neutral change per URL and sends nothing", async () => {
    const a = fresh();
    const b = fresh();
    const r = await kit.run("submit_bing_urls", { urls: [a, b, a, a.replace("https://www.example.com", "https://WWW.EXAMPLE.COM")] });
    expect(r.approval).toMatchObject({ status: "pending_approval", risk: "write" });
    expect(r.approval!.summary).toBe(
      `Submit 2 URLs of Bing site ${SITE} for crawling: ${a}, ${b}. 2 duplicates were removed. Bing crawls them later and decides itself whether to index them; nothing on the website changes. Uses 2 of the URL submission quota (10 left today, 300 this month).`,
    );
    expect(r.approval!.change_set!.changes.map((c) => [c.id, c.after, c.effect])).toEqual([
      [a, "submitted", "neutral"],
      [b, "submitted", "neutral"],
    ]);
    expect(fake.mutations).toHaveLength(0);
  });

  it("after approval sends one SubmitUrlBatch with the de-duplicated list and reports the quota left", async () => {
    const urls = [fresh(), fresh(), fresh()];
    const r = await kit.run("submit_bing_urls", { urls: [...urls, urls[0]] });
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => c.method)).toEqual(["SubmitUrlBatch"]);
    expect(fake.mutations[0]!.body).toEqual({ siteUrl: SITE, urlList: urls });
    expect(done.result).toMatchObject({ submitted_urls: urls, count: 3, method: "SubmitUrlBatch", quota_after: { daily_remaining: 7, monthly_remaining: 297 } });
    expect((done.result as any).notes.join(" ")).toContain("crawls the URLs later");
  });

  it("one URL uses SubmitUrl {siteUrl, url}", async () => {
    const u = fresh();
    const r = await kit.run("submit_bing_urls", { urls: [u] });
    expect(r.approval!.summary).toContain("Submit 1 URL of Bing site");
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([["SubmitUrl", { siteUrl: SITE, url: u }]]);
  });

  it("refuses URLs outside the site, more than 500, and an empty list, before anything", async () => {
    expect((await kit.run("submit_bing_urls", { urls: [fresh(), "https://shop.example.com/a"] })).error?.code).toBe("invalid_argument");
    expect((await kit.run("submit_bing_urls", { urls: Array.from({ length: 501 }, (_, i) => P(`x${i}`)) })).error?.code).toBe("invalid_argument");
    expect((await kit.run("submit_bing_urls", { urls: [] })).error?.code).toBe("invalid_argument");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses more URLs than the daily or monthly quota left, saying how many fit", async () => {
    s.urlQuota = { DailyQuota: 2, MonthlyQuota: 300 };
    let r = await kit.run("submit_bing_urls", { urls: [fresh(), fresh(), fresh()] });
    expect(r.error).toMatchObject({ code: "quota_exceeded" });
    expect(r.error!.message).toBe("Bing allows 2 more URL submissions today and 300 this month; this needs 3. Submit at most 2. Nothing was sent.");
    s.urlQuota = { DailyQuota: 10, MonthlyQuota: 0 };
    r = await kit.run("submit_bing_urls", { urls: [fresh()] });
    expect(r.error!.message).toContain("Try again after the quota resets.");
    fake.handlers.GetUrlSubmissionQuota = () => undefined;
    r = await kit.run("submit_bing_urls", { urls: [fresh()] });
    expect(r.error!.message).toContain("did not report the remaining URL submission quota");
    expect(fake.mutations).toHaveLength(0);
  });

  it("quota used up between request and approval: refused at execution with nothing sent (a definite failure)", async () => {
    const r = await kit.run("submit_bing_urls", { urls: [fresh(), fresh()] });
    s.urlQuota.DailyQuota = 1;
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect((done.result as any).error.code).toBe("quota_exceeded");
    expect(fake.mutations).toHaveLength(0);
  });

  it("a quota that changed but still fits does not block the approval (it is checked, not snapshotted)", async () => {
    const r = await kit.run("submit_bing_urls", { urls: [fresh()] });
    s.urlQuota.DailyQuota = 4;
    expect((await kit.approveAs(r.approval!.approval_id, kit.owner)).status).toBe("executed");
  });

  it("a read-only connection cannot request it", async () => {
    const r = await kit.run("submit_bing_urls", { account_id: kit.readOnlyId, urls: [`${RO_SITE}a`] });
    expect(r.error?.code).toBe("permission_denied");
    expect(fake.calls).toHaveLength(0);
  });

  it("Bing's InvalidUrl on the POST is a definite failure; a server error is unknown_outcome, sent once", async () => {
    let r = await kit.run("submit_bing_urls", { urls: [fresh()] });
    fake.handlers.SubmitUrl = () => bingErr(7, "InvalidUrl");
    let done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect((done.result as any).error.code).toBe("invalid_argument");
    fake.reset();
    installIndexHandlers(fake, s);
    r = await kit.run("submit_bing_urls", { urls: [fresh(), fresh()] });
    fake.handlers.SubmitUrlBatch = () => bingErr(1, "InternalError", 500);
    done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect(fake.of("SubmitUrlBatch")).toHaveLength(1);
  });

  it("a failed quota read after a confirmed submission is reported as null, not as a failure", async () => {
    const r = await kit.run("submit_bing_urls", { urls: [fresh()] });
    fake.fail = (c) => (c.method === "GetUrlSubmissionQuota" && fake.mutations.length > 0 ? bingErr(4, "ThrottleUser") : undefined);
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
    expect(done.result).toMatchObject({ quota_after: null });
  });

  it("verify is indeterminate: Bing has no read-back of submissions", async () => {
    const v = await verify("submit_bing_urls", { urls: [fresh()] }, { site_url: SITE, urls: [] });
    expect(v.outcome).toBe("indeterminate");
    expect(v.detail).toContain("no read-back");
  });
});

describe("submit_bing_content", () => {
  const html = "<!DOCTYPE html>\n<html><head><title>Test Page</title></head><body><p>Hello world! é</p></body></html>";

  it("builds the HTTP message Bing documents (status line, CRLF headers, empty line, body) and base64-encodes it", () => {
    const b64 = buildHttpMessage({ html, status_code: 200, content_type: "text/html", headers: [{ name: "Last-Modified", value: "Sun, 10 Oct 2017 23:26:07 GMT" }] });
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(html)}\r\nLast-Modified: Sun, 10 Oct 2017 23:26:07 GMT\r\n\r\n${html}`);
    expect(Buffer.from(buildHttpMessage({ html: "x", status_code: 404, content_type: "text/plain", headers: [] }), "base64").toString().split("\r\n")[0]).toBe("HTTP/1.1 404 Not Found");
  });

  it("queues an approval that describes the submission, then sends one SubmitContent with the documented keys", async () => {
    const u = fresh();
    const r = await kit.run("submit_bing_content", { url: u, html, structured_data: '{"@type":"Product"}', dynamic_serving: "mobile" });
    expect(r.approval).toMatchObject({ status: "pending_approval", risk: "write" });
    expect(r.approval!.summary).toBe(
      `Send the content of ${u} to Bing (site ${SITE}) so Bing can index it without crawling: HTTP 200, text/html; charset=utf-8, about 1 KB, structured data, served to mobile devices. Nothing on the website changes; Bing decides whether and when the page appears in results. Uses 1 of the content submission quota (100 left today, 3000 this month).`,
    );
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ resource: "content_submission", id: u, effect: "neutral" });
    expect(fake.mutations).toHaveLength(0);
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
    const sent = fake.of("SubmitContent");
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.body!).sort()).toEqual(["dynamicServing", "httpMessage", "siteUrl", "structuredData", "url"]);
    expect(sent[0]!.body).toMatchObject({ siteUrl: SITE, url: u, dynamicServing: 2, structuredData: Buffer.from('{"@type":"Product"}').toString("base64") });
    expect(Buffer.from(sent[0]!.body!.httpMessage, "base64").toString("utf8")).toContain(`\r\n\r\n${html}`);
    expect(done.result).toMatchObject({ url: u, status_code: 200, structured_data: true, dynamic_serving: "mobile", content_quota_after: { daily_remaining: 99, monthly_remaining: 2999 } });
  });

  it("without structured data sends an empty string and dynamicServing 0", async () => {
    const r = await kit.run("submit_bing_content", { url: fresh(), html });
    await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(fake.of("SubmitContent")[0]!.body).toMatchObject({ structuredData: "", dynamicServing: 0 });
  });

  it("refuses outside the site, header injection, reserved headers, and an exhausted content quota", async () => {
    expect((await kit.run("submit_bing_content", { url: "https://evil.example.net/a", html })).error?.code).toBe("invalid_argument");
    expect((await kit.run("submit_bing_content", { url: fresh(), html, headers: [{ name: "X-A", value: "1\r\nSet-Cookie: x" }] })).error?.code).toBe("invalid_argument");
    expect((await kit.run("submit_bing_content", { url: fresh(), html, headers: [{ name: "content-length", value: "1" }] })).error?.code).toBe("invalid_argument");
    expect((await kit.run("submit_bing_content", { url: fresh(), html, content_type: "text/html\r\nX: y" })).error?.code).toBe("invalid_argument");
    expect((await kit.run("submit_bing_content", { url: fresh(), html: "x".repeat(1_000_001) })).error?.code).toBe("invalid_argument");
    s.contentQuota = { DailyQuota: 0, MonthlyQuota: 10 };
    const r = await kit.run("submit_bing_content", { url: fresh(), html });
    expect(r.error).toMatchObject({ code: "quota_exceeded" });
    expect(fake.mutations).toHaveLength(0);
  });

  it("the input caps keep the largest request under Bing's 10 MB limit", async () => {
    // 1,000,000 three-byte characters (the worst case per UTF-16 unit) and the largest structured data: about 4.8 MB encoded.
    const u = fresh();
    const r = await kit.run("submit_bing_content", { url: u, html: "€".repeat(1_000_000), structured_data: "€".repeat(200_000) });
    expect(r.approval?.status).toBe("pending_approval");
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect((done.result as any).encoded_bytes).toBeLessThan(10 * 1024 * 1024);
  });

  it("a read-only connection cannot request it", async () => {
    expect((await kit.run("submit_bing_content", { account_id: kit.readOnlyId, url: `${RO_SITE}a`, html })).error?.code).toBe("permission_denied");
  });

  it("content quota used up before approval: refused with nothing sent; a server error after sending is unknown_outcome", async () => {
    let r = await kit.run("submit_bing_content", { url: fresh(), html });
    s.contentQuota.DailyQuota = 0;
    let done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect(fake.mutations).toHaveLength(0);
    s.contentQuota.DailyQuota = 5;
    r = await kit.run("submit_bing_content", { url: fresh(), html });
    fake.handlers.SubmitContent = () => bingErr(2, "UnknownError", 500);
    done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect(fake.of("SubmitContent")).toHaveLength(1);
  });

  it("verify is indeterminate", async () => {
    expect((await verify("submit_bing_content", { url: fresh(), html }, { site_url: SITE })).outcome).toBe("indeterminate");
  });
});
