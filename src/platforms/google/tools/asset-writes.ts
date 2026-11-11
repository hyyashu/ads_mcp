import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { type Change, textChange } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, pick } from "../gaql";
import { tailId } from "./campaign-reads";
import { accountId, idSchema, str } from "./common";
import { rn, stateWrite, temp } from "./write-kit";

/**
 * Campaign-level extensions (assets): sitelinks, callouts, structured snippets, calls and business name.
 * An extension is an asset plus a campaign_asset link. Adding creates both in one atomic request (temporary ids);
 * removing deletes the link only (assets themselves cannot be deleted in Google Ads). Text limits are Google Ads'
 * published limits; Google enforces them too.
 */
export const clean = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");
export const url = z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u), "http(s) URL");
type FieldType = "SITELINK" | "CALLOUT" | "STRUCTURED_SNIPPET" | "CALL" | "BUSINESS_NAME";
/** Field types other tool files link with these helpers (more-assets.ts); they pass their own LinkContent. */
export type LinkFieldType = FieldType | "PROMOTION" | "PRICE" | "LEAD_FORM" | "BUSINESS_MESSAGE";
/** The asset fields to read with each link and how to turn a row into its identity (key) and display label. */
export interface LinkContent {
  fields: string[];
  key: (r: Row) => { key: string; label: string };
}

export interface Link {
  asset_id: string;
  status: string;
  key: string;
  label: string;
}
interface CampaignAssets {
  campaign: { id: string; name: string | null; status: string };
  links: Link[];
}

const CONTENT_FIELDS = ["asset.final_urls", "asset.sitelink_asset.link_text", "asset.callout_asset.callout_text", "asset.structured_snippet_asset.header", "asset.structured_snippet_asset.values", "asset.call_asset.phone_number", "asset.call_asset.country_code", "asset.text_asset.text"];
/** Identity of an extension's content, used to skip duplicates (case-insensitive, as Google compares them). */
function contentKey(fieldType: FieldType, r: Row): { key: string; label: string } {
  const low = (v: unknown) => String(v ?? "").trim().toLowerCase();
  if (fieldType === "SITELINK") {
    const t = str(r, "asset.sitelink_asset.link_text") ?? "";
    const u = ((pick(r, "asset.final_urls") as string[] | undefined) ?? [])[0] ?? "";
    return { key: `${low(t)}|${low(u)}`, label: `${t} -> ${u}` };
  }
  if (fieldType === "CALLOUT") return { key: low(pick(r, "asset.callout_asset.callout_text")), label: str(r, "asset.callout_asset.callout_text") ?? "" };
  if (fieldType === "STRUCTURED_SNIPPET") {
    const h = str(r, "asset.structured_snippet_asset.header") ?? "";
    const v = ((pick(r, "asset.structured_snippet_asset.values") as string[] | undefined) ?? []).map(low);
    return { key: `${low(h)}|${v.join(",")}`, label: `${h}: ${v.join(", ")}` };
  }
  if (fieldType === "CALL") {
    const p = (str(r, "asset.call_asset.phone_number") ?? "").replace(/[^\d+]/g, "");
    return { key: `${low(pick(r, "asset.call_asset.country_code"))}|${p}`, label: `${str(r, "asset.call_asset.country_code")} ${str(r, "asset.call_asset.phone_number")}` };
  }
  return { key: low(pick(r, "asset.text_asset.text")), label: str(r, "asset.text_asset.text") ?? "" };
}

const defaultContent = (fieldType: LinkFieldType): LinkContent => ({ fields: CONTENT_FIELDS, key: (r) => contentKey(fieldType as FieldType, r) });
export async function readCampaignAssets(ads: GoogleAdsClient, campaignId: string, fieldType: LinkFieldType, content: LinkContent = defaultContent(fieldType)): Promise<CampaignAssets> {
  const [c] = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status").from("campaign").where(`campaign.id = ${lit.id(campaignId)}`).limit(1), { maxRows: 1 });
  if (!c) throw new ToolError("not_found", `No campaign ${campaignId} in this account.`);
  if (str(c, "campaign.status") === "REMOVED") throw new ToolError("invalid_argument", "The campaign is removed and cannot be changed.");
  const rows = await ads.query(
    new Gaql().select("asset.id", "campaign_asset.status", ...content.fields).from("campaign_asset").where(`campaign_asset.campaign = ${lit.str(rn(ads, "campaigns", campaignId))}`).where(`campaign_asset.field_type = '${fieldType}'`).where("campaign_asset.status != 'REMOVED'"),
    { maxRows: 2000 },
  );
  const links = rows.map((r) => ({ asset_id: String(pick(r, "asset.id") ?? ""), status: str(r, "campaign_asset.status") ?? "", ...content.key(r) })).sort((x, y) => x.asset_id.localeCompare(y.asset_id));
  return { campaign: { id: campaignId, name: str(c, "campaign.name"), status: str(c, "campaign.status")! }, links };
}

// ------------------------------------------------------------------------------- link levels: account, campaign, ad group
/** Where an extension is linked. An account-level link applies to every campaign that does not exclude its field type. */
type Level = "account" | "campaign" | "ad_group";
export interface Scope {
  level: Level;
  campaign_id?: string | undefined;
  ad_group_id?: string | undefined;
}
export const scopeFields = {
  level: z.enum(["campaign", "ad_group", "account"]).default("campaign").describe("campaign (default, give campaign_id), ad_group (give ad_group_id) or account (give neither; applies to every campaign that does not exclude the type)."),
  campaign_id: idSchema.optional(),
  ad_group_id: idSchema.optional(),
};
export const scopeOk = (v: Scope) => (v.level === "campaign" ? v.campaign_id !== undefined && v.ad_group_id === undefined : v.level === "ad_group" ? v.ad_group_id !== undefined && v.campaign_id === undefined : v.campaign_id === undefined && v.ad_group_id === undefined);
export const scopeMsg = { message: "give campaign_id for level campaign, ad_group_id for level ad_group, and neither for level account" };

