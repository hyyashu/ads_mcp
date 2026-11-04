import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../auth/token-providers";
import { googleHarness, type GoogleHarness } from "./support/harness";

const C = "customers/1234567890";
let labels: { id: string; name: string; status: string }[];
let campLabels: string[];
let camps: Record<string, { name: string; status: string }>;
let groups: Record<string, { name: string; status: string; channel: string }>;
let ads: Record<string, { status: string; type: string; channel: string }>;
let cas: Record<string, any>[];
let nextId = 300;
let mutates: any[][];
let dropWrites = false;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const ids = (q: string, f: string) => [...(new RegExp(`${f.replace(".", "\\.")} IN \\(([^)]*)\\)`).exec(q)?.[1] ?? "").matchAll(/\d+/g)].map((m) => m[0]);

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    if (q.includes("FROM label")) return J({ results: labels.filter((l) => l.status !== "REMOVED").map((l) => ({ label: l })) });
    if (q.includes("FROM campaign_label")) return J({ results: campLabels.map((k) => ({ campaign: { id: k.split("~")[0] }, label: { id: k.split("~")[1] } })) });
    if (q.includes("FROM campaign")) return J({ results: ids(q, "campaign.id").filter((i) => camps[i]).map((i) => ({ campaign: { id: i, ...camps[i] } })) });
    if (q.includes("FROM ad_group_ad")) {
      const ad = /ad_group_ad\.ad\.id = (\d+)/.exec(q)![1]!;
      const a = ads[ad];
      return J({ results: a ? [{ adGroupAd: { status: a.status, ad: { id: ad, type: a.type } }, campaign: { advertisingChannelType: a.channel } }] : [] });
    }
    if (q.includes("FROM ad_group")) {
      const list = q.includes("ad_group.id IN") ? ids(q, "ad_group.id") : [/ad_group\.id = (\d+)/.exec(q)![1]!];
      return J({ results: list.filter((i) => groups[i]).map((i) => ({ adGroup: { id: i, name: groups[i]!.name, status: groups[i]!.status }, campaign: { advertisingChannelType: groups[i]!.channel } })) });
    }
    if (q.includes("FROM conversion_action")) {
      const one = /conversion_action\.id = (\d+)/.exec(q)?.[1];
      return J({ results: cas.filter((c) => (!one || c.id === one) && c.status !== "REMOVED").map((c) => ({ conversionAction: c })) });
    }
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    if (dropWrites) return J({ mutateOperationResponses: [] });
    for (const op of body.mutateOperations) {
      if (op.labelOperation?.create) labels.push({ id: String(nextId++), name: op.labelOperation.create.name, status: "ENABLED" });
      else if (op.campaignLabelOperation?.create) campLabels.push(`${op.campaignLabelOperation.create.campaign.split("/").pop()}~${op.campaignLabelOperation.create.label.split("/").pop()}`);
      else if (op.campaignLabelOperation?.remove) campLabels = campLabels.filter((k) => k !== op.campaignLabelOperation.remove.split("/").pop());
      else if (op.campaignOperation?.update) camps[op.campaignOperation.update.resourceName.split("/").pop()]!.status = op.campaignOperation.update.status;
      else if (op.adGroupOperation?.update) groups[op.adGroupOperation.update.resourceName.split("/").pop()]!.status = op.adGroupOperation.update.status;
      else if (op.adGroupOperation?.remove) groups[op.adGroupOperation.remove.split("/").pop()]!.status = "REMOVED";
      else if (op.adGroupAdOperation?.remove) ads[op.adGroupAdOperation.remove.split("~").pop()]!.status = "REMOVED";
      else if (op.conversionActionOperation?.create) cas.push({ id: String(nextId++), status: "ENABLED", ...op.conversionActionOperation.create, tagSnippets: [{ type: "WEBPAGE", pageFormat: "HTML", globalSiteTag: "<script>gtag</script>", eventSnippet: "<script>event</script>" }] });
      else if (op.conversionActionOperation?.update) {
        const u = op.conversionActionOperation.update;
        Object.assign(cas.find((c) => c.id === u.resourceName.split("/").pop())!, u);
      }
    }
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("AC", fake);
});
beforeEach(() => {
  labels = [{ id: "3", name: "Q4", status: "ENABLED" }];
  campLabels = ["11~3"];
  camps = { "11": { name: "Brand", status: "ENABLED" }, "12": { name: "Generic", status: "PAUSED" }, "13": { name: "Old", status: "REMOVED" } };
  groups = { "21": { name: "Core", status: "ENABLED", channel: "SEARCH" }, "61": { name: "Disp", status: "PAUSED", channel: "DISPLAY" } };
  ads = { "801": { status: "ENABLED", type: "RESPONSIVE_DISPLAY_AD", channel: "DISPLAY" }, "802": { status: "ENABLED", type: "RESPONSIVE_SEARCH_AD", channel: "SEARCH" } };
  cas = [{ id: "1", name: "Purchase", status: "ENABLED", type: "WEBPAGE", category: "PURCHASE", countingType: "ONE_PER_CLICK", primaryForGoal: true, clickThroughLookbackWindowDays: "30" }];
  mutates = [];
  dropWrites = false;
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (id: string, by = kit.owner) => kit.approveAs(id, by);

describe("labels", () => {
  it("creates a label, refuses duplicates, attaches and detaches it", async () => {
    const r = await run("create_label", { name: "Holiday", description: "season", background_color: "#ff0000" });
    const done = await approve(r.approval!.approval_id);
    expect(done.result).toEqual({ label_id: "300", name: "Holiday" });
    expect(mutates[0]).toEqual([{ labelOperation: { create: { name: "Holiday", textLabel: { description: "season", backgroundColor: "#FF0000" } } } }]);
    expect((await run("create_label", { name: "holiday" })).error?.message).toContain("already exists");

    const add = await run("add_campaign_label", { campaign_ids: ["11", "12"], label_id: "3" });
    expect(add.approval?.summary).toContain("1 campaign");
    expect((await approve(add.approval!.approval_id)).status).toBe("executed");
    expect(mutates[1]).toEqual([{ campaignLabelOperation: { create: { campaign: `${C}/campaigns/12`, label: `${C}/labels/3` } } }]);
    expect((await run("add_campaign_label", { campaign_ids: ["11"], label_id: "999" })).error?.code).toBe("not_found");

    const rm = await run("remove_campaign_label", { campaign_ids: ["11"], label_id: "3" });
    expect(rm.approval?.risk).toBe("destructive");
    expect((await approve(rm.approval!.approval_id, kit.second)).status).toBe("executed");
    expect(mutates[2]).toEqual([{ campaignLabelOperation: { remove: `${C}/campaignLabels/11~3` } }]);
  });
});

describe("bulk status and removals", () => {
  it("pausing a few campaigns is one approver; enabling needs a second; removed ones are refused", async () => {
    const pause = await run("bulk_update_campaign_status", { ids: ["11", "12"], status: "PAUSED" });
    expect(pause.approval?.risk).toBe("write");
    const done = await approve(pause.approval!.approval_id);
    expect(done.result).toEqual({ status: "PAUSED", updated: ["11"], unchanged: ["12"] });
    const enable = await run("bulk_update_ad_group_status", { ids: ["61"], status: "ENABLED" });
    expect(enable.approval?.risk).toBe("high_impact");
    expect((await run("bulk_update_campaign_status", { ids: ["13"], status: "PAUSED" })).error?.message).toContain("Removed");
    expect((await run("bulk_update_campaign_status", { ids: ["99"], status: "PAUSED" })).error?.code).toBe("not_found");
  });

  it("removes ad groups and Display ads (destructive), checking the channel", async () => {
    const rm = await run("remove_display_ad_group", { ad_group_id: "61" });
    expect(rm.approval?.risk).toBe("destructive");
    expect((await approve(rm.approval!.approval_id, kit.second)).result).toEqual({ ad_group_id: "61", status: "REMOVED" });
    expect((await run("remove_display_ad_group", { ad_group_id: "21" })).error?.message).toContain("not in a DISPLAY");
    const ad = await run("remove_display_ad", { ad_group_id: "61", ad_id: "801" });
    expect((await approve(ad.approval!.approval_id, kit.second)).status).toBe("executed");
    expect(mutates[1]).toEqual([{ adGroupAdOperation: { remove: `${C}/adGroupAds/61~801` } }]);
    expect((await run("remove_display_ad", { ad_group_id: "21", ad_id: "802" })).error?.message).toContain("not in a Display");
    const g = await run("remove_ad_group", { ad_group_id: "21" });
    expect((await approve(g.approval!.approval_id, kit.second)).status).toBe("executed");
    expect((await run("remove_ad_group", { ad_group_id: "21" })).error?.message).toContain("already removed");
  });
});

describe("conversion actions", () => {
  it("creating one is high impact and returns the tag snippets Google generated", async () => {
    const r = await run("create_conversion_action", { name: "Lead form", type: "WEBPAGE", category: "SUBMIT_LEAD_FORM", default_value: 25, default_currency_code: "USD" });
    expect(r.approval?.risk).toBe("high_impact");
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.result).toEqual({ conversion_action_id: expect.stringMatching(/^\d+$/), name: "Lead form", tag_snippets: [{ type: "WEBPAGE", page_format: "HTML", global_site_tag: "<script>gtag</script>", event_snippet: "<script>event</script>" }] });
    expect(mutates[0]![0].conversionActionOperation.create).toEqual({ name: "Lead form", type: "WEBPAGE", category: "SUBMIT_LEAD_FORM", countingType: "ONE_PER_CLICK", status: "ENABLED", primaryForGoal: true, clickThroughLookbackWindowDays: "30", valueSettings: { defaultValue: 25, defaultCurrencyCode: "USD", alwaysUseDefaultValue: false } });
    expect((await run("create_conversion_action", { name: "purchase", type: "WEBPAGE", category: "PURCHASE" })).error?.message).toContain("already exists");
  });

  it("a rename is a write; changing the primary goal needs a second approver", async () => {
    const rename = await run("update_conversion_action", { conversion_action_id: "1", name: "Purchase (web)" });
    expect(rename.approval?.risk).toBe("write");
    expect((await approve(rename.approval!.approval_id)).status).toBe("executed");
    const goal = await run("update_conversion_action", { conversion_action_id: "1", primary_for_goal: false });
    expect(goal.approval?.risk).toBe("high_impact");
    const done = await approve(goal.approval!.approval_id, kit.second);
    expect(done.result).toMatchObject({ conversion_action: { id: "1", primary_for_goal: false } });
    expect(mutates[1]).toEqual([{ conversionActionOperation: { update: { resourceName: `${C}/conversionActions/1`, primaryForGoal: false }, updateMask: "primary_for_goal" } }]);
    expect((await run("update_conversion_action", { conversion_action_id: "1" })).error?.code).toBe("invalid_argument");
  });

  it("unconfirmed writes are unknown_outcome", async () => {
    const r = await run("bulk_update_campaign_status", { ids: ["11"], status: "PAUSED" });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});
