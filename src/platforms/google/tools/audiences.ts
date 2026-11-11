import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import type { AnyTool } from "../../../mcp/tool";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, num, pick } from "../gaql";
import { accountId, googleRead, idSchema, str } from "./common";
import { rn, stateWrite } from "./write-kit";

/**
 * Remarketing lists and Customer Match (UserListService, GAQL user_list). Members are not uploaded here: since 2026-04-01 Google refuses Customer Match
 * upload jobs from API projects without earlier use and points to its Data Manager API, so upload_customer_match_members was removed.
 * Docs: https://developers.google.com/google-ads/api/reference/rpc/v26/UserList,
 * https://developers.google.com/google-ads/api/docs/remarketing/audience-segments/website-visitors and
 * https://developers.google.com/google-ads/api/docs/remarketing/audience-segments/customer-match/get-started.
 */
const clean = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");
const USER_LIST_TYPES = ["REMARKETING", "LOGICAL", "EXTERNAL_REMARKETING", "RULE_BASED", "SIMILAR", "CRM_BASED", "LOOKALIKE"] as const;
/** UserList.membership_life_span: "must be between 0 and 540 inclusive" (v26 reference); 540 is also the Customer Match maximum. */
const MAX_LIFE_SPAN = 540;
const nOrNull = (r: Row, f: string): number | null => (pick(r, f) === undefined || pick(r, f) === null ? null : num(pick(r, f)));

// ----------------------------------------------------------------------------------------------- list_user_lists
const LIST_FIELDS = [
  "user_list.id",
  "user_list.name",
  "user_list.description",
  "user_list.type",
  "user_list.membership_status",
  "user_list.membership_life_span",
  "user_list.size_range_for_search",
  "user_list.size_range_for_display",
  "user_list.size_for_search",
  "user_list.size_for_display",
  "user_list.eligible_for_search",
  "user_list.eligible_for_display",
  "user_list.closing_reason",
  "user_list.access_reason",
  "user_list.read_only",
  "user_list.match_rate_percentage",
  "user_list.crm_based_user_list.upload_key_type",
];
const userListOut = z.object({
  id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  type: z.string().nullable().describe("REMARKETING, LOGICAL, EXTERNAL_REMARKETING, RULE_BASED, SIMILAR, CRM_BASED (Customer Match) or LOOKALIKE."),
  membership_status: z.string().nullable().describe("OPEN lists collect members and can be targeted; CLOSED ones do not."),
  membership_life_span_days: z.number().nullable(),
  size_range_for_search: z.string().nullable(),
  size_range_for_display: z.string().nullable(),
  size_for_search: z.number().nullable().describe("Google's estimate of users on Google Search; null until determined."),
  size_for_display: z.number().nullable().describe("Google's estimate of users on the Display Network; null until determined."),
  eligible_for_search: z.boolean().nullable(),
  eligible_for_display: z.boolean().nullable(),
  closing_reason: z.string().nullable().describe("Set only when Google closed the list automatically (UNUSED)."),
  access_reason: z.string().nullable().describe("OWNED, SHARED, LICENSED, SUBSCRIBED or AFFILIATED."),
  read_only: z.boolean().nullable(),
  match_rate_percentage: z.number().nullable().describe("Customer Match lists only: share of uploaded records Google matched (0-100)."),
  upload_key_type: z.string().nullable().describe("Customer Match lists only: CONTACT_INFO, CRM_ID or MOBILE_ADVERTISING_ID."),
});
const userListRow = (r: Row): z.infer<typeof userListOut> => ({
  id: String(pick(r, "user_list.id") ?? ""),
  name: str(r, "user_list.name"),
  description: str(r, "user_list.description"),
  type: str(r, "user_list.type"),
  membership_status: str(r, "user_list.membership_status"),
  membership_life_span_days: nOrNull(r, "user_list.membership_life_span"),
  size_range_for_search: str(r, "user_list.size_range_for_search"),
  size_range_for_display: str(r, "user_list.size_range_for_display"),
  size_for_search: nOrNull(r, "user_list.size_for_search"),
  size_for_display: nOrNull(r, "user_list.size_for_display"),
  // Proto3 JSON omits false booleans, so an absent eligibility flag on a returned row is false.
  eligible_for_search: pick(r, "user_list.eligible_for_search") === true,
  eligible_for_display: pick(r, "user_list.eligible_for_display") === true,
  closing_reason: str(r, "user_list.closing_reason"),
  access_reason: str(r, "user_list.access_reason"),
  read_only: pick(r, "user_list.read_only") === true,
  match_rate_percentage: nOrNull(r, "user_list.match_rate_percentage"),
  upload_key_type: str(r, "user_list.crm_based_user_list.upload_key_type"),
});

