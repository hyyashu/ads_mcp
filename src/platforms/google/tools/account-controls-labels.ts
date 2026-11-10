import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, pick } from "../gaql";
import { accountId, entityStatus, googleRead, idSchema, str } from "./common";
import { rn, stateWrite } from "./write-kit";

/**
 * Labels on ad groups, ads and keywords: get_entity_labels, add_entity_labels, remove_entity_labels.
 * Links are AdGroupLabel, AdGroupAdLabel and AdGroupCriterionLabel (v26), with resource names
 *   customers/{customer_id}/adGroupLabels/{ad_group_id}~{label_id}
 *   customers/{customer_id}/adGroupAdLabels/{ad_group_id}~{ad_id}~{label_id}
 *   customers/{customer_id}/adGroupCriterionLabels/{ad_group_id}~{criterion_id}~{label_id}
 * All fields are Immutable: links are only created and removed.
 */
type EntityType = "ad_group" | "ad" | "keyword";
const ENTITY_TYPES = ["ad_group", "ad", "keyword"] as const;
const SPEC = {
  ad_group: { from: "ad_group_label", op: "adGroupLabelOperation", collection: "adGroupLabels", target: "adGroup" },
  ad: { from: "ad_group_ad_label", op: "adGroupAdLabelOperation", collection: "adGroupAdLabels", target: "adGroupAd" },
  keyword: { from: "ad_group_criterion_label", op: "adGroupCriterionLabelOperation", collection: "adGroupCriterionLabels", target: "adGroupCriterion" },
} as const;

const entity = z.object({ ad_group_id: idSchema, ad_id: idSchema.optional(), criterion_id: idSchema.optional().describe("Keyword criterion id (entity_type keyword).") });
type Entity = z.infer<typeof entity>;
const entityOk = (t: EntityType, e: Entity) => (t === "ad_group" ? !e.ad_id && !e.criterion_id : t === "ad" ? !!e.ad_id && !e.criterion_id : !!e.criterion_id && !e.ad_id);
const SHAPE_MSG = "entity_type ad_group takes ad_group_id only; ad takes ad_group_id and ad_id; keyword takes ad_group_id and criterion_id";
/** The entity's id inside its link's resource name: "{ad_group_id}", "{ad_group_id}~{ad_id}" or "{ad_group_id}~{criterion_id}". */
const entityKey = (t: EntityType, e: Entity) => (t === "ad_group" ? e.ad_group_id : `${e.ad_group_id}~${t === "ad" ? e.ad_id : e.criterion_id}`);
const entityRn = (ads: GoogleAdsClient, t: EntityType, key: string) => `customers/${ads.customerId}/${t === "ad_group" ? "adGroups" : t === "ad" ? "adGroupAds" : "adGroupCriteria"}/${key}`;

/** Selects and reads the entity side of a label link row (attributed resources of the *_label views). */
const ENTITY_FIELDS: Record<EntityType, string[]> = {
  ad_group: ["ad_group.id", "ad_group.name"],
  ad: ["ad_group.id", "ad_group_ad.ad.id", "ad_group_ad.ad.name"],
  keyword: ["ad_group.id", "ad_group_criterion.criterion_id", "ad_group_criterion.keyword.text", "ad_group_criterion.keyword.match_type"],
};
function rowEntity(t: EntityType, r: Row): { key: string; ad_group_id: string; ad_id: string | null; criterion_id: string | null; name: string | null } {
  const g = String(pick(r, "ad_group.id") ?? "");
  if (t === "ad_group") return { key: g, ad_group_id: g, ad_id: null, criterion_id: null, name: str(r, "ad_group.name") };
  if (t === "ad") {
    const ad = String(pick(r, "ad_group_ad.ad.id") ?? "");
    return { key: `${g}~${ad}`, ad_group_id: g, ad_id: ad, criterion_id: null, name: str(r, "ad_group_ad.ad.name") };
  }
  const k = String(pick(r, "ad_group_criterion.criterion_id") ?? "");
  const text = str(r, "ad_group_criterion.keyword.text");
  const mt = str(r, "ad_group_criterion.keyword.match_type");
  return { key: `${g}~${k}`, ad_group_id: g, ad_id: null, criterion_id: k, name: text ? `${text}${mt ? ` (${mt})` : ""}` : null };
}
/** GAQL filters that narrow a label view to the given entities (exact pairs are checked afterwards). */
function entityWhere(t: EntityType, entities: Entity[]): string[] {
  const groups = [...new Set(entities.map((e) => e.ad_group_id))].sort();
  const out = [`ad_group.id IN ${lit.list(groups.map(lit.id))}`];
  if (t === "ad") out.push(`ad_group_ad.ad.id IN ${lit.list([...new Set(entities.map((e) => e.ad_id!))].sort().map(lit.id))}`);
  if (t === "keyword") out.push(`ad_group_criterion.criterion_id IN ${lit.list([...new Set(entities.map((e) => e.criterion_id!))].sort().map(lit.id))}`);
  return out;
}

