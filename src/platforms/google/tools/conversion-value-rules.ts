import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { type Change, statusChange, textChange } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, num, pick } from "../gaql";
import { tailId } from "./campaign-reads";
import { accountId, googleRead, idSchema, str } from "./common";
import { rn, stateWrite, temp } from "./write-kit";

/**
 * Conversion value rules (v26 guide docs/conversions/conversion-value-rules; ConversionValueRule, ConversionValueRuleSet references).
 * - A rule is an action (ADD a value > 0, MULTIPLY by 0.5 to 10, or SET) plus at most two conditions (audience, device, geo,
 *   itinerary). A rule only changes conversion values once it is in a ConversionValueRuleSet, attached to the account
 *   (attachment_type CUSTOMER) or to a campaign; until then it does not even show in the Google Ads UI.
 * - A set's dimensions (at most two) list the condition types its rules may use. A rule can be in one enabled or paused set only.
 * - Removing a rule that an enabled or paused set references fails; a set must keep at least one rule.
 * So create_conversion_value_rule creates the rule and, unless asked not to, adds it to the account's or the campaign's rule
 * set (creating that set when there is none) in one atomic GoogleAdsService.Mutate, and remove_conversion_value_rule first
 * takes the rule out of its set.
 */

const DEVICES = ["MOBILE", "DESKTOP", "TABLET"] as const;
const GEO_MATCH = ["ANY", "LOCATION_OF_PRESENCE"] as const;
const RULE_FIELDS = [
  "conversion_value_rule.id",
  "conversion_value_rule.status",
  "conversion_value_rule.owner_customer",
  "conversion_value_rule.action.operation",
  "conversion_value_rule.action.value",
  "conversion_value_rule.device_condition.device_types",
  "conversion_value_rule.geo_location_condition.geo_target_constants",
  "conversion_value_rule.geo_location_condition.geo_match_type",
  "conversion_value_rule.geo_location_condition.excluded_geo_target_constants",
  "conversion_value_rule.geo_location_condition.excluded_geo_match_type",
  "conversion_value_rule.audience_condition.user_lists",
  "conversion_value_rule.audience_condition.user_interests",
  "conversion_value_rule.itinerary_condition.advance_booking_window.min_days",
  "conversion_value_rule.itinerary_condition.advance_booking_window.max_days",
  "conversion_value_rule.itinerary_condition.travel_length.min_nights",
  "conversion_value_rule.itinerary_condition.travel_length.max_nights",
];

interface Rule {
  rule_id: string;
  status: string | null;
  owner_customer_id: string | null;
  operation: string | null;
  value: number | null;
  device_types: string[];
  geo: { location_ids: string[]; match_type: string | null; excluded_location_ids: string[]; excluded_match_type: string | null } | null;
  audience: { user_list_ids: string[]; user_interest_ids: string[] } | null;
  itinerary: boolean;
}
interface RuleSet {
  rule_set_id: string;
  status: string | null;
  owner_customer_id: string | null;
  attachment_type: string | null;
  campaign_id: string | null;
  conversion_action_categories: string[];
  dimensions: string[];
  rule_ids: string[];
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => tailId(x)).filter((x): x is string => !!x).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).sort() : []);

function ruleRow(r: Row): Rule {
  const f = (p: string) => pick(r, `conversion_value_rule.${p}`);
  const geoIds = ids(f("geo_location_condition.geo_target_constants"));
  const geoEx = ids(f("geo_location_condition.excluded_geo_target_constants"));
  const lists = ids(f("audience_condition.user_lists"));
  const interests = ids(f("audience_condition.user_interests"));
  const itin = ["advance_booking_window.min_days", "advance_booking_window.max_days", "travel_length.min_nights", "travel_length.max_nights"].some((p) => f(`itinerary_condition.${p}`) !== undefined);
  return {
    rule_id: String(f("id")),
    status: str(r, "conversion_value_rule.status"),
    owner_customer_id: tailId(f("owner_customer")),
    operation: str(r, "conversion_value_rule.action.operation"),
    value: f("action.value") === undefined ? null : num(f("action.value")),
    device_types: strs(f("device_condition.device_types")),
    geo: geoIds.length || geoEx.length ? { location_ids: geoIds, match_type: str(r, "conversion_value_rule.geo_location_condition.geo_match_type"), excluded_location_ids: geoEx, excluded_match_type: geoEx.length ? str(r, "conversion_value_rule.geo_location_condition.excluded_geo_match_type") : null } : null,
    audience: lists.length || interests.length ? { user_list_ids: lists, user_interest_ids: interests } : null,
    itinerary: itin,
  };
}

