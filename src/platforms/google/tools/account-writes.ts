import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { type Change, type Effect, statusChange } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, num, pick } from "../gaql";
import { accountId, idSchema, str } from "./common";
import { rn, stateWrite } from "./write-kit";

const change = (ref: { resource: string; id: string; name?: string | null }, field: string, before: string | number | boolean | null, after: string | number | boolean | null, effect: Effect, unit: Change["unit"] = "text"): Change => ({ ...ref, field, before, after, unit, effect });
const clean = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");

// ------------------------------------------------------------------------------------------------------- labels
async function readLabels(ads: GoogleAdsClient) {
  const rows = await ads.query(new Gaql().select("label.id", "label.name", "label.status").from("label").where("label.status != 'REMOVED'").orderBy("label.id"), { maxRows: 5000 });
  return rows.map((r) => ({ id: String(pick(r, "label.id")), name: str(r, "label.name") ?? "" }));
}
export const createLabel = stateWrite({
  name: "create_label",
  title: "Create label",
  risk: "write",
  description: "Creates an account label (for organising campaigns and other items), optionally with a description and a background colour (#RRGGBB), after approval. Label names are unique in an account, compared case-insensitively. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, name: clean(80), description: clean(200).optional(), background_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional() }),
  output: z.object({ label_id: z.string(), name: z.string() }),
  read: async (_a, ads) => ({ labels: await readLabels(ads) }),
  build: (a, s, ads) => {
    if (s.labels.some((l) => l.name.toLowerCase() === a.name.toLowerCase())) throw new ToolError("invalid_argument", `A label named "${a.name}" already exists.`);
    return {
      summary: `Create label "${a.name}"`,
      changes: [change({ resource: "label", id: "new", name: a.name }, "label", null, a.name, "neutral")],
      ops: [{ labelOperation: { create: { name: a.name, ...(a.description || a.background_color ? { textLabel: { ...(a.description ? { description: a.description } : {}), ...(a.background_color ? { backgroundColor: a.background_color.toUpperCase() } : {}) } } : {}) } } }],
    };
  },
  landed: (a, _b, after) => after.labels.some((l) => l.name.toLowerCase() === a.name.toLowerCase()),
  result: (a, after) => ({ label_id: after.labels.find((l) => l.name.toLowerCase() === a.name.toLowerCase())!.id, name: a.name }),
});

