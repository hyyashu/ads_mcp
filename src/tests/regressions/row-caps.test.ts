import { describe, expect, it } from "vitest";
import { googleHarness } from "../support/harness";

/**
 * Review item R6: reads must never cut a list silently. A search that matches more rows than a tool reads either fails
 * (when the tool needs the whole list) or says `truncated` (when it shows a page). The fake pages like Google: it honours
 * LIMIT and returns `nextPageToken` while rows remain.
 */
const J = (b: unknown) => new Response(JSON.stringify(b));
const PAGE = 1000;

function pagedFake(rowsFor: (from: string, q: string) => Record<string, unknown>[]) {
  let mutations = 0;
  const fetch = async (url: string, init?: RequestInit) => {
    if (!url.endsWith("googleAds:search")) {
      mutations++;
      return J({ results: [{}] });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const q: string = body.query;
    const from = /FROM (\w+)/.exec(q)![1]!;
    const limit = Number(/LIMIT (\d+)/.exec(q)?.[1] ?? Infinity);
    const all = rowsFor(from, q).slice(0, limit);
    const start = Number(body.pageToken ?? 0);
    const next = start + PAGE;
    return J({ results: all.slice(start, next), ...(next < all.length ? { nextPageToken: String(next) } : {}) });
  };
  return { fetch, mutations: () => mutations };
}

const listRows = (from: string, q: string, keywords: number) => {
  if (from === "shared_set") return [{ sharedSet: { id: "900", name: "Brand negatives", memberCount: String(keywords), referenceCount: "1" } }];
  if (from === "shared_criterion") return Array.from({ length: keywords }, (_, i) => ({ sharedCriterion: { criterionId: String(i + 1), keyword: { text: `kw ${i}`, matchType: "BROAD" } } }));
  if (from === "campaign_shared_set") return [{ campaign: { id: "11", name: "Brand" } }];
  return [];
};

describe("R6: row caps are never silent", () => {
  it("a write that checks duplicates against a list longer than it can read refuses and queues nothing", async () => {
    const f = pagedFake((from, q) => listRows(from, q, 5_001));
    const kit = await googleHarness("R6a", f.fetch);
    const r = await kit.run("add_negative_keywords_to_list", { shared_set_id: "900", keywords: [{ text: "brand new", match_type: "BROAD" }] });
    expect(r.error?.code).toBe("unsupported");
    expect(r.error?.message).toContain("5,000");
    expect(r.approval).toBeUndefined();
    expect(f.mutations()).toBe(0);
  });

  it("the same write works when the list fits", async () => {
    const f = pagedFake((from, q) => listRows(from, q, 4_999));
    const kit = await googleHarness("R6b", f.fetch);
    const r = await kit.run("add_negative_keywords_to_list", { shared_set_id: "900", keywords: [{ text: "brand new", match_type: "BROAD" }] });
    expect(r.approval?.status).toBe("pending_approval");
  });

  it("a read that shows a page says truncated instead of failing", async () => {
    const f = pagedFake((from, q) => listRows(from, q, 5_001));
    const kit = await googleHarness("R6c", f.fetch);
    const r = await kit.run("get_negative_keyword_list", { shared_set_id: "900", keyword_limit: 10 });
    expect(r.error).toBeUndefined();
    expect((r.data as any).keywords).toHaveLength(10);
    expect((r.data as any).keywords_truncated).toBe(true);
  });

  it("list_labels reports truncated when more labels exist than the limit", async () => {
    const labels = Array.from({ length: 3 }, (_, i) => ({ label: { id: String(i + 1), name: `L${i}`, status: "ENABLED" } }));
    const kit = await googleHarness("R6d", pagedFake((from) => (from === "label" ? labels : [])).fetch);
    const cut = await kit.run("list_labels", { limit: 2 });
    expect(cut.data).toMatchObject({ returned: 2, truncated: true });
    const all = await kit.run("list_labels", { limit: 3 });
    expect(all.data).toMatchObject({ returned: 3, truncated: false });
  });
});

describe("R8: shares and totals cover every row, not only the page shown", () => {
  it("PMax search category shares are of all categories when only the top ones are returned", async () => {
    const cats = [10, 6, 4].map((c, i) => ({ campaignSearchTermInsight: { id: String(i + 1), categoryLabel: `cat ${i}` }, metrics: { impressions: "100", clicks: "10", conversions: c, conversionsValue: c * 10 } }));
    const kit = await googleHarness("R8a", pagedFake((from) => (from === "campaign" ? [{ campaign: { id: "11", name: "PMax", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX" } }] : from === "campaign_search_term_insight" ? cats : [])).fetch);
    const r = await kit.run("analyze_pmax_search_categories", { campaign_id: "11", limit: 1 });
    expect(r.error).toBeUndefined();
    expect((r.data as any).categories).toHaveLength(1);
    expect((r.data as any).categories[0].conversion_share).toBe(0.5); // 10 of 20, not 10 of 10
    expect(r.data).toMatchObject({ returned: 1, truncated: true });
  });
});

describe("R6 on Meta: the Graph client never cuts an edge silently", () => {
  const client = async (rows: number) => {
    const { MetaAdsClient } = await import("../../platforms/meta/client");
    const { MetaGraphHttp } = await import("../../platforms/meta/http");
    const { metaPage } = await import("../support/meta");
    const all = Array.from({ length: rows }, (_, i) => ({ id: String(i + 1) }));
    const http = new MetaGraphHttp({ apiVersion: "v27.0", sleep: async () => {}, fetch: async (url: string) => metaPage(all, new URL(url).searchParams) });
    return new MetaAdsClient({ http, adAccountId: "act_1", currency: "USD", getToken: async () => ({ accessToken: "t", appSecretProof: "p" }) });
  };

  it("an edge longer than the cap is refused unless the caller asked for a page", async () => {
    const m = await client(250);
    await expect(m.list("act_1/campaigns", {}, 200)).rejects.toMatchObject({ code: "unsupported", opts: { details: { reason: "row_cap", cap: 200, edge: "campaigns" } } });
    expect(await m.list("act_1/campaigns", {}, 200, { partial: true })).toHaveLength(200);
  });

  it("an edge that fits is returned whole, including exactly at the cap", async () => {
    expect(await (await client(200)).list("act_1/campaigns", {}, 200)).toHaveLength(200);
    expect(await (await client(37)).list("act_1/campaigns", {}, 200)).toHaveLength(37);
  });
});
