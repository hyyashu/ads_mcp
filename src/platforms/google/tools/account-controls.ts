import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { AnyTool } from "../../../mcp/tool";
import type { Change, Effect } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, num, pick } from "../gaql";
import { tailId } from "./campaign-reads";
import { accountId, entityStatus, googleRead, idSchema, str } from "./common";
import { entityLabelTools } from "./account-controls-labels";
import { rn, stateWrite } from "./write-kit";

/**
 * Google Ads tools: get_account_exclusions, add_account_exclusions, remove_account_exclusions, update_tracking_settings, set_auto_tagging, set_location_bid_modifiers, get_entity_labels, add_entity_labels, remove_entity_labels.
 * Approved by the owner on 2026-11-11 (inventory/tool-registry.json); API surfaces in inventory/mapping.ts.
 * The entity label tools live in account-controls-labels.ts.
 */

const change = (ref: { resource: string; id: string; name?: string | null }, field: string, before: string | number | boolean | null, after: string | number | boolean | null, effect: Effect): Change => ({ ...ref, field, before, after, unit: "text", effect });
const NO_CTRL = /^[^\u0000-\u001f\u007f]*$/;
const bytes = (s: string) => new TextEncoder().encode(s).length;

// ------------------------------------------------------------------------------------------- account exclusions
// v26 CustomerNegativeCriterion: the criterion is a union of content_label, ip_block, mobile_app_category, mobile_application,
// negative_keyword_list, placement, placement_list, youtube_channel and youtube_video (all Immutable; no update, only create
// and remove). Customer-level criteria can only be negative (targeting guide: docs/targeting/criteria).
const KINDS = {
  placement: { type: "PLACEMENT", field: "placement.url" },
  youtube_channel: { type: "YOUTUBE_CHANNEL", field: "youtube_channel.channel_id" },
  youtube_video: { type: "YOUTUBE_VIDEO", field: "youtube_video.video_id" },
  mobile_application: { type: "MOBILE_APPLICATION", field: "mobile_application.app_id" },
  mobile_app_category: { type: "MOBILE_APP_CATEGORY", field: "mobile_app_category.mobile_app_category_constant" },
  content_label: { type: "CONTENT_LABEL", field: "content_label.type" },
  ip_block: { type: "IP_BLOCK", field: "ip_block.ip_address" },
  negative_keyword_list: { type: "NEGATIVE_KEYWORD_LIST", field: "negative_keyword_list.shared_set" },
  placement_list: { type: "PLACEMENT_LIST", field: "placement_list.shared_set" },
} as const;
type Kind = keyof typeof KINDS;
const KIND_NAMES = Object.keys(KINDS) as Kind[];
const API_TYPES = KIND_NAMES.map((k) => KINDS[k].type);
const kindOfType = (t: string): Kind | null => KIND_NAMES.find((k) => KINDS[k].type === t) ?? null;
const CNC = "customer_negative_criterion";

// ContentLabelTypeEnum (v26), without UNSPECIFIED and UNKNOWN (return values only).
const CONTENT_LABELS = ["SEXUALLY_SUGGESTIVE", "BELOW_THE_FOLD", "PARKED_DOMAIN", "JUVENILE", "PROFANITY", "TRAGEDY", "VIDEO", "VIDEO_RATING_DV_G", "VIDEO_RATING_DV_PG", "VIDEO_RATING_DV_T", "VIDEO_RATING_DV_MA", "VIDEO_NOT_YET_RATED", "EMBEDDED_VIDEO", "LIVE_STREAMING_VIDEO", "SOCIAL_ISSUES", "BRAND_SUITABILITY_CONTENT_FOR_FAMILIES", "BRAND_SUITABILITY_GAMES_FIGHTING", "BRAND_SUITABILITY_GAMES_MATURE", "BRAND_SUITABILITY_HEALTH_SENSITIVE", "BRAND_SUITABILITY_HEALTH_SOURCE_UNDETERMINED", "BRAND_SUITABILITY_NEWS_RECENT", "BRAND_SUITABILITY_NEWS_SENSITIVE", "BRAND_SUITABILITY_NEWS_SOURCE_NOT_FEATURED", "BRAND_SUITABILITY_POLITICS", "BRAND_SUITABILITY_RELIGION"] as const;