async function readCampaignLabels(ads: GoogleAdsClient, campaignIds: string[]) {
  const camps = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status").from("campaign").where(`campaign.id IN ${lit.list(campaignIds.map(lit.id))}`), { maxRows: 100 });
  const found = new Set(camps.map((r) => String(pick(r, "campaign.id"))));
  const missing = campaignIds.filter((c) => !found.has(c));
  if (missing.length) throw new ToolError("not_found", `No campaign ${missing.join(", ")} in this account.`);
  const links = await ads.query(new Gaql().select("campaign.id", "label.id").from("campaign_label").where(`campaign.id IN ${lit.list(campaignIds.map(lit.id))}`), { maxRows: 10_000 });
  return { names: Object.fromEntries(camps.map((r) => [String(pick(r, "campaign.id")), str(r, "campaign.name")])), links: links.map((r) => `${pick(r, "campaign.id")}~${pick(r, "label.id")}`).sort() };
}
const labelInput = z.object({ account_id: accountId, campaign_ids: z.array(idSchema).min(1).max(50), label_id: idSchema });
export const addCampaignLabel = stateWrite({
  name: "add_campaign_label",
  title: "Label campaigns",
  risk: "write",
  description: "Attaches an existing label to campaigns (ids from list_campaigns; label id from get_campaign_labels or create_label), after approval. Campaigns that already have the label are skipped. Confirmed by re-reading.",
  input: labelInput,
  output: z.object({ label_id: z.string(), labelled: z.array(z.string()) }),
  read: async (a, ads) => {
    const labels = await readLabels(ads);
    if (!labels.some((l) => l.id === a.label_id)) throw new ToolError("not_found", `No label ${a.label_id} in this account.`);
    return readCampaignLabels(ads, [...new Set(a.campaign_ids)].sort());
  },
  build: (a, s, ads) => {
    const todo = [...new Set(a.campaign_ids)].filter((c) => !s.links.includes(`${c}~${a.label_id}`));
    if (!todo.length) throw new ToolError("invalid_argument", "Nothing would change: every campaign already has this label.");
    return { summary: `Label ${todo.length} campaign(s) with label ${a.label_id}: ${todo.map((c) => s.names[c] ?? c).join(", ")}`, changes: todo.map((c) => change({ resource: "campaign", id: c, name: s.names[c] }, "label", null, a.label_id, "neutral")), ops: todo.map((c) => ({ campaignLabelOperation: { create: { campaign: rn(ads, "campaigns", c), label: rn(ads, "labels", a.label_id) } } })) };
  },
  landed: (a, _b, after) => a.campaign_ids.every((c) => after.links.includes(`${c}~${a.label_id}`)),
  result: (a) => ({ label_id: a.label_id, labelled: [...new Set(a.campaign_ids)].sort() }),
});
export const removeCampaignLabel = stateWrite({
  name: "remove_campaign_label",
  title: "Remove label from campaigns",
  risk: "destructive",
  description: "Detaches a label from campaigns after approval from a second person (the label itself stays in the account). Confirmed by re-reading.",
  input: labelInput,
  output: z.object({ label_id: z.string(), unlabelled: z.array(z.string()) }),
  read: (a, ads) => readCampaignLabels(ads, [...new Set(a.campaign_ids)].sort()),
  build: (a, s, ads) => {
    const ids = [...new Set(a.campaign_ids)].sort();
    const missing = ids.filter((c) => !s.links.includes(`${c}~${a.label_id}`));
    if (missing.length) throw new ToolError("invalid_argument", `These campaigns do not have label ${a.label_id}: ${missing.join(", ")}`);
    return { summary: `Remove label ${a.label_id} from ${ids.length} campaign(s)`, changes: ids.map((c) => change({ resource: "campaign", id: c, name: s.names[c] }, "label", a.label_id, null, "remove")), ops: ids.map((c) => ({ campaignLabelOperation: { remove: `customers/${ads.customerId}/campaignLabels/${c}~${a.label_id}` } })) };
  },
  landed: (a, _b, after) => a.campaign_ids.every((c) => !after.links.includes(`${c}~${a.label_id}`)),
  result: (a) => ({ label_id: a.label_id, unlabelled: [...new Set(a.campaign_ids)].sort() }),
});

// ------------------------------------------------------------------------------------------------ bulk statuses
function bulkStatusTool(o: { name: "bulk_update_campaign_status" | "bulk_update_ad_group_status"; resource: "campaign" | "ad_group"; service: "campaignOperation" | "adGroupOperation"; collection: "campaigns" | "adGroups" }) {
  const label = o.resource.replace("_", " ");
  return stateWrite({
    name: o.name,
    title: `Pause or enable ${label}s in bulk`,
    risk: "high_impact",
    description: `Pauses or enables up to 50 ${label}s in one atomic request, after approval. Enabling (which can start spend) or changing more than 20 needs a second approver. ${label[0]!.toUpperCase()}${label.slice(1)}s already in the requested status are left alone; removed ones are refused. Confirmed by re-reading.`,
    input: z.object({ account_id: accountId, ids: z.array(idSchema).min(1).max(50), status: z.enum(["ENABLED", "PAUSED"]) }),
    output: z.object({ status: z.string(), updated: z.array(z.string()), unchanged: z.array(z.string()) }),
    read: async (a, ads) => {
      const ids = [...new Set(a.ids)].sort();
      const rows = await ads.query(new Gaql().select(`${o.resource}.id`, `${o.resource}.name`, `${o.resource}.status`).from(o.resource).where(`${o.resource}.id IN ${lit.list(ids.map(lit.id))}`), { maxRows: 100 });
      const items = rows.map((r) => ({ id: String(pick(r, `${o.resource}.id`)), name: str(r, `${o.resource}.name`), status: str(r, `${o.resource}.status`) ?? "" })).sort((x, y) => x.id.localeCompare(y.id));
      const missing = ids.filter((i) => !items.some((x) => x.id === i));
      if (missing.length) throw new ToolError("not_found", `No ${label} ${missing.join(", ")} in this account.`);
      const removed = items.filter((x) => x.status === "REMOVED");
      if (removed.length) throw new ToolError("invalid_argument", `Removed ${label}s cannot be changed: ${removed.map((x) => x.id).join(", ")}`);
      return { items };
    },
    build: (a, s, ads) => {
      const changing = s.items.filter((x) => x.status !== a.status);
      if (!changing.length) throw new ToolError("invalid_argument", `Nothing would change: all are already ${a.status.toLowerCase()}.`);
      return {
        summary: `Set ${changing.length} ${label}(s) to ${a.status}: ${changing.slice(0, 10).map((x) => x.name ?? x.id).join(", ")}${changing.length > 10 ? ", …" : ""}`,
        changes: changing.map((x) => statusChange({ resource: o.resource, id: x.id, name: x.name }, x.status, a.status)),
        ops: changing.map((x) => ({ [o.service]: { update: { resourceName: rn(ads, o.collection, x.id), status: a.status }, updateMask: "status" } })),
      };
    },
    landed: (a, _b, after) => after.items.every((x) => x.status === a.status),
    result: (a, _after, _r, before) => ({ status: a.status, updated: before.items.filter((x) => x.status !== a.status).map((x) => x.id), unchanged: before.items.filter((x) => x.status === a.status).map((x) => x.id) }),
  });
}
export const bulkUpdateCampaignStatus = bulkStatusTool({ name: "bulk_update_campaign_status", resource: "campaign", service: "campaignOperation", collection: "campaigns" });
export const bulkUpdateAdGroupStatus = bulkStatusTool({ name: "bulk_update_ad_group_status", resource: "ad_group", service: "adGroupOperation", collection: "adGroups" });

