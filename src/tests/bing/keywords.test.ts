import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { riskOf } from "../../mcp/tool";
import { keywordTools } from "../../platforms/bing/tools/keywords";
import { FakeBing, bingErr, bingHarness, guardProtocol, type BingHarness } from "./fake-bing";
import { kw, ks } from "./performance-fixtures";

const fake = new FakeBing();
guardProtocol(fake);
let kit: BingHarness;
beforeAll(async () => {
  fake.reset();
  kit = await bingHarness("BKW", fake, keywordTools);
});
beforeEach(() => fake.reset());

const data = (r: { ok: boolean; data?: unknown; error?: unknown }) => {
  expect(r.error, JSON.stringify(r.error)).toBeUndefined();
  return r.data as any;
};
const base = { query: "running shoes", country: "us", language: "en-US" };
const range = { start_date: "2026-09-01", end_date: "2026-09-30" };

describe("keyword tools: registration", () => {
  it("registers the 3 tools as reads, matching the inventory's risk", () => {
    const inv = loadInventory();
    expect(keywordTools.map((t) => t.name)).toEqual(["get_bing_keyword_volume", "get_bing_keyword_history", "get_bing_related_keywords"]);
    for (const t of keywordTools) expect(riskOf(t), t.name).toBe(mapTool(inv.find((i) => i.name === t.name)!).risk);
  });
});

describe("get_bing_keyword_volume", () => {
  it("sends q, country, language and ISO dates without siteUrl and returns Bing's counts", async () => {
    fake.handlers.GetKeyword = () => kw("running shoes", 1200, 5400);
    const d = data(await kit.run("get_bing_keyword_volume", { ...base, ...range }));
    const c = fake.of("GetKeyword")[0]!;
    expect(c.http).toBe("GET");
    expect(Object.fromEntries(c.params)).toEqual({ q: "running shoes", country: "us", language: "en-US", startDate: "2026-09-01", endDate: "2026-09-30" });
    expect(d).toMatchObject({ found: true, bing_query: "running shoes", impressions: 1200, broad_impressions: 5400, start_date: "2026-09-01", end_date: "2026-09-30" });
    expect(d.notes.join(" ")).toContain("not this site's traffic");
  });

  it("found is false when Bing answers {\"d\": null}", async () => {
    fake.handlers.GetKeyword = () => undefined;
    const d = data(await kit.run("get_bing_keyword_volume", { ...base, ...range }));
    expect(d).toMatchObject({ found: false, impressions: null, broad_impressions: null, bing_query: null });
  });

  it("validates inputs before calling Bing", async () => {
    const bad = [
      { ...base, ...range, country: "USA" },
      { ...base, ...range, country: "u1" },
      { ...base, ...range, language: "english" },
      { ...base, ...range, language: "" },
      { ...base, ...range, query: "" },
      { ...base, ...range, query: "x".repeat(201) },
      { ...base, start_date: "2026-09-30", end_date: "2026-09-01" },
      { ...base, start_date: "2026-09-01", end_date: "2999-01-01" },
      { ...base, start_date: "2026-02-30", end_date: "2026-03-01" },
      { ...base },
    ];
    for (const a of bad) expect((await kit.run("get_bing_keyword_volume", a)).error, JSON.stringify(a)).toMatchObject({ code: "invalid_argument" });
    expect(fake.of("GetKeyword")).toHaveLength(0);
  });

  it("maps Bing's InvalidParameter and throttling errors", async () => {
    fake.handlers.GetKeyword = () => bingErr(8, "InvalidParameter");
    expect((await kit.run("get_bing_keyword_volume", { ...base, ...range })).error).toMatchObject({ code: "invalid_argument" });
    fake.handlers.GetKeyword = () => bingErr(5, "ThrottleHost");
    expect((await kit.run("get_bing_keyword_volume", { ...base, ...range })).error).toMatchObject({ code: "quota_exceeded" });
  });

  it("works through a read-only connection", async () => {
    fake.handlers.GetKeyword = () => kw("running shoes", 1, 2);
    expect((await kit.run("get_bing_keyword_volume", { ...base, ...range, account_id: kit.readOnlyId })).ok).toBe(true);
  });
});

describe("get_bing_keyword_history", () => {
  it("returns Bing's dated rows newest first with honest truncation; no siteUrl or dates sent", async () => {
    fake.handlers.GetKeywordStats = () => [ks("running shoes", "2026-09-06", 10, 20), ks("running shoes", "2026-09-20", 30, 60), ks("running shoes", "2026-09-13", 20, 40)];
    let d = data(await kit.run("get_bing_keyword_history", base));
    expect(Object.fromEntries(fake.of("GetKeywordStats")[0]!.params)).toEqual({ q: "running shoes", country: "us", language: "en-US" });
    expect(d).toMatchObject({ first_date: "2026-09-06", last_date: "2026-09-20", returned: 3, total: 3, truncated: false });
    expect(d.rows[0]).toEqual({ date: "2026-09-20", impressions: 30, broad_impressions: 60 });
    d = data(await kit.run("get_bing_keyword_history", { ...base, limit: 1 }));
    expect(d).toMatchObject({ returned: 1, total: 3, truncated: true });
  });

  it("explains an empty history", async () => {
    fake.handlers.GetKeywordStats = () => undefined;
    const d = data(await kit.run("get_bing_keyword_history", base));
    expect(d).toMatchObject({ rows: [], first_date: null, total: 0 });
    expect(d.notes.join(" ")).toContain("no history");
  });
});

describe("get_bing_related_keywords", () => {
  it("sorts related keywords by impressions, limits with totals, and sends the documented parameters", async () => {
    fake.handlers.GetRelatedKeywords = () => [kw("trail shoes", 50, 90), kw("best running shoes", 300, 700), kw("shoe sale", 50, 120), kw("", 1, 1)];
    let d = data(await kit.run("get_bing_related_keywords", { ...base, ...range }));
    expect(Object.fromEntries(fake.of("GetRelatedKeywords")[0]!.params)).toEqual({ q: "running shoes", country: "us", language: "en-US", startDate: "2026-09-01", endDate: "2026-09-30" });
    expect(d.keywords.map((k: any) => k.keyword)).toEqual(["best running shoes", "shoe sale", "trail shoes"]);
    expect(d).toMatchObject({ returned: 3, total: 3, truncated: false });
    d = data(await kit.run("get_bing_related_keywords", { ...base, ...range, limit: 2 }));
    expect(d).toMatchObject({ returned: 2, total: 3, truncated: true });
  });

  it("explains an empty answer and refuses a reversed range", async () => {
    fake.handlers.GetRelatedKeywords = () => [];
    const d = data(await kit.run("get_bing_related_keywords", { ...base, ...range }));
    expect(d.notes.join(" ")).toContain("no related keywords");
    expect((await kit.run("get_bing_related_keywords", { ...base, start_date: "2026-10-01", end_date: "2026-09-01" })).error).toMatchObject({ code: "invalid_argument" });
  });
});