/** Links of one field type at a level. Campaign level keeps readCampaignAssets' shape, so pending approvals still match. */
export interface ScopedLinks {
  campaign?: { id: string; name: string | null; status: string };
  ad_group?: { id: string; name: string | null; status: string };
  links: Link[];
}
export async function readLinks(ads: GoogleAdsClient, s: Scope, fieldType: LinkFieldType, content: LinkContent = defaultContent(fieldType)): Promise<ScopedLinks> {
  if (s.level === "campaign") return readCampaignAssets(ads, s.campaign_id!, fieldType, content);
  let owner: ScopedLinks["ad_group"];
  if (s.level === "ad_group") {
    const [g] = await ads.query(new Gaql().select("ad_group.id", "ad_group.name", "ad_group.status").from("ad_group").where(`ad_group.id = ${lit.id(s.ad_group_id!)}`).limit(1), { maxRows: 1 });
    if (!g) throw new ToolError("not_found", `No ad group ${s.ad_group_id} in this account.`);
    if (str(g, "ad_group.status") === "REMOVED") throw new ToolError("invalid_argument", "The ad group is removed and cannot be changed.");
    owner = { id: s.ad_group_id!, name: str(g, "ad_group.name"), status: str(g, "ad_group.status")! };
  }
  const res = s.level === "ad_group" ? "ad_group_asset" : "customer_asset";
  const rows = await ads.query(
    new Gaql()
      .select("asset.id", `${res}.status`, ...content.fields)
      .from(res)
      .where(s.level === "ad_group" ? `ad_group_asset.ad_group = ${lit.str(rn(ads, "adGroups", s.ad_group_id!))}` : undefined)
      .where(`${res}.field_type = '${fieldType}'`)
      .where(`${res}.status != 'REMOVED'`),
    { maxRows: 2000 },
  );
  const links = rows.map((r) => ({ asset_id: String(pick(r, "asset.id") ?? ""), status: str(r, `${res}.status`) ?? "", ...content.key(r) })).sort((x, y) => x.asset_id.localeCompare(y.asset_id));
  return { ...(owner ? { ad_group: owner } : {}), links };
}
/** "the account", campaign "Brand" or ad group "Shoes", for summaries and errors. */
export const where = (s: Scope, snap: ScopedLinks) => (s.level === "account" ? "the account" : s.level === "campaign" ? `campaign "${snap.campaign?.name ?? s.campaign_id}"` : `ad group "${snap.ad_group?.name ?? s.ad_group_id}"`);
export const ownerRef = (ads: GoogleAdsClient, s: Scope, snap: ScopedLinks) =>
  s.level === "account" ? { resource: "account", id: ads.customerId } : s.level === "campaign" ? { resource: "campaign", id: s.campaign_id!, name: snap.campaign?.name ?? null } : { resource: "ad_group", id: s.ad_group_id!, name: snap.ad_group?.name ?? null };
/** The mutate operation that creates or removes one link at the scope's level. */
export function linkOp(ads: GoogleAdsClient, s: Scope, assetId: string, fieldType: LinkFieldType, action: "create" | "remove"): Row {
  const c = ads.customerId;
  if (s.level === "account") return { customerAssetOperation: action === "create" ? { create: { asset: rn(ads, "assets", assetId), fieldType } } : { remove: `customers/${c}/customerAssets/${assetId}~${fieldType}` } };
  if (s.level === "ad_group") return { adGroupAssetOperation: action === "create" ? { create: { asset: rn(ads, "assets", assetId), adGroup: rn(ads, "adGroups", s.ad_group_id!), fieldType } } : { remove: `customers/${c}/adGroupAssets/${s.ad_group_id}~${assetId}~${fieldType}` } };
  return { campaignAssetOperation: action === "create" ? { create: { asset: rn(ads, "assets", assetId), campaign: rn(ads, "campaigns", s.campaign_id!), fieldType } } : { remove: `customers/${c}/campaignAssets/${s.campaign_id}~${assetId}~${fieldType}` } };
}
export const scopeResult = (s: Scope) => ({ level: s.level, campaign_id: s.campaign_id ?? null, ad_group_id: s.ad_group_id ?? null });
export const scopeOutput = { level: z.string(), campaign_id: z.string().nullable(), ad_group_id: z.string().nullable() };