export const listUserLists = googleRead({
  name: "list_user_lists",
  title: "List remarketing and customer lists",
  description:
    "Lists the account's user lists (remarketing lists, Customer Match lists, combined/logical lists, similar and lookalike lists): id, name, type, whether the list is open, membership duration, Google's size estimates and size ranges for Search and Display, whether it can be used on Search and Display, why Google closed it, and for Customer Match lists the match rate. Filter by type, status or name. Fetched live.",
  input: z.object({
    account_id: accountId,
    types: z.array(z.enum(USER_LIST_TYPES)).min(1).max(USER_LIST_TYPES.length).optional().describe("Only these list types."),
    membership_status: z.enum(["OPEN", "CLOSED"]).optional(),
    name_contains: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f%_]+$/, "no control characters, % or _").optional(),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  output: z.object({ user_lists: z.array(userListOut), truncated: z.boolean().describe("True when more lists match than limit.") }),
  handler: async (a, ctx) => {
    const rows = await ctx.services.ads.query(
      new Gaql()
        .select(...LIST_FIELDS)
        .from("user_list")
        .where(a.types ? `user_list.type IN ${lit.list(a.types.map((t) => lit.enumLit(t, USER_LIST_TYPES)))}` : undefined)
        .where(a.membership_status ? `user_list.membership_status = ${lit.enumLit(a.membership_status, ["OPEN", "CLOSED"] as const)}` : undefined)
        .where(a.name_contains ? `user_list.name LIKE ${lit.str(`%${a.name_contains}%`)}` : undefined)
        .orderBy("user_list.name")
        .limit(a.limit + 1),
      { maxRows: a.limit + 1, partial: true },
    );
    return { user_lists: rows.slice(0, a.limit).map(userListRow).filter((l) => l.id), truncated: rows.length > a.limit };
  },
});

// ------------------------------------------------------------------------------------------------ list creation
/** Lists with exactly this name (names are unique per account, UserList reference). Used as the snapshot of a create. */
async function listsNamed(ads: GoogleAdsClient, name: string): Promise<Named> {
  const rows = await ads.query(new Gaql().select("user_list.id", "user_list.type").from("user_list").where(`user_list.name = ${lit.str(name)}`).orderBy("user_list.id"), { maxRows: 100 });
  return { lists: rows.map((r) => ({ id: String(pick(r, "user_list.id")), type: str(r, "user_list.type") })) };
}
const createdOut = z.object({ user_list_id: z.string(), name: z.string(), type: z.string(), note: z.string() });
type Named = { lists: { id: string; type: string | null }[] };
const created = (before: Named, after: Named) => after.lists.find((l) => !before.lists.some((b) => b.id === l.id));
const refuseTaken = (name: string, s: { lists: { id: string }[] }) => {
  if (s.lists.length) throw new ToolError("invalid_argument", `A user list named "${name}" already exists (id ${s.lists[0]!.id}). List names are unique in an account.`);
};
const createChange = (name: string, what: string): Change => ({ resource: "user_list", id: "new", name, field: "user_list", before: null, after: what, unit: "text", effect: "neutral" });

