import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

/** In-memory labels, ad groups, ads, ad group criteria and their label links ("{entity key}~{label id}"). */
const C = "customers/1234567890";
let labels: Record<string, { name: string; status: string }>;
let groups: Record<string, { name: string; status: string }>;
let ads: Record<string, { status: string; name?: string }>; // "{ad_group_id}~{ad_id}"
let criteria: Record<string, { type: string; status: string; text?: string; matchType?: string }>; // "{ad_group_id}~{criterion_id}"
let links: { ad_group: string[]; ad: string[]; keyword: string[] };
let mutates: any[][];
let queries: string[];
let dropWrites = false;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const inList = (q: string, f: string) => {
  const m = new RegExp(`${f.replace(/\./g, "\\.")} IN \\(([^)]*)\\)`).exec(q);
  return m ? [...m[1]!.matchAll(/\d+/g)].map((x) => x[0]) : null;
};
const eq = (q: string, f: string) => new RegExp(`${f.replace(/\./g, "\\.")} = (\\d+)`).exec(q)?.[1];
const labelRow = (id: string) => ({ id, name: labels[id]?.name ?? "?" });

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    queries.push(q);
    const from = /FROM (\w+)/.exec(q)![1];
    const groupIds = inList(q, "ad_group.id") ?? (eq(q, "ad_group.id") ? [eq(q, "ad_group.id")!] : null);
    const labelIds = inList(q, "label.id") ?? (/_label\.label = '[^']*\/labels\/(\d+)'/.exec(q) ? [/_label\.label = '[^']*\/labels\/(\d+)'/.exec(q)![1]!] : null);
    const okG = (g: string) => !groupIds || groupIds.includes(g);
    const okL = (l: string) => !labelIds || labelIds.includes(l);
    if (from === "label") return J({ results: (inList(q, "label.id") ?? Object.keys(labels)).filter((i) => labels[i]).map((i) => ({ label: { id: i, ...labels[i] } })) });
    if (from === "campaign") return J({ results: eq(q, "campaign.id") === "11" ? [{ campaign: { id: "11", status: "ENABLED" } }] : [] });
    if (from === "ad_group") return J({ results: Object.entries(groups).filter(([g]) => groupIds?.includes(g)).map(([id, g]) => ({ adGroup: { id, ...g } })) });
    if (from === "ad_group_ad") {
      const adIds = inList(q, "ad_group_ad.ad.id");
      return J({ results: Object.entries(ads).filter(([k]) => okG(k.split("~")[0]!) && (!adIds || adIds.includes(k.split("~")[1]!))).map(([k, a]) => ({ adGroup: { id: k.split("~")[0] }, adGroupAd: { status: a.status, ad: { id: k.split("~")[1], ...(a.name ? { name: a.name } : {}) } } })) });
    }
    if (from === "ad_group_criterion") {
      const ids = inList(q, "ad_group_criterion.criterion_id");
      return J({ results: Object.entries(criteria).filter(([k]) => okG(k.split("~")[0]!) && (!ids || ids.includes(k.split("~")[1]!))).map(([k, c]) => ({ adGroup: { id: k.split("~")[0] }, adGroupCriterion: { criterionId: k.split("~")[1], type: c.type, status: c.status, ...(c.text ? { keyword: { text: c.text, matchType: c.matchType } } : {}) } })) });
    }
    if (from === "ad_group_label") return J({ results: links.ad_group.map((l) => l.split("~")).filter(([g, l]) => okG(g!) && okL(l!)).map(([g, l]) => ({ adGroup: { id: g, name: groups[g!]?.name }, label: labelRow(l!) })) });
    if (from === "ad_group_ad_label") {
      const adIds = inList(q, "ad_group_ad.ad.id");
      return J({ results: links.ad.map((l) => l.split("~")).filter(([g, a, l]) => okG(g!) && okL(l!) && (!adIds || adIds.includes(a!))).map(([g, a, l]) => ({ adGroup: { id: g }, adGroupAd: { ad: { id: a } }, label: labelRow(l!) })) });
    }
    if (from === "ad_group_criterion_label") {
      const ids = inList(q, "ad_group_criterion.criterion_id");
      return J({ results: links.keyword.map((l) => l.split("~")).filter(([g, k, l]) => okG(g!) && okL(l!) && (!ids || ids.includes(k!))).map(([g, k, l]) => ({ adGroup: { id: g }, adGroupCriterion: { criterionId: k, keyword: { text: criteria[`${g}~${k}`]?.text, matchType: criteria[`${g}~${k}`]?.matchType } }, label: labelRow(l!) })) });
    }
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    if (dropWrites) return J({ mutateOperationResponses: [] });
    const tail = (rn: string) => rn.split("/").pop()!;
    for (const op of body.mutateOperations) {
      if (op.adGroupLabelOperation?.create) links.ad_group.push(`${tail(op.adGroupLabelOperation.create.adGroup)}~${tail(op.adGroupLabelOperation.create.label)}`);
      else if (op.adGroupAdLabelOperation?.create) links.ad.push(`${tail(op.adGroupAdLabelOperation.create.adGroupAd)}~${tail(op.adGroupAdLabelOperation.create.label)}`);
      else if (op.adGroupCriterionLabelOperation?.create) links.keyword.push(`${tail(op.adGroupCriterionLabelOperation.create.adGroupCriterion)}~${tail(op.adGroupCriterionLabelOperation.create.label)}`);
      else if (op.adGroupLabelOperation?.remove) links.ad_group = links.ad_group.filter((l) => l !== tail(op.adGroupLabelOperation.remove));
      else if (op.adGroupAdLabelOperation?.remove) links.ad = links.ad.filter((l) => l !== tail(op.adGroupAdLabelOperation.remove));
      else if (op.adGroupCriterionLabelOperation?.remove) links.keyword = links.keyword.filter((l) => l !== tail(op.adGroupCriterionLabelOperation.remove));
    }
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("ENTLAB", fake);
});
beforeEach(() => {
  labels = { "3": { name: "Q4", status: "ENABLED" }, "4": { name: "Promo", status: "ENABLED" }, "5": { name: "Old", status: "REMOVED" } };
  groups = { "21": { name: "Core", status: "ENABLED" }, "22": { name: "Other", status: "PAUSED" }, "23": { name: "Gone", status: "REMOVED" } };
  ads = { "21~801": { status: "ENABLED" }, "21~802": { status: "PAUSED", name: "Video A" }, "22~803": { status: "REMOVED" } };
  criteria = { "21~1001": { type: "KEYWORD", status: "ENABLED", text: "running shoes", matchType: "EXACT" }, "21~1002": { type: "AGE_RANGE", status: "ENABLED" } };
  links = { ad_group: ["21~3"], ad: ["21~801~3"], keyword: ["21~1001~3"] };
  mutates = [];
  queries = [];
  dropWrites = false;
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (id: string, by = kit.owner) => kit.approveAs(id, by);

describe("get_entity_labels", () => {
  it("shows the labels of given ad groups, ads and keywords", async () => {
    expect((await run("get_entity_labels", { entity_type: "ad_group", entities: [{ ad_group_id: "21" }, { ad_group_id: "22" }] })).data).toEqual({
      labels: [{ entity_type: "ad_group", ad_group_id: "21", ad_id: null, criterion_id: null, entity_name: "Core", label_id: "3", label_name: "Q4" }],
      returned: 1,
      truncated: false,
    });
    expect((await run("get_entity_labels", { entity_type: "ad", entities: [{ ad_group_id: "21", ad_id: "801" }] })).data).toMatchObject({ labels: [{ entity_type: "ad", ad_group_id: "21", ad_id: "801", label_id: "3", label_name: "Q4" }] });
    expect((await run("get_entity_labels", { entity_type: "keyword", entities: [{ ad_group_id: "21", criterion_id: "1001" }] })).data).toMatchObject({ labels: [{ criterion_id: "1001", entity_name: "running shoes (EXACT)", label_id: "3" }] });
    expect(queries.some((q) => q.includes("FROM ad_group_criterion_label") && q.includes("ad_group_criterion.criterion_id IN (1001)"))).toBe(true);
  });

  it("lists every entity carrying a label", async () => {
    links.ad_group.push("22~4", "21~4");
    const r = await run("get_entity_labels", { entity_type: "ad_group", label_id: "4" });
    expect(r.data).toMatchObject({ labels: [{ ad_group_id: "22", label_id: "4" }, { ad_group_id: "21", label_id: "4" }], returned: 2 });
    expect(queries.at(-1)).toContain(`ad_group_label.label = '${C}/labels/4'`);
  });

  it("validates the entity shape and needs entities or a label", async () => {
    expect((await run("get_entity_labels", { entity_type: "ad" })).error?.message).toContain("give entities, label_id, or both");
    expect((await run("get_entity_labels", { entity_type: "ad", entities: [{ ad_group_id: "21" }] })).error?.message).toContain("ad takes ad_group_id and ad_id");
    expect((await run("get_entity_labels", { entity_type: "keyword", entities: [{ ad_group_id: "21", ad_id: "801" }] })).error?.code).toBe("invalid_argument");
  });
});

describe("add_entity_labels", () => {
  it("attaches labels to ad groups, skipping pairs that exist", async () => {
    const r = await run("add_entity_labels", { entity_type: "ad_group", entities: [{ ad_group_id: "21" }, { ad_group_id: "22" }], label_ids: ["3", "4"] });
    expect(r.approval).toMatchObject({ risk: "write", change_set: { changes: [{ resource: "ad_group", id: "21", field: "label", before: null, after: "4", effect: "neutral" }, { id: "22", after: "3" }, { id: "22", after: "4" }] } });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      { adGroupLabelOperation: { create: { adGroup: `${C}/adGroups/21`, label: `${C}/labels/4` } } },
      { adGroupLabelOperation: { create: { adGroup: `${C}/adGroups/22`, label: `${C}/labels/3` } } },
      { adGroupLabelOperation: { create: { adGroup: `${C}/adGroups/22`, label: `${C}/labels/4` } } },
    ]);
    expect(done.result).toEqual({ entity_type: "ad_group", attached: [{ entity: "21", label_id: "4" }, { entity: "22", label_id: "3" }, { entity: "22", label_id: "4" }], skipped_existing: [{ entity: "21", label_id: "3" }] });
  });

  it("attaches labels to ads and keywords with the documented resource names", async () => {
    const ad = await run("add_entity_labels", { entity_type: "ad", entities: [{ ad_group_id: "21", ad_id: "802" }], label_ids: ["3"] });
    expect((await approve(ad.approval!.approval_id)).status).toBe("executed");
    expect(mutates[0]).toEqual([{ adGroupAdLabelOperation: { create: { adGroupAd: `${C}/adGroupAds/21~802`, label: `${C}/labels/3` } } }]);
    const kw = await run("add_entity_labels", { entity_type: "keyword", entities: [{ ad_group_id: "21", criterion_id: "1001" }], label_ids: ["4"] });
    expect((await approve(kw.approval!.approval_id)).status).toBe("executed");
    expect(mutates[1]).toEqual([{ adGroupCriterionLabelOperation: { create: { adGroupCriterion: `${C}/adGroupCriteria/21~1001`, label: `${C}/labels/4` } } }]);
  });

  it("refuses no-ops, unknown or removed labels and entities, and the wrong kind of entity", async () => {
    const add = (args: Record<string, unknown>) => run("add_entity_labels", args);
    expect((await add({ entity_type: "ad_group", entities: [{ ad_group_id: "21" }], label_ids: ["3"] })).error?.message).toContain("Nothing would change");
    expect((await add({ entity_type: "ad_group", entities: [{ ad_group_id: "21" }], label_ids: ["5"] })).error).toMatchObject({ code: "not_found", message: expect.stringContaining("label 5") });
    expect((await add({ entity_type: "ad_group", entities: [{ ad_group_id: "99" }], label_ids: ["4"] })).error).toMatchObject({ code: "not_found", message: expect.stringContaining("ad group 99") });
    expect((await add({ entity_type: "ad_group", entities: [{ ad_group_id: "11" }], label_ids: ["4"] })).error?.message).toContain("campaign id, not an ad group id");
    expect((await add({ entity_type: "ad_group", entities: [{ ad_group_id: "23" }], label_ids: ["4"] })).error?.message).toContain("Removed ad groups");
    expect((await add({ entity_type: "ad", entities: [{ ad_group_id: "21", ad_id: "803" }], label_ids: ["4"] })).error?.code).toBe("not_found");
    expect((await add({ entity_type: "ad", entities: [{ ad_group_id: "22", ad_id: "803" }], label_ids: ["4"] })).error?.message).toContain("Removed ads");
    expect((await add({ entity_type: "keyword", entities: [{ ad_group_id: "21", criterion_id: "1002" }], label_ids: ["4"] })).error?.message).toContain("Not keywords: 21~1002 (AGE_RANGE)");
    expect((await add({ entity_type: "keyword", entities: [{ ad_group_id: "21" }], label_ids: ["4"] })).error?.message).toContain("keyword takes ad_group_id and criterion_id");
    expect((await add({ entity_type: "ad_group", entities: [{ ad_group_id: "21" }], label_ids: [] })).error?.code).toBe("invalid_argument");
  });

  it("applies nothing on drift and reports unconfirmed writes", async () => {
    const r = await run("add_entity_labels", { entity_type: "ad_group", entities: [{ ad_group_id: "22" }], label_ids: ["4"] });
    groups["22"]!.name = "Renamed";
    const done = await approve(r.approval!.approval_id);
    expect(done.result).toMatchObject({ error: { code: "conflict" } });
    expect(mutates).toHaveLength(0);
    const r2 = await run("add_entity_labels", { entity_type: "ad_group", entities: [{ ad_group_id: "22" }], label_ids: ["4"] });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

describe("remove_entity_labels", () => {
  it("detaches labels (destructive) with the documented resource names, skipping pairs that are not attached", async () => {
    const r = await run("remove_entity_labels", { entity_type: "ad", entities: [{ ad_group_id: "21", ad_id: "801" }, { ad_group_id: "21", ad_id: "802" }], label_ids: ["3"] });
    expect(r.approval).toMatchObject({ risk: "destructive", change_set: { changes: [{ resource: "ad", id: "21~801", before: "3", after: null, effect: "remove" }] } });
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ adGroupAdLabelOperation: { remove: `${C}/adGroupAdLabels/21~801~3` } }]);
    expect(done.result).toEqual({ entity_type: "ad", detached: [{ entity: "21~801", label_id: "3" }], not_attached: [{ entity: "21~802", label_id: "3" }] });

    const g = await run("remove_entity_labels", { entity_type: "ad_group", entities: [{ ad_group_id: "21" }], label_ids: ["3"] });
    expect((await approve(g.approval!.approval_id, kit.second)).status).toBe("executed");
    expect(mutates[1]).toEqual([{ adGroupLabelOperation: { remove: `${C}/adGroupLabels/21~3` } }]);
    const k = await run("remove_entity_labels", { entity_type: "keyword", entities: [{ ad_group_id: "21", criterion_id: "1001" }], label_ids: ["3"] });
    expect((await approve(k.approval!.approval_id, kit.second)).status).toBe("executed");
    expect(mutates[2]).toEqual([{ adGroupCriterionLabelOperation: { remove: `${C}/adGroupCriterionLabels/21~1001~3` } }]);
  });

  it("refuses when nothing is attached, and reports unconfirmed removals", async () => {
    expect((await run("remove_entity_labels", { entity_type: "ad_group", entities: [{ ad_group_id: "22" }], label_ids: ["3"] })).error?.message).toContain("Nothing would change");
    expect((await run("remove_entity_labels", { entity_type: "ad_group", entities: [{ ad_group_id: "99" }], label_ids: ["3"] })).error?.code).toBe("not_found");
    links.keyword.push("21~1001~4"); // a different change from the one applied above (identical changes are refused as replays)
    const r = await run("remove_entity_labels", { entity_type: "keyword", entities: [{ ad_group_id: "21", criterion_id: "1001" }], label_ids: ["4"] });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
  });
});