async function readRules(ads: GoogleAdsClient, where?: string): Promise<Rule[]> {
  const rows = await ads.query(new Gaql().select(...RULE_FIELDS).from("conversion_value_rule").where(where).orderBy("conversion_value_rule.id"), { maxRows: 10_000 });
  return rows.map(ruleRow);
}
/** Rule sets. Google does not return removed sets (conversion-value-rules guide). */
async function readSets(ads: GoogleAdsClient): Promise<RuleSet[]> {
  const rows = await ads.query(
    new Gaql()
      .select("conversion_value_rule_set.id", "conversion_value_rule_set.status", "conversion_value_rule_set.owner_customer", "conversion_value_rule_set.attachment_type", "conversion_value_rule_set.campaign", "conversion_value_rule_set.conversion_action_categories", "conversion_value_rule_set.dimensions", "conversion_value_rule_set.conversion_value_rules")
      .from("conversion_value_rule_set")
      .orderBy("conversion_value_rule_set.id"),
    { maxRows: 10_000 },
  );
  return rows
    .map((r) => ({
      rule_set_id: String(pick(r, "conversion_value_rule_set.id")),
      status: str(r, "conversion_value_rule_set.status"),
      owner_customer_id: tailId(pick(r, "conversion_value_rule_set.owner_customer")),
      attachment_type: str(r, "conversion_value_rule_set.attachment_type"),
      campaign_id: tailId(pick(r, "conversion_value_rule_set.campaign")),
      conversion_action_categories: strs(pick(r, "conversion_value_rule_set.conversion_action_categories")),
      // Order matters: the first dimension is the primary one, and rules are evaluated in list order.
      dimensions: ((pick(r, "conversion_value_rule_set.dimensions") as string[] | undefined) ?? []).map(String),
      rule_ids: ((pick(r, "conversion_value_rule_set.conversion_value_rules") as string[] | undefined) ?? []).map((x) => tailId(x)!).filter(Boolean),
    }))
    .filter((s) => s.status !== "REMOVED");
}

const ruleSchema = z.object({
  rule_id: z.string(),
  status: z.string().nullable(),
  owner_customer_id: z.string().nullable().describe("A rule owned by another account (a manager) is inherited and can only be changed there."),
  operation: z.string().nullable().describe("ADD, MULTIPLY or SET."),
  value: z.number().nullable(),
  device_types: z.array(z.string()),
  geo: z.object({ location_ids: z.array(z.string()), match_type: z.string().nullable(), excluded_location_ids: z.array(z.string()), excluded_match_type: z.string().nullable() }).nullable(),
  audience: z.object({ user_list_ids: z.array(z.string()), user_interest_ids: z.array(z.string()) }).nullable(),
  itinerary: z.boolean().describe("Has a travel itinerary condition (allowlisted accounts only)."),
});
const ruleSetSchema = z.object({
  rule_set_id: z.string(),
  status: z.string().nullable(),
  owner_customer_id: z.string().nullable(),
  attachment_type: z.string().nullable().describe("CUSTOMER (whole account) or CAMPAIGN."),
  campaign_id: z.string().nullable(),
  conversion_action_categories: z.array(z.string()).describe("Empty: applies to every category."),
  dimensions: z.array(z.string()),
  rule_ids: z.array(z.string()).describe("In evaluation order: the first matching rule applies."),
});

// ------------------------------------------------------------------------------------------ list_conversion_value_rules
export const listConversionValueRules = googleRead({
  name: "list_conversion_value_rules",
  title: "Conversion value rules",
  description:
    "Lists the conversion value rules that adjust conversion values: each rule's action (ADD a value, MULTIPLY, or SET), its conditions (device types, locations with match type and exclusions, audiences: user lists and user interests, or a travel itinerary), status, owner, and the rule set it belongs to. Also lists the rule sets: account or campaign attachment, dimensions and rule order. A rule only changes values while it is in a rule set. Removed rules are left out unless include_removed. Fetched live.",
  input: z.object({ account_id: accountId, include_removed: z.boolean().default(false) }),
  output: z.object({ rules: z.array(ruleSchema.extend({ rule_set_id: z.string().nullable().describe("The set the rule is in; null means the rule does not apply anywhere.") })), rule_sets: z.array(ruleSetSchema) }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const [rules, sets] = await Promise.all([readRules(ads, a.include_removed ? undefined : "conversion_value_rule.status != 'REMOVED'"), readSets(ads)]);
    return { rules: rules.map((r) => ({ ...r, rule_set_id: sets.find((s) => s.rule_ids.includes(r.rule_id))?.rule_set_id ?? null })), rule_sets: sets };
  },
});