// --------------------------------------------------------------------------------------------- ad group removal
function removeAdGroupTool(name: "remove_ad_group" | "remove_display_ad_group", channel?: string) {
  return stateWrite({
    name,
    title: channel ? "Remove Display ad group" : "Remove ad group",
    risk: "destructive",
    description: `Permanently removes ${channel ? "a Display" : "an"} ad group and with it its ads and targeting, after approval from a second person. A removed ad group cannot be restored (pause it instead to keep its history). Confirmed by re-reading.`,
    input: z.object({ account_id: accountId, ad_group_id: idSchema }),
    output: z.object({ ad_group_id: z.string(), status: z.literal("REMOVED") }),
    read: async (a, ads) => {
      const [g] = await ads.query(new Gaql().select("ad_group.id", "ad_group.name", "ad_group.status", "campaign.advertising_channel_type").from("ad_group").where(`ad_group.id = ${lit.id(a.ad_group_id)}`).limit(1), { maxRows: 1 });
      if (!g) throw new ToolError("not_found", `No ad group ${a.ad_group_id} in this account.`);
      if (channel && str(g, "campaign.advertising_channel_type") !== channel) throw new ToolError("invalid_argument", `Ad group ${a.ad_group_id} is not in a ${channel} campaign.`);
      return { name: str(g, "ad_group.name"), status: str(g, "ad_group.status") ?? "" };
    },
    build: (a, s, ads) => {
      if (s.status === "REMOVED") throw new ToolError("invalid_argument", "Nothing would change: the ad group is already removed.");
      return { summary: `Permanently remove ad group "${s.name ?? a.ad_group_id}" (currently ${s.status}). This cannot be undone.`, changes: [statusChange({ resource: "ad_group", id: a.ad_group_id, name: s.name }, s.status, "REMOVED")], ops: [{ adGroupOperation: { remove: rn(ads, "adGroups", a.ad_group_id) } }] };
    },
    landed: (_a, _b, after) => after.status === "REMOVED",
    result: (a) => ({ ad_group_id: a.ad_group_id, status: "REMOVED" as const }),
  });
}
export const removeAdGroup = removeAdGroupTool("remove_ad_group");
export const removeDisplayAdGroup = removeAdGroupTool("remove_display_ad_group", "DISPLAY");

