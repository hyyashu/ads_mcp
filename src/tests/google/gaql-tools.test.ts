import { beforeEach, describe, expect, it } from "vitest";
import { fakeGoogle } from "../support/fake-google";
import { googleHarness } from "../support/harness";
import { drainSchemaProblems } from "../support/schema-guard";

const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("run_gaql and get_gaql_fields", () => {
  let g: ReturnType<typeof fakeGoogle>;
  let kit: Awaited<ReturnType<typeof googleHarness>>;

  beforeEach(async () => {
    g = fakeGoogle();
    kit = await googleHarness("GAQL", async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith("googleAds:search") && typeof body.query === "string" && body.query.includes("campaign.bogus_field")) {
        return J({ error: { code: 400, status: "INVALID_ARGUMENT", details: [{ errors: [{ errorCode: { queryError: "UNRECOGNIZED_FIELD" }, message: "Unrecognized field in the query: 'campaign.bogus_field'." }] }] } }, 400);
      }
      return g.fetch(url, init);
    });
  });

  const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);

  describe("run_gaql", () => {
    it("flattens nested Google Ads rows, maps exact SELECT keys, preserves arrays, and converts *_micros fields", async () => {
      g.search.campaign = () => [
        {
          campaign: { resourceName: "customers/1234567890/campaigns/10", id: "10", name: "Brand Search", finalUrlSuffix: "utm_source=google" },
          campaignBudget: { amountMicros: "50000000" },
          metrics: { clicks: "42", costMicros: "12500000", averageCpc: 297619.04 },
          segments: { date: "2026-11-01" },
        },
      ];

      const res = await run("run_gaql", {
        query: "SELECT campaign.id, campaign.name, campaign.final_url_suffix, campaign_budget.amount_micros, metrics.clicks, metrics.cost_micros, metrics.average_cpc, segments.date FROM campaign WHERE segments.date DURING LAST_7_DAYS",
      });

      expect(res.ok).toBe(true);
      const d = res.data as any;
      expect(d.row_count).toBe(1);
      expect(d.truncated).toBe(false);
      expect(d.size_capped).toBe(false);
      expect(d.rows[0]).toEqual({
        "campaign.resource_name": "customers/1234567890/campaigns/10",
        "campaign.id": "10",
        "campaign.name": "Brand Search",
        "campaign.final_url_suffix": "utm_source=google",
        "campaign_budget.amount_micros": "50000000",
        "campaign_budget.amount": 50,
        "metrics.clicks": "42",
        "metrics.cost_micros": "12500000",
        "metrics.cost": 12.5,
        "metrics.average_cpc": 297619.04,
        "segments.date": "2026-11-01",
      });
    });

    it("preserves repeated fields like finalUrls as arrays without flattening indices", async () => {
      g.search.ad_group_ad = () => [
        {
          adGroupAd: {
            ad: {
              id: "99",
              finalUrls: ["https://example.com/a", "https://example.com/b"],
              responsiveSearchAd: { path1: "shoes", path2: "sale" },
            },
          },
        },
      ];

      const res = await run("run_gaql", {
        query: "SELECT ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2 FROM ad_group_ad",
      });

      expect(res.ok).toBe(true);
      const d = res.data as any;
      expect(d.rows[0]).toEqual({
        "ad_group_ad.ad.id": "99",
        "ad_group_ad.ad.final_urls": ["https://example.com/a", "https://example.com/b"],
        "ad_group_ad.ad.responsive_search_ad.path1": "shoes",
        "ad_group_ad.ad.responsive_search_ad.path2": "sale",
      });
    });

    it("detects truncation when more rows match than limit", async () => {
      g.search.campaign = () => [1, 2, 3, 4].map((i) => ({ campaign: { id: String(i), name: `C${i}` } }));

      const res = await run("run_gaql", {
        query: "SELECT campaign.id, campaign.name FROM campaign",
        limit: 3,
      });

      expect(res.ok).toBe(true);
      const d = res.data as any;
      expect(d.row_count).toBe(3);
      expect(d.truncated).toBe(true);
      expect(d.size_capped).toBe(false);
    });

    it("caps response at 256 KB and marks truncated and size_capped", async () => {
      const longName = "x".repeat(4000);
      g.search.campaign = () => Array.from({ length: 100 }, (_, i) => ({ campaign: { id: String(i + 1), name: `${longName}-${i}` } }));

      const res = await run("run_gaql", {
        query: "SELECT campaign.id, campaign.name FROM campaign",
        limit: 100,
      });

      expect(res.ok).toBe(true);
      const d = res.data as any;
      expect(d.row_count).toBeGreaterThan(0);
      expect(d.row_count).toBeLessThan(100);
      expect(d.truncated).toBe(true);
      expect(d.size_capped).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(d), "utf8")).toBeLessThanOrEqual(256 * 1024);
    });

    it("rejects non-SELECT queries, oversized queries, and missing/both query inputs", async () => {
      expect(await run("run_gaql", { query: "MUTATE campaign SET status = 'PAUSED'" })).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      expect(await run("run_gaql", { query: "   " })).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      expect(await run("run_gaql", { query: `SELECT campaign.id FROM campaign WHERE campaign.name = '${"a".repeat(10_000)}'` })).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      expect(await run("run_gaql", {})).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      expect(await run("run_gaql", { query: "SELECT campaign.id FROM campaign", queries: [{ name: "q1", query: "SELECT campaign.id FROM campaign" }] })).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      expect(g.calls).toHaveLength(0);
    });

    it("passes Google's field error through on single-query failure", async () => {
      const res = await run("run_gaql", { query: "SELECT campaign.bogus_field FROM campaign" });
      expect(drainSchemaProblems()).toEqual(["GAQL: unknown field: campaign.bogus_field"]);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("invalid_argument");
      expect(res.error?.message).toContain("campaign.bogus_field");
    });

    it("runs up to 10 named queries in parallel and isolates per-query failures", async () => {
      g.search.campaign = () => [{ campaign: { id: "1", name: "Search" }, metrics: { costMicros: "2000000" } }];
      g.search.ad_group = () => [{ adGroup: { id: "10", name: "Exact" } }];

      const res = await run("run_gaql", {
        queries: [
          { name: "campaigns", query: "SELECT campaign.id, campaign.name, metrics.cost_micros FROM campaign" },
          { name: "bad", query: "SELECT campaign.bogus_field FROM campaign" },
          { name: "ad_groups", query: "SELECT ad_group.id, ad_group.name FROM ad_group" },
        ],
      });

      expect(drainSchemaProblems()).toEqual(["GAQL: unknown field: campaign.bogus_field"]);
      expect(res.ok).toBe(true);
      const d = res.data as any;
      expect(d.size_capped).toBe(false);
      expect(d.results).toHaveLength(3);
      expect(d.results[0]).toMatchObject({ ok: true, name: "campaigns", row_count: 1, truncated: false });
      expect(d.results[0].rows[0]["metrics.cost"]).toBe(2);
      expect(d.results[1]).toMatchObject({ ok: false, name: "bad", row_count: 0, rows: [] });
      expect(d.results[1].error.code).toBe("invalid_argument");
      expect(d.results[1].error.message).toContain("campaign.bogus_field");
      expect(d.results[2]).toMatchObject({ ok: true, name: "ad_groups", row_count: 1, truncated: false });
    });

    it("rejects duplicate query names in batch mode", async () => {
      const res = await run("run_gaql", {
        queries: [
          { name: "dup", query: "SELECT campaign.id FROM campaign" },
          { name: "dup", query: "SELECT ad_group.id FROM ad_group" },
        ],
      });
      expect(res).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      expect(g.calls).toHaveLength(0);
    });
  });

  describe("get_gaql_fields", () => {
    beforeEach(() => {
      g.rpc["googleAdsFields:search"] = (body) => {
        const q = String(body.query ?? "");
        if (q.includes("WHERE name = 'keyword_view'")) {
          return {
            results: [
              {
                name: "keyword_view",
                category: "RESOURCE",
                selectable: false,
                attributeResources: ["ad_group", "ad_group_criterion", "campaign", "customer"],
                metrics: ["metrics.clicks", "metrics.cost_micros", "metrics.impressions"],
                segments: ["segments.date", "segments.device"],
                selectableWith: ["ad_group", "ad_group_criterion", "campaign", "metrics.clicks", "segments.date"],
              },
            ],
          };
        }
        if (q.includes("WHERE name LIKE 'keyword_view.%'")) {
          return {
            results: [
              { name: "keyword_view.resource_name", category: "ATTRIBUTE", dataType: "RESOURCE_NAME", selectable: true, filterable: true, sortable: true, isRepeated: false },
            ],
          };
        }
        if (q.includes("WHERE name = 'campaign'")) {
          return {
            results: [
              {
                name: "campaign",
                category: "RESOURCE",
                selectable: false,
                attributeResources: ["campaign_budget", "customer"],
                metrics: ["metrics.clicks", "metrics.cost_micros", "metrics.average_cost"],
                segments: ["segments.date", "segments.device"],
              },
            ],
          };
        }
        if (q.includes("WHERE name LIKE 'campaign.%'")) {
          if (!body.pageToken) {
            return {
              results: [
                { name: "campaign.id", category: "ATTRIBUTE", dataType: "INT64", selectable: true, filterable: true, sortable: true, isRepeated: false },
                { name: "campaign.status", category: "ATTRIBUTE", dataType: "ENUM", selectable: true, filterable: true, sortable: true, isRepeated: false, enumValues: ["ENABLED", "PAUSED", "REMOVED"] },
              ],
              nextPageToken: "page-2",
            };
          }
          return {
            results: [
              { name: "campaign.name", category: "ATTRIBUTE", dataType: "STRING", selectable: true, filterable: true, sortable: true, isRepeated: false },
            ],
          };
        }
        return { results: [] };
      };
    });

    it("returns own fields, related resources, metrics and segments for keyword_view", async () => {
      const res = await run("get_gaql_fields", { resource: "keyword_view" });
      expect(res.ok).toBe(true);
      const d = res.data as any;
      expect(d.resource).toBe("keyword_view");
      expect(d.own_fields).toEqual([
        { name: "keyword_view.resource_name", category: "ATTRIBUTE", data_type: "RESOURCE_NAME", selectable: true, filterable: true, sortable: true, is_repeated: false, enum_values: [] },
      ]);
      expect(d.related_resources).toEqual(["ad_group", "ad_group_criterion", "campaign", "customer"]);
      expect(d.metrics).toEqual(["metrics.clicks", "metrics.cost_micros", "metrics.impressions"]);
      expect(d.segments).toEqual(["segments.date", "segments.device"]);
      expect(d.truncated).toBe(false);
    });

    it("follows pagination and filters across fields, metrics, segments and related resources", async () => {
      const allRes = await run("get_gaql_fields", { resource: "campaign" });
      expect(allRes.ok).toBe(true);
      expect((allRes.data as any).own_fields.map((f: any) => f.name)).toEqual(["campaign.id", "campaign.name", "campaign.status"]);
      expect((allRes.data as any).own_fields[2].enum_values).toEqual(["ENABLED", "PAUSED", "REMOVED"]);

      const filtered = await run("get_gaql_fields", { resource: "campaign", filter: "cost" });
      expect(filtered.ok).toBe(true);
      const fd = filtered.data as any;
      expect(fd.own_fields).toEqual([]);
      expect(fd.metrics).toEqual(["metrics.average_cost", "metrics.cost_micros"]);
      expect(fd.segments).toEqual([]);
    });

    it("returns not_found for an unknown resource and rejects invalid resource syntax", async () => {
      expect(await run("get_gaql_fields", { resource: "nonexistent_view" })).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(await run("get_gaql_fields", { resource: "campaign; DROP" })).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    });
  });
});
