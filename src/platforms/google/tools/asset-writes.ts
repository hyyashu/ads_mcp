import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { type Change, textChange } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, pick } from "../gaql";
import { accountId, idSchema, str } from "./common";
import { rn, stateWrite, temp } from "./write-kit";

/**
 * Campaign-level extensions (assets): sitelinks, callouts, structured snippets, calls and business name.
 * An extension is an asset plus a campaign_asset link. Adding creates both in one atomic request (temporary ids);
 * removing deletes the link only (assets themselves cannot be deleted in Google Ads). Text limits are Google Ads'
 * published limits; Google enforces them too.
 */
const clean = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");
const url = z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u), "http(s) URL");
type FieldType = "SITELINK" | "CALLOUT" | "STRUCTURED_SNIPPET" | "CALL" | "BUSINESS_NAME";

interface Link {
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

async function readCampaignAssets(ads: GoogleAdsClient, campaignId: string, fieldType: FieldType): Promise<CampaignAssets> {
  const [c] = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status").from("campaign").where(`campaign.id = ${lit.id(campaignId)}`).limit(1), { maxRows: 1 });
  if (!c) throw new ToolError("not_found", `No campaign ${campaignId} in this account.`);
  if (str(c, "campaign.status") === "REMOVED") throw new ToolError("invalid_argument", "The campaign is removed and cannot be changed.");
  const rows = await ads.query(
    new Gaql().select("asset.id", "campaign_asset.status", ...CONTENT_FIELDS).from("campaign_asset").where(`campaign_asset.campaign = ${lit.str(rn(ads, "campaigns", campaignId))}`).where(`campaign_asset.field_type = '${fieldType}'`).where("campaign_asset.status != 'REMOVED'"),
    { maxRows: 2000 },
  );
  const links = rows.map((r) => ({ asset_id: String(pick(r, "asset.id") ?? ""), status: str(r, "campaign_asset.status") ?? "", ...contentKey(fieldType, r) })).sort((x, y) => x.asset_id.localeCompare(y.asset_id));
  return { campaign: { id: campaignId, name: str(c, "campaign.name"), status: str(c, "campaign.status")! }, links };
}

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

/** Builds "remove extensions" tools: unlinks the given assets from the campaign (the asset stays in the library). */
function removeTool(o: { name: string; title: string; description: string; fieldType: FieldType }) {
  return stateWrite({
    name: o.name,
    title: o.title,
    risk: "destructive",
    description: o.description,
    input: z.object({ account_id: accountId, campaign_id: idSchema, asset_ids: z.array(idSchema).min(1).max(50) }),
    output: z.object({ campaign_id: z.string(), removed: z.array(z.string()) }),
    read: (a, ads) => readCampaignAssets(ads, a.campaign_id, o.fieldType),
    build: (a, s, ads) => {
      const ids = [...new Set(a.asset_ids)].sort();
      const missing = ids.filter((id) => !s.links.some((l) => l.asset_id === id));
      if (missing.length) throw new ToolError("invalid_argument", `Not linked to this campaign as ${o.fieldType}: ${missing.join(", ")}`);
      const ops = ids.map((id) => ({ campaignAssetOperation: { remove: `customers/${ads.customerId}/campaignAssets/${a.campaign_id}~${id}~${o.fieldType}` } }));
      const changes = ids.map((id) => textChange({ resource: "campaign", id: a.campaign_id, name: s.campaign.name }, o.fieldType.toLowerCase(), s.links.find((l) => l.asset_id === id)!.label, "(removed)"));
      // A removal is irreversible as a link: re-adding creates a new link without the old history.
      for (const c of changes) c.effect = "remove";
      return { summary: `Remove ${ids.length} ${o.fieldType.toLowerCase().replace("_", " ")}(s) from campaign "${s.campaign.name ?? a.campaign_id}": ${ids.map((id) => s.links.find((l) => l.asset_id === id)!.label).slice(0, 5).join("; ")}`, changes, ops };
    },
    landed: (a, _b, after) => a.asset_ids.every((id) => !after.links.some((l) => l.asset_id === id)),
    result: (a) => ({ campaign_id: a.campaign_id, removed: [...new Set(a.asset_ids)].sort() }),
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
export const removeSitelinks = removeTool({ name: "remove_sitelinks", title: "Remove sitelinks", description: "Removes sitelinks from a campaign after approval from a second person (the sitelink assets stay in the asset library). Give the asset ids from list_campaign_extensions. Confirmed by re-reading.", fieldType: "SITELINK" });

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
export const removeCallouts = removeTool({ name: "remove_callouts", title: "Remove callouts", description: "Removes callouts from a campaign after approval from a second person (the assets stay in the library). Give the asset ids from list_campaign_extensions. Confirmed by re-reading.", fieldType: "CALLOUT" });

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
export const removeStructuredSnippets = removeTool({ name: "remove_structured_snippets", title: "Remove structured snippets", description: "Removes structured snippets from a campaign after approval from a second person (the assets stay in the library). Give the asset ids from list_campaign_extensions. Confirmed by re-reading.", fieldType: "STRUCTURED_SNIPPET" });

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
export const removeCallAssets = removeTool({ name: "remove_call_assets", title: "Remove call assets", description: "Removes phone numbers (call assets) from a campaign after approval from a second person (the assets stay in the library). Give the asset ids from list_call_assets. Confirmed by re-reading.", fieldType: "CALL" });

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

export const assetWriteTools = [addSitelinks, removeSitelinks, addCalloutExtensions, removeCallouts, addStructuredSnippets, removeStructuredSnippets, addCallAsset, removeCallAssets, setCallAssetStatus, addBusinessNameAsset];