export const removeDisplayAd = stateWrite({
  name: "remove_display_ad",
  title: "Remove Display ad",
  risk: "destructive",
  description: "Permanently removes one ad from a Display ad group, after approval from a second person. A removed ad cannot be restored and loses its history; pause it to keep the history. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, ad_id: idSchema }),
  output: z.object({ ad_group_id: z.string(), ad_id: z.string(), status: z.literal("REMOVED") }),
  read: async (a, ads) => {
    const [r] = await ads.query(new Gaql().select("ad_group_ad.ad.id", "ad_group_ad.status", "ad_group_ad.ad.type", "campaign.advertising_channel_type").from("ad_group_ad").where(`ad_group.id = ${lit.id(a.ad_group_id)}`).where(`ad_group_ad.ad.id = ${lit.id(a.ad_id)}`).limit(1), { maxRows: 1 });
    if (!r) throw new ToolError("not_found", `No ad ${a.ad_id} in ad group ${a.ad_group_id}.`);
    if (str(r, "campaign.advertising_channel_type") !== "DISPLAY") throw new ToolError("invalid_argument", "This ad is not in a Display campaign.");
    return { status: str(r, "ad_group_ad.status") ?? "", type: str(r, "ad_group_ad.ad.type") };
  },
  build: (a, s, ads) => {
    if (s.status === "REMOVED") throw new ToolError("invalid_argument", "Nothing would change: the ad is already removed.");
    return { summary: `Permanently remove ${s.type ?? ""} ad ${a.ad_id} from ad group ${a.ad_group_id} (currently ${s.status}). This cannot be undone.`, changes: [statusChange({ resource: "ad", id: `${a.ad_group_id}~${a.ad_id}` }, s.status, "REMOVED")], ops: [{ adGroupAdOperation: { remove: `customers/${ads.customerId}/adGroupAds/${a.ad_group_id}~${a.ad_id}` } }] };
  },
  landed: (_a, _b, after) => after.status === "REMOVED",
  result: (a) => ({ ad_group_id: a.ad_group_id, ad_id: a.ad_id, status: "REMOVED" as const }),
});

// ------------------------------------------------------------------------------------------- conversion actions
const CA_TYPES = ["WEBPAGE", "UPLOAD_CLICKS", "UPLOAD_CALLS"] as const;
const CA_CATEGORIES = ["DEFAULT", "PAGE_VIEW", "PURCHASE", "SIGNUP", "DOWNLOAD", "ADD_TO_CART", "BEGIN_CHECKOUT", "SUBSCRIBE_PAID", "PHONE_CALL_LEAD", "IMPORTED_LEAD", "SUBMIT_LEAD_FORM", "BOOK_APPOINTMENT", "REQUEST_QUOTE", "GET_DIRECTIONS", "OUTBOUND_CLICK", "CONTACT", "ENGAGEMENT", "QUALIFIED_LEAD", "CONVERTED_LEAD"] as const;
const caFields = ["conversion_action.id", "conversion_action.name", "conversion_action.status", "conversion_action.type", "conversion_action.category", "conversion_action.counting_type", "conversion_action.primary_for_goal", "conversion_action.value_settings.default_value", "conversion_action.value_settings.default_currency_code", "conversion_action.value_settings.always_use_default_value", "conversion_action.click_through_lookback_window_days"];
const caRow = (r: Row) => ({
  id: String(pick(r, "conversion_action.id")),
  name: str(r, "conversion_action.name") ?? "",
  status: str(r, "conversion_action.status"),
  type: str(r, "conversion_action.type"),
  category: str(r, "conversion_action.category"),
  counting_type: str(r, "conversion_action.counting_type"),
  primary_for_goal: pick(r, "conversion_action.primary_for_goal") === true,
  default_value: pick(r, "conversion_action.value_settings.default_value") === undefined ? null : num(pick(r, "conversion_action.value_settings.default_value")),
  default_currency: str(r, "conversion_action.value_settings.default_currency_code"),
  always_use_default_value: pick(r, "conversion_action.value_settings.always_use_default_value") === true,
  click_lookback_days: pick(r, "conversion_action.click_through_lookback_window_days") === undefined ? null : num(pick(r, "conversion_action.click_through_lookback_window_days")),
});
const snippetSchema = z.object({ type: z.string().nullable(), page_format: z.string().nullable(), global_site_tag: z.string().nullable(), event_snippet: z.string().nullable() });