/** Builds "add extensions" tools: new items become asset + link pairs; items whose content is already linked are skipped. */
function addTool<T>(o: {
  name: string;
  title: string;
  description: string;
  fieldType: FieldType;
  item: z.ZodType<T>;
  max: number;
  /** The asset fields for one item (without resourceName). */
  asset: (it: T) => Row;
  key: (it: T) => { key: string; label: string };
}) {
  const input = z.object({ account_id: accountId, campaign_id: idSchema, items: z.array(o.item).min(1).max(o.max) });
  return stateWrite({
    name: o.name,
    title: o.title,
    risk: "write",
    description: o.description,
    input,
    output: z.object({ campaign_id: z.string(), added: z.array(z.object({ asset_id: z.string(), label: z.string() })), skipped_existing: z.array(z.string()) }),
    read: (a, ads) => readCampaignAssets(ads, a.campaign_id, o.fieldType),
    build: (a, s, ads) => {
      const have = new Set(s.links.map((l) => l.key));
      const seen = new Set<string>();
      const fresh = (a.items as T[]).filter((it) => {
        const k = o.key(it).key;
        if (have.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const skipped = (a.items as T[]).filter((it) => have.has(o.key(it).key)).map((it) => o.key(it).label);
      if (!fresh.length) throw new ToolError("invalid_argument", `Nothing would change: every item is already on the campaign (${skipped.slice(0, 5).join("; ")}).`);
      const ops: Row[] = [];
      fresh.forEach((it, i) => {
        const tmp = temp(ads, "assets", i + 1);
        ops.push({ assetOperation: { create: { resourceName: tmp, ...o.asset(it) } } });
        ops.push({ campaignAssetOperation: { create: { asset: tmp, campaign: rn(ads, "campaigns", a.campaign_id), fieldType: o.fieldType } } });
      });
      const changes: Change[] = fresh.map((it) => textChange({ resource: "campaign", id: a.campaign_id, name: s.campaign.name }, o.fieldType.toLowerCase(), null, o.key(it).label));
      return { summary: `Add ${fresh.length} ${o.fieldType.toLowerCase().replace("_", " ")}(s) to campaign "${s.campaign.name ?? a.campaign_id}": ${fresh.slice(0, 5).map((it) => o.key(it).label).join("; ")}${skipped.length ? ` (${skipped.length} already present)` : ""}`, changes, ops };
    },
    landed: (a, _before, after) => (a.items as T[]).every((it) => after.links.some((l) => l.key === o.key(it).key)),
    result: (a, after, _res, before) => {
      const had = new Set(before.links.map((l) => l.key));
      const items = a.items as T[];
      const added = items.filter((it) => !had.has(o.key(it).key)).map((it) => after.links.find((l) => l.key === o.key(it).key)).filter((l): l is Link => !!l);
      return { campaign_id: a.campaign_id, added: [...new Map(added.map((l) => [l.asset_id, { asset_id: l.asset_id, label: l.label }])).values()], skipped_existing: items.filter((it) => had.has(o.key(it).key)).map((it) => o.key(it).label) };
    },
  });
}

/** Builds "remove extensions" tools: unlinks the given assets from a campaign, ad group or the account (the asset stays in the library). */
function removeTool(o: { name: string; title: string; description: string; fieldType: FieldType }) {
  return stateWrite({
    name: o.name,
    title: o.title,
    risk: "destructive",
    description: `${o.description} Works at campaign (default), ad group or account level.`,
    input: z.object({ account_id: accountId, ...scopeFields, asset_ids: z.array(idSchema).min(1).max(50) }).refine(scopeOk, scopeMsg),
    output: z.object({ ...scopeOutput, removed: z.array(z.string()) }),
    read: (a, ads) => readLinks(ads, a, o.fieldType),
    build: (a, s, ads) => {
      const ids = [...new Set(a.asset_ids)].sort();
      const missing = ids.filter((id) => !s.links.some((l) => l.asset_id === id));
      if (missing.length) throw new ToolError("invalid_argument", `Not linked to ${a.level === "account" ? "the account" : `this ${a.level === "campaign" ? "campaign" : "ad group"}`} as ${o.fieldType}: ${missing.join(", ")}`);
      const ops = ids.map((id) => linkOp(ads, a, id, o.fieldType, "remove"));
      const changes = ids.map((id) => textChange(ownerRef(ads, a, s), o.fieldType.toLowerCase(), s.links.find((l) => l.asset_id === id)!.label, "(removed)"));
      // A removal is irreversible as a link: re-adding creates a new link without the old history.
      for (const c of changes) c.effect = "remove";
      return { summary: `Remove ${ids.length} ${o.fieldType.toLowerCase().replace("_", " ")}(s) from ${where(a, s)}: ${ids.map((id) => s.links.find((l) => l.asset_id === id)!.label).slice(0, 5).join("; ")}`, changes, ops };
    },
    landed: (a, _b, after) => a.asset_ids.every((id) => !after.links.some((l) => l.asset_id === id)),
    result: (a) => ({ ...scopeResult(a), removed: [...new Set(a.asset_ids)].sort() }),
  });
}

// ---------------------------------------------------------------------------------------------------- sitelinks
const sitelink = z
  .object({ link_text: clean(25), final_url: url, description1: clean(35).optional(), description2: clean(35).optional() })
  .refine((s) => (s.description1 === undefined) === (s.description2 === undefined), "give both descriptions or neither");
export const addSitelinks = addTool({
  name: "add_sitelinks",
  title: "Add sitelinks",
  description: "Adds sitelinks (extra links under an ad) to a campaign after approval. Each has link text (max 25 characters), a final URL, and optionally two description lines (max 35 each, both or neither). Sitelinks already on the campaign with the same text and URL are skipped. Created atomically and confirmed by re-reading.",
  fieldType: "SITELINK",
  item: sitelink,
  max: 20,
  asset: (s) => ({ finalUrls: [s.final_url], sitelinkAsset: { linkText: s.link_text, ...(s.description1 ? { description1: s.description1, description2: s.description2 } : {}) } }),
  key: (s) => ({ key: `${s.link_text.trim().toLowerCase()}|${s.final_url.trim().toLowerCase()}`, label: `${s.link_text} -> ${s.final_url}` }),
});
export const removeSitelinks = removeTool({ name: "remove_sitelinks", title: "Remove sitelinks", description: "Removes sitelinks from a campaign after a person approves it (the sitelink assets stay in the asset library). Give the asset ids from list_campaign_extensions. Confirmed by re-reading.", fieldType: "SITELINK" });

// ----------------------------------------------------------------------------------------------------- callouts
export const addCalloutExtensions = addTool({
  name: "add_callout_extensions",
  title: "Add callouts",
  description: "Adds callouts (short phrases such as 'Free shipping', max 25 characters) to a campaign after approval. Callouts already on the campaign are skipped. Created atomically and confirmed by re-reading.",
  fieldType: "CALLOUT",
  item: z.object({ text: clean(25) }),
  max: 20,
  asset: (c) => ({ calloutAsset: { calloutText: c.text } }),
  key: (c) => ({ key: c.text.trim().toLowerCase(), label: c.text }),
});
export const removeCallouts = removeTool({ name: "remove_callouts", title: "Remove callouts", description: "Removes callouts from a campaign after a person approves it (the assets stay in the library). Give the asset ids from list_campaign_extensions. Confirmed by re-reading.", fieldType: "CALLOUT" });

// ------------------------------------------------------------------------------------------- structured snippets
/** English headers from Google's "Structured snippet headers" reference (localized variants are not accepted here). */
export const SNIPPET_HEADERS = ["Amenities", "Brands", "Courses", "Degree programs", "Destinations", "Featured hotels", "Insurance coverage", "Models", "Neighborhoods", "Service catalog", "Shows", "Styles", "Types"] as const;
export const addStructuredSnippets = addTool({
  name: "add_structured_snippets",
  title: "Add structured snippets",
  description: `Adds structured snippets (a header plus 3 to 10 values, each value max 25 characters) to a campaign after approval. The header must be one of Google's English headers: ${SNIPPET_HEADERS.join(", ")}. Identical snippets are skipped. Created atomically and confirmed by re-reading.`,
  fieldType: "STRUCTURED_SNIPPET",
  item: z.object({ header: z.enum(SNIPPET_HEADERS), values: z.array(clean(25)).min(3).max(10) }),
  max: 10,
  asset: (s) => ({ structuredSnippetAsset: { header: s.header, values: s.values } }),
  key: (s) => ({ key: `${s.header.toLowerCase()}|${s.values.map((v) => v.trim().toLowerCase()).join(",")}`, label: `${s.header}: ${s.values.join(", ")}` }),
});
export const removeStructuredSnippets = removeTool({ name: "remove_structured_snippets", title: "Remove structured snippets", description: "Removes structured snippets from a campaign after a person approves it (the assets stay in the library). Give the asset ids from list_campaign_extensions. Confirmed by re-reading.", fieldType: "STRUCTURED_SNIPPET" });

// ---------------------------------------------------------------------------------------------------- call assets
export const addCallAsset = addTool({
  name: "add_call_asset",
  title: "Add call asset",
  description: "Adds a phone number (call asset) to a campaign after approval, with its two-letter country code. Calls from ads can be reported as conversions using the account's call conversion action. A number already on the campaign is skipped. Created atomically and confirmed by re-reading.",
  fieldType: "CALL",
  item: z.object({ country_code: z.string().regex(/^[A-Z]{2}$/), phone_number: z.string().trim().regex(/^\+?[0-9 ()-]{5,25}$/, "a phone number") }),
  max: 1,
  asset: (c) => ({ callAsset: { countryCode: c.country_code, phoneNumber: c.phone_number, callConversionReportingState: "USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION" } }),
  key: (c) => ({ key: `${c.country_code.toLowerCase()}|${c.phone_number.replace(/[^\d+]/g, "")}`, label: `${c.country_code} ${c.phone_number}` }),
});
export const removeCallAssets = removeTool({ name: "remove_call_assets", title: "Remove call assets", description: "Removes phone numbers (call assets) from a campaign after a person approves it (the assets stay in the library). Give the asset ids from list_call_assets. Confirmed by re-reading.", fieldType: "CALL" });

export const setCallAssetStatus = stateWrite({
  name: "set_call_asset_status",
  title: "Pause or enable call assets",
  risk: "write",
  description: "Pauses or enables phone numbers (call assets) linked to a campaign, after approval. Paused numbers stop showing with ads but stay linked. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, asset_ids: z.array(idSchema).min(1).max(20), status: z.enum(["ENABLED", "PAUSED"]) }),
  output: z.object({ campaign_id: z.string(), updated: z.array(z.string()), status: z.string() }),
  read: (a, ads) => readCampaignAssets(ads, a.campaign_id, "CALL"),
  build: (a, s, ads) => {
    const ids = [...new Set(a.asset_ids)].sort();
    const missing = ids.filter((id) => !s.links.some((l) => l.asset_id === id));
    if (missing.length) throw new ToolError("invalid_argument", `Not linked to this campaign as a call asset: ${missing.join(", ")}`);
    const changing = ids.filter((id) => s.links.find((l) => l.asset_id === id)!.status !== a.status);
    if (!changing.length) throw new ToolError("invalid_argument", `Nothing would change: already ${a.status.toLowerCase()}.`);
    const ops = changing.map((id) => ({ campaignAssetOperation: { update: { resourceName: `customers/${ads.customerId}/campaignAssets/${a.campaign_id}~${id}~CALL`, status: a.status }, updateMask: "status" } }));
    const changes = changing.map((id) => textChange({ resource: "call_asset", id, name: s.links.find((l) => l.asset_id === id)!.label }, "status", s.links.find((l) => l.asset_id === id)!.status, a.status));
    return { summary: `Set ${changing.length} call asset(s) on campaign "${s.campaign.name ?? a.campaign_id}" to ${a.status}`, changes, ops };
  },
  landed: (a, _b, after) => a.asset_ids.every((id) => after.links.find((l) => l.asset_id === id)?.status === a.status),
  result: (a) => ({ campaign_id: a.campaign_id, updated: [...new Set(a.asset_ids)].sort(), status: a.status }),
});

// ------------------------------------------------------------------------------------------ existing library assets
/** Field types whose asset can be shared by several campaigns; the business name is replaced, not added (add_business_name_asset). */
const LINKABLE = ["SITELINK", "CALLOUT", "STRUCTURED_SNIPPET", "CALL"] as const satisfies readonly FieldType[];
export const linkExistingAssets = stateWrite({
  name: "link_existing_assets",
  title: "Link existing assets",
  risk: "write",
  description:
    "Links assets already in the account's asset library (sitelinks, callouts, structured snippets or phone numbers) to a campaign, an ad group or the whole account after approval, without creating new ones, so they share the asset and its history. An account-level link shows with every campaign that does not exclude the type (exclude_account_assets_from_campaign). Give the field type and the asset ids from list_call_assets, list_campaign_extensions or discover_existing_assets. Each asset must be of that type; assets already linked there (enabled or paused) are skipped. Created atomically and confirmed by re-reading.",
  input: z.object({ account_id: accountId, ...scopeFields, field_type: z.enum(LINKABLE), asset_ids: z.array(idSchema).min(1).max(20) }).refine(scopeOk, scopeMsg),
  output: z.object({ ...scopeOutput, field_type: z.string(), linked: z.array(z.object({ asset_id: z.string(), label: z.string() })), skipped_existing: z.array(z.string()) }),
  read: async (a, ads) => {
    const ids = [...new Set(a.asset_ids)].sort();
    const [scoped, rows] = await Promise.all([
      readLinks(ads, a, a.field_type),
      ads.query(new Gaql().select("asset.id", "asset.type", ...CONTENT_FIELDS).from("asset").where(`asset.id IN ${lit.list(ids.map(lit.id))}`), { maxRows: ids.length }),
    ]);
    const assets = rows.map((r) => ({ asset_id: String(pick(r, "asset.id") ?? ""), type: str(r, "asset.type") ?? "", label: contentKey(a.field_type, r).label })).sort((x, y) => x.asset_id.localeCompare(y.asset_id));
    return { ...scoped, assets };
  },
  build: (a, s, ads) => {
    const ids = [...new Set(a.asset_ids)].sort();
    const missing = ids.filter((id) => !s.assets.some((x) => x.asset_id === id));
    if (missing.length) throw new ToolError("not_found", `No asset ${missing.join(", ")} in this account's asset library.`);
    const wrong = s.assets.filter((x) => x.type !== a.field_type);
    if (wrong.length) throw new ToolError("invalid_argument", `Not ${a.field_type} assets: ${wrong.map((x) => `${x.asset_id} is a ${x.type} asset`).join("; ")}.`);
    const skipped = ids.filter((id) => s.links.some((l) => l.asset_id === id));
    const fresh = s.assets.filter((x) => !skipped.includes(x.asset_id));
    if (!fresh.length) throw new ToolError("invalid_argument", `Nothing would change: ${skipped.join(", ")} already linked to ${where(a, s)}.`);
    const kind = a.field_type.toLowerCase().replace("_", " ");
    return {
      summary: `Link ${fresh.length} existing ${kind} asset(s) to ${where(a, s)}${a.level === "account" ? " (every campaign that does not exclude account-level ones)" : ""}: ${fresh.slice(0, 5).map((x) => x.label).join("; ")}${skipped.length ? ` (${skipped.length} already linked)` : ""}`,
      changes: fresh.map((x) => textChange(ownerRef(ads, a, s), a.field_type.toLowerCase(), null, x.label)),
      ops: fresh.map((x) => linkOp(ads, a, x.asset_id, a.field_type, "create")),
    };
  },
  landed: (a, _b, after) => a.asset_ids.every((id) => after.links.some((l) => l.asset_id === id)),
  result: (a, after, _res, before) => {
    const had = new Set(before.links.map((l) => l.asset_id));
    const ids = [...new Set(a.asset_ids)].sort();
    return { ...scopeResult(a), field_type: a.field_type, linked: ids.filter((id) => !had.has(id)).map((id) => ({ asset_id: id, label: after.assets.find((x) => x.asset_id === id)!.label })), skipped_existing: ids.filter((id) => had.has(id)) };
  },
});

// ------------------------------------------------------------------------------------------- edit an asset in place
/** One editable field: its name in the output, its update-mask path, and where it goes in the update body. */
interface Edit {
  field: string;
  mask: string;
  before: string | null;
  after: string | null;
  set: (u: Row) => void;
}
const sitelinkPatch = z
  .object({ link_text: clean(25).optional(), final_url: url.optional(), description1: clean(35).nullable().optional(), description2: clean(35).nullable().optional() })
  .refine((o) => Object.values(o).some((v) => v !== undefined), "give at least one field to change")
  .describe("Fields to change; null for description1/description2 clears it (clear both or neither).");
const snippetPatch = z.object({ header: z.enum(SNIPPET_HEADERS).optional(), values: z.array(clean(25)).min(3).max(10).optional() }).refine((o) => o.header !== undefined || o.values !== undefined, "give header or values");
const callPatch = z.object({ country_code: z.string().regex(/^[A-Z]{2}$/).optional(), phone_number: z.string().trim().regex(/^\+?[0-9 ()-]{5,25}$/, "a phone number").optional() }).refine((o) => o.country_code !== undefined || o.phone_number !== undefined, "give country_code or phone_number");
const EDIT_KINDS = { sitelink: "SITELINK", callout: "CALLOUT", structured_snippet: "STRUCTURED_SNIPPET", call: "CALL" } as const;
const nest = (u: Row, key: string, k: string, v: unknown) => ((u[key] = { ...((u[key] as Row | undefined) ?? {}), [k]: v }), undefined);

export const updateExtensionAsset = stateWrite({
  name: "update_extension_asset",
  title: "Edit an extension asset",
  risk: "write",
  description:
    "Edits a sitelink, callout, structured snippet or phone number (call asset) in place after approval, keeping its id and history. The asset changes everywhere it is linked: the approval lists every campaign, ad group and account link. Give the asset id and exactly one of sitelink, callout, structured_snippet or call with only the fields to change. Assets Google created automatically cannot be edited. Confirmed by re-reading.",
  input: z
    .object({ account_id: accountId, asset_id: idSchema, sitelink: sitelinkPatch.optional(), callout: z.object({ text: clean(25) }).optional(), structured_snippet: snippetPatch.optional(), call: callPatch.optional() })
    .refine((v) => Object.keys(EDIT_KINDS).filter((k) => v[k as keyof typeof EDIT_KINDS] !== undefined).length === 1, { message: "give exactly one of sitelink, callout, structured_snippet or call" }),
  output: z.object({ asset_id: z.string(), field_type: z.string(), updated: z.array(z.string()), used_in: z.number().int() }),
  read: async (a, ads) => {
    const asset = rn(ads, "assets", a.asset_id);
    const [rows, acct, camp, grp] = await Promise.all([
      ads.query(new Gaql().select("asset.id", "asset.type", "asset.source", ...CONTENT_FIELDS).from("asset").where(`asset.id IN ${lit.list([lit.id(a.asset_id)])}`), { maxRows: 1 }),
      ads.query(new Gaql().select("customer_asset.field_type").from("customer_asset").where(`customer_asset.asset = ${lit.str(asset)}`).where("customer_asset.status != 'REMOVED'"), { maxRows: 100 }),
      ads.query(new Gaql().select("campaign_asset.campaign", "campaign.name").from("campaign_asset").where(`campaign_asset.asset = ${lit.str(asset)}`).where("campaign_asset.status != 'REMOVED'"), { maxRows: 5000 }),
      ads.query(new Gaql().select("ad_group_asset.ad_group", "ad_group.name").from("ad_group_asset").where(`ad_group_asset.asset = ${lit.str(asset)}`).where("ad_group_asset.status != 'REMOVED'"), { maxRows: 5000 }),
    ]);
    const r = rows[0];
    const used = [
      ...(acct.length ? ["the account"] : []),
      ...camp.map((x) => ({ id: tailId(pick(x, "campaign_asset.campaign")) ?? "", name: str(x, "campaign.name") })).sort((x, y) => x.id.localeCompare(y.id)).map((x) => `campaign "${x.name ?? x.id}"`),
      ...grp.map((x) => ({ id: tailId(pick(x, "ad_group_asset.ad_group")) ?? "", name: str(x, "ad_group.name") })).sort((x, y) => x.id.localeCompare(y.id)).map((x) => `ad group "${x.name ?? x.id}"`),
    ];
    if (!r) return { asset: null, used };
    const arr = (f: string) => (pick(r, f) as string[] | undefined) ?? [];
    return {
      asset: {
        type: str(r, "asset.type"),
        source: str(r, "asset.source"),
        link_text: str(r, "asset.sitelink_asset.link_text"),
        final_url: arr("asset.final_urls")[0] ?? null,
        description1: str(r, "asset.sitelink_asset.description1"),
        description2: str(r, "asset.sitelink_asset.description2"),
        callout_text: str(r, "asset.callout_asset.callout_text"),
        header: str(r, "asset.structured_snippet_asset.header"),
        values: arr("asset.structured_snippet_asset.values").join(", ") || null,
        country_code: str(r, "asset.call_asset.country_code"),
        phone_number: str(r, "asset.call_asset.phone_number"),
      },
      used,
    };
  },
  build: (a, s, ads) => {
    const kind = (Object.keys(EDIT_KINDS) as (keyof typeof EDIT_KINDS)[]).find((k) => a[k] !== undefined)!;
    const want = EDIT_KINDS[kind];
    const cur = s.asset;
    if (!cur) throw new ToolError("not_found", `No asset ${a.asset_id} in this account's asset library.`);
    if (cur.type !== want) throw new ToolError("invalid_argument", `${a.asset_id} is a ${cur.type} asset, not a ${want} asset.`);
    if (cur.source === "AUTOMATICALLY_CREATED") throw new ToolError("invalid_argument", `Asset ${a.asset_id} was created automatically by Google and cannot be edited. Link your own asset instead.`);
    const edits: Edit[] = [];
    const edit = (field: string, mask: string, after: string | null, set: Edit["set"]) => {
      const before = (cur as Record<string, string | null>)[field] ?? null;
      if (after !== before) edits.push({ field, mask, before, after, set });
    };
    if (a.sitelink) {
      const p = a.sitelink;
      if (p.link_text !== undefined) edit("link_text", "sitelink_asset.link_text", p.link_text, (u) => nest(u, "sitelinkAsset", "linkText", p.link_text));
      if (p.final_url !== undefined) edit("final_url", "final_urls", p.final_url, (u) => void (u.finalUrls = [p.final_url]));
      for (const d of ["description1", "description2"] as const) if (p[d] !== undefined) edit(d, `sitelink_asset.${d}`, p[d], (u) => (p[d] === null ? undefined : nest(u, "sitelinkAsset", d, p[d])));
      const d1 = p.description1 !== undefined ? p.description1 : cur.description1;
      const d2 = p.description2 !== undefined ? p.description2 : cur.description2;
      if ((d1 === null) !== (d2 === null)) throw new ToolError("invalid_argument", "A sitelink has both descriptions or neither: set or clear both.");
    }
    if (a.callout) edit("callout_text", "callout_asset.callout_text", a.callout.text, (u) => nest(u, "calloutAsset", "calloutText", a.callout!.text));
    if (a.structured_snippet) {
      const p = a.structured_snippet;
      if (p.header !== undefined) edit("header", "structured_snippet_asset.header", p.header, (u) => nest(u, "structuredSnippetAsset", "header", p.header));
      if (p.values !== undefined) edit("values", "structured_snippet_asset.values", p.values.join(", "), (u) => nest(u, "structuredSnippetAsset", "values", p.values));
    }
    if (a.call) {
      const p = a.call;
      if (p.country_code !== undefined) edit("country_code", "call_asset.country_code", p.country_code, (u) => nest(u, "callAsset", "countryCode", p.country_code));
      if (p.phone_number !== undefined) edit("phone_number", "call_asset.phone_number", p.phone_number, (u) => nest(u, "callAsset", "phoneNumber", p.phone_number));
    }
    if (!edits.length) throw new ToolError("invalid_argument", "Nothing would change: the asset already has those values.");
    const update: Row = { resourceName: rn(ads, "assets", a.asset_id) };
    for (const e of edits) e.set(update);
    const ref = { resource: "asset", id: a.asset_id, name: `${want.toLowerCase().replace("_", " ")} asset` };
    return {
      summary: `Edit ${want.toLowerCase().replace("_", " ")} asset ${a.asset_id}: ${edits.map((e) => `${e.field} "${e.before ?? "(none)"}" -> "${e.after ?? "(none)"}"`).join("; ")}. It is used in ${s.used.length} place${s.used.length === 1 ? "" : "s"}${s.used.length ? `: ${s.used.slice(0, 10).join(", ")}${s.used.length > 10 ? ", ..." : ""}` : ""}.`,
      changes: edits.map((e) => textChange(ref, e.field, e.before, e.after ?? "(none)")),
      ops: [{ assetOperation: { update, updateMask: edits.map((e) => e.mask).join(",") } }],
    };
  },
  landed: (a, before, after) => {
    if (!after.asset || !before.asset) return false;
    const changed = (Object.keys(after.asset) as (keyof NonNullable<typeof after.asset>)[]).filter((k) => after.asset![k] !== before.asset![k]);
    return changed.length > 0 && wantedHolds(a, after.asset);
  },
  result: (a, after, _res, before) => ({
    asset_id: a.asset_id,
    field_type: after.asset!.type ?? "",
    updated: (Object.keys(after.asset!) as (keyof NonNullable<typeof after.asset>)[]).filter((k) => after.asset![k] !== before.asset![k]),
    used_in: after.used.length,
  }),
});
/** True when the re-read asset has every value the request asked for. */
function wantedHolds(a: { sitelink?: z.infer<typeof sitelinkPatch> | undefined; callout?: { text: string } | undefined; structured_snippet?: z.infer<typeof snippetPatch> | undefined; call?: z.infer<typeof callPatch> | undefined }, now: Record<string, string | null>): boolean {
  const want: Record<string, string | null | undefined> = {
    ...(a.sitelink ?? {}),
    ...(a.callout ? { callout_text: a.callout.text } : {}),
    ...(a.structured_snippet ? { header: a.structured_snippet.header, values: a.structured_snippet.values?.join(", ") } : {}),
    ...(a.call ?? {}),
  };
  return Object.entries(want).every(([k, v]) => v === undefined || now[k] === v);
}

// ------------------------------------------------------------------------------- account-level assets on one campaign
/** Field types a campaign inherits from account-level links (asset overview: linkable at customer level). */
const INHERITABLE = ["SITELINK", "CALLOUT", "STRUCTURED_SNIPPET", "CALL", "PRICE", "PROMOTION", "MOBILE_APP", "HOTEL_CALLOUT", "BUSINESS_MESSAGE", "BUSINESS_NAME", "BUSINESS_LOGO"] as const;
export const excludeAccountAssetsFromCampaign = stateWrite({
  name: "exclude_account_assets_from_campaign",
  title: "Exclude account-level assets from a campaign",
  risk: "write",
  description:
    "Stops a campaign from showing account-level assets of the given types (for example the account's sitelinks or phone number), or with action include lets it show them again, after approval. The campaign's own and its ad groups' assets are not affected. Uses the campaign's excluded parent asset field types. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, field_types: z.array(z.enum(INHERITABLE)).min(1).max(INHERITABLE.length), action: z.enum(["exclude", "include"]).default("exclude") }),
  output: z.object({ campaign_id: z.string(), excluded_field_types: z.array(z.string()) }),
  read: async (a, ads) => {
    const [[c], acct] = await Promise.all([
      ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status", "campaign.excluded_parent_asset_field_types").from("campaign").where(`campaign.id = ${lit.id(a.campaign_id)}`).limit(1), { maxRows: 1 }),
      ads.query(new Gaql().select("customer_asset.field_type").from("customer_asset").where(`customer_asset.field_type IN ${lit.list(a.field_types.map((t) => `'${t}'`))}`).where("customer_asset.status != 'REMOVED'"), { maxRows: 5000 }),
    ]);
    if (!c) throw new ToolError("not_found", `No campaign ${a.campaign_id} in this account.`);
    if (str(c, "campaign.status") === "REMOVED") throw new ToolError("invalid_argument", "The campaign is removed and cannot be changed.");
    const accountLinks: Record<string, number> = {};
    for (const r of acct) {
      const t = str(r, "customer_asset.field_type") ?? "";
      accountLinks[t] = (accountLinks[t] ?? 0) + 1;
    }
    const excluded = [...((pick(c, "campaign.excluded_parent_asset_field_types") as string[] | undefined) ?? [])].sort();
    return { campaign: { id: a.campaign_id, name: str(c, "campaign.name") }, excluded, accountLinks };
  },
  build: (a, s, ads) => {
    const next = a.action === "exclude" ? [...new Set([...s.excluded, ...a.field_types])].sort() : s.excluded.filter((t) => !a.field_types.includes(t as (typeof INHERITABLE)[number]));
    if (next.join() === s.excluded.join()) throw new ToolError("invalid_argument", `Nothing would change: ${a.field_types.join(", ")} already ${a.action === "exclude" ? "excluded" : "allowed"}.`);
    const counts = a.field_types.map((t) => {
      const n = s.accountLinks[t] ?? 0;
      return `${n} account-level ${t.toLowerCase().replace(/_/g, " ")}${n === 1 ? "" : "s"}`;
    });
    const name = s.campaign.name ?? a.campaign_id;
    return {
      summary: a.action === "exclude" ? `Campaign "${name}" stops showing account-level ${a.field_types.join(", ")} assets (the account has ${counts.join(", ")})` : `Campaign "${name}" shows account-level ${a.field_types.join(", ")} assets again (the account has ${counts.join(", ")})`,
      changes: [textChange({ resource: "campaign", id: a.campaign_id, name: s.campaign.name }, "excluded_account_asset_types", s.excluded.join(", ") || "(none)", next.join(", ") || "(none)")],
      ops: [{ campaignOperation: { update: { resourceName: rn(ads, "campaigns", a.campaign_id), excludedParentAssetFieldTypes: next }, updateMask: "excluded_parent_asset_field_types" } }],
    };
  },
  landed: (a, _b, after) => a.field_types.every((t) => after.excluded.includes(t) === (a.action === "exclude")),
  result: (a, after) => ({ campaign_id: a.campaign_id, excluded_field_types: after.excluded }),
});

// ---------------------------------------------------------------------------------------------------- business name
export const addBusinessNameAsset = stateWrite({
  name: "add_business_name_asset",
  title: "Set business name",
  risk: "write",
  description: "Sets the business name shown with a campaign's ads (max 25 characters, must match the business, per Google Ads policy), after approval. A campaign has at most one: an existing business name is replaced in the same atomic request. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, business_name: clean(25) }),
  output: z.object({ campaign_id: z.string(), asset_id: z.string(), business_name: z.string() }),
  read: (a, ads) => readCampaignAssets(ads, a.campaign_id, "BUSINESS_NAME"),
  build: (a, s, ads) => {
    const key = a.business_name.trim().toLowerCase();
    if (s.links.length === 1 && s.links[0]!.key === key) throw new ToolError("invalid_argument", "Nothing would change: that business name is already set.");
    const tmp = temp(ads, "assets", 1);
    const ops: Row[] = [
      ...s.links.map((l) => ({ campaignAssetOperation: { remove: `customers/${ads.customerId}/campaignAssets/${a.campaign_id}~${l.asset_id}~BUSINESS_NAME` } })),
      { assetOperation: { create: { resourceName: tmp, textAsset: { text: a.business_name } } } },
      { campaignAssetOperation: { create: { asset: tmp, campaign: rn(ads, "campaigns", a.campaign_id), fieldType: "BUSINESS_NAME" } } },
    ];
    return { summary: `Set business name of campaign "${s.campaign.name ?? a.campaign_id}" to "${a.business_name}"${s.links.length ? ` (replacing "${s.links.map((l) => l.label).join('", "')}")` : ""}`, changes: [textChange({ resource: "campaign", id: a.campaign_id, name: s.campaign.name }, "business_name", s.links[0]?.label ?? null, a.business_name)], ops };
  },
  landed: (a, _b, after) => after.links.length === 1 && after.links[0]!.key === a.business_name.trim().toLowerCase(),
  result: (a, after) => ({ campaign_id: a.campaign_id, asset_id: after.links[0]!.asset_id, business_name: a.business_name }),
});

export const assetWriteTools = [addSitelinks, removeSitelinks, addCalloutExtensions, removeCallouts, addStructuredSnippets, removeStructuredSnippets, addCallAsset, removeCallAssets, setCallAssetStatus, linkExistingAssets, updateExtensionAsset, excludeAccountAssetsFromCampaign, addBusinessNameAsset];
