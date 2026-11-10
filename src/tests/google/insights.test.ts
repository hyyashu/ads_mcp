import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { localDate } from "../../platforms/google/tools/insights";
import { googleHarness, type GoogleHarness } from "../support/harness";

const C = "customers/1234567890";
type Rec = { id: string; type: string; dismissed?: boolean; campaign?: string; adGroup?: string; campaignBudget?: string; campaigns?: string[]; impact?: unknown };
let recs: Rec[];
let events: any[];
let statuses: any[];
let auction: Record<string, any[]>;
let queries: string[];
let rpcs: { path: string; body: any }[];
let dropWrites = false;
let failRpc = false;
let denyAuction: "permission" | "query" | null = null;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const CAMPAIGNS = ["11", "12"];
const AD_GROUPS = ["21"];
const inList = (q: string, field: string) => (new RegExp(`${field.replace(/\./g, "\\.")} (?:IN|CONTAINS ANY) \\(([^)]*)\\)`).exec(q)?.[1] ?? "").split(",").map((x) => x.trim().replace(/^'|'$/g, "")).filter(Boolean);

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    queries.push(q);
    const from = /FROM ([a-z_]+)/.exec(q)![1]!;
    if (q.includes("auction_insight")) {
      if (denyAuction === "permission") return J({ error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission", details: [{ errors: [{ errorCode: { authorizationError: "ACTION_NOT_PERMITTED" }, message: "not allowed" }] }] } }, 403);
      if (denyAuction === "query") return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument.", details: [{ errors: [{ errorCode: { queryError: "PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE" }, message: "Cannot select metrics.auction_insight_search_impression_share" }] }] } }, 400);
      return J({ results: auction[from] ?? [] });
    }
    if (from === "customer") return J({ results: [{ customer: { timeZone: "Asia/Kolkata" } }] });
    if (from === "campaign") return J({ results: inList(q, "campaign.id").filter((id) => CAMPAIGNS.includes(id)).map((id) => ({ campaign: { id } })) });
    if (from === "ad_group") return J({ results: inList(q, "ad_group.id").filter((id) => AD_GROUPS.includes(id)).map((id) => ({ adGroup: { id } })) });
    if (from === "recommendation") {
      const names = inList(q, "recommendation.resource_name");
      const types = inList(q, "recommendation.type");
      const camps = inList(q, "recommendation.campaign");
      const many = inList(q, "recommendation.campaigns");
      const hits = recs.filter(
        (r) =>
          (!names.length || names.includes(`${C}/recommendations/${r.id}`)) &&
          (!types.length || types.includes(r.type)) &&
          (!q.includes("recommendation.dismissed = FALSE") || !r.dismissed) &&
          (!camps.length || (r.campaign && camps.includes(r.campaign))) &&
          (!many.length || (r.campaigns ?? []).some((c) => many.includes(c))),
      );
      return J({ results: hits.map(({ id, ...r }) => ({ recommendation: { resourceName: `${C}/recommendations/${id}`, ...r, dismissed: !!r.dismissed } })) });
    }
    if (from === "change_event") return J({ results: events });
    if (from === "change_status") return J({ results: statuses });
    return J({ results: [] });
  }
  rpcs.push({ path, body });
  if (failRpc) return J({ error: { code: 500, status: "INTERNAL", message: "boom" } }, 500);
  if (dropWrites) return J({ results: [] });
  const ids = body.operations.map((o: any) => o.resourceName.split("/").pop());
  if (path.endsWith("recommendations:apply")) recs = recs.filter((r) => !ids.includes(r.id));
  if (path.endsWith("recommendations:dismiss")) for (const r of recs) if (ids.includes(r.id)) r.dismissed = true;
  return J({ results: body.operations.map((o: any) => ({ resourceName: o.resourceName })) });
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("IN", fake);
});
const impact = (clicks: number, potentialClicks: number) => ({ baseMetrics: { clicks, impressions: clicks * 10, costMicros: String(clicks * 500_000) }, potentialMetrics: { clicks: potentialClicks, impressions: potentialClicks * 10, costMicros: String(potentialClicks * 500_000) } });
beforeEach(() => {
  recs = [
    { id: "k1", type: "KEYWORD", campaign: `${C}/campaigns/11`, adGroup: `${C}/adGroups/21`, impact: impact(100, 130) },
    { id: "k2", type: "KEYWORD", campaign: `${C}/campaigns/12`, impact: impact(40, 45) },
    { id: "b1", type: "CAMPAIGN_BUDGET", campaignBudget: `${C}/campaignBudgets/7`, campaigns: [`${C}/campaigns/12`, `${C}/campaigns/11`], impact: { potentialMetrics: { conversions: 3 } } },
    { id: "s1", type: "SITELINK_ASSET", campaign: `${C}/campaigns/11`, dismissed: true },
  ];
  events = [];
  statuses = [];
  auction = {};
  queries = [];
  rpcs = [];
  dropWrites = false;
  failRpc = false;
  denyAuction = null;
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (id: string, by = kit.owner) => kit.approveAs(id, by);
const data = async (name: string, args: Record<string, unknown>) => {
  const r = await run(name, args);
  if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data as any;
};
const exec = async (name: string, args: Record<string, unknown>, by?: string) => {
  const r = await run(name, args);
  if (!r.approval) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  const done = await approve(r.approval.approval_id, by);
  expect(done.status, JSON.stringify(done.result)).toBe("executed");
  return { r, done };
};

describe("list_recommendations", () => {
  it("lists active recommendations with their id, place and estimated impact", async () => {
    const d = await data("list_recommendations", {});
    expect(queries[0]).toBe(
      "SELECT recommendation.resource_name, recommendation.type, recommendation.dismissed, recommendation.campaign, recommendation.ad_group, recommendation.campaign_budget, recommendation.campaigns, recommendation.impact FROM recommendation WHERE recommendation.dismissed = FALSE",
    );
    expect(d.recommendations.map((r: any) => r.id)).toEqual(["b1", "k1", "k2"]);
    expect(d.recommendations[1]).toEqual({ id: "k1", type: "KEYWORD", dismissed: false, campaign_id: "11", ad_group_id: "21", budget_id: null, campaign_ids: [], impact: { base: { impressions: 1000, clicks: 100, cost: 50, conversions: null, conversions_value: null, video_views: null }, potential: { impressions: 1300, clicks: 130, cost: 65, conversions: null, conversions_value: null, video_views: null } } });
    // Metrics Google does not estimate are null, not 0; a missing side of the estimate is null.
    expect(d.recommendations[0]).toMatchObject({ budget_id: "7", campaign_ids: ["11", "12"], impact: { base: null, potential: { conversions: 3, clicks: null } } });
    expect(d.by_type).toEqual([{ type: "KEYWORD", count: 2 }, { type: "CAMPAIGN_BUDGET", count: 1 }]);
    expect(d.truncated).toBe(false);
  });

  it("filters by type, includes dismissed ones on request and reports truncation", async () => {
    const d = await data("list_recommendations", { types: ["SITELINK_ASSET", "KEYWORD"], include_dismissed: true, limit: 2 });
    expect(queries[0]).toContain("WHERE recommendation.type IN ('SITELINK_ASSET', 'KEYWORD')");
    expect(queries[0]).not.toContain("dismissed = FALSE");
    expect(d.recommendations.map((r: any) => r.id)).toEqual(["k1", "k2"]);
    expect(d.truncated).toBe(true);
    expect(d.by_type).toEqual([{ type: "KEYWORD", count: 2 }, { type: "SITELINK_ASSET", count: 1 }]);
  });

  it("a campaign filter finds campaign recommendations and budget recommendations covering the campaign", async () => {
    const d = await data("list_recommendations", { campaign_ids: ["12"] });
    expect(queries.filter((q) => q.includes("FROM recommendation"))).toEqual([
      expect.stringContaining(`recommendation.campaign IN ('${C}/campaigns/12')`),
      expect.stringContaining(`recommendation.campaigns CONTAINS ANY ('${C}/campaigns/12')`),
    ]);
    expect(d.recommendations.map((r: any) => r.id)).toEqual(["b1", "k2"]);
  });

  it("refuses unknown and wrong-type campaign ids, and invalid input", async () => {
    expect((await run("list_recommendations", { campaign_ids: ["21"] })).error).toMatchObject({ code: "invalid_argument", message: expect.stringContaining("21 is an ad group id") });
    expect((await run("list_recommendations", { campaign_ids: ["99"] })).error).toMatchObject({ code: "not_found", message: expect.stringContaining("No campaign 99") });
    expect((await run("list_recommendations", { types: ["NOT_A_TYPE"] })).error?.code).toBe("invalid_argument");
    expect((await run("list_recommendations", { campaign_ids: Array.from({ length: 51 }, (_, i) => String(i + 1)) })).error?.code).toBe("invalid_argument");
    expect((await run("list_recommendations", { limit: 0 })).error?.code).toBe("invalid_argument");
  });
});

describe("apply_recommendations", () => {
  it("applies with Google's defaults after a second approval, sending exactly the listed ids", async () => {
    const { r, done } = await exec("apply_recommendations", { recommendation_ids: ["k2", "k1", "k1"] }, kit.second);
    expect(r.approval?.risk).toBe("high_impact");
    expect(r.approval?.summary).toBe(
      "Apply 2 KEYWORD recommendations with Google's recommended values:\n- k1: ad group 21; estimated weekly clicks 100 → 130, impressions 1000 → 1300, cost 50 → 65\n- k2: campaign 12; estimated weekly clicks 40 → 45, impressions 400 → 450, cost 20 → 22.5",
    );
    expect(r.approval?.change_set?.changes).toEqual([
      { resource: "recommendation", id: "k1", name: "KEYWORD (ad group 21)", field: "applied", before: false, after: true, unit: "text", effect: "create" },
      { resource: "recommendation", id: "k2", name: "KEYWORD (campaign 12)", field: "applied", before: false, after: true, unit: "text", effect: "create" },
    ]);
    expect(rpcs).toEqual([{ path: "customers/1234567890/recommendations:apply", body: { operations: [{ resourceName: `${C}/recommendations/k1` }, { resourceName: `${C}/recommendations/k2` }] } }]);
    expect(done.result).toEqual({ applied: [{ id: "k1", type: "KEYWORD", campaign_id: "11" }, { id: "k2", type: "KEYWORD", campaign_id: "12" }], resource_names: [`${C}/recommendations/k1`, `${C}/recommendations/k2`] });
    expect(recs.map((x) => x.id)).toEqual(["b1", "s1"]);
  });

  it("a budget recommendation reads as a spend increase", async () => {
    const r = await run("apply_recommendations", { recommendation_ids: ["b1"] });
    expect(r.approval?.risk).toBe("high_impact");
    expect(r.approval?.change_set?.changes[0]).toMatchObject({ id: "b1", name: "CAMPAIGN_BUDGET (campaigns 11, 12)", effect: "increase_spend" });
    expect(r.approval?.summary).toContain("b1: campaigns 11, 12; estimated weekly conversions ? → 3");
  });

  it("refuses unknown, dismissed and mixed-type recommendations, and invalid input", async () => {
    expect((await run("apply_recommendations", { recommendation_ids: ["k1", "gone"] })).error).toMatchObject({ code: "not_found", message: expect.stringContaining("No recommendation gone") });
    expect((await run("apply_recommendations", { recommendation_ids: ["s1"] })).error).toMatchObject({ code: "invalid_argument", message: expect.stringContaining("s1 is dismissed") });
    expect((await run("apply_recommendations", { recommendation_ids: ["k1", "b1"] })).error).toMatchObject({ code: "invalid_argument", message: expect.stringContaining("types CAMPAIGN_BUDGET, KEYWORD") });
    expect((await run("apply_recommendations", { recommendation_ids: [] })).error?.code).toBe("invalid_argument");
    expect((await run("apply_recommendations", { recommendation_ids: Array.from({ length: 21 }, (_, i) => `r${i}`) })).error?.code).toBe("invalid_argument");
    expect((await run("apply_recommendations", { recommendation_ids: ["a'b"] })).error?.code).toBe("invalid_argument");
    expect((await run("apply_recommendations", { recommendation_ids: ["a/b"] })).error?.code).toBe("invalid_argument");
    // Custom values are not supported: an attempt is refused rather than silently applied with Google's defaults.
    expect((await run("apply_recommendations", { recommendation_ids: ["k1"], parameters: { budget: 5 } })).error?.code).toBe("invalid_argument");
    expect(rpcs).toHaveLength(0);
  });

  it("drift, unconfirmed applies and server errors are never reported as success", async () => {
    const r = await run("apply_recommendations", { recommendation_ids: ["k1"] });
    recs[0]!.impact = impact(100, 160); // Google refreshed the estimate after approval was requested
    const drift = await approve(r.approval!.approval_id, kit.second);
    expect(drift.status).toBe("failed");
    expect(drift.result).toMatchObject({ error: { code: "conflict" } });
    expect(rpcs).toHaveLength(0);

    const r2 = await run("apply_recommendations", { recommendation_ids: ["k1"] });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");

    dropWrites = false;
    const r3 = await run("apply_recommendations", { recommendation_ids: ["k2"] }); // k1 now has an unconfirmed attempt: the pipeline blocks repeats
    failRpc = true;
    expect((await approve(r3.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
    const tool = kit.deps.registry.get("apply_recommendations")!;
    if (tool.kind !== "write") throw new Error("write tool expected");
    const services = await kit.deps.createServices({ tenantId: kit.tenantId, account: { id: kit.accountId, platform: "google_ads", externalId: "1234567890", loginCustomerId: null, connectionId: "x" } });
    const row = await kit.approvals.get(kit.tenantId, r3.approval!.approval_id);
    expect(await tool.verify(row!.args as never, { services } as never, { snapshot: row!.planSnapshot })).toEqual({ outcome: "not_applied" });
    recs = recs.filter((x) => x.id !== "k2");
    expect(await tool.verify(row!.args as never, { services } as never, { snapshot: row!.planSnapshot })).toEqual({ outcome: "applied" });
  });
});

describe("dismiss_recommendations", () => {
  it("dismisses active ones, skips dismissed ones and confirms by re-reading with dismissed included", async () => {
    const { r, done } = await exec("dismiss_recommendations", { recommendation_ids: ["k1", "k2"] });
    expect(r.approval?.risk).toBe("write");
    expect(r.approval?.summary).toBe("Dismiss 2 KEYWORD recommendations: k1 (ad group 21), k2 (campaign 12)");
    expect(rpcs).toEqual([{ path: "customers/1234567890/recommendations:dismiss", body: { operations: [{ resourceName: `${C}/recommendations/k1` }, { resourceName: `${C}/recommendations/k2` }] } }]);
    expect(done.result).toEqual({ dismissed: ["k1", "k2"], already_dismissed: [] });
    expect(recs.filter((x) => x.dismissed).map((x) => x.id).sort()).toEqual(["k1", "k2", "s1"]);
    // The confirming read includes dismissed recommendations: no dismissed = FALSE filter.
    expect(queries.filter((q) => q.includes("FROM recommendation")).every((q) => !q.includes("dismissed = FALSE"))).toBe(true);

    recs.push({ id: "c1", type: "SITELINK_ASSET", campaign: `${C}/campaigns/12` });
    const mixed = await exec("dismiss_recommendations", { recommendation_ids: ["s1", "c1"] });
    expect(mixed.done.result).toEqual({ dismissed: ["c1"], already_dismissed: ["s1"] });
    expect(mixed.r.approval?.summary).toContain("Already dismissed: s1");
  });

  it("refuses no-ops, unknown ids and mixed types", async () => {
    expect((await run("dismiss_recommendations", { recommendation_ids: ["s1"] })).error?.message).toContain("Nothing would change");
    expect((await run("dismiss_recommendations", { recommendation_ids: ["nope"] })).error?.code).toBe("not_found");
    expect((await run("dismiss_recommendations", { recommendation_ids: ["k1", "b1"] })).error?.message).toContain("one type per request");
    expect(rpcs).toHaveLength(0);
  });

  it("an unconfirmed dismissal is unknown_outcome", async () => {
    const r = await run("dismiss_recommendations", { recommendation_ids: ["k1"] });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

describe("get_change_history", () => {
  const event = (over: Record<string, unknown> = {}) => ({
    changeEvent: {
      resourceName: `${C}/changeEvents/1700000000000000~1~0`,
      changeDateTime: "2026-11-10 14:03:22.123456",
      changeResourceName: `${C}/campaigns/11`,
      userEmail: "ana@example.com",
      clientType: "GOOGLE_ADS_WEB_CLIENT",
      changeResourceType: "CAMPAIGN",
      resourceChangeOperation: "UPDATE",
      changedFields: "status,name,targetSpend.cpcBidCeilingMicros",
      oldResource: { campaign: { status: "ENABLED", name: "Brand", targetSpend: { cpcBidCeilingMicros: "1000000" } } },
      newResource: { campaign: { status: "PAUSED", name: "x".repeat(300), targetSpend: { cpcBidCeilingMicros: "2000000" } } },
      campaign: `${C}/campaigns/11`,
      ...over,
    },
  });

  it("reports who changed what, with old and new values of the changed fields only", async () => {
    events = [event()];
    const d = await data("get_change_history", {});
    const today = localDate(new Date(), "Asia/Kolkata");
    expect(d).toMatchObject({ start_date: localDate(new Date(), "Asia/Kolkata", -6), end_date: localDate(new Date(), "Asia/Kolkata", 1), time_zone: "Asia/Kolkata", truncated: false });
    expect(d.start_date < today && today < d.end_date).toBe(true);
    expect(d.changes).toEqual([
      {
        time: "2026-11-10 14:03:22.123456",
        user_email: "ana@example.com",
        client_type: "GOOGLE_ADS_WEB_CLIENT",
        resource_type: "CAMPAIGN",
        resource_id: "11",
        campaign_id: "11",
        ad_group_id: null,
        operation: "UPDATE",
        fields: [
          { field: "status", old: "ENABLED", new: "PAUSED" },
          { field: "name", old: "Brand", new: `${"x".repeat(199)}…` },
          { field: "targetSpend.cpcBidCeilingMicros", old: "1000000", new: "2000000" },
        ],
        more_fields: 0,
      },
    ]);
    expect(d.status_only).toBeUndefined();
    const q = queries.find((x) => x.includes("FROM change_event"))!;
    expect(q).toBe(
      `SELECT change_event.change_date_time, change_event.change_resource_name, change_event.user_email, change_event.client_type, change_event.change_resource_type, change_event.resource_change_operation, change_event.changed_fields, change_event.old_resource, change_event.new_resource, change_event.campaign, change_event.ad_group FROM change_event WHERE change_event.change_date_time >= '${d.start_date}' AND change_event.change_date_time < '${d.end_date}' ORDER BY change_event.change_date_time DESC LIMIT 101`,
    );
  });

  it("filters by type and campaign, and reports truncation", async () => {
    events = [event(), event({ changeResourceType: "AD_GROUP_CRITERION", changeResourceName: `${C}/adGroupCriteria/21~5`, adGroup: `${C}/adGroups/21`, resourceChangeOperation: "CREATE", changedFields: "status", oldResource: undefined, newResource: { adGroupCriterion: { status: "ENABLED" } } })];
    const d = await data("get_change_history", { days: 30, resource_types: ["CAMPAIGN", "AD_GROUP_CRITERION"], campaign_ids: ["11"], limit: 1 });
    expect(d.start_date).toBe(localDate(new Date(), "Asia/Kolkata", -29));
    const q = queries.find((x) => x.includes("FROM change_event"))!;
    expect(q).toContain("change_event.change_resource_type IN ('CAMPAIGN', 'AD_GROUP_CRITERION')");
    expect(q).toContain(`change_event.campaign IN ('${C}/campaigns/11')`);
    expect(q).toMatch(/LIMIT 2$/);
    expect(d.changes).toHaveLength(1);
    expect(d.truncated).toBe(true);
  });

  it("include_status_only lists resources without a detailed record, dropping those already listed", async () => {
    events = [event({ changeResourceType: "AD_GROUP_CRITERION", changeResourceName: `${C}/adGroupCriteria/21~5`, adGroup: `${C}/adGroups/21`, resourceChangeOperation: "CREATE", changedFields: "status", oldResource: undefined, newResource: { adGroupCriterion: { status: "ENABLED" } } })];
    statuses = [
      { changeStatus: { lastChangeDateTime: "2026-11-10 10:00:00", resourceType: "AD_GROUP_CRITERION", resourceStatus: "ADDED", adGroupCriterion: `${C}/adGroupCriteria/21~5`, adGroup: `${C}/adGroups/21`, campaign: `${C}/campaigns/11` } },
      { changeStatus: { lastChangeDateTime: "2026-11-09 09:00:00", resourceType: "ASSET_GROUP", resourceStatus: "CHANGED", assetGroup: `${C}/assetGroups/901`, campaign: `${C}/campaigns/12` } },
    ];
    const d = await data("get_change_history", { include_status_only: true });
    expect(d.changes[0]).toMatchObject({ resource_type: "AD_GROUP_CRITERION", resource_id: "21~5", ad_group_id: "21", operation: "CREATE", fields: [{ field: "status", old: null, new: "ENABLED" }] });
    expect(d.status_only).toEqual([{ time: "2026-11-09 09:00:00", resource_type: "ASSET_GROUP", resource_id: "901", campaign_id: "12", ad_group_id: null, status: "CHANGED" }]);
    expect(d.status_only_truncated).toBe(false);
    const q = queries.find((x) => x.includes("FROM change_status"))!;
    expect(q).toContain(`change_status.last_change_date_time >= '${d.start_date}' AND change_status.last_change_date_time < '${d.end_date}'`);
    expect(q).toContain("ORDER BY change_status.last_change_date_time DESC LIMIT 102");

    // limit 1: one detailed change, so up to 3 status rows are read; reading all 3 means more may exist.
    statuses.push({ changeStatus: { lastChangeDateTime: "2026-11-08 09:00:00", resourceType: "SHARED_SET", resourceStatus: "CHANGED", sharedSet: `${C}/sharedSets/5` } });
    const t = await data("get_change_history", { include_status_only: true, limit: 1 });
    expect(t.status_only).toHaveLength(1);
    expect(t.status_only_truncated).toBe(true);
    expect(queries.at(-1)).toMatch(/LIMIT 3$/);

    queries = [];
    await data("get_change_history", { include_status_only: true, resource_types: ["SHARED_SET"] });
    expect(queries.some((x) => x.includes("FROM change_event"))).toBe(false);
    expect(queries.find((x) => x.includes("FROM change_status"))).toContain("change_status.resource_type IN ('SHARED_SET')");
  });

  it("refuses invalid input and wrong-type campaign ids", async () => {
    expect((await run("get_change_history", { days: 0 })).error?.code).toBe("invalid_argument");
    expect((await run("get_change_history", { days: 31 })).error?.code).toBe("invalid_argument");
    expect((await run("get_change_history", { resource_types: ["SHARED_SET"] })).error?.message).toContain("include_status_only");
    expect((await run("get_change_history", { campaign_ids: ["21"] })).error?.message).toContain("21 is an ad group id");
    expect((await run("get_change_history", { campaign_ids: ["98"] })).error?.code).toBe("not_found");
  });

  it("computes the window in the account's time zone", () => {
    const now = new Date("2026-11-10T20:00:00Z"); // already 11 November in Kolkata, still 10 November in Los Angeles
    expect(localDate(now, "Asia/Kolkata")).toBe("2026-11-11");
    expect(localDate(now, "America/Los_Angeles")).toBe("2026-11-10");
    expect(localDate(now, "Asia/Kolkata", -29)).toBe("2026-10-13");
    expect(localDate(now, "Not/AZone", 1)).toBe("2026-11-11");
  });
});

describe("get_auction_insights", () => {
  const row = (domain: string, share: number, extra: Record<string, unknown> = {}) => ({ ...extra, segments: { auctionInsightDomain: domain }, metrics: { auctionInsightSearchImpressionShare: share, auctionInsightSearchOverlapRate: 0.4, auctionInsightSearchPositionAboveRate: 0.2, auctionInsightSearchTopImpressionPercentage: 0.5, auctionInsightSearchAbsoluteTopImpressionPercentage: 0.1, auctionInsightSearchOutrankingShare: 0.0999 } });

  it("reads account-level competitors from customer, largest impression share first", async () => {
    auction.customer = [row("b.example", 0.2), row("a.example", 0.6), { segments: { auctionInsightDomain: "c.example" }, metrics: { auctionInsightSearchImpressionShare: 0.0999 } }];
    const d = await data("get_auction_insights", { date_range: "LAST_7_DAYS" });
    expect(queries[0]).toBe(
      "SELECT segments.auction_insight_domain, metrics.auction_insight_search_impression_share, metrics.auction_insight_search_overlap_rate, metrics.auction_insight_search_position_above_rate, metrics.auction_insight_search_top_impression_percentage, metrics.auction_insight_search_absolute_top_impression_percentage, metrics.auction_insight_search_outranking_share FROM customer WHERE segments.date DURING LAST_7_DAYS",
    );
    expect(d.level).toBe("account");
    expect(d.period).toBe("LAST_7_DAYS");
    expect(d.rows.map((r: any) => r.domain)).toEqual(["a.example", "b.example", "c.example"]);
    expect(d.rows[0]).toEqual({ campaign_id: null, ad_group_id: null, domain: "a.example", impression_share: 0.6, overlap_rate: 0.4, position_above_rate: 0.2, top_impression_rate: 0.5, absolute_top_impression_rate: 0.1, outranking_share: 0.0999 });
    expect(d.rows[2]).toMatchObject({ overlap_rate: null, outranking_share: null });
  });

  it("splits by campaign or by ad group", async () => {
    auction.campaign = [row("a.example", 0.3, { campaign: { id: "12" } }), row("a.example", 0.5, { campaign: { id: "11" } })];
    const c = await data("get_auction_insights", { campaign_ids: ["11", "12"], start_date: "2026-10-01", end_date: "2026-10-31", limit: 1 });
    expect(queries.at(-1)).toContain("FROM campaign WHERE segments.date BETWEEN '2026-10-01' AND '2026-10-31' AND campaign.id IN (11, 12)");
    expect(c).toMatchObject({ level: "campaign", period: "2026-10-01..2026-10-31", truncated: true, rows: [{ campaign_id: "11", impression_share: 0.5 }] });

    auction.ad_group = [row("z.example", 0.3, { campaign: { id: "11" }, adGroup: { id: "21" } })];
    const g = await data("get_auction_insights", { ad_group_ids: ["21"] });
    expect(queries.at(-1)).toMatch(/^SELECT campaign\.id, ad_group\.id, segments\.auction_insight_domain, .* FROM ad_group WHERE segments\.date DURING LAST_30_DAYS AND ad_group\.id IN \(21\)$/);
    expect(g.rows).toEqual([expect.objectContaining({ campaign_id: "11", ad_group_id: "21", domain: "z.example" })]);
  });

  it("refuses invalid input and ids of the wrong kind", async () => {
    expect((await run("get_auction_insights", { campaign_ids: ["11"], ad_group_ids: ["21"] })).error?.code).toBe("invalid_argument");
    expect((await run("get_auction_insights", { start_date: "2026-10-01" })).error?.code).toBe("invalid_argument");
    expect((await run("get_auction_insights", { ad_group_ids: ["11"] })).error?.message).toContain("11 is a campaign id");
    expect((await run("get_auction_insights", { campaign_ids: ["21"] })).error?.message).toContain("21 is an ad group id");
    expect((await run("get_auction_insights", { ad_group_ids: ["77"] })).error).toMatchObject({ code: "not_found", message: expect.stringContaining("No ad group 77") });
  });

  it("explains Google's access restriction", async () => {
    denyAuction = "permission";
    const e = (await run("get_auction_insights", {})).error;
    expect(e?.code).toBe("platform_permission_denied");
    expect(e?.message).toContain("not publicly available");
    denyAuction = "query";
    const e2 = (await run("get_auction_insights", {})).error;
    expect(e2?.code).toBe("platform_permission_denied");
    expect(e2?.message).toContain("Cannot select metrics.auction_insight_search_impression_share");
  });
});
