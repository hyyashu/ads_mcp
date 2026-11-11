import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, pick } from "../gaql";
import { tailId } from "./campaign-reads";
import { accountId, campaignIds, googleRead, idSchema, str } from "./common";
import { CATEGORIES, ORIGINS, conversionCustomer, requireOwnConversionCustomer } from "./conversion-common";
import { stateWrite } from "./write-kit";

/**
 * Conversion goals (v26 guides docs/conversions/goals/overview, customer-goals, campaign-goals).
 * - customer_conversion_goal: the account default, one per category + origin in use; biddable decides whether Smart Bidding
 *   optimises toward conversion actions of that pair. Google creates and removes them; the API only updates `biddable`.
 *   Mutations must be sent to the account's Google Ads conversion customer.
 * - campaign_conversion_goal: the same per campaign. Updating any of a campaign's goals makes Google set the campaign's
 *   conversion_goal_campaign_config.goal_config_level to CAMPAIGN, after which account-level changes no longer reach it.
 *   Resource names: customers/{c}/customerConversionGoals/{category}~{origin} and
 *   customers/{c}/campaignConversionGoals/{campaign_id}~{category}~{origin}.
 */

const goalSchema = z.object({ category: z.string().nullable(), origin: z.string().nullable(), biddable: z.boolean() });
const goalRow = (r: Row, res: string) => ({ category: str(r, `${res}.category`), origin: str(r, `${res}.origin`), biddable: pick(r, `${res}.biddable`) === true });
const byPair = (x: { category: string | null; origin: string | null }, y: { category: string | null; origin: string | null }) => `${x.category}~${x.origin}`.localeCompare(`${y.category}~${y.origin}`);

async function accountGoals(ads: GoogleAdsClient) {
  const rows = await ads.query(new Gaql().select("customer_conversion_goal.category", "customer_conversion_goal.origin", "customer_conversion_goal.biddable").from("customer_conversion_goal"), { maxRows: 1000 });
  return rows.map((r) => goalRow(r, "customer_conversion_goal")).sort(byPair);
}

interface CampaignGoals {
  campaign_id: string;
  campaign_name: string | null;
  goal_config_level: string | null;
  custom_conversion_goal_id: string | null;
  goals: { category: string | null; origin: string | null; biddable: boolean }[];
}

/** Goals and goal configuration of non-removed campaigns (all, or the given ids). */
async function campaignGoals(ads: GoogleAdsClient, ids: string[] | undefined): Promise<CampaignGoals[]> {
  const only = ids?.length ? `campaign.id IN ${lit.list(ids.map(lit.id))}` : undefined;
  const [goals, configs] = await Promise.all([
    ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign_conversion_goal.category", "campaign_conversion_goal.origin", "campaign_conversion_goal.biddable").from("campaign_conversion_goal").where("campaign.status != 'REMOVED'").where(only), { maxRows: 10_000 }),
    ads.query(new Gaql().select("campaign.id", "campaign.name", "conversion_goal_campaign_config.goal_config_level", "conversion_goal_campaign_config.custom_conversion_goal").from("conversion_goal_campaign_config").where("campaign.status != 'REMOVED'").where(only), { maxRows: 10_000 }),
  ]);
  const by = new Map<string, CampaignGoals>();
  const get = (r: Row) => {
    const id = String(pick(r, "campaign.id"));
    let c = by.get(id);
    if (!c) by.set(id, (c = { campaign_id: id, campaign_name: str(r, "campaign.name"), goal_config_level: null, custom_conversion_goal_id: null, goals: [] }));
    return c;
  };
  for (const r of configs) {
    const c = get(r);
    c.goal_config_level = str(r, "conversion_goal_campaign_config.goal_config_level");
    c.custom_conversion_goal_id = tailId(pick(r, "conversion_goal_campaign_config.custom_conversion_goal"));
  }
  for (const r of goals) get(r).goals.push(goalRow(r, "campaign_conversion_goal"));
  for (const c of by.values()) c.goals.sort(byPair);
  return [...by.values()].sort((x, y) => x.campaign_id.localeCompare(y.campaign_id, undefined, { numeric: true }));
}

