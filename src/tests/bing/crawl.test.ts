import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { createVerifier } from "../../mcp/pipeline";
import { riskOf } from "../../mcp/tool";
import { decodeCrawlIssues } from "../../platforms/bing/api/crawl";
import { crawlTools } from "../../platforms/bing/tools/crawl";
import { BING_ERROR } from "../../platforms/bing/http";
import { type BingHarness, FakeBing, SITE, bingErr, bingHarness, guardProtocol, wcfDay } from "./fake-bing";

const fake = new FakeBing();
guardProtocol(fake);
let kit: BingHarness;
beforeAll(async () => {
  fake.reset();
  kit = await bingHarness("BCRAWL", fake, crawlTools);
});

/** Live crawl settings the fake serves; SaveCrawlSettings replaces them (unless `ignoreSave`). */
let settings: Record<string, any>;
let ignoreSave = false;
const rates = (v = 5) => Array.from({ length: 24 }, () => v);
beforeEach(() => {
  fake.reset();
  ignoreSave = false;
  settings = { __type: "CrawlSettings:#Microsoft.Bing.Webmaster.Api", CrawlBoostAvailable: true, CrawlBoostEnabled: false, CrawlRate: rates() };
  fake.handlers.GetCrawlSettings = () => structuredClone(settings);
  fake.handlers.SaveCrawlSettings = (c) => {
    if (!ignoreSave) settings = { ...settings, ...structuredClone(c.body!.crawlSettings) };
    return undefined;
  };
});

const statsRow = (day: string, o: Record<string, number> = {}) => ({
  __type: "CrawlStats:#Microsoft.Bing.Webmaster.Api",
  AllOtherCodes: 0,
  BlockedByRobotsTxt: 0,
  Code2xx: 9998,
  Code301: 0,
  Code302: 0,
  Code4xx: 1,
  Code5xx: 1,
  ConnectionTimeout: 0,
  ContainsMalware: 5,
  CrawlErrors: 0,
  CrawledPages: 0,
  Date: wcfDay(day),
  DnsFailures: 0,
  InIndex: 1000,
  InLinks: 2048,
  ...o,
});

describe("get_bing_crawl_stats", () => {
  it("maps every documented CrawlStats field per day, newest first, with Bing's window", async () => {
    fake.handlers.GetCrawlStats = () => [statsRow("2026-11-01"), statsRow("2026-11-03", { CrawledPages: 40, DnsFailures: 2, ConnectionTimeout: 3 }), statsRow("2026-11-02")];
    const r = await kit.run("get_bing_crawl_stats");
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d.days.map((x: any) => x.date)).toEqual(["2026-11-03", "2026-11-02", "2026-11-01"]);
    expect(d.days[0]).toEqual({ date: "2026-11-03", crawled_pages: 40, crawl_errors: 0, in_index: 1000, in_links: 2048, code_2xx: 9998, code_301: 0, code_302: 0, code_4xx: 1, code_5xx: 1, all_other_codes: 0, blocked_by_robots_txt: 0, contains_malware: 5, dns_failures: 2, connection_timeout: 3 });
    expect(d).toMatchObject({ site_url: SITE, first_day: "2026-11-01", last_day: "2026-11-03", returned: 3, total: 3, truncated: false });
    expect(d.notes.join(" ")).toContain("about the last 6 months");
    const call = fake.of("GetCrawlStats")[0]!;
    expect(call.http).toBe("GET");
    expect(call.params.get("siteUrl")).toBe(SITE);
  });

  it("filters by date, reports truncation, and says when the range has no data", async () => {
    fake.handlers.GetCrawlStats = () => ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"].map((x) => statsRow(x));
    let d = (await kit.run("get_bing_crawl_stats", { start_date: "2026-10-02", end_date: "2026-10-04", limit: 2 })).data as any;
    expect(d.days.map((x: any) => x.date)).toEqual(["2026-10-04", "2026-10-03"]);
    expect(d).toMatchObject({ returned: 2, total: 3, truncated: true });
    d = (await kit.run("get_bing_crawl_stats", { start_date: "2025-01-01", end_date: "2025-01-31" })).data as any;
    expect(d.days).toEqual([]);
    expect(d.notes.join(" ")).toContain("Bing has 2026-10-01 to 2026-10-04");
  });

  it("an empty answer is no rows; bad dates are refused before calling Bing", async () => {
    fake.handlers.GetCrawlStats = () => undefined;
    expect((await kit.run("get_bing_crawl_stats")).data).toMatchObject({ days: [], total: 0, first_day: null });
    expect((await kit.run("get_bing_crawl_stats", { start_date: "2026-02-30" })).error?.code).toBe("invalid_argument");
    expect((await kit.run("get_bing_crawl_stats", { start_date: "2026-03-02", end_date: "2026-03-01" })).error?.code).toBe("invalid_argument");
    expect(fake.of("GetCrawlStats")).toHaveLength(1);
  });

  it("maps Bing errors", async () => {
    fake.handlers.GetCrawlStats = () => bingErr(BING_ERROR.NotAuthorized, "NotAuthorized");
    expect((await kit.run("get_bing_crawl_stats")).error?.code).toBe("platform_permission_denied");
    fake.handlers.GetCrawlStats = () => bingErr(BING_ERROR.ThrottleUser, "ThrottleUser");
    expect((await kit.run("get_bing_crawl_stats")).error?.code).toBe("quota_exceeded");
  });
});