function isIPv4(s: string): boolean {
  const p = s.split(".");
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255 && (x === "0" || !x.startsWith("0")));
}
function isIPv6(s: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || (s.match(/::/g) ?? []).length > 1) return false;
  const [head, tail] = s.includes("::") ? s.split("::") : [s, undefined];
  const groups = (x: string | undefined) => (x ? x.split(":") : []);
  const all = [...groups(head), ...groups(tail)];
  const last = all[all.length - 1];
  const v4 = last !== undefined && last.includes(".");
  if (v4 && !isIPv4(last!)) return false;
  const hex = v4 ? all.slice(0, -1) : all;
  if (!hex.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  const width = hex.length + (v4 ? 2 : 0);
  return s.includes("::") ? width < 8 : width === 8;
}
/** An IP address or CIDR block (IpBlockInfo: "192.168.0.1", "192.168.0.0/24", "2001:db8::/48"). */
function ipProblem(v: string): string | null {
  const [addr, prefix, extra] = v.split("/");
  if (extra !== undefined || !addr) return "not an IP address or CIDR block";
  const v4 = isIPv4(addr);
  if (!v4 && !isIPv6(addr)) return "not an IP address or CIDR block";
  if (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (v4 ? 32 : 128))) return "invalid CIDR prefix length";
  return null;
}
/** Managed placement rules from the targeting guide: URL at most 250 characters and 2 levels deep; adsenseformobileapps.com is not allowed; YouTube URLs must use the YouTube types (CriterionError YOUTUBE_URL_UNSUPPORTED). */
function placementProblem(v: string): string | null {
  if (v.length > 250) return "a placement URL is at most 250 characters";
  if (/[\s,]/.test(v)) return "one placement URL, without spaces or commas";
  const rest = v.replace(/^https?:\/\//i, "");
  const [host = "", ...path] = rest.split("/");
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(host)) return "not a website domain or URL";
  if (path.filter(Boolean).length > 2) return "a placement can be at most 2 levels deep (domain/level1/level2)";
  const h = host.toLowerCase();
  if (h === "adsenseformobileapps.com" || h.endsWith(".adsenseformobileapps.com")) return "adsenseformobileapps.com cannot be excluded as a placement";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return "for YouTube use type youtube_channel or youtube_video";
  return null;
}
function valueProblem(kind: Kind, v: string): string | null {
  switch (kind) {
    case "placement":
      return placementProblem(v);
    case "youtube_channel":
      // YouTubeChannelInfo.channel_id: "the YouTube uploader channel id or the channel code of a YouTube channel".
      return /^[A-Za-z0-9_-]{1,100}$/.test(v) ? null : "give the YouTube channel id (for example UCxxxxxxxxxxxxxxxxxxxxxx), not a URL or @handle";
    case "youtube_video":
      // YouTubeVideoInfo.video_id: "as it appears on the YouTube watch page" (the v= value).
      return /^[A-Za-z0-9_-]{11}$/.test(v) ? null : "give the 11-character YouTube video id from the watch page URL (v=...), not a URL";
    case "mobile_application":
      // MobileApplicationInfo.app_id: "{platform}-{native id}", 1 = iOS (numeric App Store id), 2 = Android (package name).
      return /^1-\d{1,20}$/.test(v) || /^2-[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(v) ? null : "app id must be 1-<App Store id> (iOS, e.g. 1-476943146) or 2-<package name> (Android, e.g. 2-com.example.app)";
    case "mobile_app_category":
      return /^(mobileAppCategoryConstants\/)?\d{1,20}$/.test(v) ? null : "give a mobile app category constant id (e.g. 60008) or mobileAppCategoryConstants/{id}";
    case "content_label":
      return (CONTENT_LABELS as readonly string[]).includes(v) ? null : `content label must be one of: ${CONTENT_LABELS.join(", ")}`;
    case "ip_block":
      return ipProblem(v);
    case "negative_keyword_list":
    case "placement_list":
      return /^(customers\/\d+\/sharedSets\/)?\d{1,20}$/.test(v) ? null : "give a shared set id";
  }
}
/** The value as stored and compared: ids without their resource-name prefix, placements without scheme or trailing slash. */
function normValue(kind: Kind, v: string): string {
  if (kind === "placement") return v.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  if (kind === "ip_block") return v.toLowerCase();
  if (kind === "mobile_app_category" || kind === "negative_keyword_list" || kind === "placement_list") return v.split("/").pop()!;
  return v;
}
const exclusionKey = (kind: Kind, v: string) => `${KINDS[kind].type}:${normValue(kind, v)}`;

function exclusionBody(ads: GoogleAdsClient, kind: Kind, raw: string): Row {
  const v = normValue(kind, raw);
  switch (kind) {
    case "placement": return { placement: { url: raw } };
    case "youtube_channel": return { youtubeChannel: { channelId: v } };
    case "youtube_video": return { youtubeVideo: { videoId: v } };
    case "mobile_application": return { mobileApplication: { appId: v } };
    case "mobile_app_category": return { mobileAppCategory: { mobileAppCategoryConstant: `mobileAppCategoryConstants/${v}` } };
    case "content_label": return { contentLabel: { type: v } };
    case "ip_block": return { ipBlock: { ipAddress: v } };
    case "negative_keyword_list": return { negativeKeywordList: { sharedSet: rn(ads, "sharedSets", v) } };
    case "placement_list": return { placementList: { sharedSet: rn(ads, "sharedSets", v) } };
  }
}

interface Exclusion {
  criterion_id: string;
  type: string;
  value: string | null;
  key: string;
}
const EXCL_FIELDS = [`${CNC}.id`, `${CNC}.type`, ...KIND_NAMES.map((k) => `${CNC}.${KINDS[k].field}`)];
function exclusionRow(r: Row): Exclusion {
  const type = str(r, `${CNC}.type`) ?? "UNKNOWN";
  const kind = kindOfType(type);
  const raw = kind ? str(r, `${CNC}.${KINDS[kind].field}`) : null;
  const value = kind && raw !== null ? normValue(kind, raw) : null;
  return { criterion_id: String(pick(r, `${CNC}.id`) ?? ""), type, value: kind === "placement" ? raw : value, key: kind && raw !== null ? exclusionKey(kind, raw) : `${type}:#${String(pick(r, `${CNC}.id`) ?? "")}` };
}
async function readExclusions(ads: GoogleAdsClient, where: { types?: string[]; ids?: string[] }, maxRows = 10_000): Promise<Exclusion[]> {
  const q = new Gaql()
    .select(...EXCL_FIELDS)
    .from(CNC)
    .where(where.types?.length ? `${CNC}.type IN ${lit.list(where.types.map((t) => lit.enumLit(t, API_TYPES)))}` : undefined)
    .where(where.ids?.length ? `${CNC}.id IN ${lit.list(where.ids.map(lit.id))}` : undefined)
    .orderBy(`${CNC}.id`);
  return (await ads.query(q, { maxRows })).map(exclusionRow);
}

const exclusionOut = z.object({ criterion_id: z.string(), type: z.string(), value: z.string().nullable(), name: z.string().nullable().describe("App, app category or shared set name, when Google has one."), resource_name: z.string() });

export const getAccountExclusions = googleRead({
  name: "get_account_exclusions",
  title: "Account-level exclusions",
  description:
    "Lists the account-level exclusions (they apply to every campaign in the account): placements (websites), YouTube channels and videos, mobile apps, mobile app categories, content labels (sensitive content categories), IP addresses, and the account-level negative keyword list and placement exclusion lists that are linked, each with its criterion id (needed by remove_account_exclusions). Names come from Google.",
  input: z.object({ account_id: accountId, types: z.array(z.enum(KIND_NAMES as [Kind, ...Kind[]])).max(9).optional().describe("Only these exclusion types."), limit: z.number().int().min(1).max(5000).default(1000) }),
  output: z.object({ exclusions: z.array(exclusionOut), returned: z.number(), truncated: z.boolean().describe("True when more matched than limit; raise limit to see the rest.") }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const q = new Gaql()
      .select(`${CNC}.resource_name`, `${CNC}.mobile_application.name`, ...EXCL_FIELDS)
      .from(CNC)
      .where(a.types?.length ? `${CNC}.type IN ${lit.list([...new Set(a.types)].map((k) => lit.enumLit(KINDS[k].type, API_TYPES)))}` : undefined)
      .orderBy(`${CNC}.id`)
      .limit(a.limit + 1);
    const fetched = await ads.query(q, { maxRows: a.limit + 1, partial: true });
    const rows = fetched.slice(0, a.limit);
    const items = rows.map((r) => ({ ...exclusionRow(r), resource_name: str(r, `${CNC}.resource_name`) ?? "", app_name: str(r, `${CNC}.mobile_application.name`) }));
    // Names of app categories and shared sets come from their own resources (looked up by id, not joined).
    const ids = (t: string) => [...new Set(items.filter((x) => x.type === t && x.value).map((x) => x.value!))];
    const names = new Map<string, string | null>();
    const cats = ids("MOBILE_APP_CATEGORY");
    if (cats.length) for (const r of await ads.query(new Gaql().select("mobile_app_category_constant.id", "mobile_app_category_constant.name").from("mobile_app_category_constant").where(`mobile_app_category_constant.id IN ${lit.list(cats.map(lit.id))}`), { maxRows: cats.length })) names.set(`MOBILE_APP_CATEGORY:${pick(r, "mobile_app_category_constant.id")}`, str(r, "mobile_app_category_constant.name"));
    const sets = [...ids("NEGATIVE_KEYWORD_LIST"), ...ids("PLACEMENT_LIST")];
    if (sets.length) for (const r of await ads.query(new Gaql().select("shared_set.id", "shared_set.name").from("shared_set").where(`shared_set.id IN ${lit.list(sets.map(lit.id))}`), { maxRows: sets.length })) names.set(`SET:${pick(r, "shared_set.id")}`, str(r, "shared_set.name"));
    return {
      exclusions: items.map((x) => ({
        criterion_id: x.criterion_id,
        type: x.type,
        value: x.value,
        name: x.type === "MOBILE_APPLICATION" ? x.app_name : x.type === "MOBILE_APP_CATEGORY" ? names.get(`MOBILE_APP_CATEGORY:${x.value}`) ?? null : x.type === "NEGATIVE_KEYWORD_LIST" || x.type === "PLACEMENT_LIST" ? names.get(`SET:${x.value}`) ?? null : null,
        resource_name: x.resource_name,
      })),
      returned: rows.length,
      truncated: fetched.length > a.limit,
    };
  },
});

const exclusionItem = z
  .object({ type: z.enum(KIND_NAMES as [Kind, ...Kind[]]), value: z.string().trim().min(1).max(250).regex(NO_CTRL, "no control characters") })
  .superRefine((x, ctx) => {
    const p = valueProblem(x.type, x.value);
    if (p) ctx.addIssue({ code: "custom", path: ["value"], message: `${x.type} "${x.value}": ${p}` });
  });
const IP_LIMIT = 500; // CustomerNegativeCriterion.ip_block: "You can exclude up to 500 IP addresses per account."

export const addAccountExclusions = stateWrite({
  name: "add_account_exclusions",
  title: "Add account-level exclusions",
  // High impact as planned (inventory/mapping.ts); the change set's effects also set each approval's risk (see build).
  risk: "high_impact",
  description:
    "Adds account-level exclusions after approval. They apply to EVERY campaign in the account, so this is high impact. Types: placement (website domain or URL, at most 250 characters and 2 levels deep), youtube_channel (channel id), youtube_video (11-character video id), mobile_application (1-<App Store id> for iOS, 2-<package name> for Android), mobile_app_category (mobile app category constant id), content_label (e.g. SEXUALLY_SUGGESTIVE, PARKED_DOMAIN, BRAND_SUITABILITY_POLITICS), ip_block (IP address or CIDR block; at most 500 per account), negative_keyword_list (an ACCOUNT_LEVEL_NEGATIVE_KEYWORDS shared set id; at most one per account) and placement_list (a NEGATIVE_PLACEMENTS shared set id). Exclusions already in place are skipped. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, exclusions: z.array(exclusionItem).min(1).max(200) }),
  output: z.object({ added: z.array(z.object({ type: z.string(), value: z.string(), criterion_id: z.string().nullable() })), skipped_existing: z.array(z.string()) }),
  read: async (a, ads) => {
    const kinds = [...new Set(a.exclusions.map((x) => x.type))];
    // IP blocks and the account negative keyword list have account-wide limits, so all of them are read.
    const types = [...new Set([...kinds.map((k) => KINDS[k].type), ...(kinds.includes("ip_block") ? ["IP_BLOCK"] : []), ...(kinds.includes("negative_keyword_list") ? ["NEGATIVE_KEYWORD_LIST"] : [])])].sort();
    const existing = await readExclusions(ads, { types });
    const catIds = [...new Set(a.exclusions.filter((x) => x.type === "mobile_app_category").map((x) => normValue("mobile_app_category", x.value)))].sort();
    if (catIds.length) {
      const found = new Set((await ads.query(new Gaql().select("mobile_app_category_constant.id").from("mobile_app_category_constant").where(`mobile_app_category_constant.id IN ${lit.list(catIds.map(lit.id))}`), { maxRows: catIds.length })).map((r) => String(pick(r, "mobile_app_category_constant.id"))));
      const missing = catIds.filter((c) => !found.has(c));
      if (missing.length) throw new ToolError("not_found", `No mobile app category constant ${missing.join(", ")}.`);
    }
    const setIds = [...new Set(a.exclusions.filter((x) => x.type === "negative_keyword_list" || x.type === "placement_list").map((x) => normValue(x.type, x.value)))].sort();
    if (setIds.length) {
      const rows = await ads.query(new Gaql().select("shared_set.id", "shared_set.type", "shared_set.status").from("shared_set").where(`shared_set.id IN ${lit.list(setIds.map(lit.id))}`), { maxRows: setIds.length });
      const sets = new Map(rows.map((r) => [String(pick(r, "shared_set.id")), { type: str(r, "shared_set.type"), status: str(r, "shared_set.status") }]));
      for (const x of a.exclusions.filter((e) => e.type === "negative_keyword_list" || e.type === "placement_list")) {
        const id = normValue(x.type, x.value);
        const s = sets.get(id);
        if (!s) throw new ToolError("not_found", `No shared set ${id} in this account.`);
        if (s.status === "REMOVED") throw new ToolError("invalid_argument", `Shared set ${id} is removed.`);
        const want = x.type === "negative_keyword_list" ? "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS" : "NEGATIVE_PLACEMENTS";
        if (s.type !== want) throw new ToolError("invalid_argument", `Shared set ${id} is a ${s.type} list; ${x.type} needs a ${want} list.`);
      }
    }
    return { existing };
  },
  build: (a, s, ads) => {
    const have = new Set(s.existing.map((x) => x.key));
    const unique = [...new Map(a.exclusions.map((x) => [exclusionKey(x.type, x.value), x])).values()];
    const fresh = unique.filter((x) => !have.has(exclusionKey(x.type, x.value)));
    if (!fresh.length) throw new ToolError("invalid_argument", "Nothing would change: every exclusion is already in place.");
    const ips = s.existing.filter((x) => x.type === "IP_BLOCK").length + fresh.filter((x) => x.type === "ip_block").length;
    if (ips > IP_LIMIT) throw new ToolError("invalid_argument", `An account can exclude at most ${IP_LIMIT} IP addresses; this would make ${ips}.`);
    const lists = s.existing.filter((x) => x.type === "NEGATIVE_KEYWORD_LIST").length + fresh.filter((x) => x.type === "negative_keyword_list").length;
    if (lists > 1) throw new ToolError("invalid_argument", "An account can link at most one account-level negative keyword list; remove the current one first.");
    const label = (x: { type: Kind; value: string }) => `${x.type} ${normValue(x.type, x.value)}`;
    return {
      summary: `Exclude across the WHOLE account (every campaign): ${fresh.map(label).join(", ")}`,
      // "create" marks this high impact: an account-level exclusion changes delivery of every campaign at once.
      changes: fresh.map((x) => change({ resource: "account", id: ads.customerId }, "account_exclusion", null, exclusionKey(x.type, x.value), "create")),
      ops: fresh.map((x) => ({ customerNegativeCriterionOperation: { create: exclusionBody(ads, x.type, x.value) } })),
    };
  },
  landed: (a, _b, after) => a.exclusions.every((x) => after.existing.some((e) => e.key === exclusionKey(x.type, x.value))),
  result: (a, after, _r, before) => {
    const had = new Set(before.existing.map((x) => x.key));
    const keys = [...new Set(a.exclusions.map((x) => exclusionKey(x.type, x.value)))];
    return {
      added: keys.filter((k) => !had.has(k)).map((k) => {
        const e = after.existing.find((x) => x.key === k);
        return { type: k.slice(0, k.indexOf(":")), value: k.slice(k.indexOf(":") + 1), criterion_id: e?.criterion_id ?? null };
      }),
      skipped_existing: keys.filter((k) => had.has(k)),
    };
  },
});

export const removeAccountExclusions = stateWrite({
  name: "remove_account_exclusions",
  title: "Remove account-level exclusions",
  risk: "destructive",
  description: "Removes account-level exclusions by criterion id (from get_account_exclusions), after a person approves it. Every campaign in the account may then serve on those placements, apps, content or IP addresses again. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, criterion_ids: z.array(idSchema).min(1).max(200) }),
  output: z.object({ removed: z.array(z.object({ criterion_id: z.string(), type: z.string(), value: z.string().nullable() })) }),
  read: async (a, ads) => ({ items: await readExclusions(ads, { ids: [...new Set(a.criterion_ids)].sort() }, 200) }),
  build: (a, s, ads) => {
    const ids = [...new Set(a.criterion_ids)].sort();
    const missing = ids.filter((id) => !s.items.some((x) => x.criterion_id === id));
    if (missing.length) throw new ToolError("not_found", `No account-level exclusion ${missing.join(", ")} in this account.`);
    const items = ids.map((id) => s.items.find((x) => x.criterion_id === id)!);
    return {
      summary: `Remove ${items.length} account-level exclusion(s), so every campaign can serve there again: ${items.map((x) => `${x.type} ${x.value ?? x.criterion_id}`).join(", ")}`,
      changes: items.map((x) => change({ resource: "account", id: ads.customerId }, "account_exclusion", x.key, null, "remove")),
      ops: ids.map((id) => ({ customerNegativeCriterionOperation: { remove: `customers/${ads.customerId}/customerNegativeCriteria/${id}` } })),
    };
  },
  landed: (a, _b, after) => a.criterion_ids.every((id) => !after.items.some((x) => x.criterion_id === id)),
  result: (a, _after, _r, before) => ({ removed: [...new Set(a.criterion_ids)].sort().map((id) => before.items.find((x) => x.criterion_id === id)!).map((x) => ({ criterion_id: x.criterion_id, type: x.type, value: x.value })) }),
});

// ------------------------------------------------------------------------------------------ tracking settings
// Upgraded URLs guide (docs/ads/upgraded-urls/fields): custom parameter keys are alphanumeric, at most 8 per entity, key at
// most 16 bytes and value at most 200 bytes, keys unique case-insensitively (DistinctError.DUPLICATE_ELEMENT otherwise).
const customParam = z.object({
  key: z.string().regex(/^[A-Za-z0-9]+$/, "custom parameter keys are alphanumeric").refine((k) => bytes(k) <= 16, "a key is at most 16 bytes"),
  value: z.string().min(1).regex(NO_CTRL, "no control characters").refine((v) => bytes(v) <= 200, "a value is at most 200 bytes"),
});
const urlText = z.string().trim().min(1).max(2048).regex(/^[^\s\u0000-\u001f\u007f]+$/, "no spaces or control characters");
type Params = { key: string; value: string }[];
const paramsText = (p: Params) => (p.length ? p.map((x) => `${x.key}=${x.value}`).join("; ") : null);
const sortParams = (p: Params) => [...p].sort((x, y) => x.key.toLowerCase().localeCompare(y.key.toLowerCase()));

export const updateTrackingSettings = stateWrite({
  name: "update_tracking_settings",
  title: "Update tracking settings",
  risk: "write",
  description:
    "Sets or clears the tracking URL template, final URL suffix and custom parameters ({_name} values, at most 8; key alphanumeric up to 16 bytes, value up to 200 bytes) on one campaign or ad group, after approval. null clears a field; custom parameters given replace the whole list. Settings on an ad group override the campaign's. A broken template can stop click tracking, so check it first. Confirmed by re-reading.",
  input: z
    .object({
      account_id: accountId,
      level: z.enum(["campaign", "ad_group"]),
      id: idSchema.describe("The campaign id (level campaign) or ad group id (level ad_group)."),
      tracking_url_template: urlText.refine((t) => /^(https?:\/\/|\{)/i.test(t), "starts with http://, https:// or a ValueTrack parameter such as {lpurl}").nullable().optional(),
      final_url_suffix: urlText.nullable().optional().describe("Parameters appended to the landing page URL, e.g. utm_source=google&utm_medium=cpc (no leading ?)."),
      url_custom_parameters: z
        .array(customParam)
        .max(8)
        .refine((p) => new Set(p.map((x) => x.key.toLowerCase())).size === p.length, "custom parameter keys must be unique (case-insensitive)")
        .nullable()
        .optional(),
    })
    .refine((v) => v.tracking_url_template !== undefined || v.final_url_suffix !== undefined || v.url_custom_parameters !== undefined, "give tracking_url_template, final_url_suffix or url_custom_parameters (null clears)"),
  output: z.object({ level: z.string(), id: z.string(), tracking_url_template: z.string().nullable(), final_url_suffix: z.string().nullable(), url_custom_parameters: z.array(z.object({ key: z.string(), value: z.string() })) }),
  read: async (a, ads) => {
    const e = a.level;
    const [r] = await ads.query(new Gaql().select(`${e}.id`, `${e}.name`, `${e}.status`, `${e}.tracking_url_template`, `${e}.final_url_suffix`, `${e}.url_custom_parameters`).from(e).where(`${e}.id = ${lit.id(a.id)}`).limit(1), { maxRows: 1 });
    if (!r) {
      const other = e === "campaign" ? "ad_group" : "campaign";
      if ((await entityStatus(ads, other, a.id)) !== null) throw new ToolError("invalid_argument", `${a.id} is ${other === "ad_group" ? "an ad group" : "a campaign"} id; use level ${other}.`);
      throw new ToolError("not_found", `No ${e === "ad_group" ? "ad group" : "campaign"} ${a.id} in this account.`);
    }
    if (str(r, `${e}.status`) === "REMOVED") throw new ToolError("invalid_argument", `The ${e === "ad_group" ? "ad group" : "campaign"} is removed and cannot be changed.`);
    const params = ((pick(r, `${e}.url_custom_parameters`) as { key?: string; value?: string }[] | undefined) ?? []).filter((p) => p.key).map((p) => ({ key: String(p.key), value: String(p.value ?? "") }));
    return { name: str(r, `${e}.name`), tracking_url_template: str(r, `${e}.tracking_url_template`) || null, final_url_suffix: str(r, `${e}.final_url_suffix`) || null, url_custom_parameters: params };
  },
  build: (a, s, ads) => {
    const ref = { resource: a.level, id: a.id, name: s.name };
    const update: Row = { resourceName: rn(ads, a.level === "campaign" ? "campaigns" : "adGroups", a.id) };
    const mask: string[] = [];
    const changes: Change[] = [];
    // A path in the mask without a value in the update clears that field.
    if (a.tracking_url_template !== undefined && a.tracking_url_template !== s.tracking_url_template) {
      if (a.tracking_url_template !== null) update.trackingUrlTemplate = a.tracking_url_template;
      mask.push("tracking_url_template");
      changes.push(change(ref, "tracking_url_template", s.tracking_url_template, a.tracking_url_template, "neutral"));
    }
    if (a.final_url_suffix !== undefined && a.final_url_suffix !== s.final_url_suffix) {
      if (a.final_url_suffix !== null) update.finalUrlSuffix = a.final_url_suffix;
      mask.push("final_url_suffix");
      changes.push(change(ref, "final_url_suffix", s.final_url_suffix, a.final_url_suffix, "neutral"));
    }
    if (a.url_custom_parameters !== undefined) {
      const want = a.url_custom_parameters ?? [];
      if (JSON.stringify(sortParams(want)) !== JSON.stringify(sortParams(s.url_custom_parameters))) {
        if (want.length) update.urlCustomParameters = want.map((p) => ({ key: p.key, value: p.value }));
        mask.push("url_custom_parameters");
        changes.push(change(ref, "url_custom_parameters", paramsText(s.url_custom_parameters), paramsText(want), "neutral"));
      }
    }
    if (!mask.length) throw new ToolError("invalid_argument", "Nothing would change: these tracking settings are already in place.");
    const op = a.level === "campaign" ? "campaignOperation" : "adGroupOperation";
    return { summary: `${a.level === "campaign" ? "Campaign" : "Ad group"} "${s.name ?? a.id}" tracking: ${changes.map((c) => `${c.field} ${c.before ?? "(none)"} -> ${c.after ?? "(cleared)"}`).join("; ")}`, changes, ops: [{ [op]: { update, updateMask: mask.join(",") } }] };
  },
  landed: (a, _b, after) =>
    (a.tracking_url_template === undefined || after.tracking_url_template === a.tracking_url_template) &&
    (a.final_url_suffix === undefined || after.final_url_suffix === a.final_url_suffix) &&
    (a.url_custom_parameters === undefined || JSON.stringify(sortParams(after.url_custom_parameters)) === JSON.stringify(sortParams(a.url_custom_parameters ?? []))),
  result: (a, after) => ({ level: a.level, id: a.id, tracking_url_template: after.tracking_url_template, final_url_suffix: after.final_url_suffix, url_custom_parameters: after.url_custom_parameters }),
});

// --------------------------------------------------------------------------------------------------- auto-tagging
// Customer.auto_tagging_enabled is "only mutable in an update operation". It is sent as a customer_operation inside
// GoogleAdsService.Mutate (documented on MutateOperation); CustomerService.MutateCustomer (POST customers/{id}:mutate) takes
// the same CustomerOperation.
export const setAutoTagging = stateWrite({
  name: "set_auto_tagging",
  title: "Turn auto-tagging on or off",
  // High impact as planned (inventory/mapping.ts); the change set's effects also set each approval's risk (see build).
  risk: "high_impact",
  description:
    "Turns auto-tagging on or off for the whole account, after approval. Auto-tagging adds a click id (gclid) to ad landing page URLs. Turning it OFF breaks GA4 attribution of Google Ads clicks and conversions imported from GA4, and offline conversion imports matched by gclid; leave it on unless you know why. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, enabled: z.boolean() }),
  output: z.object({ auto_tagging_enabled: z.boolean() }),
  read: async (_a, ads) => {
    const [r] = await ads.query(new Gaql().select("customer.id", "customer.descriptive_name", "customer.auto_tagging_enabled").from("customer").limit(1), { maxRows: 1 });
    if (!r) throw new ToolError("not_found", "The account could not be read.");
    return { name: str(r, "customer.descriptive_name"), enabled: pick(r, "customer.auto_tagging_enabled") === true };
  },
  build: (a, s, ads) => {
    if (s.enabled === a.enabled) throw new ToolError("invalid_argument", `Nothing would change: auto-tagging is already ${a.enabled ? "on" : "off"}.`);
    const summary = a.enabled
      ? `Turn ON auto-tagging for account "${s.name ?? ads.customerId}": Google will add a gclid parameter to ad landing page URLs (check the site keeps URL parameters through redirects).`
      : `Turn OFF auto-tagging for account "${s.name ?? ads.customerId}". WARNING: ad clicks will no longer carry a gclid, which breaks GA4 attribution of Google Ads traffic and GA4-imported conversions, and offline conversion imports matched by gclid.`;
    return {
      summary,
      // Like conversion-goal changes (update_conversion_action), this changes the conversion data Smart Bidding learns from,
      // so it is marked as a spend effect, which keeps it high impact whichever way it goes.
      changes: [change({ resource: "account", id: ads.customerId, name: s.name }, "auto_tagging_enabled", s.enabled, a.enabled, "increase_spend")],
      ops: [{ customerOperation: { update: { resourceName: `customers/${ads.customerId}`, autoTaggingEnabled: a.enabled }, updateMask: "auto_tagging_enabled" } }],
    };
  },
  landed: (a, _b, after) => after.enabled === a.enabled,
  result: (_a, after) => ({ auto_tagging_enabled: after.enabled }),
});

// ------------------------------------------------------------------------------------------ location bid modifiers
// CampaignCriterion.bid_modifier: "must be in the range: 0.1 - 10.0". The bid modifiers guide
// (docs/campaigns/bidding/manage-bid-modifiers) lists device, location and ad_schedule as the campaign criteria that take a
// bid modifier, so proximity (radius) targets are refused here.
const SAME = (x: number | null, y: number | null) => (x === null || y === null ? x === y : Math.abs(x - y) < 1e-6);
export const setLocationBidModifiers = stateWrite({
  name: "set_location_bid_modifiers",
  title: "Set location bid adjustments",
  // High impact as planned (inventory/mapping.ts); the change set's effects also set each approval's risk (see build).
  risk: "high_impact",
  description:
    "Sets or clears bid adjustments on a campaign's targeted locations, by criterion id (from get_campaign_targeting), after approval: 1.2 = +20%, 0.8 = -20%, range 0.1 to 10.0; null clears the adjustment. Only targeted (not excluded) LOCATION criteria of that campaign; radius targets are refused. Raising an adjustment is high impact; lowering one is not. Confirmed by re-reading.",
  input: z.object({
    account_id: accountId,
    campaign_id: idSchema,
    modifiers: z
      .array(z.object({ criterion_id: idSchema, bid_modifier: z.number().min(0.1).max(10).nullable() }))
      .min(1)
      .max(100)
      .refine((m) => new Set(m.map((x) => x.criterion_id)).size === m.length, "each criterion_id at most once"),
  }),
  output: z.object({ campaign_id: z.string(), modifiers: z.array(z.object({ criterion_id: z.string(), location: z.string().nullable(), bid_modifier: z.number().nullable() })) }),
  read: async (a, ads) => {
    const [c] = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status").from("campaign").where(`campaign.id = ${lit.id(a.campaign_id)}`).limit(1), { maxRows: 1 });
    if (!c) throw new ToolError("not_found", `No campaign ${a.campaign_id} in this account.`);
    if (str(c, "campaign.status") === "REMOVED") throw new ToolError("invalid_argument", "The campaign is removed and cannot be changed.");
    const ids = a.modifiers.map((m) => m.criterion_id).sort();
    const cc = "campaign_criterion";
    const rows = await ads.query(new Gaql().select(`${cc}.criterion_id`, `${cc}.type`, `${cc}.negative`, `${cc}.status`, `${cc}.bid_modifier`, `${cc}.location.geo_target_constant`).from(cc).where(`campaign.id = ${lit.id(a.campaign_id)}`).where(`${cc}.criterion_id IN ${lit.list(ids.map(lit.id))}`).orderBy(`${cc}.criterion_id`), { maxRows: ids.length });
    const crit = rows.map((r) => ({ criterion_id: String(pick(r, `${cc}.criterion_id`)), type: str(r, `${cc}.type`), negative: pick(r, `${cc}.negative`) === true, status: str(r, `${cc}.status`), location: tailId(pick(r, `${cc}.location.geo_target_constant`)), bid_modifier: pick(r, `${cc}.bid_modifier`) === undefined ? null : num(pick(r, `${cc}.bid_modifier`)) }));
    const missing = ids.filter((id) => !crit.some((x) => x.criterion_id === id && x.status !== "REMOVED"));
    if (missing.length) throw new ToolError("not_found", `Campaign ${a.campaign_id} has no criterion ${missing.join(", ")}.`);
    for (const x of crit) {
      if (x.type !== "LOCATION") throw new ToolError("invalid_argument", `Criterion ${x.criterion_id} is a ${x.type} criterion, not a location target. Only LOCATION criteria take a location bid adjustment.`);
      if (x.negative) throw new ToolError("invalid_argument", `Criterion ${x.criterion_id} is an excluded location; bid adjustments apply only to targeted locations.`);
    }
    return { campaign: { id: a.campaign_id, name: str(c, "campaign.name") }, criteria: crit.map(({ criterion_id, location, bid_modifier }) => ({ criterion_id, location, bid_modifier })) };
  },
  build: (a, s, ads) => {
    const ops: Row[] = [];
    const changes: Change[] = [];
    for (const m of [...a.modifiers].sort((x, y) => x.criterion_id.localeCompare(y.criterion_id))) {
      const cur = s.criteria.find((x) => x.criterion_id === m.criterion_id)!;
      if (SAME(cur.bid_modifier, m.bid_modifier)) continue;
      // Clearing sends the path in the mask with no value; the effective multiplier becomes 1.0.
      const update: Row = { resourceName: `customers/${ads.customerId}/campaignCriteria/${a.campaign_id}~${m.criterion_id}` };
      if (m.bid_modifier !== null) update.bidModifier = m.bid_modifier;
      ops.push({ campaignCriterionOperation: { update, updateMask: "bid_modifier" } });
      const before = cur.bid_modifier ?? 1;
      const after = m.bid_modifier ?? 1;
      changes.push(change({ resource: "campaign", id: a.campaign_id, name: s.campaign.name }, `location_bid_modifier.${cur.location ?? m.criterion_id}`, cur.bid_modifier, m.bid_modifier, after > before ? "increase_spend" : after < before ? "decrease_spend" : "neutral"));
    }
    if (!ops.length) throw new ToolError("invalid_argument", "Nothing would change: these adjustments are already set.");
    return { summary: `Campaign "${s.campaign.name ?? a.campaign_id}" location bid adjustments: ${changes.map((c) => `${c.field.split(".")[1]} ${c.before ?? "none"} -> ${c.after ?? "none"}`).join("; ")}`, changes, ops };
  },
  // A cleared modifier may read back as absent or as 1.0; both mean no adjustment.
  landed: (a, _b, after) => a.modifiers.every((m) => {
    const got = after.criteria.find((x) => x.criterion_id === m.criterion_id)?.bid_modifier ?? null;
    return m.bid_modifier === null ? got === null || SAME(got, 1) : SAME(got, m.bid_modifier);
  }),
  result: (a, after) => ({ campaign_id: a.campaign_id, modifiers: after.criteria.map((x) => ({ criterion_id: x.criterion_id, location: x.location, bid_modifier: x.bid_modifier })) }),
});

export const accountControlTools: AnyTool[] = [getAccountExclusions, addAccountExclusions, removeAccountExclusions, updateTrackingSettings, setAutoTagging, setLocationBidModifiers, ...entityLabelTools] as AnyTool[];