// ----------------------------------------------------------------------------------------- create_conversion_value_rule
const idList = (max: number) => z.array(idSchema).min(1).max(max);
const createInput = z
  .object({
    account_id: accountId,
    operation: z.enum(["ADD", "MULTIPLY"]).describe("ADD adds value to the conversion value; MULTIPLY multiplies it (0.5 to 10). SET is not offered: Google allows SET rules only in allowlisted accounts or in store-visit/store-sales sets."),
    value: z.number().describe("ADD: the amount to add (greater than 0). MULTIPLY: the factor, from 0.5 to 10."),
    device_types: z.array(z.enum(DEVICES)).min(1).max(3).optional().describe("Condition: the impression's device is one of these."),
    geo: z
      .object({
        location_ids: idList(50).describe("Geo target constant ids to include (resolve_google_locations)."),
        match_type: z.enum(GEO_MATCH).default("ANY").describe("ANY: people in or interested in the locations. LOCATION_OF_PRESENCE: people in them."),
        excluded_location_ids: idList(50).optional().describe("Geo target constant ids to exclude."),
        excluded_match_type: z.enum(GEO_MATCH).optional().describe("Match type for the excluded locations; default the same as match_type."),
      })
      .optional()
      .describe("Condition: the impression's location."),
    audience: z
      .object({ user_list_ids: idList(50).optional().describe("Audience (user list) ids."), user_interest_ids: idList(50).optional().describe("User interest ids.") })
      .refine((v) => v.user_list_ids !== undefined || v.user_interest_ids !== undefined, "give user_list_ids or user_interest_ids")
      .optional()
      .describe("Condition: the impression is associated with any of these audiences."),
    apply_to: z.enum(["account", "campaign", "none"]).default("account").describe("account (default): add the rule to the account's rule set, creating it if needed. campaign: to campaign_id's rule set. none: create the rule only; it does not change any value until added to a rule set."),
    campaign_id: idSchema.optional().describe("Required with apply_to campaign."),
  })
  .refine((v) => [v.device_types, v.geo, v.audience].filter((x) => x !== undefined).length >= 1, { message: "give at least one condition (device_types, geo or audience)" })
  .refine((v) => [v.device_types, v.geo, v.audience].filter((x) => x !== undefined).length <= 2, { message: "Google allows at most two conditions per rule" })
  .refine((v) => (v.operation === "ADD" ? v.value > 0 : v.value >= 0.5 && v.value <= 10), { message: "ADD needs a value greater than 0; MULTIPLY a factor from 0.5 to 10" })
  .refine((v) => (v.apply_to === "campaign") === (v.campaign_id !== undefined), { message: "give campaign_id with apply_to campaign, and only then" })
  .refine((v) => v.geo?.excluded_match_type === undefined || v.geo.excluded_location_ids !== undefined, { message: "excluded_match_type needs excluded_location_ids" });
type CreateArgs = z.infer<typeof createInput>;

/** The rule as it reads back (sorted lists), to compare with live rules. */
function wanted(a: CreateArgs): Omit<Rule, "rule_id" | "status" | "owner_customer_id"> {
  const sort = (x: string[] | undefined) => [...new Set(x ?? [])].sort((p, q) => p.localeCompare(q, undefined, { numeric: true }));
  return {
    operation: a.operation,
    value: a.value,
    device_types: [...new Set(a.device_types ?? [])].sort(),
    geo: a.geo ? { location_ids: sort(a.geo.location_ids), match_type: a.geo.match_type, excluded_location_ids: sort(a.geo.excluded_location_ids), excluded_match_type: a.geo.excluded_location_ids ? (a.geo.excluded_match_type ?? a.geo.match_type) : null } : null,
    audience: a.audience ? { user_list_ids: sort(a.audience.user_list_ids), user_interest_ids: sort(a.audience.user_interest_ids) } : null,
    itinerary: false,
  };
}
const sameRule = (r: Rule, w: ReturnType<typeof wanted>) =>
  r.operation === w.operation && r.value === w.value && JSON.stringify(r.device_types) === JSON.stringify(w.device_types) && JSON.stringify(r.geo) === JSON.stringify(w.geo) && JSON.stringify(r.audience) === JSON.stringify(w.audience) && !r.itinerary;