describe("get_bing_crawl_issues", () => {
  it("decodes the documented CrawlIssues flags, including combined and unnamed bits", () => {
    expect(decodeCrawlIssues(32)).toEqual({ issues: ["ContainsMalware"], unrecognized: [] });
    expect(decodeCrawlIssues(0)).toEqual({ issues: [], unrecognized: [] });
    expect(decodeCrawlIssues(1 + 4 + 64 + 256)).toEqual({ issues: ["Code301", "Code4xx", "ImportantUrlBlockedByRobotsTxt", "TimeOutErrors"], unrecognized: [] });
    expect(decodeCrawlIssues(8 + 512 + 2048)).toEqual({ issues: ["Code5xx"], unrecognized: ["bit 512", "bit 2048"] });
    expect(decodeCrawlIssues("ContainsMalware, DnsErrors")).toEqual({ issues: ["ContainsMalware", "DnsErrors"], unrecognized: [] });
    expect(decodeCrawlIssues("NewThing")).toEqual({ issues: [], unrecognized: ["NewThing"] });
    expect(decodeCrawlIssues("128")).toEqual({ issues: ["DnsErrors"], unrecognized: [] });
  });

  it("lists URLs by inbound links with decoded issues and counts per issue; filters by issue", async () => {
    fake.handlers.GetCrawlIssues = () => [
      { __type: "UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api", HttpCode: 200, Issues: 32, Url: `${SITE}url1.htm`, InLinks: 10 },
      { __type: "UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api", HttpCode: 404, Issues: 4 + 16, Url: `${SITE}gone`, InLinks: 50 },
      { __type: "UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api", HttpCode: 500, Issues: 8, Url: `${SITE}err`, InLinks: 0 },
    ];
    let d = (await kit.run("get_bing_crawl_issues")).data as any;
    expect(d.urls.map((u: any) => u.url)).toEqual([`${SITE}gone`, `${SITE}url1.htm`, `${SITE}err`]);
    expect(d.urls[0]).toEqual({ url: `${SITE}gone`, http_code: 404, in_links: 50, issues: ["Code4xx", "BlockedByRobotsTxt"], unrecognized_issues: [] });
    expect(d.issue_counts).toEqual({ ContainsMalware: 1, Code4xx: 1, BlockedByRobotsTxt: 1, Code5xx: 1 });
    expect(d.issue_meanings.ContainsMalware).toContain("malware");
    expect(d.notes[0]).toContain("few days");
    d = (await kit.run("get_bing_crawl_issues", { issue: "Code5xx" })).data as any;
    expect(d.urls.map((u: any) => u.url)).toEqual([`${SITE}err`]);
    expect(d).toMatchObject({ returned: 1, total: 1, truncated: false, issue_counts: { Code5xx: 1 } });
    d = (await kit.run("get_bing_crawl_issues", { limit: 1 })).data as any;
    expect(d).toMatchObject({ returned: 1, total: 3, truncated: true });
  });

  it("refuses an issue name the docs do not define", async () => {
    expect((await kit.run("get_bing_crawl_issues", { issue: "Code404" })).error?.code).toBe("invalid_argument");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("get_bing_crawl_settings", () => {
  it("returns the 24 hourly rates relative to the baseline and the crawl boost flags", async () => {
    settings.CrawlRate = [...rates(5).slice(0, 16), 6, 6, 6, 5, 4, 3, 3, 4]; // the SaveCrawlSettings sample's values
    const d = (await kit.run("get_bing_crawl_settings")).data as any;
    expect(d.crawl_rate).toHaveLength(24);
    expect(d.crawl_rate[0]).toEqual({ hour: 0, rate: 5, relative: "baseline" });
    expect(d.crawl_rate[16]).toEqual({ hour: 16, rate: 6, relative: "faster than baseline" });
    expect(d.crawl_rate[21]).toEqual({ hour: 21, rate: 3, relative: "slower than baseline" });
    expect(d).toMatchObject({ site_url: SITE, crawl_boost_available: true, crawl_boost_enabled: false });
    expect(d.notes.join(" ")).toContain("does not say which time zone");
  });

  it("reads the GET sample shape (AjaxEnabled, no boost fields) and a base64 CrawlRate", async () => {
    settings = { __type: "CrawlSettings:#Microsoft.Bing.Webmaster.Api", AjaxEnabled: true, CrawlRate: Buffer.from(rates(5)).toString("base64") };
    const d = (await kit.run("get_bing_crawl_settings")).data as any;
    expect(d.crawl_rate.map((x: any) => x.rate)).toEqual(rates(5));
    expect(d).toMatchObject({ crawl_boost_available: null, crawl_boost_enabled: null });
  });

  it("a rate array of another length is reported, and a malformed one is an error", async () => {
    settings.CrawlRate = [5, 5];
    expect(((await kit.run("get_bing_crawl_settings")).data as any).notes.join(" ")).toContain("returned 2 hourly values instead of 24");
    settings.CrawlRate = ["x"];
    expect((await kit.run("get_bing_crawl_settings")).error?.code).toBe("internal");
  });
});

describe("update_bing_crawl_settings", () => {
  const verify = (args: Record<string, unknown>, snapshot: unknown) =>
    createVerifier(kit.deps)({ tool: "update_bing_crawl_settings", tenantId: kit.tenantId, accountId: kit.accountId, args: { account_id: kit.accountId, ...args }, planSnapshot: snapshot, requestedBy: kit.owner, decidedBy: kit.second });

  it("queues a high-impact approval with before/after per hour and sends nothing until approved", async () => {
    const r = await kit.run("update_bing_crawl_settings", { hours: [{ hour: 2, rate: 8 }, { hour: 14, rate: 3 }] });
    expect(r.approval).toMatchObject({ status: "pending_approval", risk: "high_impact" });
    expect(r.approval!.summary).toContain(`Change Bing Crawl Control for ${SITE}: hour 02: 5 → 8 (faster; faster than baseline); hour 14: 5 → 3 (slower; slower than baseline).`);
    expect(r.approval!.summary).toContain("Faster crawling adds load to the web server.");
    expect(r.approval!.summary).toContain("Slower crawling can delay Bing");
    expect(r.approval!.change_set!.changes).toEqual([
      { resource: "bing_crawl_settings", id: SITE, name: null, field: "crawl_rate_hour_02", before: 5, after: 8, unit: "text", effect: "enable" },
      { resource: "bing_crawl_settings", id: SITE, name: null, field: "crawl_rate_hour_14", before: 5, after: 3, unit: "text", effect: "pause" },
    ]);
    expect(fake.mutations).toHaveLength(0);
  });

  it("after approval saves the whole settings object once (other hours and fields kept) and reads it back", async () => {
    settings.AjaxEnabled = true;
    const r = await kit.run("update_bing_crawl_settings", { hours: [{ hour: 0, rate: 7 }], crawl_boost_enabled: true });
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(fake.mutations).toHaveLength(1);
    const sent = fake.of("SaveCrawlSettings")[0]!;
    expect(sent.body).toEqual({ siteUrl: SITE, crawlSettings: { __type: "CrawlSettings:#Microsoft.Bing.Webmaster.Api", CrawlRate: [7, ...rates(5).slice(1)], CrawlBoostAvailable: true, CrawlBoostEnabled: true, AjaxEnabled: true } });
    expect(done.result).toEqual({ site_url: SITE, crawl_rate: [7, ...rates(5).slice(1)], crawl_boost_enabled: true, changed: ["crawl_rate_hour_00", "crawl_boost_enabled"] });
  });

  it("all_hours_rate sets every hour; slowing only is a plain write approval", async () => {
    settings.CrawlRate = rates(6);
    const r = await kit.run("update_bing_crawl_settings", { all_hours_rate: 4 });
    expect(r.approval).toMatchObject({ risk: "write" });
    expect(r.approval!.change_set!.changes).toHaveLength(24);
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
    expect(settings.CrawlRate).toEqual(rates(4));
  });

  it("validates input: ranges, duplicate hours, nothing given, hours with all_hours_rate", async () => {
    for (const args of [{ hours: [{ hour: 24, rate: 5 }] }, { hours: [{ hour: 1, rate: 0 }] }, { hours: [{ hour: 1, rate: 11 }] }, { hours: [{ hour: 1, rate: 6 }, { hour: 1, rate: 7 }] }, {}, { hours: [{ hour: 1, rate: 6 }], all_hours_rate: 5 }, { all_hours_rate: 2.5 }])
      expect((await kit.run("update_bing_crawl_settings", args)).error?.code, JSON.stringify(args)).toBe("invalid_argument");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses no-op changes, boost where Bing says it is unavailable, and a rate list it cannot map to hours", async () => {
    expect((await kit.run("update_bing_crawl_settings", { hours: [{ hour: 3, rate: 5 }] })).error?.message).toContain("Nothing would change");
    settings.CrawlBoostAvailable = false;
    expect((await kit.run("update_bing_crawl_settings", { crawl_boost_enabled: true })).error?.message).toContain("not report crawl boost as available");
    settings.CrawlRate = rates(5).slice(0, 12);
    expect((await kit.run("update_bing_crawl_settings", { hours: [{ hour: 3, rate: 6 }] })).error?.code).toBe("unsupported");
    expect(fake.mutations).toHaveLength(0);
  });

  it("a read-only connection cannot request it", async () => {
    const r = await kit.run("update_bing_crawl_settings", { account_id: kit.readOnlyId, all_hours_rate: 6 });
    expect(r.error?.code).toBe("permission_denied");
    expect(fake.mutations).toHaveLength(0);
  });

  it("settings changed between request and approval: conflict, nothing sent", async () => {
    const r = await kit.run("update_bing_crawl_settings", { hours: [{ hour: 5, rate: 9 }] });
    settings.CrawlRate = rates(6);
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect((done.result as any).error.code).toBe("conflict");
    expect(fake.mutations).toHaveLength(0);
  });

  it("a server error on save is an unknown outcome, sent once; a save that does not read back is unknown too", async () => {
    let r = await kit.run("update_bing_crawl_settings", { hours: [{ hour: 6, rate: 9 }] });
    fake.handlers.SaveCrawlSettings = () => bingErr(BING_ERROR.InternalError, "InternalError", 500);
    let done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect(fake.of("SaveCrawlSettings")).toHaveLength(1);

    fake.reset();
    fake.handlers.GetCrawlSettings = () => structuredClone(settings);
    fake.handlers.SaveCrawlSettings = () => undefined; // accepted but not applied
    r = await kit.run("update_bing_crawl_settings", { hours: [{ hour: 7, rate: 9 }] });
    done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect((done.result as any).error.message).toContain("do not read back");
  });

  it("a failed read-back after the save is an unknown outcome, never a failure", async () => {
    const r = await kit.run("update_bing_crawl_settings", { hours: [{ hour: 8, rate: 9 }] });
    fake.fail = (c) => (c.method === "GetCrawlSettings" && fake.mutations.length > 0 ? bingErr(BING_ERROR.ThrottleUser, "ThrottleUser") : undefined);
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect((done.result as any).error.message).toContain("reading it back failed");
    expect(fake.mutations).toHaveLength(1);
  });

  it("verify: applied, not_applied, indeterminate", async () => {
    const snap = { site_url: SITE, crawl_rate: rates(5), crawl_boost_available: true, crawl_boost_enabled: false, ajax_enabled: null };
    const args = { hours: [{ hour: 1, rate: 9 }] };
    expect(await verify(args, snap)).toEqual({ outcome: "not_applied" });
    settings.CrawlRate = [5, 9, ...rates(5).slice(2)];
    expect(await verify(args, snap)).toEqual({ outcome: "applied" });
    settings.CrawlRate = rates(7);
    expect((await verify(args, snap)).outcome).toBe("indeterminate");
  });
});

describe("crawl tool registry", () => {
  it("declares the inventory's risk tiers", () => {
    const inv = loadInventory();
    const want: Record<string, string> = { get_bing_crawl_stats: "read", get_bing_crawl_issues: "read", get_bing_crawl_settings: "read", update_bing_crawl_settings: "high_impact" };
    expect(crawlTools.map((t) => t.name).sort()).toEqual(Object.keys(want).sort());
    for (const t of crawlTools) {
      expect(riskOf(t), t.name).toBe(want[t.name]);
      expect(mapTool(inv.find((x) => x.name === t.name)!).risk, t.name).toBe(riskOf(t));
      expect(t.platform).toBe("bing_webmaster");
    }
  });
});
