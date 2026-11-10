import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

/**
 * In-memory account: account-level exclusions, the customer (auto-tagging), campaigns and ad groups with tracking fields,
 * and campaign location criteria. googleAds:mutate applies the operations these tools send, with field-mask semantics
 * (a path in the mask without a value clears the field).
 */
const C = "customers/1234567890";
type Excl = { id: string; type: string; [k: string]: unknown };
let excl: Excl[];
let customer: { autoTaggingEnabled?: boolean; descriptiveName: string };
let camps: Record<string, Record<string, any>>;
let groups: Record<string, Record<string, any>>;
let crit: { criterionId: string; campaign: string; type: string; negative: boolean; status: string; bidModifier?: number; location?: { geoTargetConstant: string } }[];
const sharedSets: Record<string, { type: string; status: string; name: string }> = {
  "501": { type: "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS", status: "ENABLED", name: "Account negatives" },
  "502": { type: "NEGATIVE_PLACEMENTS", status: "ENABLED", name: "Bad sites" },
  "503": { type: "NEGATIVE_KEYWORDS", status: "ENABLED", name: "Campaign negatives" },
  "504": { type: "NEGATIVE_PLACEMENTS", status: "REMOVED", name: "Old" },
};
const categories: Record<string, string> = { "60008": "Games", "60013": "Social" };
let nextId = 700;
let mutates: any[][];
let dropWrites = false;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const inList = (q: string, f: string) => {
  const m = new RegExp(`${f.replace(/\./g, "\\.")} IN \\(([^)]*)\\)`).exec(q);
  return m ? [...m[1]!.matchAll(/'?([A-Z0-9_]+)'?/g)].map((x) => x[1]!) : null;
};
const eq = (q: string, f: string) => new RegExp(`${f.replace(/\./g, "\\.")} = (\\d+)`).exec(q)?.[1];
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function applyMask(target: Record<string, any>, update: Record<string, any>, mask: string) {
  for (const path of mask.split(",")) {
    const k = camel(path);
    if (update[k] === undefined) delete target[k];
    else target[k] = update[k];
  }
}

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    if (q.includes("FROM customer_negative_criterion")) {
      const types = inList(q, "customer_negative_criterion.type");
      const ids = inList(q, "customer_negative_criterion.id");
      return J({ results: excl.filter((e) => (!types || types.includes(e.type)) && (!ids || ids.includes(e.id))).map(({ id, ...rest }) => ({ customerNegativeCriterion: { resourceName: `${C}/customerNegativeCriteria/${id}`, id, ...rest } })) });
    }
    if (q.includes("FROM mobile_app_category_constant")) return J({ results: (inList(q, "mobile_app_category_constant.id") ?? []).filter((i) => categories[i]).map((i) => ({ mobileAppCategoryConstant: { id: Number(i), name: categories[i] } })) });
    if (q.includes("FROM shared_set")) return J({ results: (inList(q, "shared_set.id") ?? []).filter((i) => sharedSets[i]).map((i) => ({ sharedSet: { id: i, ...sharedSets[i] } })) });
    if (q.includes("FROM customer ")) return J({ results: [{ customer: { id: "1234567890", ...customer } }] });
    if (q.includes("FROM campaign_criterion")) {
      const camp = eq(q, "campaign.id");
      const ids = inList(q, "campaign_criterion.criterion_id");
      return J({ results: crit.filter((c) => c.campaign === camp && (!ids || ids.includes(c.criterionId))).map(({ campaign: _c, ...c }) => ({ campaignCriterion: c })) });
    }
    if (q.includes("FROM campaign ")) {
      const id = eq(q, "campaign.id")!;
      return J({ results: camps[id] ? [{ campaign: { id, ...camps[id] } }] : [] });
    }
    if (q.includes("FROM ad_group ")) {
      const id = eq(q, "ad_group.id")!;
      return J({ results: groups[id] ? [{ adGroup: { id, ...groups[id] } }] : [] });
    }
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    if (dropWrites) return J({ mutateOperationResponses: [] });
    for (const op of body.mutateOperations) {
      if (op.customerNegativeCriterionOperation?.create) {
        const c = op.customerNegativeCriterionOperation.create;
        const type = c.placement ? "PLACEMENT" : c.youtubeChannel ? "YOUTUBE_CHANNEL" : c.youtubeVideo ? "YOUTUBE_VIDEO" : c.mobileApplication ? "MOBILE_APPLICATION" : c.mobileAppCategory ? "MOBILE_APP_CATEGORY" : c.contentLabel ? "CONTENT_LABEL" : c.ipBlock ? "IP_BLOCK" : c.negativeKeywordList ? "NEGATIVE_KEYWORD_LIST" : "PLACEMENT_LIST";
        excl.push({ id: String(nextId++), type, ...c });
      } else if (op.customerNegativeCriterionOperation?.remove) {
        const id = op.customerNegativeCriterionOperation.remove.split("/").pop();
        excl = excl.filter((e) => e.id !== id);
      } else if (op.customerOperation?.update) {
        const { resourceName: _r, ...u } = op.customerOperation.update;
        applyMask(customer, u, op.customerOperation.updateMask);
      } else if (op.campaignOperation?.update) {
        const { resourceName, ...u } = op.campaignOperation.update;
        applyMask(camps[resourceName.split("/").pop()]!, u, op.campaignOperation.updateMask);
      } else if (op.adGroupOperation?.update) {
        const { resourceName, ...u } = op.adGroupOperation.update;
        applyMask(groups[resourceName.split("/").pop()]!, u, op.adGroupOperation.updateMask);
      } else if (op.campaignCriterionOperation?.update) {
        const { resourceName, ...u } = op.campaignCriterionOperation.update;
        const [camp, id] = resourceName.split("/").pop().split("~");
        applyMask(crit.find((c) => c.campaign === camp && c.criterionId === id)!, u, op.campaignCriterionOperation.updateMask);
      }
    }
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("ACC", fake);
});
beforeEach(() => {
  excl = [
    { id: "601", type: "PLACEMENT", placement: { url: "example.org" } },
    { id: "602", type: "MOBILE_APP_CATEGORY", mobileAppCategory: { mobileAppCategoryConstant: "mobileAppCategoryConstants/60013" } },
    { id: "603", type: "CONTENT_LABEL", contentLabel: { type: "TRAGEDY" } },
    { id: "604", type: "MOBILE_APPLICATION", mobileApplication: { appId: "2-com.example.game", name: "Example Game" } },
    { id: "605", type: "PLACEMENT_LIST", placementList: { sharedSet: `${C}/sharedSets/502` } },
  ];
  customer = { autoTaggingEnabled: true, descriptiveName: "Acme" };
  camps = {
    "11": { name: "Brand", status: "ENABLED", trackingUrlTemplate: "https://t.example/?u={lpurl}", finalUrlSuffix: "src=old", urlCustomParameters: [{ key: "promo", value: "x" }] },
    "13": { name: "Gone", status: "REMOVED" },
  };
  groups = { "21": { name: "Core", status: "ENABLED" } };
  crit = [
    { criterionId: "901", campaign: "11", type: "LOCATION", negative: false, status: "ENABLED", bidModifier: 1.2, location: { geoTargetConstant: "geoTargetConstants/2840" } },
    { criterionId: "902", campaign: "11", type: "LOCATION", negative: false, status: "ENABLED", location: { geoTargetConstant: "geoTargetConstants/2124" } },
    { criterionId: "903", campaign: "11", type: "LOCATION", negative: true, status: "ENABLED", location: { geoTargetConstant: "geoTargetConstants/2826" } },
    { criterionId: "904", campaign: "11", type: "PROXIMITY", negative: false, status: "ENABLED" },
  ];
  mutates = [];
  dropWrites = false;
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (id: string, by = kit.owner) => kit.approveAs(id, by);

describe("get_account_exclusions", () => {
  it("lists every account-level exclusion with ids and names", async () => {
    const r = await run("get_account_exclusions", {});
    expect(r.error).toBeUndefined();
    expect(r.data).toEqual({
      exclusions: [
        { criterion_id: "601", type: "PLACEMENT", value: "example.org", name: null, resource_name: `${C}/customerNegativeCriteria/601` },
        { criterion_id: "602", type: "MOBILE_APP_CATEGORY", value: "60013", name: "Social", resource_name: `${C}/customerNegativeCriteria/602` },
        { criterion_id: "603", type: "CONTENT_LABEL", value: "TRAGEDY", name: null, resource_name: `${C}/customerNegativeCriteria/603` },
        { criterion_id: "604", type: "MOBILE_APPLICATION", value: "2-com.example.game", name: "Example Game", resource_name: `${C}/customerNegativeCriteria/604` },
        { criterion_id: "605", type: "PLACEMENT_LIST", value: "502", name: "Bad sites", resource_name: `${C}/customerNegativeCriteria/605` },
      ],
      returned: 5,
      truncated: false,
    });
  });

  it("filters by type and reports truncation", async () => {
    const r = await run("get_account_exclusions", { types: ["placement", "content_label"], limit: 1 });
    expect(r.data).toMatchObject({ exclusions: [{ criterion_id: "601" }], returned: 1, truncated: true });
    expect((await run("get_account_exclusions", { types: ["nope"] })).error?.code).toBe("invalid_argument");
  });
});

describe("add_account_exclusions", () => {
  it("adds each type with the exact bodies, skips existing ones, and is high impact", async () => {
    const r = await run("add_account_exclusions", {
      exclusions: [
        { type: "placement", value: "https://Example.org/" }, // already excluded (example.org)
        { type: "placement", value: "news.example.com/sports" },
        { type: "youtube_channel", value: "UC_x5XG1OV2P6uZZ5FSM9Ttw" },
        { type: "youtube_video", value: "dQw4w9WgXcQ" },
        { type: "mobile_application", value: "1-476943146" },
        { type: "mobile_app_category", value: "mobileAppCategoryConstants/60008" },
        { type: "content_label", value: "PARKED_DOMAIN" },
        { type: "ip_block", value: "203.0.113.0/24" },
        { type: "negative_keyword_list", value: "501" },
      ],
    });
    expect(r.error).toBeUndefined();
    expect(r.approval).toMatchObject({ risk: "high_impact", summary: expect.stringContaining("WHOLE account") });
    expect(r.approval?.change_set?.changes).toHaveLength(8);
    expect(r.approval?.change_set?.changes[0]).toMatchObject({ resource: "account", field: "account_exclusion", before: null, after: "PLACEMENT:news.example.com/sports", effect: "create" });
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      { customerNegativeCriterionOperation: { create: { placement: { url: "news.example.com/sports" } } } },
      { customerNegativeCriterionOperation: { create: { youtubeChannel: { channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw" } } } },
      { customerNegativeCriterionOperation: { create: { youtubeVideo: { videoId: "dQw4w9WgXcQ" } } } },
      { customerNegativeCriterionOperation: { create: { mobileApplication: { appId: "1-476943146" } } } },
      { customerNegativeCriterionOperation: { create: { mobileAppCategory: { mobileAppCategoryConstant: "mobileAppCategoryConstants/60008" } } } },
      { customerNegativeCriterionOperation: { create: { contentLabel: { type: "PARKED_DOMAIN" } } } },
      { customerNegativeCriterionOperation: { create: { ipBlock: { ipAddress: "203.0.113.0/24" } } } },
      { customerNegativeCriterionOperation: { create: { negativeKeywordList: { sharedSet: `${C}/sharedSets/501` } } } },
    ]);
    expect(done.result).toMatchObject({
      added: [
        { type: "PLACEMENT", value: "news.example.com/sports", criterion_id: "700" },
        { type: "YOUTUBE_CHANNEL", value: "UC_x5XG1OV2P6uZZ5FSM9Ttw", criterion_id: "701" },
        { type: "YOUTUBE_VIDEO", value: "dQw4w9WgXcQ", criterion_id: "702" },
        { type: "MOBILE_APPLICATION", value: "1-476943146", criterion_id: "703" },
        { type: "MOBILE_APP_CATEGORY", value: "60008", criterion_id: "704" },
        { type: "CONTENT_LABEL", value: "PARKED_DOMAIN", criterion_id: "705" },
        { type: "IP_BLOCK", value: "203.0.113.0/24", criterion_id: "706" },
        { type: "NEGATIVE_KEYWORD_LIST", value: "501", criterion_id: "707" },
      ],
      skipped_existing: ["PLACEMENT:example.org"],
    });
  });

  it("validates each type's value", async () => {
    const bad = async (type: string, value: string) => (await run("add_account_exclusions", { exclusions: [{ type, value }] })).error;
    expect((await bad("placement", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"))?.message).toContain("youtube_channel or youtube_video");
    expect((await bad("placement", "example.com/a/b/c"))?.message).toContain("2 levels");
    expect((await bad("placement", "adsenseformobileapps.com"))?.message).toContain("adsenseformobileapps");
    expect((await bad("placement", "a.com,b.com"))?.message).toContain("commas");
    expect((await bad("placement", `${"a".repeat(240)}.example.com`))?.message).toContain("250");
    expect((await bad("youtube_channel", "https://youtube.com/@acme"))?.message).toContain("channel id");
    expect((await bad("youtube_video", "https://youtu.be/dQw4w9WgXcQ"))?.message).toContain("11-character");
    expect((await bad("mobile_application", "com.example.app"))?.message).toContain("1-<App Store id>");
    expect((await bad("mobile_app_category", "Games"))?.message).toContain("category constant id");
    expect((await bad("content_label", "UNSPECIFIED"))?.message).toContain("content label must be one of");
    expect((await bad("ip_block", "300.1.1.1"))?.message).toContain("IP address");
    expect((await bad("ip_block", "10.0.0.0/33"))?.message).toContain("prefix");
    expect((await bad("ip_block", "2001:db8::/48"))).toBeUndefined();
    expect((await run("add_account_exclusions", { exclusions: [] })).error?.code).toBe("invalid_argument");
  });

  it("refuses unknown categories and shared sets, and shared sets of the wrong kind", async () => {
    expect((await run("add_account_exclusions", { exclusions: [{ type: "mobile_app_category", value: "99999" }] })).error).toMatchObject({ code: "not_found", message: expect.stringContaining("99999") });
    expect((await run("add_account_exclusions", { exclusions: [{ type: "placement_list", value: "999" }] })).error?.code).toBe("not_found");
    expect((await run("add_account_exclusions", { exclusions: [{ type: "placement_list", value: "503" }] })).error?.message).toContain("needs a NEGATIVE_PLACEMENTS list");
    expect((await run("add_account_exclusions", { exclusions: [{ type: "negative_keyword_list", value: "502" }] })).error?.message).toContain("ACCOUNT_LEVEL_NEGATIVE_KEYWORDS");
    expect((await run("add_account_exclusions", { exclusions: [{ type: "placement_list", value: "504" }] })).error?.message).toContain("removed");
  });

  it("refuses no-ops and the account limits", async () => {
    expect((await run("add_account_exclusions", { exclusions: [{ type: "content_label", value: "TRAGEDY" }, { type: "placement", value: "EXAMPLE.org" }] })).error?.message).toContain("Nothing would change");
    excl.push({ id: "650", type: "NEGATIVE_KEYWORD_LIST", negativeKeywordList: { sharedSet: `${C}/sharedSets/501` } });
    const other = { ...sharedSets["501"]! };
    sharedSets["510"] = other;
    expect((await run("add_account_exclusions", { exclusions: [{ type: "negative_keyword_list", value: "510" }] })).error?.message).toContain("at most one account-level negative keyword list");
    delete sharedSets["510"];
    for (let i = 0; i < 499; i++) excl.push({ id: String(10_000 + i), type: "IP_BLOCK", ipBlock: { ipAddress: `10.0.${Math.floor(i / 250)}.${i % 250}` } });
    expect((await run("add_account_exclusions", { exclusions: [{ type: "ip_block", value: "192.0.2.1" }, { type: "ip_block", value: "192.0.2.2" }] })).error?.message).toContain("at most 500");
    expect((await run("add_account_exclusions", { exclusions: [{ type: "ip_block", value: "192.0.2.1" }] })).approval?.risk).toBe("high_impact");
  });

  it("applies nothing when the exclusions changed after the request, and reports unconfirmed writes", async () => {
    const r = await run("add_account_exclusions", { exclusions: [{ type: "placement", value: "spam.example" }] });
    excl.push({ id: "660", type: "PLACEMENT", placement: { url: "other.example" } });
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ error: { code: "conflict" } });
    expect(mutates).toHaveLength(0);

    const r2 = await run("add_account_exclusions", { exclusions: [{ type: "placement", value: "spam.example" }] });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
  });
});

describe("remove_account_exclusions", () => {
  it("removes by criterion id (destructive) and confirms by re-reading", async () => {
    const r = await run("remove_account_exclusions", { criterion_ids: ["603", "601"] });
    expect(r.approval).toMatchObject({ risk: "destructive", change_set: { changes: [{ before: "PLACEMENT:example.org", after: null, effect: "remove" }, { before: "CONTENT_LABEL:TRAGEDY", after: null, effect: "remove" }] } });
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ customerNegativeCriterionOperation: { remove: `${C}/customerNegativeCriteria/601` } }, { customerNegativeCriterionOperation: { remove: `${C}/customerNegativeCriteria/603` } }]);
    expect(done.result).toEqual({ removed: [{ criterion_id: "601", type: "PLACEMENT", value: "example.org" }, { criterion_id: "603", type: "CONTENT_LABEL", value: "TRAGEDY" }] });
  });

  it("refuses unknown ids and reports unconfirmed removals", async () => {
    expect((await run("remove_account_exclusions", { criterion_ids: ["601", "999"] })).error).toMatchObject({ code: "not_found", message: expect.stringContaining("999") });
    expect((await run("remove_account_exclusions", { criterion_ids: ["abc"] })).error?.code).toBe("invalid_argument");
    const r = await run("remove_account_exclusions", { criterion_ids: ["601"] });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
  });
});

describe("update_tracking_settings", () => {
  it("sets, clears and replaces campaign tracking fields with one masked update and a before/after change set", async () => {
    const r = await run("update_tracking_settings", { level: "campaign", id: "11", tracking_url_template: "{lpurl}?track=1", final_url_suffix: null, url_custom_parameters: [{ key: "promo", value: "summer" }, { key: "src", value: "g" }] });
    expect(r.approval).toMatchObject({
      risk: "write",
      change_set: {
        changes: [
          { resource: "campaign", id: "11", field: "tracking_url_template", before: "https://t.example/?u={lpurl}", after: "{lpurl}?track=1", effect: "neutral" },
          { field: "final_url_suffix", before: "src=old", after: null },
          { field: "url_custom_parameters", before: "promo=x", after: "promo=summer; src=g" },
        ],
      },
    });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ campaignOperation: { update: { resourceName: `${C}/campaigns/11`, trackingUrlTemplate: "{lpurl}?track=1", urlCustomParameters: [{ key: "promo", value: "summer" }, { key: "src", value: "g" }] }, updateMask: "tracking_url_template,final_url_suffix,url_custom_parameters" } }]);
    expect(done.result).toEqual({ level: "campaign", id: "11", tracking_url_template: "{lpurl}?track=1", final_url_suffix: null, url_custom_parameters: [{ key: "promo", value: "summer" }, { key: "src", value: "g" }] });
  });

  it("works on ad groups and clears custom parameters with null", async () => {
    groups["21"]!.urlCustomParameters = [{ key: "a", value: "1" }];
    const r = await run("update_tracking_settings", { level: "ad_group", id: "21", final_url_suffix: "utm_source=google&utm_medium=cpc", url_custom_parameters: null });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ adGroupOperation: { update: { resourceName: `${C}/adGroups/21`, finalUrlSuffix: "utm_source=google&utm_medium=cpc" }, updateMask: "final_url_suffix,url_custom_parameters" } }]);
    expect(done.result).toMatchObject({ level: "ad_group", final_url_suffix: "utm_source=google&utm_medium=cpc", url_custom_parameters: [] });
  });

  it("refuses wrong levels, unknown or removed entities, no-ops and invalid values", async () => {
    expect((await run("update_tracking_settings", { level: "ad_group", id: "11", final_url_suffix: "a=b" })).error?.message).toContain("campaign id; use level campaign");
    expect((await run("update_tracking_settings", { level: "campaign", id: "21", final_url_suffix: "a=b" })).error?.message).toContain("ad group id; use level ad_group");
    expect((await run("update_tracking_settings", { level: "campaign", id: "99", final_url_suffix: "a=b" })).error?.code).toBe("not_found");
    expect((await run("update_tracking_settings", { level: "campaign", id: "13", final_url_suffix: "a=b" })).error?.message).toContain("removed");
    expect((await run("update_tracking_settings", { level: "campaign", id: "11", final_url_suffix: "src=old", url_custom_parameters: [{ key: "promo", value: "x" }] })).error?.message).toContain("Nothing would change");
    expect((await run("update_tracking_settings", { level: "campaign", id: "11" })).error?.code).toBe("invalid_argument");
    const params = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, value: "v" }));
    expect((await run("update_tracking_settings", { level: "campaign", id: "11", url_custom_parameters: params(9) })).error?.code).toBe("invalid_argument");
    expect((await run("update_tracking_settings", { level: "campaign", id: "11", url_custom_parameters: [{ key: "Promo", value: "a" }, { key: "promo", value: "b" }] })).error?.message).toContain("unique");
    expect((await run("update_tracking_settings", { level: "campaign", id: "11", url_custom_parameters: [{ key: "bad-key", value: "a" }] })).error?.message).toContain("alphanumeric");
    expect((await run("update_tracking_settings", { level: "campaign", id: "11", url_custom_parameters: [{ key: "k", value: "é".repeat(101) }] })).error?.message).toContain("200 bytes");
    expect((await run("update_tracking_settings", { level: "campaign", id: "11", url_custom_parameters: [{ key: "a".repeat(17), value: "v" }] })).error?.message).toContain("16 bytes");
    expect((await run("update_tracking_settings", { level: "campaign", id: "11", tracking_url_template: "tracker.example/?u={lpurl}" })).error?.message).toContain("http");
  });

  it("applies nothing on drift and reports unconfirmed writes", async () => {
    const r = await run("update_tracking_settings", { level: "campaign", id: "11", final_url_suffix: "src=new" });
    camps["11"]!.trackingUrlTemplate = "https://changed.example/{lpurl}";
    const done = await approve(r.approval!.approval_id);
    expect(done.result).toMatchObject({ error: { code: "conflict" } });
    expect(mutates).toHaveLength(0);
    const r2 = await run("update_tracking_settings", { level: "campaign", id: "11", final_url_suffix: "src=new" });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

describe("set_auto_tagging", () => {
  it("turning it off is high impact and warns about GA4 and gclid attribution", async () => {
    const r = await run("set_auto_tagging", { enabled: false });
    expect(r.approval).toMatchObject({ risk: "high_impact", summary: expect.stringContaining("breaks GA4 attribution"), change_set: { changes: [{ resource: "account", field: "auto_tagging_enabled", before: true, after: false }] } });
    expect(r.approval?.summary).toContain("gclid");
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ customerOperation: { update: { resourceName: C, autoTaggingEnabled: false }, updateMask: "auto_tagging_enabled" } }]);
    expect(done.result).toEqual({ auto_tagging_enabled: false });
    expect((await run("set_auto_tagging", { enabled: false })).error?.message).toContain("already off");
  });

  it("turns it on; an account that never set it reads as off", async () => {
    delete customer.autoTaggingEnabled;
    const r = await run("set_auto_tagging", { enabled: true });
    expect(r.approval).toMatchObject({ risk: "high_impact", summary: expect.stringContaining("Turn ON") });
    expect((await approve(r.approval!.approval_id, kit.second)).result).toEqual({ auto_tagging_enabled: true });
    expect((await run("set_auto_tagging", { enabled: "yes" })).error?.code).toBe("invalid_argument");
  });

  it("reports an unconfirmed change and refuses on drift", async () => {
    // A separate workspace: the same change, already applied above, would be refused as a replay.
    const k2 = await googleHarness("ACC2", fake);
    const r = await k2.run("set_auto_tagging", { enabled: false });
    dropWrites = true;
    expect((await k2.approveAs(r.approval!.approval_id, k2.second)).status).toBe("unknown_outcome");
    dropWrites = false;
    const k3 = await googleHarness("ACC3", fake);
    mutates = [];
    const r2 = await k3.run("set_auto_tagging", { enabled: false });
    customer.descriptiveName = "Acme (renamed)";
    expect((await k3.approveAs(r2.approval!.approval_id, k3.second)).result).toMatchObject({ error: { code: "conflict" } });
    expect(mutates).toHaveLength(0);
  });
});

