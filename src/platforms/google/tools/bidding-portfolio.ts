import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change, Effect } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, fromMicros, lit, num, pick } from "../gaql";
import { tailId } from "./campaign-reads";
import { accountId, googleRead, idSchema, str, toMicros } from "./common";
import { rn, stateWrite } from "./write-kit";

/**
 * Portfolio bidding strategies (BiddingStrategy, shared by several campaigns), following the v26 guides
 * developers.google.com/google-ads/api/docs/campaigns/bidding/strategy-types (which types are valid as portfolios),
 * .../assign-strategies (campaign.bidding_strategy) and .../cross-account-strategies (strategies a manager shares).
 */

const change = (ref: { resource: string; id: string; name?: string | null }, field: string, before: string | number | null, after: string | number | null, effect: Effect, unit: Change["unit"] = "text"): Change => ({ ...ref, field, before, after, unit, effect });

/** Types the strategy-types guide lists as valid in a portfolio context, excluding the deprecated ENHANCED_CPC. */
export const PORTFOLIO_TYPES = ["TARGET_CPA", "TARGET_ROAS", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_IMPRESSION_SHARE", "TARGET_SPEND"] as const;
type PortfolioType = (typeof PORTFOLIO_TYPES)[number];
/** The bidding scheme field (REST JSON name) that creates each type: "Create a bidding strategy by setting the bidding scheme". */
const SCHEME: Record<PortfolioType, string> = {
  TARGET_CPA: "targetCpa",
  TARGET_ROAS: "targetRoas",
  MAXIMIZE_CONVERSIONS: "maximizeConversions",
  MAXIMIZE_CONVERSION_VALUE: "maximizeConversionValue",
  TARGET_IMPRESSION_SHARE: "targetImpressionShare",
  TARGET_SPEND: "targetSpend",
};
/**
 * Campaign types a portfolio type can serve, where the docs state it: portfolio MAXIMIZE_CONVERSIONS "can be used with
 * Search, Shopping, and Performance Max campaigns" (strategy-types guide); TargetImpressionShare targets "the search
 * results page" (TargetImpressionShare reference). Other types are checked by Google.
 */
const CHANNELS: Partial<Record<string, string[]>> = { MAXIMIZE_CONVERSIONS: ["SEARCH", "SHOPPING", "PERFORMANCE_MAX"], TARGET_IMPRESSION_SHARE: ["SEARCH"] };
const IS_LOCATIONS = ["ANYWHERE_ON_PAGE", "TOP_OF_PAGE", "ABSOLUTE_TOP_OF_PAGE"] as const;

const BS_FIELDS = [
  "bidding_strategy.id",
  "bidding_strategy.name",
  "bidding_strategy.type",
  "bidding_strategy.status",
  "bidding_strategy.campaign_count",
  "bidding_strategy.non_removed_campaign_count",
  "bidding_strategy.effective_currency_code",
  "bidding_strategy.aligned_campaign_budget_id",
  "bidding_strategy.target_cpa.target_cpa_micros",
  "bidding_strategy.target_cpa.cpc_bid_ceiling_micros",
  "bidding_strategy.target_cpa.cpc_bid_floor_micros",
  "bidding_strategy.target_roas.target_roas",
  "bidding_strategy.target_roas.cpc_bid_ceiling_micros",
  "bidding_strategy.target_roas.cpc_bid_floor_micros",
  "bidding_strategy.maximize_conversions.target_cpa_micros",
  "bidding_strategy.maximize_conversions.cpc_bid_ceiling_micros",
  "bidding_strategy.maximize_conversions.cpc_bid_floor_micros",
  "bidding_strategy.maximize_conversion_value.target_roas",
  "bidding_strategy.maximize_conversion_value.cpc_bid_ceiling_micros",
  "bidding_strategy.maximize_conversion_value.cpc_bid_floor_micros",
  "bidding_strategy.target_impression_share.location",
  "bidding_strategy.target_impression_share.location_fraction_micros",
  "bidding_strategy.target_impression_share.cpc_bid_ceiling_micros",
  "bidding_strategy.target_spend.cpc_bid_ceiling_micros",
];
/** The unrestricted attributes a shared (manager-owned) strategy exposes through accessible_bidding_strategy. */
const ABS_FIELDS = [
  "accessible_bidding_strategy.id",
  "accessible_bidding_strategy.name",
  "accessible_bidding_strategy.type",
  "accessible_bidding_strategy.owner_customer_id",
  "accessible_bidding_strategy.owner_descriptive_name",
  "accessible_bidding_strategy.target_cpa.target_cpa_micros",
  "accessible_bidding_strategy.target_roas.target_roas",
  "accessible_bidding_strategy.maximize_conversions.target_cpa_micros",
  "accessible_bidding_strategy.maximize_conversion_value.target_roas",
  "accessible_bidding_strategy.target_impression_share.location",
  "accessible_bidding_strategy.target_impression_share.location_fraction_micros",
  "accessible_bidding_strategy.target_impression_share.cpc_bid_ceiling_micros",
  "accessible_bidding_strategy.target_spend.cpc_bid_ceiling_micros",
];

const settingsSchema = z.object({
  target_cpa: z.number().nullable(),
  target_roas: z.number().nullable(),
  max_cpc: z.number().nullable().describe("Bid ceiling (cpc_bid_ceiling) in the account's currency."),
  min_cpc: z.number().nullable().describe("Bid floor (cpc_bid_floor) in the account's currency."),
  impression_share_location: z.string().nullable(),
  impression_share_percent: z.number().nullable(),
});
type Settings = z.infer<typeof settingsSchema>;

/** The scheme's settings from a bidding_strategy or accessible_bidding_strategy row (`p` is the resource name). */
function settingsOf(r: Row, p: string): Settings {
  const v = (f: string) => {
    const x = pick(r, `${p}.${f}`);
    return x === undefined || x === null ? null : x;
  };
  const money = (...fs: string[]) => {
    for (const f of fs) if (v(f) !== null) return fromMicros(v(f));
    return null;
  };
  const ratio = (...fs: string[]) => {
    for (const f of fs) if (v(f) !== null) return num(v(f));
    return null;
  };
  const schemes = ["target_cpa", "target_roas", "maximize_conversions", "maximize_conversion_value", "target_impression_share", "target_spend"];
  const fraction = v("target_impression_share.location_fraction_micros");
  return {
    target_cpa: money("target_cpa.target_cpa_micros", "maximize_conversions.target_cpa_micros"),
    target_roas: ratio("target_roas.target_roas", "maximize_conversion_value.target_roas"),
    max_cpc: money(...schemes.map((s) => `${s}.cpc_bid_ceiling_micros`)),
    min_cpc: money(...schemes.map((s) => `${s}.cpc_bid_floor_micros`)),
    impression_share_location: str(r, `${p}.target_impression_share.location`),
    impression_share_percent: fraction === null ? null : num(fraction) / 10_000,
  };
}

/** Text that names a campaign's bidding, for change sets: "TARGET_CPA (portfolio 77)" or "MANUAL_CPC (standard)". */
const biddingLabel = (customerId: string, type: string | null, portfolio: string | null) => {
  if (!portfolio) return `${type ?? "UNKNOWN"} (standard)`;
  const owner = portfolio.split("/")[1];
  return `${type ?? "UNKNOWN"} (portfolio ${tailId(portfolio)}${owner && owner !== customerId ? ` of account ${owner}` : ""})`;
};

// ------------------------------------------------------------------------------------------- list_bid_strategies
const campaignRef = z.object({ campaign_id: z.string(), name: z.string().nullable(), status: z.string().nullable(), channel: z.string().nullable() });
export const listBidStrategies = googleRead({
  name: "list_bid_strategies",
  title: "List portfolio bid strategies",
  description:
    "Lists the account's portfolio bid strategies (shared by several campaigns): id, name, type, targets (target CPA, target ROAS, bid limits, impression share goal), status, campaign counts and the campaigns using each. Also lists strategies a manager account shares with this account (owner = manager; Google exposes only their unrestricted attributes). Standard, per-campaign bidding is shown by list_campaigns and changed with update_bid_strategy. Names are untrusted text from Google.",
  input: z.object({
    account_id: accountId,
    include_removed: z.boolean().default(false).describe("Also list removed strategies."),
    include_shared: z.boolean().default(true).describe("Also list strategies shared by manager accounts."),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  output: z.object({
    strategies: z.array(
      z.object({
        bidding_strategy_id: z.string(),
        name: z.string().nullable(),
        type: z.string().nullable(),
        status: z.string().nullable().describe("Null for shared strategies (not visible to client accounts)."),
        owner: z.enum(["this_account", "manager"]),
        owner_customer_id: z.string(),
        owner_name: z.string().nullable(),
        currency_code: z.string().nullable(),
        campaign_count: z.number().nullable(),
        non_removed_campaign_count: z.number().nullable(),
        aligned_campaign_budget_id: z.string().nullable(),
        settings: settingsSchema,
        campaigns: z.array(campaignRef).describe("Non-removed campaigns of this account that use the strategy."),
      }),
    ),
    returned: z.number(),
    truncated: z.boolean().describe("True when more strategies matched than limit."),
    campaigns_truncated: z.boolean().describe("True when more campaigns use these strategies than were read (5,000)."),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const fetched = await ads.query(
      new Gaql()
        .select("bidding_strategy.resource_name", ...BS_FIELDS)
        .from("bidding_strategy")
        .where(a.include_removed ? undefined : "bidding_strategy.status != 'REMOVED'")
        .orderBy("bidding_strategy.id")
        .limit(a.limit + 1),
      { maxRows: a.limit + 1, partial: true },
    );
    interface Strat {
      rn: string;
      bidding_strategy_id: string;
      name: string | null;
      type: string | null;
      status: string | null;
      owner: "this_account" | "manager";
      owner_customer_id: string;
      owner_name: string | null;
      currency_code: string | null;
      campaign_count: number | null;
      non_removed_campaign_count: number | null;
      aligned_campaign_budget_id: string | null;
      settings: Settings;
    }
    const owned: Strat[] = fetched.slice(0, a.limit).map((r) => ({
      rn: str(r, "bidding_strategy.resource_name") ?? rn(ads, "biddingStrategies", String(pick(r, "bidding_strategy.id"))),
      bidding_strategy_id: String(pick(r, "bidding_strategy.id") ?? ""),
      name: str(r, "bidding_strategy.name"),
      type: str(r, "bidding_strategy.type"),
      status: str(r, "bidding_strategy.status"),
      owner: "this_account",
      owner_customer_id: ads.customerId,
      owner_name: null,
      currency_code: str(r, "bidding_strategy.effective_currency_code"),
      campaign_count: pick(r, "bidding_strategy.campaign_count") === undefined ? 0 : num(pick(r, "bidding_strategy.campaign_count")),
      non_removed_campaign_count: pick(r, "bidding_strategy.non_removed_campaign_count") === undefined ? 0 : num(pick(r, "bidding_strategy.non_removed_campaign_count")),
      aligned_campaign_budget_id: str(r, "bidding_strategy.aligned_campaign_budget_id"),
      settings: settingsOf(r, "bidding_strategy"),
    }));
    let truncated = fetched.length > a.limit;
    let shared: Strat[] = [];
    const room = a.limit - owned.length;
    if (a.include_shared && room > 0) {
      const rows = await ads.query(
        new Gaql()
          .select(...ABS_FIELDS)
          .from("accessible_bidding_strategy")
          .where(`accessible_bidding_strategy.owner_customer_id != ${lit.id(ads.customerId)}`)
          .orderBy("accessible_bidding_strategy.id")
          .limit(room + 1),
        { maxRows: room + 1, partial: true },
      );
      truncated ||= rows.length > room;
      shared = rows.slice(0, room).map((r) => {
        const owner = String(pick(r, "accessible_bidding_strategy.owner_customer_id") ?? "");
        const id = String(pick(r, "accessible_bidding_strategy.id") ?? "");
        return {
          rn: `customers/${owner}/biddingStrategies/${id}`,
          bidding_strategy_id: id,
          name: str(r, "accessible_bidding_strategy.name"),
          type: str(r, "accessible_bidding_strategy.type"),
          status: null,
          owner: "manager",
          owner_customer_id: owner,
          owner_name: str(r, "accessible_bidding_strategy.owner_descriptive_name"),
          currency_code: null,
          campaign_count: null,
          non_removed_campaign_count: null,
          aligned_campaign_budget_id: null,
          settings: settingsOf(r, "accessible_bidding_strategy"),
        } satisfies Strat;
      });
    }
    const all = [...owned, ...shared];
    const users = new Map<string, z.infer<typeof campaignRef>[]>();
    let campaignsTruncated = false;
    if (all.length) {
      const rows = await ads.query(
        new Gaql()
          .select("campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type", "campaign.bidding_strategy")
          .from("campaign")
          .where("campaign.status != 'REMOVED'")
          .where(`campaign.bidding_strategy IN ${lit.list(all.map((s) => lit.str(s.rn)))}`)
          .orderBy("campaign.id")
          .limit(5001),
        { maxRows: 5001, partial: true },
      );
      campaignsTruncated = rows.length > 5000;
      for (const r of rows.slice(0, 5000)) {
        const key = str(r, "campaign.bidding_strategy") ?? "";
        users.set(key, [...(users.get(key) ?? []), { campaign_id: String(pick(r, "campaign.id") ?? ""), name: str(r, "campaign.name"), status: str(r, "campaign.status"), channel: str(r, "campaign.advertising_channel_type") }]);
      }
    }
    const strategies = all.map(({ rn: key, ...s }) => ({ ...s, campaigns: users.get(key) ?? [] }));
    return { strategies, returned: strategies.length, truncated, campaigns_truncated: campaignsTruncated };
  },
});

// ------------------------------------------------------------------------------------------- create_bid_strategy
const name = z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");
const amount = (max: number) => z.number().positive().max(max);
const createInput = z
  .object({
    account_id: accountId,
    name: name.describe("Unique among the account's bidding strategies (1-255 characters)."),
    type: z.enum(PORTFOLIO_TYPES),
    target_cpa: amount(1_000_000).optional().describe("Target CPA in the account's currency. Required for TARGET_CPA; optional for MAXIMIZE_CONVERSIONS."),
    target_roas: z.number().min(0.01).max(1000).optional().describe("Target ROAS as a ratio (4.0 = 400%), 0.01 to 1000. Required for TARGET_ROAS; optional for MAXIMIZE_CONVERSION_VALUE."),
    max_cpc: amount(10_000).optional().describe("Bid ceiling in the account's currency. Required for TARGET_IMPRESSION_SHARE."),
    min_cpc: amount(10_000).optional().describe("Bid floor in the account's currency (TARGET_CPA, TARGET_ROAS, MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE)."),
    impression_share_location: z.enum(IS_LOCATIONS).optional().describe("TARGET_IMPRESSION_SHARE only: where on the results page."),
    impression_share_percent: z.number().gt(0).max(100).optional().describe("TARGET_IMPRESSION_SHARE only: share of impressions to win in that location, in percent."),
  })
  .refine((v) => v.type !== "TARGET_CPA" || v.target_cpa !== undefined, "TARGET_CPA needs target_cpa")
  .refine((v) => v.target_cpa === undefined || v.type === "TARGET_CPA" || v.type === "MAXIMIZE_CONVERSIONS", "target_cpa only with TARGET_CPA or MAXIMIZE_CONVERSIONS")
  .refine((v) => v.type !== "TARGET_ROAS" || v.target_roas !== undefined, "TARGET_ROAS needs target_roas")
  .refine((v) => v.target_roas === undefined || v.type === "TARGET_ROAS" || v.type === "MAXIMIZE_CONVERSION_VALUE", "target_roas only with TARGET_ROAS or MAXIMIZE_CONVERSION_VALUE")
  .refine((v) => v.type !== "TARGET_IMPRESSION_SHARE" || (v.max_cpc !== undefined && v.impression_share_location !== undefined && v.impression_share_percent !== undefined), "TARGET_IMPRESSION_SHARE needs impression_share_location, impression_share_percent and max_cpc")
  .refine((v) => v.type === "TARGET_IMPRESSION_SHARE" || (v.impression_share_location === undefined && v.impression_share_percent === undefined), "impression_share_location and impression_share_percent only with TARGET_IMPRESSION_SHARE")
  .refine((v) => v.min_cpc === undefined || ["TARGET_CPA", "TARGET_ROAS", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"].includes(v.type), "min_cpc is not available for this type")
  .refine((v) => v.min_cpc === undefined || v.max_cpc === undefined || v.min_cpc <= v.max_cpc, "min_cpc must not exceed max_cpc");

/** The scheme object for a new strategy (REST JSON). */
function schemeOf(a: z.infer<typeof createInput>): Row {
  const s: Row = {};
  if (a.target_cpa !== undefined) s.targetCpaMicros = String(toMicros(a.target_cpa));
  if (a.target_roas !== undefined) s.targetRoas = a.target_roas;
  if (a.max_cpc !== undefined) s.cpcBidCeilingMicros = String(toMicros(a.max_cpc));
  if (a.min_cpc !== undefined) s.cpcBidFloorMicros = String(toMicros(a.min_cpc));
  if (a.impression_share_location !== undefined) s.location = a.impression_share_location;
  if (a.impression_share_percent !== undefined) s.locationFractionMicros = String(Math.round(a.impression_share_percent * 10_000));
  return s;
}
const describeSettings = (a: z.infer<typeof createInput>) =>
  [a.target_cpa !== undefined && `target CPA ${a.target_cpa}`, a.target_roas !== undefined && `target ROAS ${a.target_roas}`, a.impression_share_percent !== undefined && `${a.impression_share_percent}% ${a.impression_share_location}`, a.max_cpc !== undefined && `max CPC ${a.max_cpc}`, a.min_cpc !== undefined && `min CPC ${a.min_cpc}`].filter(Boolean).join(", ");

async function strategiesNamed(ads: GoogleAdsClient, n: string) {
  const rows = await ads.query(new Gaql().select(...BS_FIELDS).from("bidding_strategy").where(`bidding_strategy.name = ${lit.str(n)}`).orderBy("bidding_strategy.id"), { maxRows: 100 });
  return rows.map((r) => ({ id: String(pick(r, "bidding_strategy.id") ?? ""), status: str(r, "bidding_strategy.status"), type: str(r, "bidding_strategy.type"), settings: settingsOf(r, "bidding_strategy") }));
}

export const createBidStrategy = stateWrite({
  name: "create_bid_strategy",
  title: "Create portfolio bid strategy",
  risk: "write",
  description:
    "Creates a portfolio bid strategy after approval: TARGET_CPA (needs target_cpa), TARGET_ROAS (needs target_roas), MAXIMIZE_CONVERSIONS (optional target_cpa), MAXIMIZE_CONVERSION_VALUE (optional target_roas), TARGET_IMPRESSION_SHARE (needs location, percent and max_cpc) or TARGET_SPEND (maximize clicks, optional max_cpc). Optional bid limits (max_cpc/min_cpc); Google disregards them for Search campaigns on portfolio MAXIMIZE_CONVERSIONS / MAXIMIZE_CONVERSION_VALUE. It is not attached to any campaign, so it changes nothing that serves; attach it with assign_bid_strategy. Confirmed by re-reading.",
  input: createInput,
  output: z.object({ bidding_strategy_id: z.string(), name: z.string(), type: z.string().nullable(), settings: settingsSchema }),
  read: async (a, ads) => ({ same_name: await strategiesNamed(ads, a.name) }),
  build: (a, s) => {
    const live = s.same_name.find((x) => x.status !== "REMOVED");
    if (live) throw new ToolError("invalid_argument", `Nothing would change: a bidding strategy named "${a.name}" already exists (id ${live.id}). Names must be unique in the account.`);
    const detail = describeSettings(a);
    return {
      summary: `Create portfolio bid strategy "${a.name}": ${a.type}${detail ? ` (${detail})` : ""}. Not attached to any campaign.`,
      // Creating an unattached strategy changes no serving campaign: neutral, so the tool's write risk applies.
      changes: [change({ resource: "bidding_strategy", id: "new", name: a.name }, "portfolio_bid_strategy", null, `${a.type}${detail ? ` (${detail})` : ""}`, "neutral")],
      ops: [{ biddingStrategyOperation: { create: { name: a.name, [SCHEME[a.type]]: schemeOf(a) } } }],
    };
  },
  landed: (a, before, after) => after.same_name.some((x) => x.status === "ENABLED" && x.type === a.type && !before.same_name.some((b) => b.id === x.id)),
  result: (a, after, _res, before) => {
    const made = after.same_name.find((x) => x.status === "ENABLED" && !before.same_name.some((b) => b.id === x.id))!;
    return { bidding_strategy_id: made.id, name: a.name, type: made.type, settings: made.settings };
  },
});

// ------------------------------------------------------------------------------------------- assign_bid_strategy
const STANDARD = ["MANUAL_CPC", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_SPEND"] as const;
interface Camp {
  id: string;
  name: string | null;
  status: string | null;
  channel: string | null;
  portfolio: string | null;
  type: string | null;
  budget_id: string | null;
  target_cpa_micros: number | null;
  target_roas: number | null;
  max_cpc_micros: number | null;
}
interface Target {
  rn: string;
  id: string;
  name: string | null;
  type: string | null;
  status: string | null;
  owner_customer_id: string;
  aligned_campaign_budget_id: string | null;
}

async function readCampaigns(ads: GoogleAdsClient, ids: string[]): Promise<Camp[]> {
  const rows = await ads.query(
    new Gaql()
      .select("campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type", "campaign.bidding_strategy", "campaign.bidding_strategy_type", "campaign.campaign_budget", "campaign.maximize_conversions.target_cpa_micros", "campaign.maximize_conversion_value.target_roas", "campaign.target_spend.cpc_bid_ceiling_micros")
      .from("campaign")
      .where(`campaign.id IN ${lit.list(ids.map(lit.id))}`)
      .orderBy("campaign.id"),
    { maxRows: ids.length + 1 },
  );
  const n = (r: Row, f: string) => (pick(r, f) === undefined ? null : num(pick(r, f)));
  return rows.map((r) => ({
    id: String(pick(r, "campaign.id") ?? ""),
    name: str(r, "campaign.name"),
    status: str(r, "campaign.status"),
    channel: str(r, "campaign.advertising_channel_type"),
    portfolio: str(r, "campaign.bidding_strategy"),
    type: str(r, "campaign.bidding_strategy_type"),
    budget_id: tailId(pick(r, "campaign.campaign_budget")),
    target_cpa_micros: n(r, "campaign.maximize_conversions.target_cpa_micros"),
    target_roas: n(r, "campaign.maximize_conversion_value.target_roas"),
    max_cpc_micros: n(r, "campaign.target_spend.cpc_bid_ceiling_micros"),
  }));
}

/** A portfolio strategy this account may use: its own (bidding_strategy) or one shared by a manager (accessible_bidding_strategy). */
async function readTarget(ads: GoogleAdsClient, id: string): Promise<Target | null> {
  const [own] = await ads.query(new Gaql().select("bidding_strategy.resource_name", "bidding_strategy.id", "bidding_strategy.name", "bidding_strategy.type", "bidding_strategy.status", "bidding_strategy.aligned_campaign_budget_id").from("bidding_strategy").where(`bidding_strategy.id = ${lit.id(id)}`).limit(1), { maxRows: 1 });
  if (own) return { rn: str(own, "bidding_strategy.resource_name") ?? rn(ads, "biddingStrategies", id), id, name: str(own, "bidding_strategy.name"), type: str(own, "bidding_strategy.type"), status: str(own, "bidding_strategy.status"), owner_customer_id: ads.customerId, aligned_campaign_budget_id: str(own, "bidding_strategy.aligned_campaign_budget_id") };
  const [shared] = await ads.query(new Gaql().select("accessible_bidding_strategy.id", "accessible_bidding_strategy.name", "accessible_bidding_strategy.type", "accessible_bidding_strategy.owner_customer_id").from("accessible_bidding_strategy").where(`accessible_bidding_strategy.id = ${lit.id(id)}`).limit(1), { maxRows: 1 });
  if (!shared) return null;
  const owner = String(pick(shared, "accessible_bidding_strategy.owner_customer_id") ?? "");
  return { rn: `customers/${owner}/biddingStrategies/${id}`, id, name: str(shared, "accessible_bidding_strategy.name"), type: str(shared, "accessible_bidding_strategy.type"), status: null, owner_customer_id: owner, aligned_campaign_budget_id: null };
}

const assignInput = z
  .object({
    account_id: accountId,
    campaign_ids: z.array(idSchema).min(1).max(50),
    bidding_strategy_id: idSchema.optional().describe("Portfolio strategy to attach (from list_bid_strategies)."),
    detach_to: z.enum(STANDARD).optional().describe("Instead of attaching: take the campaigns off their portfolio strategy onto this standard (per-campaign) strategy."),
    target_cpa: amount(1_000_000).optional().describe("With detach_to MAXIMIZE_CONVERSIONS: the campaigns' target CPA."),
    target_roas: z.number().positive().max(1000).optional().describe("With detach_to MAXIMIZE_CONVERSION_VALUE: the campaigns' target ROAS (4.0 = 400%)."),
    max_cpc: amount(10_000).optional().describe("With detach_to TARGET_SPEND: the campaigns' max CPC."),
  })
  .refine((v) => (v.bidding_strategy_id === undefined) !== (v.detach_to === undefined), "give bidding_strategy_id (attach) or detach_to (detach), not both")
  .refine((v) => v.target_cpa === undefined || v.detach_to === "MAXIMIZE_CONVERSIONS", "target_cpa only with detach_to MAXIMIZE_CONVERSIONS")
  .refine((v) => v.target_roas === undefined || v.detach_to === "MAXIMIZE_CONVERSION_VALUE", "target_roas only with detach_to MAXIMIZE_CONVERSION_VALUE")
  .refine((v) => v.max_cpc === undefined || v.detach_to === "TARGET_SPEND", "max_cpc only with detach_to TARGET_SPEND");
type AssignArgs = z.infer<typeof assignInput>;

/** The standard-strategy update for a detached campaign, as update_bid_strategy sends it (the scheme replaces the portfolio in the campaign_bidding_strategy union). */
function standardUpdate(a: AssignArgs): { body: Row; mask: string } {
  if (a.detach_to === "MANUAL_CPC") return { body: { manualCpc: {} }, mask: "manual_cpc" };
  if (a.detach_to === "MAXIMIZE_CONVERSIONS") return a.target_cpa ? { body: { maximizeConversions: { targetCpaMicros: String(toMicros(a.target_cpa)) } }, mask: "maximize_conversions.target_cpa_micros" } : { body: { maximizeConversions: {} }, mask: "maximize_conversions" };
  if (a.detach_to === "MAXIMIZE_CONVERSION_VALUE") return a.target_roas ? { body: { maximizeConversionValue: { targetRoas: a.target_roas } }, mask: "maximize_conversion_value.target_roas" } : { body: { maximizeConversionValue: {} }, mask: "maximize_conversion_value" };
  return a.max_cpc ? { body: { targetSpend: { cpcBidCeilingMicros: String(toMicros(a.max_cpc)) } }, mask: "target_spend.cpc_bid_ceiling_micros" } : { body: { targetSpend: {} }, mask: "target_spend" };
}
const detachLabel = (a: AssignArgs) => `${a.detach_to}${a.target_cpa ? ` target CPA ${a.target_cpa}` : ""}${a.target_roas ? ` target ROAS ${a.target_roas}` : ""}${a.max_cpc ? ` max CPC ${a.max_cpc}` : ""} (standard)`;

/** Campaigns the request would change (attach: not already on the strategy). Throws when the request cannot apply. */
function toChange(a: AssignArgs, s: { campaigns: Camp[]; strategy: Target | null }): Camp[] {
  const ids = [...new Set(a.campaign_ids)];
  const missing = ids.filter((id) => !s.campaigns.some((c) => c.id === id));
  if (missing.length) throw new ToolError("not_found", `No campaign ${missing.join(", ")} in this account.`);
  const removed = s.campaigns.filter((c) => c.status === "REMOVED");
  if (removed.length) throw new ToolError("invalid_argument", `Removed campaigns cannot be changed: ${removed.map((c) => c.id).join(", ")}.`);
  if (a.detach_to) {
    const standard = s.campaigns.filter((c) => !c.portfolio);
    if (standard.length) throw new ToolError("invalid_argument", `Not on a portfolio strategy (nothing to detach): ${standard.map((c) => `"${c.name ?? c.id}"`).join(", ")}. Use update_bid_strategy to change standard bidding.`);
    return s.campaigns;
  }
  const t = s.strategy;
  if (!t) throw new ToolError("not_found", `No portfolio bid strategy ${a.bidding_strategy_id} is available to this account (list_bid_strategies shows them).`);
  if (t.status === "REMOVED") throw new ToolError("invalid_argument", `Bid strategy ${t.id} is removed.`);
  const allowed = CHANNELS[t.type ?? ""];
  const wrong = allowed ? s.campaigns.filter((c) => !allowed.includes(c.channel ?? "")) : [];
  if (wrong.length) throw new ToolError("invalid_argument", `A portfolio ${t.type} strategy works only with ${allowed!.join(", ")} campaigns; not with ${wrong.map((c) => `"${c.name ?? c.id}" (${c.channel})`).join(", ")}.`);
  if (t.aligned_campaign_budget_id) {
    const off = s.campaigns.filter((c) => c.budget_id !== t.aligned_campaign_budget_id);
    if (off.length) throw new ToolError("invalid_argument", `Strategy ${t.id} is aligned with budget ${t.aligned_campaign_budget_id}; campaigns added to it must use that budget. Not: ${off.map((c) => c.id).join(", ")}.`);
  }
  const todo = s.campaigns.filter((c) => c.portfolio !== t.rn);
  if (!todo.length) throw new ToolError("invalid_argument", `Nothing would change: every campaign already uses bid strategy ${t.id}.`);
  return todo;
}

export const assignBidStrategy = stateWrite({
  name: "assign_bid_strategy",
  title: "Assign portfolio bid strategy",
  // Moving campaigns between bidding strategies changes how they spend, as update_bid_strategy does.
  risk: "high_impact",
  description:
    "Attaches campaigns to a portfolio bid strategy (bidding_strategy_id from list_bid_strategies, including one shared by a manager account), or with detach_to takes them off their portfolio onto a standard per-campaign strategy (MANUAL_CPC, MAXIMIZE_CONVERSIONS with optional target_cpa, MAXIMIZE_CONVERSION_VALUE with optional target_roas, TARGET_SPEND with optional max_cpc) in the same update. Checks documented compatibility: portfolio MAXIMIZE_CONVERSIONS only for Search, Shopping and Performance Max; TARGET_IMPRESSION_SHARE only for Search; a strategy aligned with a budget only for campaigns on that budget. Campaigns already on the strategy are skipped. The change set shows each campaign's bidding before and after. High impact: it changes how campaigns bid. Applied atomically and confirmed by re-reading.",
  input: assignInput,
  output: z.object({ campaigns: z.array(z.object({ campaign_id: z.string(), name: z.string().nullable(), bidding_strategy_id: z.string().nullable().describe("Portfolio strategy id, or null on standard bidding."), strategy_type: z.string().nullable() })), skipped_already_assigned: z.array(z.string()) }),
  read: async (a, ads) => ({ campaigns: await readCampaigns(ads, [...new Set(a.campaign_ids)]), strategy: a.bidding_strategy_id ? await readTarget(ads, a.bidding_strategy_id) : null }),
  build: (a, s, ads) => {
    const todo = toChange(a, s);
    const after = a.detach_to ? detachLabel(a) : `${s.strategy!.type} (portfolio ${s.strategy!.id}${s.strategy!.owner_customer_id !== ads.customerId ? ` of account ${s.strategy!.owner_customer_id}` : ""})`;
    // Whether bidding spends more or less after a strategy change is unknown, so each counts as the riskier direction.
    const changes = todo.map((c) => change({ resource: "campaign", id: c.id, name: c.name }, "bidding_strategy", biddingLabel(ads.customerId, c.type, c.portfolio), after, "increase_spend"));
    const std = a.detach_to ? standardUpdate(a) : null;
    const ops = todo.map((c) =>
      std ? { campaignOperation: { update: { resourceName: rn(ads, "campaigns", c.id), ...std.body }, updateMask: std.mask } } : { campaignOperation: { update: { resourceName: rn(ads, "campaigns", c.id), biddingStrategy: s.strategy!.rn }, updateMask: "bidding_strategy" } },
    );
    const skipped = s.campaigns.length - todo.length;
    const target = a.detach_to ? `standard ${detachLabel(a)}` : `portfolio "${s.strategy!.name ?? s.strategy!.id}" (${s.strategy!.type})`;
    return { summary: `Move ${todo.length} campaign(s) to ${target}: ${todo.slice(0, 10).map((c) => `"${c.name ?? c.id}"`).join(", ")}${skipped ? ` (${skipped} already on it)` : ""}`, changes, ops };
  },
  landed: (a, before, after) => {
    if (a.bidding_strategy_id) return after.campaigns.every((c) => c.portfolio === before.strategy?.rn);
    return after.campaigns.every(
      (c) => !c.portfolio && c.type === a.detach_to && (a.target_cpa === undefined || c.target_cpa_micros === toMicros(a.target_cpa)) && (a.target_roas === undefined || c.target_roas === a.target_roas) && (a.max_cpc === undefined || c.max_cpc_micros === toMicros(a.max_cpc)),
    );
  },
  result: (a, after, _res, before) => ({
    campaigns: after.campaigns.map((c) => ({ campaign_id: c.id, name: c.name, bidding_strategy_id: tailId(c.portfolio), strategy_type: c.type })),
    skipped_already_assigned: a.bidding_strategy_id ? before.campaigns.filter((c) => c.portfolio === before.strategy?.rn).map((c) => c.id) : [],
  }),
});

// ------------------------------------------------------------------------------------------- remove_bid_strategy
export const removeBidStrategy = stateWrite({
  name: "remove_bid_strategy",
  title: "Remove portfolio bid strategy",
  risk: "destructive",
  description:
    "Removes a portfolio bid strategy owned by this account after approval (irreversible). Refused while any campaign still uses it (Google rejects that too): move those campaigns first with assign_bid_strategy. A strategy shared by a manager account can only be removed in that manager account. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, bidding_strategy_id: idSchema }),
  output: z.object({ bidding_strategy_id: z.string(), name: z.string().nullable(), status: z.string() }),
  read: async (a, ads) => {
    const [r] = await ads.query(new Gaql().select("bidding_strategy.resource_name", "bidding_strategy.id", "bidding_strategy.name", "bidding_strategy.type", "bidding_strategy.status", "bidding_strategy.non_removed_campaign_count").from("bidding_strategy").where(`bidding_strategy.id = ${lit.id(a.bidding_strategy_id)}`).limit(1), { maxRows: 1 });
    if (!r) {
      const shared = await readTarget(ads, a.bidding_strategy_id);
      return { found: false, shared_owner: shared?.owner_customer_id ?? null, strategy: null, campaigns: [] as { id: string; name: string | null }[] };
    }
    const rnS = str(r, "bidding_strategy.resource_name") ?? rn(ads, "biddingStrategies", a.bidding_strategy_id);
    const users = await ads.query(new Gaql().select("campaign.id", "campaign.name").from("campaign").where(`campaign.bidding_strategy = ${lit.str(rnS)}`).where("campaign.status != 'REMOVED'").orderBy("campaign.id"), { maxRows: 5000 });
    return {
      found: true,
      shared_owner: null,
      strategy: { rn: rnS, name: str(r, "bidding_strategy.name"), type: str(r, "bidding_strategy.type"), status: str(r, "bidding_strategy.status"), non_removed_campaign_count: pick(r, "bidding_strategy.non_removed_campaign_count") === undefined ? 0 : num(pick(r, "bidding_strategy.non_removed_campaign_count")) },
      campaigns: users.map((u) => ({ id: String(pick(u, "campaign.id") ?? ""), name: str(u, "campaign.name") })),
    };
  },
  build: (a, s) => {
    if (!s.strategy) {
      if (s.shared_owner) throw new ToolError("invalid_argument", `Bid strategy ${a.bidding_strategy_id} is owned by manager account ${s.shared_owner} and shared with this account; it can only be removed there.`);
      throw new ToolError("not_found", `No portfolio bid strategy ${a.bidding_strategy_id} in this account.`);
    }
    if (s.strategy.status === "REMOVED") throw new ToolError("invalid_argument", "Nothing would change: the bid strategy is already removed.");
    if (s.campaigns.length || s.strategy.non_removed_campaign_count > 0) {
      const list = s.campaigns.slice(0, 10).map((c) => `"${c.name ?? c.id}" (${c.id})`).join(", ");
      throw new ToolError("invalid_argument", `Bid strategy "${s.strategy.name}" is still used by ${Math.max(s.campaigns.length, s.strategy.non_removed_campaign_count)} campaign(s)${list ? `: ${list}` : ""}. Move them to another strategy with assign_bid_strategy first.`);
    }
    return {
      summary: `Remove portfolio bid strategy "${s.strategy.name}" (${s.strategy.type}, id ${a.bidding_strategy_id}). No campaign uses it.`,
      changes: [change({ resource: "bidding_strategy", id: a.bidding_strategy_id, name: s.strategy.name }, "status", s.strategy.status, "REMOVED", "remove", "status")],
      ops: [{ biddingStrategyOperation: { remove: s.strategy.rn } }],
    };
  },
  landed: (_a, _b, after) => !after.strategy || after.strategy.status === "REMOVED",
  result: (a, after, _res, before) => ({ bidding_strategy_id: a.bidding_strategy_id, name: before.strategy?.name ?? null, status: after.strategy?.status ?? "REMOVED" }),
});

export const biddingPortfolioTools = [listBidStrategies, createBidStrategy, assignBidStrategy, removeBidStrategy];