export const createConversionAction = stateWrite({
  name: "create_conversion_action",
  title: "Create conversion action",
  risk: "high_impact",
  description:
    "Creates a conversion action after approval from a second person (Smart Bidding may start optimising toward it): WEBPAGE (website tag; the returned tag snippets must be installed on the site), UPLOAD_CLICKS (offline click conversions) or UPLOAD_CALLS. Sets category, counting (one or every conversion per click), default value and currency, and whether it is a primary goal. Names must be unique. Confirmed by re-reading.",
  input: z.object({
    account_id: accountId,
    name: clean(100),
    type: z.enum(CA_TYPES),
    category: z.enum(CA_CATEGORIES),
    counting_type: z.enum(["ONE_PER_CLICK", "MANY_PER_CLICK"]).default("ONE_PER_CLICK"),
    default_value: z.number().min(0).max(1_000_000).optional(),
    default_currency_code: z.string().regex(/^[A-Z]{3}$/).optional(),
    always_use_default_value: z.boolean().default(false),
    primary_for_goal: z.boolean().default(true),
    click_lookback_days: z.number().int().min(1).max(90).default(30),
  }),
  output: z.object({ conversion_action_id: z.string(), name: z.string(), tag_snippets: z.array(snippetSchema) }),
  read: async (_a, ads) => ({ actions: (await ads.query(new Gaql().select(...caFields).from("conversion_action").where("conversion_action.status != 'REMOVED'").orderBy("conversion_action.id"), { maxRows: 5000 })).map(caRow) }),
  build: (a, s) => {
    if (s.actions.some((x) => x.name.toLowerCase() === a.name.toLowerCase())) throw new ToolError("invalid_argument", `A conversion action named "${a.name}" already exists.`);
    const valueSettings = a.default_value !== undefined || a.default_currency_code ? { valueSettings: { ...(a.default_value !== undefined ? { defaultValue: a.default_value } : {}), ...(a.default_currency_code ? { defaultCurrencyCode: a.default_currency_code } : {}), alwaysUseDefaultValue: a.always_use_default_value } } : {};
    return {
      summary: `Create conversion action "${a.name}" (${a.type}, ${a.category}, ${a.counting_type}${a.primary_for_goal ? ", primary goal" : ", secondary"})`,
      changes: [change({ resource: "conversion_action", id: "new", name: a.name }, "conversion_action", null, `${a.type}/${a.category}`, "create")],
      ops: [{ conversionActionOperation: { create: { name: a.name, type: a.type, category: a.category, countingType: a.counting_type, status: "ENABLED", primaryForGoal: a.primary_for_goal, clickThroughLookbackWindowDays: String(a.click_lookback_days), ...valueSettings } } }],
    };
  },
  landed: (a, _b, after) => after.actions.some((x) => x.name.toLowerCase() === a.name.toLowerCase()),
  result: (a, after) => ({ conversion_action_id: after.actions.find((x) => x.name.toLowerCase() === a.name.toLowerCase())!.id, name: a.name, tag_snippets: [] }),
});
// Tag snippets are read after creation (they are generated by Google), so the result is completed here.
const createExecute = createConversionAction.execute;
createConversionAction.execute = async (a, ctx, run) => {
  const out = await createExecute(a, ctx, run);
  const rows = await ctx.services.ads.query(new Gaql().select("conversion_action.id", "conversion_action.tag_snippets").from("conversion_action").where(`conversion_action.id = ${lit.id(out.conversion_action_id)}`).limit(1), { maxRows: 1 });
  const snippets = ((rows[0] && (pick(rows[0], "conversion_action.tag_snippets") as Row[] | undefined)) ?? []).map((t) => ({ type: str(t, "type"), page_format: str(t, "pageFormat"), global_site_tag: str(t, "globalSiteTag"), event_snippet: str(t, "eventSnippet") }));
  return { ...out, tag_snippets: snippets };
};