/** The ValueRuleSetDimension of each condition the rule has. */
const dimsOf = (a: CreateArgs) => [...(a.geo ? ["GEO_LOCATION"] : []), ...(a.device_types ? ["DEVICE"] : []), ...(a.audience ? ["AUDIENCE"] : [])];
/** The rule set a new rule joins: the account's or the campaign's set for every category (not a store-visit or store-sales set). */
const targetSet = (a: CreateArgs, sets: RuleSet[]) =>
  a.apply_to === "none" ? undefined : sets.find((s) => !s.conversion_action_categories.length && (a.apply_to === "account" ? s.attachment_type === "CUSTOMER" : s.attachment_type === "CAMPAIGN" && s.campaign_id === a.campaign_id));

interface CreateState {
  rules: Rule[];
  sets: RuleSet[];
  campaign?: { id: string; name: string | null };
}

/** Every location, user list and user interest the condition names must exist; returns the ones that do not. */
async function missingReferences(ads: GoogleAdsClient, a: CreateArgs): Promise<string[]> {
  const out: string[] = [];
  const geo = [...new Set([...(a.geo?.location_ids ?? []), ...(a.geo?.excluded_location_ids ?? [])])];
  if (geo.length) {
    const rows = await ads.query(new Gaql().select("geo_target_constant.id", "geo_target_constant.status").from("geo_target_constant").where(`geo_target_constant.id IN ${lit.list(geo.map(lit.id))}`), { maxRows: 200 });
    const have = new Set(rows.map((r) => String(pick(r, "geo_target_constant.id"))));
    out.push(...geo.filter((id) => !have.has(id)).map((id) => `location ${id}`));
  }
  const lists = [...new Set(a.audience?.user_list_ids ?? [])];
  if (lists.length) {
    const rows = await ads.query(new Gaql().select("user_list.id", "user_list.name").from("user_list").where(`user_list.id IN ${lit.list(lists.map(lit.id))}`), { maxRows: 200 });
    const have = new Set(rows.map((r) => String(pick(r, "user_list.id"))));
    out.push(...lists.filter((id) => !have.has(id)).map((id) => `user list ${id}`));
  }
  const interests = [...new Set(a.audience?.user_interest_ids ?? [])];
  if (interests.length) {
    const rows = await ads.query(new Gaql().select("user_interest.user_interest_id", "user_interest.name").from("user_interest").where(`user_interest.user_interest_id IN ${lit.list(interests.map(lit.id))}`), { maxRows: 200 });
    const have = new Set(rows.map((r) => String(pick(r, "user_interest.user_interest_id"))));
    out.push(...interests.filter((id) => !have.has(id)).map((id) => `user interest ${id}`));
  }
  return out;
}

const describeRule = (a: CreateArgs) => {
  const conds = [
    a.device_types ? `device ${a.device_types.join("/")}` : "",
    a.geo ? `location ${a.geo.match_type} ${a.geo.location_ids.join(",")}${a.geo.excluded_location_ids ? ` excluding ${a.geo.excluded_location_ids.join(",")}` : ""}` : "",
    a.audience ? `audience ${[...(a.audience.user_list_ids ?? []).map((x) => `list ${x}`), ...(a.audience.user_interest_ids ?? []).map((x) => `interest ${x}`)].join(",")}` : "",
  ].filter(Boolean);
  return `${a.operation === "ADD" ? `add ${a.value}` : `multiply by ${a.value}`} when ${conds.join(" and ")}`;
};