// ------------------------------------------------------------------------------------------------- get_entity_labels
export const getEntityLabels = googleRead({
  name: "get_entity_labels",
  title: "Labels on ad groups, ads or keywords",
  description:
    "Shows which labels are attached to ad groups, ads or keywords (entity_type): either for the given entities, or every entity of that type carrying label_id (or both). Label and keyword text come from Google. Use list_labels for the account's labels.",
  input: z
    .object({
      account_id: accountId,
      entity_type: z.enum(ENTITY_TYPES),
      entities: z.array(entity).max(100).optional().describe("Ad groups (ad_group_id), ads (ad_group_id + ad_id) or keywords (ad_group_id + criterion_id)."),
      label_id: idSchema.optional().describe("Only this label; alone, lists every entity of entity_type that carries it."),
      limit: z.number().int().min(1).max(5000).default(500),
    })
    .refine((v) => (v.entities?.length ?? 0) > 0 || v.label_id !== undefined, "give entities, label_id, or both")
    .refine((v) => (v.entities ?? []).every((e) => entityOk(v.entity_type, e)), SHAPE_MSG),
  output: z.object({
    labels: z.array(z.object({ entity_type: z.string(), ad_group_id: z.string(), ad_id: z.string().nullable(), criterion_id: z.string().nullable(), entity_name: z.string().nullable(), label_id: z.string(), label_name: z.string().nullable() })),
    returned: z.number(),
    truncated: z.boolean().describe("True when more matched than limit; raise limit to see the rest."),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const t = a.entity_type;
    const s = SPEC[t];
    const q = new Gaql().select(...ENTITY_FIELDS[t], "label.id", "label.name").from(s.from);
    if (a.entities?.length) for (const w of entityWhere(t, a.entities)) q.where(w);
    if (a.label_id) q.where(`${s.from}.label = ${lit.str(rn(ads, "labels", a.label_id))}`);
    q.orderBy("ad_group.id").limit(a.limit + 1);
    const wanted = a.entities?.length ? new Set(a.entities.map((e) => entityKey(t, e))) : null;
    const fetched = (await ads.query(q, { maxRows: a.limit + 1, partial: true })).filter((r) => !wanted || wanted.has(rowEntity(t, r).key));
    const rows = fetched.slice(0, a.limit);
    return {
      labels: rows.map((r) => {
        const e = rowEntity(t, r);
        return { entity_type: t, ad_group_id: e.ad_group_id, ad_id: e.ad_id, criterion_id: e.criterion_id, entity_name: e.name, label_id: String(pick(r, "label.id") ?? ""), label_name: str(r, "label.name") };
      }),
      returned: rows.length,
      truncated: fetched.length > a.limit,
    };
  },
});

// ----------------------------------------------------------------------------------------------- add/remove links
const writeInput = z
  .object({
    account_id: accountId,
    entity_type: z.enum(ENTITY_TYPES),
    entities: z.array(entity).min(1).max(100).describe("Ad groups (ad_group_id), ads (ad_group_id + ad_id) or keywords (ad_group_id + criterion_id)."),
    label_ids: z.array(idSchema).min(1).max(20).describe("Label ids from list_labels."),
  })
  .refine((v) => v.entities.every((e) => entityOk(v.entity_type, e)), SHAPE_MSG);
type WriteInput = z.infer<typeof writeInput>;
const noun = (t: EntityType) => (t === "ad_group" ? "ad group" : t);

/** Labels, the entities (which must exist, be of the right kind and not be removed) and their current links to the labels. */
async function readLinks(a: WriteInput, ads: GoogleAdsClient) {
  const t = a.entity_type;
  const labelIds = [...new Set(a.label_ids)].sort();
  const labelRows = await ads.query(new Gaql().select("label.id", "label.name", "label.status").from("label").where(`label.id IN ${lit.list(labelIds.map(lit.id))}`), { maxRows: labelIds.length });
  const labels = labelRows.filter((r) => str(r, "label.status") !== "REMOVED").map((r) => ({ id: String(pick(r, "label.id")), name: str(r, "label.name") }));
  const missingLabels = labelIds.filter((l) => !labels.some((x) => x.id === l));
  if (missingLabels.length) throw new ToolError("not_found", `No label ${missingLabels.join(", ")} in this account (see list_labels).`);

  const keys = [...new Set(a.entities.map((e) => entityKey(t, e)))].sort();
  const where = entityWhere(t, a.entities);
  let found: { key: string; name: string | null; status: string | null; type?: string | null }[];
  if (t === "ad_group") {
    const q = new Gaql().select("ad_group.id", "ad_group.name", "ad_group.status").from("ad_group");
    where.forEach((w) => q.where(w));
    found = (await ads.query(q, { maxRows: keys.length })).map((r) => ({ key: String(pick(r, "ad_group.id")), name: str(r, "ad_group.name"), status: str(r, "ad_group.status") }));
  } else if (t === "ad") {
    const q = new Gaql().select("ad_group.id", "ad_group_ad.ad.id", "ad_group_ad.ad.name", "ad_group_ad.status").from("ad_group_ad");
    where.forEach((w) => q.where(w));
    found = (await ads.query(q, { maxRows: 10_000 })).map((r) => ({ key: `${pick(r, "ad_group.id")}~${pick(r, "ad_group_ad.ad.id")}`, name: str(r, "ad_group_ad.ad.name"), status: str(r, "ad_group_ad.status") }));
  } else {
    const q = new Gaql().select("ad_group.id", "ad_group_criterion.criterion_id", "ad_group_criterion.type", "ad_group_criterion.status", "ad_group_criterion.keyword.text").from("ad_group_criterion");
    where.forEach((w) => q.where(w));
    found = (await ads.query(q, { maxRows: 10_000 })).map((r) => ({ key: `${pick(r, "ad_group.id")}~${pick(r, "ad_group_criterion.criterion_id")}`, name: str(r, "ad_group_criterion.keyword.text"), status: str(r, "ad_group_criterion.status"), type: str(r, "ad_group_criterion.type") }));
  }
  const byKey = new Map(found.map((x) => [x.key, x]));
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length) {
    // An ad group id that is really a campaign id is the most common mistake: say so.
    if (t === "ad_group" && missing.length === 1 && (await entityStatus(ads, "campaign", missing[0]!)) !== null) throw new ToolError("invalid_argument", `${missing[0]} is a campaign id, not an ad group id.`);
    throw new ToolError("not_found", `No ${noun(t)} ${missing.join(", ")} in this account.`);
  }
  const wrongType = keys.filter((k) => t === "keyword" && byKey.get(k)!.type !== "KEYWORD");
  if (wrongType.length) throw new ToolError("invalid_argument", `Not keywords: ${wrongType.map((k) => `${k} (${byKey.get(k)!.type})`).join(", ")}. entity_type keyword takes keyword criteria only.`);
  const removed = keys.filter((k) => byKey.get(k)!.status === "REMOVED");
  if (removed.length) throw new ToolError("invalid_argument", `Removed ${noun(t)}s cannot be labelled or unlabelled: ${removed.join(", ")}`);

  const s = SPEC[t];
  const lq = new Gaql().select(...ENTITY_FIELDS[t].filter((f) => !f.endsWith(".name") && !f.includes("keyword.")), "label.id").from(s.from);
  where.forEach((w) => lq.where(w));
  lq.where(`label.id IN ${lit.list(labelIds.map(lit.id))}`);
  const wanted = new Set(keys);
  const links = (await ads.query(lq, { maxRows: 10_000 })).filter((r) => wanted.has(rowEntity(t, r).key)).map((r) => `${rowEntity(t, r).key}~${pick(r, "label.id")}`).sort();
  return { labels, entities: keys.map((k) => ({ key: k, name: byKey.get(k)!.name })), links };
}
type LinkState = Awaited<ReturnType<typeof readLinks>>;
const pairs = (a: WriteInput) => {
  const keys = [...new Set(a.entities.map((e) => entityKey(a.entity_type, e)))].sort();
  return keys.flatMap((k) => [...new Set(a.label_ids)].sort().map((l) => ({ key: k, label: l, link: `${k}~${l}` })));
};
const labelName = (s: LinkState, id: string) => s.labels.find((l) => l.id === id)?.name ?? id;
const entityName = (s: LinkState, key: string) => s.entities.find((e) => e.key === key)?.name ?? null;