describe("set_location_bid_modifiers", () => {
  it("sets and clears modifiers on targeted locations; raising one is high impact", async () => {
    const r = await run("set_location_bid_modifiers", { campaign_id: "11", modifiers: [{ criterion_id: "902", bid_modifier: 1.5 }, { criterion_id: "901", bid_modifier: null }] });
    expect(r.approval).toMatchObject({
      risk: "high_impact",
      change_set: { changes: [{ field: "location_bid_modifier.2840", before: 1.2, after: null, effect: "decrease_spend" }, { field: "location_bid_modifier.2124", before: null, after: 1.5, effect: "increase_spend" }] },
    });
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      { campaignCriterionOperation: { update: { resourceName: `${C}/campaignCriteria/11~901` }, updateMask: "bid_modifier" } },
      { campaignCriterionOperation: { update: { resourceName: `${C}/campaignCriteria/11~902`, bidModifier: 1.5 }, updateMask: "bid_modifier" } },
    ]);
    expect(done.result).toEqual({ campaign_id: "11", modifiers: [{ criterion_id: "901", location: "2840", bid_modifier: null }, { criterion_id: "902", location: "2124", bid_modifier: 1.5 }] });
  });

  it("lowering only is a write", async () => {
    const r = await run("set_location_bid_modifiers", { campaign_id: "11", modifiers: [{ criterion_id: "901", bid_modifier: 0.9 }] });
    expect(r.approval?.risk).toBe("write");
    expect((await approve(r.approval!.approval_id)).status).toBe("executed");
  });

  it("refuses criteria that are not targeted locations of the campaign, out-of-range values and no-ops", async () => {
    const set = (modifiers: unknown, campaign_id = "11") => run("set_location_bid_modifiers", { campaign_id, modifiers });
    expect((await set([{ criterion_id: "903", bid_modifier: 1.1 }])).error?.message).toContain("excluded location");
    expect((await set([{ criterion_id: "904", bid_modifier: 1.1 }])).error?.message).toContain("PROXIMITY criterion, not a location target");
    expect((await set([{ criterion_id: "999", bid_modifier: 1.1 }])).error).toMatchObject({ code: "not_found", message: expect.stringContaining("999") });
    expect((await set([{ criterion_id: "901", bid_modifier: 1.1 }], "99")).error?.code).toBe("not_found");
    expect((await set([{ criterion_id: "901", bid_modifier: 1.1 }], "13")).error?.message).toContain("removed");
    expect((await set([{ criterion_id: "901", bid_modifier: 12 }])).error?.code).toBe("invalid_argument");
    expect((await set([{ criterion_id: "901", bid_modifier: 0.05 }])).error?.code).toBe("invalid_argument");
    expect((await set([{ criterion_id: "901", bid_modifier: 1.1 }, { criterion_id: "901", bid_modifier: 1.2 }])).error?.message).toContain("at most once");
    expect((await set([{ criterion_id: "901", bid_modifier: 1.2 }, { criterion_id: "902", bid_modifier: null }])).error?.message).toContain("Nothing would change");
  });

  it("applies nothing on drift and reports unconfirmed writes", async () => {
    const r = await run("set_location_bid_modifiers", { campaign_id: "11", modifiers: [{ criterion_id: "901", bid_modifier: 2 }] });
    crit[0]!.bidModifier = 1.3;
    expect((await approve(r.approval!.approval_id, kit.second)).result).toMatchObject({ error: { code: "conflict" } });
    expect(mutates).toHaveLength(0);
    const r2 = await run("set_location_bid_modifiers", { campaign_id: "11", modifiers: [{ criterion_id: "901", bid_modifier: 2 }] });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
  });
});