// ----------------------------------------------------------------------------------------------- get_conversion_goals
export const getConversionGoals = googleRead({
  name: "get_conversion_goals",
  title: "Conversion goals (account and campaign)",
  description:
    "Lists the conversion goals Smart Bidding optimises toward. Account-level goals (one per conversion category and origin, e.g. PURCHASE from WEBSITE) with whether each is biddable (an account-default goal), and for each campaign its own goals, whether it follows the account goals (goal_config_level CUSTOMER) or its own (CAMPAIGN), and any custom conversion goal. Optionally limited to some campaigns. Removed campaigns are left out. Fetched live.",
  input: z.object({ account_id: accountId, campaign_ids: campaignIds.optional(), include_campaigns: z.boolean().default(true).describe("false returns the account-level goals only.") }),
  output: z.object({
    conversion_customer_id: z.string().nullable().describe("The account that manages conversions for this one (account-level goals live there)."),
    account_goals: z.array(goalSchema),
    campaigns: z.array(z.object({ campaign_id: z.string(), campaign_name: z.string().nullable(), goal_config_level: z.string().nullable().describe("CUSTOMER: follows the account goals. CAMPAIGN: has its own."), custom_conversion_goal_id: z.string().nullable(), goals: z.array(goalSchema) })),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const [cc, account, campaigns] = await Promise.all([conversionCustomer(ads), accountGoals(ads), a.include_campaigns ? campaignGoals(ads, a.campaign_ids) : Promise.resolve([])]);
    return { conversion_customer_id: cc, account_goals: account, campaigns };
  },
});

// -------------------------------------------------------------------------------------------- update_conversion_goals
interface GoalsState {
  conversion_customer_id: string | null;
  /** Account level: the account goals. */
  account?: { category: string | null; origin: string | null; biddable: boolean }[];
  /** Account level: campaigns with their own goals, which an account-level change does not reach. */
  campaigns_with_own_goals?: number;
  /** Campaign level: the named campaigns. */
  campaigns?: CampaignGoals[];
}

const goalInput = z.object({ category: z.enum(CATEGORIES), origin: z.enum(ORIGINS), biddable: z.boolean() });
type GoalInput = z.infer<typeof goalInput>;
const pairKey = (g: { category: string | null; origin: string | null }) => `${g.category}~${g.origin}`;

/** The requested goals that differ from the live state, per campaign (null = account level). */
function diffs(a: { level: string; campaign_ids?: string[] | undefined; goals: GoalInput[] }, s: GoalsState) {
  const out: { campaign: CampaignGoals | null; goal: GoalInput; before: boolean }[] = [];
  const scopes = a.level === "account" ? [null] : s.campaigns!;
  for (const c of scopes) {
    const live = c ? c.goals : s.account!;
    for (const g of a.goals) {
      const cur = live.find((x) => pairKey(x) === pairKey(g));
      if (!cur) {
        throw new ToolError(
          "invalid_argument",
          `${c ? `Campaign "${c.campaign_name ?? c.campaign_id}" has` : "The account has"} no conversion goal for category ${g.category} and origin ${g.origin}. Google creates goals only for category and origin pairs used by the account's conversion actions; get_conversion_goals lists them. Nothing was changed.`,
        );
      }
      if (cur.biddable !== g.biddable) out.push({ campaign: c, goal: g, before: cur.biddable });
    }
  }
  return out;
}

export const updateConversionGoals = stateWrite({
  name: "update_conversion_goals",
  title: "Update conversion goals",
  risk: "high_impact",
  description:
    "Sets whether Smart Bidding optimises toward a conversion goal (biddable true or false), for given category + origin pairs, after a person approves it. At account level it changes the account-default goals, which apply to every campaign that follows them; at campaign level it changes the goals of the given campaigns only, and Google then switches those campaigns to their own goals (goal_config_level CAMPAIGN), so later account-level changes no longer reach them. Goals exist only for pairs used by conversion actions; this tool cannot create or remove them. Changes what bidding optimises for, so it is high impact. Confirmed by re-reading.",
  input: z
    .object({
      account_id: accountId,
      level: z.enum(["account", "campaign"]).describe("account: the account-default goals. campaign: the goals of campaign_ids."),
      campaign_ids: z.array(idSchema).min(1).max(50).optional().describe("Required for level campaign (up to 50)."),
      goals: z.array(goalInput).min(1).max(50),
    })
    .refine((v) => (v.level === "campaign") === (v.campaign_ids !== undefined), { message: "give campaign_ids for level campaign, and none for level account" })
    .refine((v) => new Set(v.goals.map(pairKey)).size === v.goals.length, { message: "each category and origin pair may appear once" }),
  output: z.object({
    level: z.string(),
    updated: z.array(z.object({ campaign_id: z.string().nullable(), category: z.string(), origin: z.string(), biddable: z.boolean() })),
    unchanged: z.number().int().describe("Requested goals that already had the requested value."),
    campaigns_goal_config_level: z.array(z.object({ campaign_id: z.string(), goal_config_level: z.string().nullable() })).describe("Level campaign: each campaign's goal configuration after the change."),
  }),
  read: async (a, ads): Promise<GoalsState> => {
    const cc = await conversionCustomer(ads);
    if (a.level === "account") {
      // Account goals can only be changed in the conversion customer (goals overview, Mutate requirements).
      requireOwnConversionCustomer(ads, cc, "changes to account-level conversion goals");
      const own = await ads.query(new Gaql().select("campaign.id", "conversion_goal_campaign_config.goal_config_level").from("conversion_goal_campaign_config").where("campaign.status != 'REMOVED'").where("conversion_goal_campaign_config.goal_config_level = 'CAMPAIGN'"), { maxRows: 10_000 });
      return { conversion_customer_id: cc, account: await accountGoals(ads), campaigns_with_own_goals: own.length };
    }
    const ids = [...new Set(a.campaign_ids!)].sort();
    const found = await campaignGoals(ads, ids);
    const missing = ids.filter((id) => !found.some((c) => c.campaign_id === id));
    if (missing.length) throw new ToolError("not_found", `No active campaign ${missing.join(", ")} in this account (removed campaigns cannot be changed).`);
    return { conversion_customer_id: cc, campaigns: found };
  },
  build: (a, s, ads) => {
    const d = diffs(a, s);
    if (!d.length) throw new ToolError("invalid_argument", "Nothing would change: every requested goal already has that biddable value.");
    const c = ads.customerId;
    const ops = d.map((x) =>
      x.campaign
        ? { campaignConversionGoalOperation: { update: { resourceName: `customers/${c}/campaignConversionGoals/${x.campaign.campaign_id}~${x.goal.category}~${x.goal.origin}`, biddable: x.goal.biddable }, updateMask: "biddable" } }
        : { customerConversionGoalOperation: { update: { resourceName: `customers/${c}/customerConversionGoals/${x.goal.category}~${x.goal.origin}`, biddable: x.goal.biddable }, updateMask: "biddable" } },
    );
    // What bidding optimises for changes, so the change set marks it as affecting spend (high impact), as update_conversion_action does.
    const changes: Change[] = d.map((x) => ({
      resource: x.campaign ? "campaign_conversion_goal" : "customer_conversion_goal",
      id: `${x.campaign ? `${x.campaign.campaign_id}~` : ""}${x.goal.category}~${x.goal.origin}`,
      name: x.campaign?.campaign_name ?? null,
      field: "biddable",
      before: x.before,
      after: x.goal.biddable,
      unit: "status",
      effect: "increase_spend",
    }));
    const list = d.map((x) => `${x.campaign ? `campaign "${x.campaign.campaign_name ?? x.campaign.campaign_id}" ` : ""}${x.goal.category}/${x.goal.origin} ${x.before} -> ${x.goal.biddable}`);
    const notes: string[] = [];
    if (a.level === "account") notes.push(`Applies to every campaign that follows the account goals${s.campaigns_with_own_goals ? `; ${s.campaigns_with_own_goals} campaign(s) with their own goals are not affected` : ""}.`);
    else {
      const switching = s.campaigns!.filter((c) => c.goal_config_level !== "CAMPAIGN" && d.some((x) => x.campaign?.campaign_id === c.campaign_id));
      if (switching.length) notes.push(`${switching.map((c) => `"${c.campaign_name ?? c.campaign_id}"`).join(", ")} will switch from the account goals to their own goals (Google sets goal_config_level to CAMPAIGN), so later account-level goal changes no longer apply to them.`);
    }
    return { summary: `Set conversion goal biddability at ${a.level} level: ${list.slice(0, 10).join("; ")}${list.length > 10 ? `; and ${list.length - 10} more` : ""}. ${notes.join(" ")}`.trim(), changes, ops };
  },
  landed: (a, _before, after) => {
    const scopes = a.level === "account" ? [after.account!] : a.campaign_ids!.map((id) => after.campaigns!.find((c) => c.campaign_id === id)?.goals ?? []);
    return scopes.every((goals) => a.goals.every((g) => goals.some((x) => pairKey(x) === pairKey(g) && x.biddable === g.biddable)));
  },
  result: (a, after, _res, before) => {
    const d = diffs(a, before);
    return {
      level: a.level,
      updated: d.map((x) => ({ campaign_id: x.campaign?.campaign_id ?? null, category: x.goal.category, origin: x.goal.origin, biddable: x.goal.biddable })),
      unchanged: (a.level === "account" ? 1 : before.campaigns!.length) * a.goals.length - d.length,
      campaigns_goal_config_level: (after.campaigns ?? []).map((c) => ({ campaign_id: c.campaign_id, goal_config_level: c.goal_config_level })),
    };
  },
});

export const conversionGoalTools = [getConversionGoals, updateConversionGoals];