export const addEntityLabels = stateWrite({
  name: "add_entity_labels",
  title: "Label ad groups, ads or keywords",
  risk: "write",
  description:
    "Attaches existing labels (ids from list_labels or create_label) to ad groups (ad_group_id), ads (ad_group_id + ad_id) or keywords (ad_group_id + criterion_id), chosen by entity_type, after approval. Pairs that already exist are skipped. Confirmed by re-reading.",
  input: writeInput,
  output: z.object({ entity_type: z.string(), attached: z.array(z.object({ entity: z.string(), label_id: z.string() })), skipped_existing: z.array(z.object({ entity: z.string(), label_id: z.string() })) }),
  read: readLinks,
  build: (a, s, ads) => {
    const t = a.entity_type;
    const todo = pairs(a).filter((p) => !s.links.includes(p.link));
    if (!todo.length) throw new ToolError("invalid_argument", `Nothing would change: every ${noun(t)} already has these labels.`);
    const sp = SPEC[t];
    return {
      summary: `Attach label(s) to ${new Set(todo.map((p) => p.key)).size} ${noun(t)}(s): ${todo.slice(0, 20).map((p) => `${entityName(s, p.key) ?? p.key} <- ${labelName(s, p.label)}`).join(", ")}${todo.length > 20 ? ", …" : ""}`,
      changes: todo.map((p): Change => ({ resource: t, id: p.key, name: entityName(s, p.key), field: "label", before: null, after: p.label, unit: "text", effect: "neutral" })),
      ops: todo.map((p) => ({ [sp.op]: { create: { [sp.target]: entityRn(ads, t, p.key), label: rn(ads, "labels", p.label) } } })),
    };
  },
  landed: (a, _b, after) => pairs(a).every((p) => after.links.includes(p.link)),
  result: (a, _after, _r, before) => {
    const all = pairs(a).map((p) => ({ entity: p.key, label_id: p.label, had: before.links.includes(p.link) }));
    return { entity_type: a.entity_type, attached: all.filter((p) => !p.had).map(({ entity, label_id }) => ({ entity, label_id })), skipped_existing: all.filter((p) => p.had).map(({ entity, label_id }) => ({ entity, label_id })) };
  },
});