export const updateConversionAction = stateWrite({
  name: "update_conversion_action",
  title: "Update conversion action",
  risk: "high_impact",
  description: "Changes a conversion action's name, status (ENABLED or HIDDEN), whether it is a primary goal, counting, default value, or click lookback window, after approval. Changing what counts as a primary goal, counting or value changes what Smart Bidding optimises, so it needs a second approver; a rename does not. Confirmed by re-reading.",
  input: z
    .object({ account_id: accountId, conversion_action_id: idSchema, name: clean(100).optional(), status: z.enum(["ENABLED", "HIDDEN"]).optional(), primary_for_goal: z.boolean().optional(), counting_type: z.enum(["ONE_PER_CLICK", "MANY_PER_CLICK"]).optional(), default_value: z.number().min(0).max(1_000_000).optional(), click_lookback_days: z.number().int().min(1).max(90).optional() })
    .refine((v) => Object.keys(v).some((k) => !["account_id", "conversion_action_id"].includes(k)), "give at least one setting"),
  output: z.object({ conversion_action: z.object({ id: z.string(), name: z.string(), status: z.string().nullable(), primary_for_goal: z.boolean(), counting_type: z.string().nullable(), default_value: z.number().nullable(), click_lookback_days: z.number().nullable() }) }),
  read: async (a, ads) => {
    const [r] = await ads.query(new Gaql().select(...caFields).from("conversion_action").where(`conversion_action.id = ${lit.id(a.conversion_action_id)}`).limit(1), { maxRows: 1 });
    if (!r) throw new ToolError("not_found", `No conversion action ${a.conversion_action_id} in this account.`);
    const x = caRow(r);
    if (x.status === "REMOVED") throw new ToolError("invalid_argument", "The conversion action is removed and cannot be changed.");
    return x;
  },
  build: (a, s, ads) => {
    const ref = { resource: "conversion_action", id: a.conversion_action_id, name: s.name };
    const update: Row = { resourceName: rn(ads, "conversionActions", a.conversion_action_id) };
    const mask: string[] = [];
    const changes: Change[] = [];
    if (a.name !== undefined && a.name !== s.name) (update.name = a.name), mask.push("name"), changes.push(change(ref, "name", s.name, a.name, "neutral"));
    if (a.status !== undefined && a.status !== s.status) (update.status = a.status), mask.push("status"), changes.push(change(ref, "status", s.status, a.status, "increase_spend"));
    if (a.primary_for_goal !== undefined && a.primary_for_goal !== s.primary_for_goal) (update.primaryForGoal = a.primary_for_goal), mask.push("primary_for_goal"), changes.push(change(ref, "primary_for_goal", s.primary_for_goal, a.primary_for_goal, "increase_spend"));
    if (a.counting_type !== undefined && a.counting_type !== s.counting_type) (update.countingType = a.counting_type), mask.push("counting_type"), changes.push(change(ref, "counting_type", s.counting_type, a.counting_type, "increase_spend"));
    if (a.default_value !== undefined && a.default_value !== s.default_value) (update.valueSettings = { defaultValue: a.default_value }), mask.push("value_settings.default_value"), changes.push(change(ref, "default_value", s.default_value, a.default_value, "increase_spend"));
    if (a.click_lookback_days !== undefined && a.click_lookback_days !== s.click_lookback_days) (update.clickThroughLookbackWindowDays = String(a.click_lookback_days)), mask.push("click_through_lookback_window_days"), changes.push(change(ref, "click_lookback_days", s.click_lookback_days, a.click_lookback_days, "increase_spend"));
    if (!mask.length) throw new ToolError("invalid_argument", "Nothing would change.");
    return { summary: `Conversion action "${s.name}": ${changes.map((c) => `${c.field} ${c.before} -> ${c.after}`).join("; ")}`, changes, ops: [{ conversionActionOperation: { update, updateMask: mask.join(",") } }] };
  },
  landed: (a, _b, x) => (a.name === undefined || x.name === a.name) && (a.status === undefined || x.status === a.status) && (a.primary_for_goal === undefined || x.primary_for_goal === a.primary_for_goal) && (a.counting_type === undefined || x.counting_type === a.counting_type) && (a.default_value === undefined || x.default_value === a.default_value) && (a.click_lookback_days === undefined || x.click_lookback_days === a.click_lookback_days),
  result: (_a, x) => ({ conversion_action: { id: x.id, name: x.name, status: x.status, primary_for_goal: x.primary_for_goal, counting_type: x.counting_type, default_value: x.default_value, click_lookback_days: x.click_lookback_days } }),
});

export const accountWriteTools = [createLabel, addCampaignLabel, removeCampaignLabel, bulkUpdateCampaignStatus, bulkUpdateAdGroupStatus, removeAdGroup, removeDisplayAdGroup, removeDisplayAd, createConversionAction, updateConversionAction];