const URL_OPERATORS = ["CONTAINS", "EQUALS", "STARTS_WITH", "ENDS_WITH", "NOT_CONTAINS", "NOT_EQUALS", "NOT_STARTS_WITH", "NOT_ENDS_WITH"] as const;
/** UserListStringRuleItemInfo.value: URL values "can not contain illegal URL chars such as newlines, quotes, tabs, or parentheses". */
const urlRule = z.object({
  operator: z.enum(URL_OPERATORS),
  value: z.string().trim().min(1).max(1024).regex(/^[^\s"'()\u0000-\u001f\u007f]+$/, "no spaces, quotes, parentheses or control characters"),
});
type UrlRule = z.infer<typeof urlRule>;
/** A rule on the Google tag's built-in page URL parameter, url__ (website-visitors guide). */
const urlItem = (r: UrlRule) => ({ name: "url__", stringRuleItem: { operator: r.operator, value: r.value } });
const ruleLabel = (r: UrlRule) => `URL ${r.operator.toLowerCase().replace(/_/g, " ")} ${r.value}`;

export const createRemarketingList = stateWrite({
  name: "create_remarketing_list",
  title: "Create website remarketing list",
  risk: "write",
  description:
    "Creates a rule-based remarketing list of website visitors, after approval: people whose visited page URL matches the rules (contains, equals, starts with, ends with, or their negations), any or all of them, optionally minus visitors of excluded URLs, for a membership duration of up to 540 days. " +
    "The list only fills from visits recorded by the Google tag: the tag must be installed on every page of the site, and Google only targets a list once it has enough active members (for example 100 on Display, 1,000 on Search). Optionally includes visitors from the last 30 days (Display only). Confirmed by re-reading.",
  input: z.object({
    account_id: accountId,
    name: clean(255),
    description: clean(1000).optional(),
    url_rules: z.array(urlRule).min(1).max(10).describe("Page URL conditions for being added to the list."),
    match: z.enum(["any", "all"]).default("any").describe("any: a visit matching one rule qualifies; all: a visit must match every rule."),
    exclude_url_rules: z.array(urlRule).max(10).optional().describe("Visitors whose visits match any of these are left out of the list."),
    membership_duration_days: z.number().int().min(1).max(MAX_LIFE_SPAN).default(30).describe("How long a visitor stays on the list after the last matching visit."),
    include_past_visitors: z.boolean().default(true).describe("Prepopulate with matching visitors from the last 30 days (Display Network only)."),
  }),
  output: createdOut,
  read: (a, ads) => listsNamed(ads, a.name),
  build: (a, s) => {
    refuseTaken(a.name, s);
    const days = String(a.membership_duration_days);
    // Within a rule item group items are ANDed; groups are ORed (UserListRuleInfo: OR of ANDs, the only type for flexible rules).
    const include = a.match === "all" ? [{ ruleItems: a.url_rules.map(urlItem) }] : a.url_rules.map((r) => ({ ruleItems: [urlItem(r)] }));
    const exclude = (a.exclude_url_rules ?? []).map((r) => ({ ruleItems: [urlItem(r)] }));
    const userList = {
      name: a.name,
      ...(a.description ? { description: a.description } : {}),
      membershipStatus: "OPEN",
      // The website-visitors guide sets membership_life_span; the UserList reference says rule-based lists take their
      // duration from the rule instead, so the operands' lookback window carries the same number of days.
      membershipLifeSpan: days,
      ruleBasedUserList: {
        ...(a.include_past_visitors ? { prepopulationStatus: "REQUESTED" } : {}),
        flexibleRuleUserList: {
          inclusiveRuleOperator: "AND",
          inclusiveOperands: [{ rule: { ruleItemGroups: include }, lookbackWindowDays: days }],
          ...(exclude.length ? { exclusiveOperands: [{ rule: { ruleItemGroups: exclude }, lookbackWindowDays: days }] } : {}),
        },
      },
    };
    const rules = a.url_rules.map(ruleLabel).join(a.match === "all" ? " AND " : " OR ");
    const excl = a.exclude_url_rules?.length ? `; excluding ${a.exclude_url_rules.map(ruleLabel).join(" OR ")}` : "";
    return {
      summary: `Create website remarketing list "${a.name}": visitors where ${rules}${excl}; members stay ${a.membership_duration_days} days${a.include_past_visitors ? "; includes matching visitors from the last 30 days" : ""}. Fills only if the Google tag is on the site.`,
      changes: [createChange(a.name, `rule-based list: ${rules}${excl}`)],
      ops: [],
      mutate: { service: "userLists", operations: [{ create: userList }] },
    };
  },
  landed: (_a, before, after) => created(before, after) !== undefined,
  result: (a, after, _r, before) => ({
    user_list_id: created(before, after)!.id,
    name: a.name,
    type: created(before, after)!.type ?? "RULE_BASED",
    note: "The list fills only from visits recorded by the Google tag on the site. Google targets it once it has enough active members; check its size with list_user_lists.",
  }),
});

export const createCustomerMatchList = stateWrite({
  name: "create_customer_match_list",
  title: "Create Customer Match list",
  risk: "write",
  description:
    "Creates an empty Customer Match list for your own customers' contact information (emails and phone numbers; CRM-based, first-party data), after approval, with a membership duration of up to 540 days (Google's maximum and default). This server cannot add people to it: add them in Google Ads (Tools > Audience manager) or through Google's Data Manager API (Google refuses Customer Match uploads through the Google Ads API for new integrations). " +
    "Customer Match is only available to accounts Google considers eligible (a good history of policy compliance and of payments, under Google's Customer Match policy); if the account is not eligible Google refuses the request and its error is returned as given. Google targets a list only once enough of its members are matched and active. Confirmed by re-reading.",
  input: z.object({
    account_id: accountId,
    name: clean(255),
    description: clean(1000).optional(),
    membership_life_span_days: z.number().int().min(1).max(MAX_LIFE_SPAN).default(MAX_LIFE_SPAN).describe("Days a person stays on the list after their most recent upload (at most 540)."),
  }),
  output: createdOut,
  read: (a, ads) => listsNamed(ads, a.name),
  build: (a, s) => {
    refuseTaken(a.name, s);
    return {
      summary: `Create Customer Match list "${a.name}" (contact information, first-party data; members stay ${a.membership_life_span_days} days after their last upload)`,
      changes: [createChange(a.name, "Customer Match list (contact info)")],
      ops: [],
      mutate: {
        service: "userLists",
        operations: [{ create: { name: a.name, ...(a.description ? { description: a.description } : {}), membershipLifeSpan: String(a.membership_life_span_days), crmBasedUserList: { uploadKeyType: "CONTACT_INFO", dataSourceType: "FIRST_PARTY" } } }],
      },
    };
  },
  landed: (_a, before, after) => created(before, after) !== undefined,
  result: (a, after, _r, before) => ({
    user_list_id: created(before, after)!.id,
    name: a.name,
    type: created(before, after)!.type ?? "CRM_BASED",
    note: "The list is empty: add members in Google Ads (Tools > Audience manager) or through Google's Data Manager API. Google targets it once enough members are matched and active.",
  }),
});

// ------------------------------------------------------------------------------------------------ remove_user_list
interface RemoveState {
  exists: boolean;
  list?: { id: string; name: string | null; type: string | null; access_reason: string | null; read_only: boolean };
  /** Where the list is still used: "ad_group 12 (Name)", "campaign 3 (Name)", "audience 7 (Name)", "logical_list 9 (Name)". */
  used_by?: string[];
}
const USE_CAP = 25;
async function readForRemoval(ads: GoogleAdsClient, id: string): Promise<RemoveState> {
  const [r] = await ads.query(new Gaql().select("user_list.id", "user_list.name", "user_list.type", "user_list.access_reason", "user_list.read_only").from("user_list").where(`user_list.id = ${lit.id(id)}`).limit(1), { maxRows: 1 });
  if (!r) return { exists: false };
  const res = lit.str(rn(ads, "userLists", id));
  const page = { maxRows: USE_CAP, partial: true } as const;
  const [groups, campaigns, segments, exclusions, logical] = await Promise.all([
    ads.query(new Gaql().select("ad_group.id", "ad_group.name").from("ad_group_criterion").where(`ad_group_criterion.user_list.user_list = ${res}`).where("ad_group_criterion.status != 'REMOVED'").where("ad_group.status != 'REMOVED'").limit(USE_CAP), page),
    ads.query(new Gaql().select("campaign.id", "campaign.name").from("campaign_criterion").where(`campaign_criterion.user_list.user_list = ${res}`).where("campaign_criterion.status != 'REMOVED'").where("campaign.status != 'REMOVED'").limit(USE_CAP), page),
    ads.query(new Gaql().select("audience.id", "audience.name").from("audience").where(`audience.dimensions.audience_segments.segments.user_list.user_list = ${res}`).where("audience.status != 'REMOVED'").limit(USE_CAP), page),
    ads.query(new Gaql().select("audience.id", "audience.name").from("audience").where(`audience.exclusion_dimension.exclusions.user_list.user_list = ${res}`).where("audience.status != 'REMOVED'").limit(USE_CAP), page),
    ads.query(new Gaql().select("user_list.id", "user_list.name", "user_list.logical_user_list.rules").from("user_list").where("user_list.type = 'LOGICAL'"), { maxRows: 1000 }),
  ]);
  const label = (kind: string, row: Row) => `${kind} ${pick(row, `${kind === "logical_list" ? "user_list" : kind}.id`)} (${str(row, `${kind === "logical_list" ? "user_list" : kind}.name`) ?? "unnamed"})`;
  const usesList = (row: Row) => ((pick(row, "user_list.logical_user_list.rules") as { ruleOperands?: { userList?: string }[] }[] | undefined) ?? []).some((rule) => (rule.ruleOperands ?? []).some((o) => o.userList === `customers/${ads.customerId}/userLists/${id}`));
  const used = [...groups.map((g) => label("ad_group", g)), ...campaigns.map((c) => label("campaign", c)), ...[...segments, ...exclusions].map((x) => label("audience", x)), ...logical.filter(usesList).map((l) => label("logical_list", l))];
  return {
    exists: true,
    list: { id, name: str(r, "user_list.name"), type: str(r, "user_list.type"), access_reason: str(r, "user_list.access_reason"), read_only: pick(r, "user_list.read_only") === true },
    used_by: [...new Set(used)].sort(),
  };
}

export const removeUserList = stateWrite({
  name: "remove_user_list",
  title: "Remove user list",
  risk: "destructive",
  description:
    "Permanently removes a remarketing or Customer Match list that this account owns, after a person approves it. Refused while the list is still used: targeted or excluded by an ad group or campaign, part of an audience (Demand Gen, Performance Max signals) or of a combined (logical) list; remove that use first. Lists Google marks read-only or that are shared with this account cannot be removed here. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, user_list_id: idSchema }),
  output: z.object({ user_list_id: z.string(), name: z.string().nullable(), removed: z.literal(true) }),
  read: (a, ads) => readForRemoval(ads, a.user_list_id),
  build: (a, s, ads) => {
    if (!s.exists || !s.list) throw new ToolError("not_found", `No user list ${a.user_list_id} in this account.`);
    const l = s.list;
    if (l.read_only) throw new ToolError("invalid_argument", `Google marks list "${l.name ?? a.user_list_id}" read-only (for example a list created by Google or shared from another account), so it cannot be removed.`);
    if (l.access_reason !== "OWNED") throw new ToolError("invalid_argument", `This account does not own list "${l.name ?? a.user_list_id}" (access: ${l.access_reason ?? "unknown"}); only the owner can remove it.`);
    const used = s.used_by ?? [];
    if (used.length) throw new ToolError("invalid_argument", `List "${l.name ?? a.user_list_id}" is still used by ${used.length >= USE_CAP ? `${USE_CAP} or more items` : `${used.length} item(s)`}: ${used.slice(0, 10).join("; ")}${used.length > 10 ? "; …" : ""}. Remove the list from these first.`);
    return {
      summary: `Permanently remove ${l.type ?? ""} user list "${l.name ?? a.user_list_id}" (${a.user_list_id}). It is not used by any ad group, campaign, audience or combined list. This cannot be undone.`,
      changes: [{ resource: "user_list", id: a.user_list_id, name: l.name, field: "user_list", before: l.type, after: "(removed)", unit: "text", effect: "remove" }],
      ops: [],
      mutate: { service: "userLists", operations: [{ remove: rn(ads, "userLists", a.user_list_id) }] },
    };
  },
  landed: (_a, _b, after) => !after.exists,
  result: (a, _after, _r, before) => ({ user_list_id: a.user_list_id, name: before.list?.name ?? null, removed: true as const }),
});

/**
 * Google Ads tools: list_user_lists, create_remarketing_list, create_customer_match_list, remove_user_list.
 * Approved by the owner on 2026-11-11 (inventory/tool-registry.json); API surfaces in inventory/mapping.ts.
 */
export const audienceTools: AnyTool[] = [listUserLists, createRemarketingList, createCustomerMatchList, removeUserList];