export const removeEntityLabels = stateWrite({
  name: "remove_entity_labels",
  title: "Remove labels from ad groups, ads or keywords",
  risk: "destructive",
  description:
    "Detaches labels from ad groups (ad_group_id), ads (ad_group_id + ad_id) or keywords (ad_group_id + criterion_id), chosen by entity_type, after a person approves it. The labels themselves stay in the account. Pairs that are not attached are skipped. Confirmed by re-reading.",
  input: writeInput,
  output: z.object({ entity_type: z.string(), detached: z.array(z.object({ entity: z.string(), label_id: z.string() })), not_attached: z.array(z.object({ entity: z.string(), label_id: z.string() })) }),
  read: readLinks,
  build: (a, s, ads) => {
    const t = a.entity_type;
    const todo = pairs(a).filter((p) => s.links.includes(p.link));
    if (!todo.length) throw new ToolError("invalid_argument", `Nothing would change: none of these ${noun(t)}s has these labels.`);
    const sp = SPEC[t];
    return {
      summary: `Detach label(s) from ${new Set(todo.map((p) => p.key)).size} ${noun(t)}(s): ${todo.slice(0, 20).map((p) => `${entityName(s, p.key) ?? p.key} -/- ${labelName(s, p.label)}`).join(", ")}${todo.length > 20 ? ", …" : ""}`,
      changes: todo.map((p): Change => ({ resource: t, id: p.key, name: entityName(s, p.key), field: "label", before: p.label, after: null, unit: "text", effect: "remove" })),
      ops: todo.map((p) => ({ [sp.op]: { remove: `customers/${ads.customerId}/${sp.collection}/${p.link}` } })),
    };
  },
  landed: (a, _b, after) => pairs(a).every((p) => !after.links.includes(p.link)),
  result: (a, _after, _r, before) => {
    const all = pairs(a).map((p) => ({ entity: p.key, label_id: p.label, had: before.links.includes(p.link) }));
    return { entity_type: a.entity_type, detached: all.filter((p) => p.had).map(({ entity, label_id }) => ({ entity, label_id })), not_attached: all.filter((p) => !p.had).map(({ entity, label_id }) => ({ entity, label_id })) };
  },
});

export const entityLabelTools = [getEntityLabels, addEntityLabels, removeEntityLabels];