export const createConversionValueRule = stateWrite({
  name: "create_conversion_value_rule",
  title: "Create conversion value rule",
  risk: "high_impact",
  description:
    "Creates a conversion value rule after a person approves it: ADD a value to, or MULTIPLY (0.5 to 10), the value of conversions whose impression matches one or two conditions (device types; locations with optional exclusions; audiences: user lists or user interests). A rule only changes values while it is in a rule set, so by default the rule is added to the account's rule set (or, with apply_to campaign, to that campaign's set), and the set is created when there is none, in one atomic request. Campaign rule sets take precedence over the account's for that campaign; within a set the first matching rule applies, and the new rule goes last. A set allows at most two condition types. Changes reported values and Smart Bidding, so it is high impact. Confirmed by re-reading.",
  input: createInput,
  output: z.object({
    rule_id: z.string(),
    status: z.string().nullable(),
    rule_set: z.object({ rule_set_id: z.string(), created: z.boolean(), attachment_type: z.string().nullable(), campaign_id: z.string().nullable(), position: z.number().int().describe("1-based position of the rule in the set's evaluation order.") }).nullable(),
    applies: z.boolean().describe("False when the rule is in no rule set (apply_to none): it changes nothing yet."),
  }),
  read: async (a, ads): Promise<CreateState> => {
    let campaign: CreateState["campaign"];
    if (a.apply_to === "campaign") {
      const [c] = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status").from("campaign").where(`campaign.id = ${lit.id(a.campaign_id!)}`).limit(1), { maxRows: 1 });
      if (!c) throw new ToolError("not_found", `No campaign ${a.campaign_id} in this account.`);
      if (str(c, "campaign.status") === "REMOVED") throw new ToolError("invalid_argument", "The campaign is removed.");
      campaign = { id: a.campaign_id!, name: str(c, "campaign.name") };
    }
    const missing = await missingReferences(ads, a);
    if (missing.length) throw new ToolError("not_found", `These do not exist or are not available to this account: ${missing.join(", ")}. Nothing was changed.`);
    const [rules, sets] = await Promise.all([readRules(ads, "conversion_value_rule.status != 'REMOVED'"), readSets(ads)]);
    return { rules, sets, ...(campaign ? { campaign } : {}) };
  },
  build: (a, s, ads) => {
    const w = wanted(a);
    const dup = s.rules.find((r) => sameRule(r, w));
    if (dup) throw new ToolError("invalid_argument", `Nothing would change: rule ${dup.rule_id} already does exactly this.`);
    const tmp = temp(ads, "conversionValueRules", 1);
    const rule: Row = {
      resourceName: tmp,
      action: { operation: a.operation, value: a.value },
      status: "ENABLED",
      ...(a.device_types ? { deviceCondition: { deviceTypes: w.device_types } } : {}),
      ...(a.geo
        ? { geoLocationCondition: { geoTargetConstants: w.geo!.location_ids.map((id) => `geoTargetConstants/${id}`), geoMatchType: w.geo!.match_type, ...(a.geo.excluded_location_ids ? { excludedGeoTargetConstants: w.geo!.excluded_location_ids.map((id) => `geoTargetConstants/${id}`), excludedGeoMatchType: w.geo!.excluded_match_type } : {}) } }
        : {}),
      ...(a.audience ? { audienceCondition: { ...(w.audience!.user_list_ids.length ? { userLists: w.audience!.user_list_ids.map((id) => rn(ads, "userLists", id)) } : {}), ...(w.audience!.user_interest_ids.length ? { userInterests: w.audience!.user_interest_ids.map((id) => rn(ads, "userInterests", id)) } : {}) } } : {}),
    };
    const ops: Row[] = [{ conversionValueRuleOperation: { create: rule } }];
    const where = a.apply_to === "account" ? "the account" : a.apply_to === "campaign" ? `campaign "${s.campaign?.name ?? a.campaign_id}"` : "";
    const changes: Change[] = [{ resource: "conversion_value_rule", id: "new", field: "conversion_value_rule", before: null, after: describeRule(a), unit: "text", effect: "create" }];
    let setNote = "";
    if (a.apply_to !== "none") {
      const set = targetSet(a, s.sets);
      const need = dimsOf(a);
      if (set) {
        if (set.owner_customer_id && set.owner_customer_id !== ads.customerId) throw new ToolError("invalid_argument", `The rule set of ${where} (${set.rule_set_id}) is inherited from account ${set.owner_customer_id}; add rules to it there. Nothing was changed.`);
        if (set.dimensions.includes("NO_CONDITION")) throw new ToolError("invalid_argument", `The rule set of ${where} (${set.rule_set_id}) only takes rules without conditions. Nothing was changed.`);
        const dims = [...set.dimensions, ...need.filter((d) => !set.dimensions.includes(d))];
        if (dims.length > 2) throw new ToolError("invalid_argument", `The rule set of ${where} (${set.rule_set_id}) uses the condition types ${set.dimensions.join(" and ")}; Google allows at most two per set, so a rule with ${need.join(" and ")} cannot join it. Nothing was changed.`);
        const update: Row = { resourceName: rn(ads, "conversionValueRuleSets", set.rule_set_id), conversionValueRules: [...set.rule_ids.map((id) => rn(ads, "conversionValueRules", id)), tmp] };
        const mask = ["conversion_value_rules"];
        if (dims.length !== set.dimensions.length) (update.dimensions = dims), mask.push("dimensions");
        ops.push({ conversionValueRuleSetOperation: { update, updateMask: mask.join(",") } });
        changes.push(textChange({ resource: "conversion_value_rule_set", id: set.rule_set_id }, "conversion_value_rules", `${set.rule_ids.length} rule(s)`, `${set.rule_ids.length + 1} rule(s)`));
        setNote = ` It joins the existing rule set ${set.rule_set_id} of ${where} as rule ${set.rule_ids.length + 1} of ${set.rule_ids.length + 1} (the first matching rule applies)${dims.length !== set.dimensions.length ? `, which then also allows ${need.filter((d) => !set.dimensions.includes(d)).join(" and ")} conditions` : ""}.`;
      } else {
        ops.push({ conversionValueRuleSetOperation: { create: { attachmentType: a.apply_to === "account" ? "CUSTOMER" : "CAMPAIGN", ...(a.apply_to === "campaign" ? { campaign: rn(ads, "campaigns", a.campaign_id!) } : {}), dimensions: need, conversionValueRules: [tmp] } } });
        changes.push({ resource: "conversion_value_rule_set", id: "new", name: null, field: "conversion_value_rule_set", before: null, after: `${a.apply_to === "account" ? "account" : `campaign ${a.campaign_id}`} rule set (${need.join(", ")})`, unit: "text", effect: "create" });
        setNote = ` A new rule set for ${where} is created to hold it${a.apply_to === "campaign" ? "; from then on this campaign uses its own rule set instead of the account's" : ""}.`;
      }
    }
    return { summary: `Create a conversion value rule: ${describeRule(a)}.${a.apply_to === "none" ? " It is not added to any rule set, so it changes no conversion values until it is." : setNote}`, changes, ops };
  },
  landed: (a, before, after) => {
    const w = wanted(a);
    const fresh = after.rules.find((r) => sameRule(r, w) && !before.rules.some((b) => b.rule_id === r.rule_id));
    if (!fresh) return false;
    return a.apply_to === "none" || !!targetSet(a, after.sets)?.rule_ids.includes(fresh.rule_id);
  },
  result: (a, after, _res, before) => {
    const w = wanted(a);
    const fresh = after.rules.find((r) => sameRule(r, w) && !before.rules.some((b) => b.rule_id === r.rule_id))!;
    const set = targetSet(a, after.sets);
    return {
      rule_id: fresh.rule_id,
      status: fresh.status,
      rule_set: set ? { rule_set_id: set.rule_set_id, created: !before.sets.some((b) => b.rule_set_id === set.rule_set_id), attachment_type: set.attachment_type, campaign_id: set.campaign_id, position: set.rule_ids.indexOf(fresh.rule_id) + 1 } : null,
      applies: !!set,
    };
  },
});

