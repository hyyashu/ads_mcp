import { describe, expect, it } from "vitest";
import { addDays, checkDates, filterSchema, minusMonths, oldestAllowed, pacificToday, siteUrlSchema, validateQuery, withinProperty, type QueryShape } from "../../platforms/gsc/tools/common";

describe("Search Console date helpers", () => {
  it("today is Pacific Time across the UTC midnight", () => {
    expect(pacificToday(new Date("2026-11-10T07:30:00Z"))).toBe("2026-11-09");
    expect(pacificToday(new Date("2026-11-10T08:30:00Z"))).toBe("2026-11-10");
    expect(pacificToday(new Date("2026-07-01T06:59:00Z"))).toBe("2026-06-30"); // PDT, UTC-7
  });
  it("adds days and subtracts months, clamped to the month end", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(minusMonths("2026-11-10", 16)).toBe("2025-07-10");
    expect(minusMonths("2026-06-30", 16)).toBe("2025-02-28");
    expect(oldestAllowed("2026-11-10")).toBe("2025-07-10");
  });
  it("checks start <= end <= today and the 16-month window", () => {
    expect(() => checkDates("2025-07-10", "2026-11-10", "2026-11-10")).not.toThrow();
    expect(() => checkDates("2025-07-09", "2026-11-10", "2026-11-10")).toThrow(/16 months.*2025-07-10/);
    expect(() => checkDates("2026-11-01", "2026-11-11", "2026-11-10")).toThrow(/after today/);
    expect(() => checkDates("2026-11-02", "2026-11-01", "2026-11-10")).toThrow(/after end_date/);
  });
});

describe("property membership", () => {
  it("domain properties cover the domain and subdomains over http and https", () => {
    expect(withinProperty("sc-domain:example.com", "https://example.com/a")).toBe(true);
    expect(withinProperty("sc-domain:example.com", "http://www.shop.example.com/")).toBe(true);
    expect(withinProperty("sc-domain:example.com", "https://badexample.com/")).toBe(false);
    expect(withinProperty("sc-domain:example.com", "ftp://example.com/")).toBe(false);
    expect(withinProperty("sc-domain:example.com", "not a url")).toBe(false);
  });
  it("URL-prefix properties are a prefix match (scheme and host included)", () => {
    expect(withinProperty("https://shop.example.com/", "https://shop.example.com/p/1")).toBe(true);
    expect(withinProperty("https://shop.example.com/", "http://shop.example.com/p/1")).toBe(false);
    expect(withinProperty("https://shop.example.com/", "https://shop.example.com.evil.test/")).toBe(false);
  });
  it("URL-prefix matching normalises the URL first: dot segments resolved, host case ignored", () => {
    expect(withinProperty("https://example.com/blog/", "https://example.com/blog/../admin")).toBe(false);
    expect(withinProperty("https://example.com/blog/", "https://example.com/blog/%2e%2e/admin")).toBe(false);
    expect(withinProperty("https://example.com/blog/", "https://example.com/blog/./post")).toBe(true);
    expect(withinProperty("https://example.com/blog/", "https://EXAMPLE.com/blog/post")).toBe(true);
    expect(withinProperty("https://example.com/blog/", "https://example.com/other/../blog/post")).toBe(true);
  });
});

describe("input schemas", () => {
  it("site URLs: domain or prefix with trailing slash; never fixed silently", () => {
    expect(siteUrlSchema.safeParse("sc-domain:example.com").success).toBe(true);
    expect(siteUrlSchema.safeParse("https://www.example.com/").success).toBe(true);
    const r = siteUrlSchema.safeParse("https://www.example.com");
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toContain("https://www.example.com/");
    for (const bad of ["sc-domain:", "sc-domain:exa mple.com", "ftp://x.com/", "https://u:p@x.com/", "https://x.com/?q=1"]) expect(siteUrlSchema.safeParse(bad).success, bad).toBe(false);
  });
  it("filters: country codes and device values are checked", () => {
    expect(filterSchema.safeParse({ dimension: "country", expression: "usa" }).success).toBe(true);
    expect(filterSchema.safeParse({ dimension: "country", expression: "US" }).success).toBe(false);
    expect(filterSchema.safeParse({ dimension: "country", operator: "includingRegex", expression: "us.*" }).success).toBe(true);
    expect(filterSchema.safeParse({ dimension: "device", expression: "mobile" }).success).toBe(true);
    expect(filterSchema.safeParse({ dimension: "device", expression: "phone" }).success).toBe(false);
    expect(filterSchema.safeParse({ dimension: "query", expression: "x".repeat(4097) }).success).toBe(false);
  });
});

describe("validateQuery", () => {
  const q = (o: Partial<QueryShape>): QueryShape => ({ dimensions: [], type: "web", filters: [], aggregation: "auto", dataState: "final", ...o });
  const page = { dimension: "page" as const, operator: "contains" as const, expression: "/a" };
  it("enforces Google's documented combinations", () => {
    expect(() => validateQuery(q({ dimensions: ["query", "page"] }))).not.toThrow();
    expect(() => validateQuery(q({ dimensions: ["query", "query"] }))).toThrow(/only once/);
    expect(() => validateQuery(q({ dimensions: ["searchAppearance", "query"] }))).toThrow(/searchAppearance/);
    expect(() => validateQuery(q({ dimensions: ["hour"] }))).toThrow(/hourly_all/);
    expect(() => validateQuery(q({ dimensions: ["hour"], dataState: "hourly_all" }))).not.toThrow();
    expect(() => validateQuery(q({ type: "discover", dimensions: ["query"] }))).toThrow(/Discover/);
    expect(() => validateQuery(q({ type: "discover", filters: [{ dimension: "query", operator: "equals", expression: "x" }] }))).toThrow(/Discover/);
    expect(() => validateQuery(q({ type: "googleNews", dimensions: ["query"] }))).toThrow(/Google News data has no queries/);
    expect(() => validateQuery(q({ type: "googleNews", filters: [{ dimension: "query", operator: "equals", expression: "x" }] }))).toThrow(/Google News/);
    expect(() => validateQuery(q({ type: "googleNews", dimensions: ["page"] }))).not.toThrow();
    expect(() => validateQuery(q({ aggregation: "byProperty", filters: [page] }))).toThrow(/byProperty/);
    expect(() => validateQuery(q({ aggregation: "byProperty", type: "googleNews" }))).toThrow(/byProperty/);
    const ns = { dimension: "searchAppearance" as const, operator: "equals" as const, expression: "NEWS_SHOWCASE" };
    expect(() => validateQuery(q({ aggregation: "byNewsShowcasePanel", type: "discover", filters: [ns] }))).not.toThrow();
    expect(() => validateQuery(q({ aggregation: "byNewsShowcasePanel", type: "web", filters: [ns] }))).toThrow(/discover or googleNews/);
    expect(() => validateQuery(q({ aggregation: "byNewsShowcasePanel", type: "discover" }))).toThrow(/NEWS_SHOWCASE/);
    expect(() => validateQuery(q({ aggregation: "byNewsShowcasePanel", type: "discover", filters: [ns, page] }))).toThrow(/page/);
  });
});