// ----------------------------------------------------------------------------------------- remove_conversion_value_rule
interface RemoveState {
  rule: Rule | null;
  sets: RuleSet[];
}

export const removeConversionValueRule = stateWrite({
  name: "remove_conversion_value_rule",
  title: "Remove conversion value rule",
  risk: "destructive",
  description:
    "Permanently removes a conversion value rule after a person approves it (two approvers). Google refuses to remove a rule that a rule set still uses, so the rule is first taken out of its set in the same atomic request. A set must keep at least one rule: if this is the set's only rule, the request is refused unless remove_rule_set_if_empty is true, which also removes the set (conversion values then stop being adjusted there). Rules inherited from a manager account cannot be removed here. Cannot be undone. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, rule_id: idSchema, remove_rule_set_if_empty: z.boolean().default(false).describe("Also remove the rule set when this is its only rule.") }),
  output: z.object({ rule_id: z.string(), status: z.literal("REMOVED"), removed_from_rule_sets: z.array(z.string()), removed_rule_sets: z.array(z.string()) }),
  read: async (a, ads): Promise<RemoveState> => {
    const [rules, sets] = await Promise.all([readRules(ads, `conversion_value_rule.id = ${lit.id(a.rule_id)}`), readSets(ads)]);
    return { rule: rules[0] ?? null, sets: sets.filter((s) => s.rule_ids.includes(a.rule_id)) };
  },
  build: (a, s, ads) => {
    if (!s.rule) throw new ToolError("not_found", `No conversion value rule ${a.rule_id} in this account.`);
    if (s.rule.status === "REMOVED" && !s.sets.length) throw new ToolError("invalid_argument", "Nothing would change: the rule is already removed.");
    if (s.rule.owner_customer_id && s.rule.owner_customer_id !== ads.customerId) throw new ToolError("invalid_argument", `Rule ${a.rule_id} is inherited from account ${s.rule.owner_customer_id}; remove it there. Nothing was changed.`);
    const ops: Row[] = [];
    const changes: Change[] = [];
    const notes: string[] = [];
    for (const set of s.sets) {
      if (set.owner_customer_id && set.owner_customer_id !== ads.customerId) throw new ToolError("invalid_argument", `Rule ${a.rule_id} is in rule set ${set.rule_set_id}, which is inherited from account ${set.owner_customer_id}; remove it there. Nothing was changed.`);
      const rest = set.rule_ids.filter((id) => id !== a.rule_id);
      const where = set.attachment_type === "CAMPAIGN" ? `campaign ${set.campaign_id}` : "the account";
      if (rest.length) {
        ops.push({ conversionValueRuleSetOperation: { update: { resourceName: rn(ads, "conversionValueRuleSets", set.rule_set_id), conversionValueRules: rest.map((id) => rn(ads, "conversionValueRules", id)) }, updateMask: "conversion_value_rules" } });
        changes.push(textChange({ resource: "conversion_value_rule_set", id: set.rule_set_id }, "conversion_value_rules", `${set.rule_ids.length} rule(s)`, `${rest.length} rule(s)`));
        notes.push(`It is taken out of rule set ${set.rule_set_id} (${where}), which keeps ${rest.length} rule(s).`);
      } else if (a.remove_rule_set_if_empty) {
        ops.push({ conversionValueRuleSetOperation: { remove: rn(ads, "conversionValueRuleSets", set.rule_set_id) } });
        changes.push(statusChange({ resource: "conversion_value_rule_set", id: set.rule_set_id }, set.status ?? "ENABLED", "REMOVED"));
        notes.push(`Rule set ${set.rule_set_id} (${where}) has no other rule and is removed too: conversion values stop being adjusted there.`);
      } else {
        throw new ToolError("invalid_argument", `Rule ${a.rule_id} is the only rule in rule set ${set.rule_set_id} (${where}), and Google requires a set to keep at least one rule. Pass remove_rule_set_if_empty: true to remove the set as well, or add another rule to the set first. Nothing was changed.`);
      }
    }
    if (s.rule.status !== "REMOVED") {
      ops.push({ conversionValueRuleOperation: { remove: rn(ads, "conversionValueRules", a.rule_id) } });
      changes.push(statusChange({ resource: "conversion_value_rule", id: a.rule_id }, s.rule.status ?? "ENABLED", "REMOVED"));
    }
    for (const c of changes) c.effect = "remove";
    const r = s.rule;
    return { summary: `Permanently remove conversion value rule ${a.rule_id} (${r.operation ?? "?"} ${r.value ?? ""}, ${r.status}). ${notes.join(" ")} This cannot be undone.`.replace(/\s+/g, " ").trim(), changes, ops };
  },
  landed: (a, _before, after) => (!after.rule || after.rule.status === "REMOVED") && !after.sets.length,
  result: (a, _after, _res, before) => ({
    rule_id: a.rule_id,
    status: "REMOVED" as const,
    removed_from_rule_sets: before.sets.filter((s) => s.rule_ids.length > 1).map((s) => s.rule_set_id),
    removed_rule_sets: before.sets.filter((s) => s.rule_ids.length === 1).map((s) => s.rule_set_id),
  }),
});

export const conversionValueRuleTools = [listConversionValueRules, createConversionValueRule, removeConversionValueRule];
