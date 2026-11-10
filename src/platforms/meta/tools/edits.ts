import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { type Change, moneyChange, statusChange, textChange } from "../../../policy/change-set";
import { canonicalJson } from "../../../security/canonical";
import { type MetaAdsClient, type MetaRow, currencyOffset, fromMinor, toMinor } from "../client";
import { EDGE_CAP, accountId, metaId, metaWrite, s } from "./common";
import { metaStateWrite, stateDef } from "./write-kit";

/*
 * Meta edits through approval, checked against the Marketing API v27 reference on 2026-11-05:
 * - Campaign update (POST /{campaign_id}): name, status, daily_budget / lifetime_budget (campaign budget = Advantage campaign
 *   budget), spend_cap (int64 in the currency's subunit, minimum USD 100 or local equivalent; 922337203685478 removes it),
 *   bid_strategy. Switching a campaign to COST_CAP or LOWEST_COST_WITH_BID_CAP needs adset_bid_amounts, and
 *   LOWEST_COST_WITH_MIN_ROAS cannot be switched (Advantage Campaign Budget guide), so only a switch to LOWEST_COST_WITHOUT_CAP
 *   is offered. Campaign stop_time is read-only ("At the campaign level, stop_time is a read only field. You can setup stop_time
 *   at the ad set level"), so it is not offered.
 * - Ad set update (POST /{ad_set_id}): name, status, daily_budget, lifetime_budget, bid_amount, bid_strategy, end_time.
 *   "If you enable Campaign Budget Optimization, set bid_strategy at the parent campaign level." Lowering a budget must stay at
 *   least 10% above the amount already spent (Meta rejects it otherwise). v27 does not return meta_moment_maker_spec and rejects
 *   it on writes: it is never read or sent. Targeting is not offered: the reference shows `targeting` sent as a whole object but
 *   does not state whether an update replaces or merges it.
 * - Ad update (POST /{ad_id}): name and status. A creative cannot be edited in place.
 * - Campaign copy (POST /{campaign_id}/copies): deep_copy, rename_options {rename_strategy, rename_prefix, rename_suffix},
 *   status_option {ACTIVE, PAUSED, INHERITED_FROM_SOURCE}; returns {copied_campaign_id, ad_object_ids}. A synchronous deep copy
 *   may copy at most 3 ads ("3 for a synchronous call and 51 for an asynchronous call"); this server only makes synchronous copies.
 * Every write is one POST, sent once and never retried; the live state read back decides whether it landed.
 */

const NO_SPEND_CAP = "922337203685478";
const nameInput = z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters or line breaks");
const statusInput = z.enum(["ACTIVE", "PAUSED"]);
const amount = z.number().positive().max(100_000_000).describe("In the account's currency.");
const int = (v: unknown): number | null => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const positiveBudget = (v: number | null) => (v !== null && v > 0 ? v : null);

/** Money in a change set: account currency units, compared without float drift. */
function money(ref: { resource: string; id: string; name?: string | null }, field: string, beforeMinor: number | null, afterMinor: number, currency: string | null): Change {
  const off = currencyOffset(currency);
  if (off === null) throw new ToolError("internal", "The account's currency is unknown, so amounts cannot be shown.");
  return moneyChange(ref, field, beforeMinor === null ? null : Math.round((beforeMinor / off) * 1e6), Math.round((afterMinor / off) * 1e6));
}
/** Units to Meta's minor unit; refuses amounts that round to nothing. */
function minor(units: number, currency: string | null, field: string): number {
  const v = toMinor(units, currency);
  if (v <= 0) throw new ToolError("invalid_argument", `${field} is too small for this currency.`);
  return v;
}
/** Reads an owned object; null when it is missing or belongs to another ad account (never throws for those, so verify can use it). */
async function readOwned(m: MetaAdsClient, id: string, fields: string[], label: string): Promise<MetaRow | null> {
  try {
    return await m.getOwned(id, fields, label);
  } catch (e) {
    if (e instanceof ToolError && e.code === "not_found") return null;
    throw e;
  }
}
const editable = (status: string | null, label: string) => {
  if (status !== "ACTIVE" && status !== "PAUSED") throw new ToolError("invalid_argument", `The ${label} is ${String(status).toLowerCase()} and cannot be edited.`);
};
const nothing = () => new ToolError("invalid_argument", "Nothing would change: every requested value is already set.");

// ------------------------------------------------------------------------------------------------- update_meta_campaign
const CAMPAIGN_STRATEGIES = ["LOWEST_COST_WITHOUT_CAP"] as const;

async function readCampaign(m: MetaAdsClient, id: string) {
  const r = await readOwned(m, id, ["id", "name", "status", "daily_budget", "lifetime_budget", "spend_cap", "bid_strategy"], "campaign");
  if (!r) return { exists: false as const };
  const cap = s(r, "spend_cap");
  return {
    exists: true as const,
    currency: m.currency,
    name: s(r, "name"),
    status: s(r, "status"),
    daily_budget: positiveBudget(int(r.daily_budget)),
    lifetime_budget: positiveBudget(int(r.lifetime_budget)),
    spend_cap: cap === null || cap === "0" || cap === NO_SPEND_CAP ? null : int(cap),
    bid_strategy: s(r, "bid_strategy"),
  };
}
type CampaignState = Awaited<ReturnType<typeof readCampaign>>;

export const campaignFields = {
    account_id: accountId,
    campaign_id: metaId,
    name: nameInput.optional(),
    status: statusInput.optional().describe("ACTIVE is high impact: it can start spend."),
    daily_budget: amount.optional().describe("Only for a campaign that already uses a daily campaign budget."),
    lifetime_budget: amount.optional().describe("Only for a campaign that already uses a lifetime campaign budget."),
    spend_cap: z.union([amount, z.literal("remove")]).optional().describe('New spend cap in the account currency, or "remove" to remove the cap.'),
    bid_strategy: z.enum(CAMPAIGN_STRATEGIES).optional().describe("Only LOWEST_COST_WITHOUT_CAP, and only on a campaign budget; other switches need per-ad-set bids."),
};
type Fields = Record<string, unknown>;
const oneBudget = (v: Fields) => !(v.daily_budget !== undefined && v.lifetime_budget !== undefined);
const someField = (keys: string[]) => (v: Fields) => keys.some((k) => v[k] !== undefined);
/** Builds an edit input from a subset of the fields above, with the shared checks. */
export const editInput = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .refine(oneBudget, "give daily_budget or lifetime_budget, not both")
    .refine(someField(Object.keys(shape).filter((k) => !k.endsWith("_id"))), "give at least one field to change");
const campaignInput = editInput(campaignFields);
type CampaignIn = z.infer<typeof campaignInput>;

type Ref = { resource: string; id: string; name: string | null };
type Diff = { params: Record<string, string>; changes: Change[] };

/** Name and status: send only what differs. Shared by the campaign, ad set and ad updaters. */
function diffNameStatus(a: { name?: string; status?: string }, st: { name: string | null; status: string | null }, ref: Ref, params: Diff["params"], changes: Diff["changes"]) {
  if (a.name !== undefined && a.name !== st.name) (params.name = a.name), changes.push(textChange(ref, "name", st.name, a.name));
  if (a.status !== undefined && a.status !== st.status) (params.status = a.status), changes.push(statusChange(ref, st.status!, a.status));
}

/**
 * Daily or lifetime budget on the object that owns it. `notOwner` is the refusal when this object does not own the budget
 * (null when it does). Switching between daily and lifetime is refused.
 */
function diffBudgets(
  a: { daily_budget?: number; lifetime_budget?: number },
  st: { currency: string | null; daily_budget: number | null; lifetime_budget: number | null },
  ref: Ref,
  params: Diff["params"],
  changes: Diff["changes"],
  label: string,
  notOwner: string | null,
) {
  for (const f of ["daily_budget", "lifetime_budget"] as const) {
    if (a[f] === undefined) continue;
    if (notOwner) throw new ToolError("invalid_argument", notOwner);
    if (st[f] === null) throw new ToolError("invalid_argument", `This ${label} uses a ${f === "daily_budget" ? "lifetime" : "daily"} budget. Switching budget type is not supported here.`);
    const v = minor(a[f]!, st.currency, f);
    if (v !== st[f]) (params[f] = String(v)), changes.push(money(ref, f, st[f], v, st.currency));
  }
}

const sameNameStatus = (a: { name?: string; status?: string }, after: { name: string | null; status: string | null }) => (a.name === undefined || after.name === a.name) && (a.status === undefined || after.status === a.status);
/** landed(): name, status and budgets read back as requested. */
const landedCommon = (a: { name?: string; status?: string; daily_budget?: number; lifetime_budget?: number }, after: { name: string | null; status: string | null; daily_budget: number | null; lifetime_budget: number | null }, cur: string | null) =>
  sameNameStatus(a, after) && (a.daily_budget === undefined || after.daily_budget === toMinor(a.daily_budget, cur)) && (a.lifetime_budget === undefined || after.lifetime_budget === toMinor(a.lifetime_budget, cur));

function campaignPlan(a: CampaignIn, st: CampaignState) {
  if (!st.exists) throw new ToolError("not_found", `No campaign ${a.campaign_id} in this ad account.`);
  editable(st.status, "campaign");
  const cur = st.currency;
  const ref = { resource: "campaign", id: a.campaign_id, name: st.name };
  const params: Record<string, string> = {};
  const changes: Change[] = [];
  const cbo = st.daily_budget !== null || st.lifetime_budget !== null;
  diffNameStatus(a, st, ref, params, changes);
  diffBudgets(a, st, ref, params, changes, "campaign", cbo ? null : "This campaign does not use a campaign budget: its budgets are on the ad sets. Use update_meta_ad_set.");
  if (a.spend_cap === "remove") {
    if (st.spend_cap !== null) {
      params.spend_cap = NO_SPEND_CAP;
      changes.push({ ...ref, field: "spend_cap", before: st.spend_cap / currencyOffset(cur)!, after: null, unit: "currency", effect: "increase_spend" }); // no cap: more can be spent
    }
  } else if (a.spend_cap !== undefined) {
    if (cur?.toUpperCase() === "USD" && a.spend_cap < 100) throw new ToolError("invalid_argument", "Meta's minimum campaign spend cap is USD 100.");
    const v = minor(a.spend_cap, cur, "spend_cap");
    if (v !== st.spend_cap) {
      params.spend_cap = String(v);
      // A first cap limits spend; otherwise a higher cap allows more and a lower one less.
      const c = money(ref, "spend_cap", st.spend_cap, v, cur);
      changes.push(st.spend_cap === null ? { ...c, effect: "decrease_spend" } : c);
    }
  }
  if (a.bid_strategy !== undefined && a.bid_strategy !== st.bid_strategy) {
    if (!cbo) throw new ToolError("invalid_argument", "Without a campaign budget, the bid strategy is set on each ad set. Use update_meta_ad_set.");
    if (st.bid_strategy === "LOWEST_COST_WITH_MIN_ROAS") throw new ToolError("invalid_argument", "Meta does not allow switching a LOWEST_COST_WITH_MIN_ROAS campaign to another bid strategy.");
    params.bid_strategy = a.bid_strategy;
    changes.push({ ...ref, field: "bid_strategy", before: st.bid_strategy, after: a.bid_strategy, unit: "text", effect: "increase_spend" }); // direction unknown: the riskier reading
  }
  if (!changes.length) throw nothing();
  return { params, changes, summary: summarize("campaign", st.name, a.campaign_id, changes) };
}

const summarize = (label: string, name: string | null, id: string, changes: Change[]) => `Meta ${label} "${name ?? id}" (${id}): ${changes.map((c) => `${c.field} ${c.before ?? "none"} -> ${c.after ?? "none"}`).join("; ")}`;

export const campaignEditDef = stateDef({
  name: "update_meta_campaign",
  title: "Update Meta campaign",
  risk: "high_impact",
  description:
    'Changes one Meta campaign after human approval: name, status (ACTIVE or PAUSED), the campaign budget (daily or lifetime, only on a campaign that already uses that kind of campaign budget; budgets on ad sets are changed with update_meta_ad_set), the spend cap (set, change, or "remove"), or the bid strategy (to LOWEST_COST_WITHOUT_CAP only, on a campaign budget). Only fields that differ are sent, in one request. Activating, raising a budget, raising or removing the spend cap and changing the bid strategy are high impact; pausing, lowering, setting a first cap and renaming do not. End dates are set on ad sets. Amounts are in the account currency. Deleted or archived campaigns are refused. Confirmed by re-reading the campaign; never retried automatically.',
  input: campaignInput,
  output: z.object({ campaign_id: z.string(), name: z.string().nullable(), status: z.string().nullable(), daily_budget: z.number().nullable(), lifetime_budget: z.number().nullable(), spend_cap: z.number().nullable(), bid_strategy: z.string().nullable() }),
  read: (a, m) => readCampaign(m, a.campaign_id),
  build: (a, st) => {
    const p = campaignPlan(a, st);
    return { summary: p.summary, changes: p.changes, post: { path: a.campaign_id, params: p.params } };
  },
  landed: (a, before, after) => {
    if (!after.exists || !before.exists) return false;
    const cur = before.currency;
    return (
      landedCommon(a, after, cur) &&
      (a.spend_cap === undefined || after.spend_cap === (a.spend_cap === "remove" ? null : toMinor(a.spend_cap, cur))) &&
      (a.bid_strategy === undefined || after.bid_strategy === a.bid_strategy)
    );
  },
  result: (a, after) => {
    if (!after.exists) throw new ToolError("internal", "The campaign could not be read back.");
    return { campaign_id: a.campaign_id, name: after.name, status: after.status, daily_budget: fromMinor(after.daily_budget, after.currency), lifetime_budget: fromMinor(after.lifetime_budget, after.currency), spend_cap: fromMinor(after.spend_cap, after.currency), bid_strategy: after.bid_strategy };
  },
});
export const updateMetaCampaign = metaStateWrite(campaignEditDef);

// --------------------------------------------------------------------------------------------------- update_meta_ad_set
const ADSET_STRATEGIES = ["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP"] as const;
const BID_STRATEGIES_WITH_AMOUNT = new Set(["LOWEST_COST_WITH_BID_CAP", "COST_CAP"]);

/** Meta returns times like 2026-12-01T00:00:00-0500; Unix seconds compare reliably. */
export const epoch = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "" || v === "0" || v === 0) return null;
  const t = Date.parse(String(v).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

async function readAdSet(m: MetaAdsClient, id: string) {
  const r = await readOwned(m, id, ["id", "name", "status", "campaign_id", "daily_budget", "lifetime_budget", "bid_amount", "bid_strategy", "start_time", "end_time"], "ad set");
  if (!r) return { exists: false as const };
  const camp = await readOwned(m, String(r.campaign_id ?? ""), ["id", "daily_budget", "lifetime_budget"], "campaign");
  return {
    exists: true as const,
    currency: m.currency,
    name: s(r, "name"),
    status: s(r, "status"),
    campaign_budget: camp !== null && (positiveBudget(int(camp.daily_budget)) !== null || positiveBudget(int(camp.lifetime_budget)) !== null),
    daily_budget: positiveBudget(int(r.daily_budget)),
    lifetime_budget: positiveBudget(int(r.lifetime_budget)),
    bid_amount: int(r.bid_amount),
    bid_strategy: s(r, "bid_strategy"),
    start_time: epoch(r.start_time),
    end_time: epoch(r.end_time),
  };
}
type AdSetState = Awaited<ReturnType<typeof readAdSet>>;

const isoTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?([+-]\d{2}:?\d{2}|Z)$/, "an ISO 8601 date-time with a time zone, e.g. 2026-12-31T23:59:00-05:00")
  .refine((v) => epoch(v) !== null, "not a real date-time");

export const adSetFields = {
    account_id: accountId,
    ad_set_id: metaId,
    name: nameInput.optional(),
    status: statusInput.optional().describe("ACTIVE is high impact."),
    daily_budget: amount.optional().describe("Only for an ad set that owns a daily budget (not under a campaign budget)."),
    lifetime_budget: amount.optional().describe("Only for an ad set that owns a lifetime budget (not under a campaign budget)."),
    bid_amount: amount.optional().describe("Bid cap or cost cap, in the account currency. Only with LOWEST_COST_WITH_BID_CAP or COST_CAP."),
    bid_strategy: z.enum(ADSET_STRATEGIES).optional().describe("Not on ad sets under a campaign budget (set it on the campaign). Cap strategies need a bid_amount."),
    end_time: isoTime.optional().describe("New end, in the future and after the start. A later end is high impact; an earlier one does not."),
};
const adSetInput = editInput(adSetFields);
type AdSetIn = z.infer<typeof adSetInput>;

function adSetPlan(a: AdSetIn, st: AdSetState, now: number) {
  if (!st.exists) throw new ToolError("not_found", `No ad set ${a.ad_set_id} in this ad account.`);
  editable(st.status, "ad set");
  const cur = st.currency;
  const ref = { resource: "ad_set", id: a.ad_set_id, name: st.name };
  const params: Record<string, string> = {};
  const changes: Change[] = [];
  diffNameStatus(a, st, ref, params, changes);
  diffBudgets(a, st, ref, params, changes, "ad set", st.campaign_budget ? "This ad set is under a campaign budget: change the budget with update_meta_campaign." : null);
  const strategy = a.bid_strategy ?? st.bid_strategy;
  if (a.bid_strategy !== undefined && a.bid_strategy !== st.bid_strategy) {
    if (st.campaign_budget) throw new ToolError("invalid_argument", "This ad set is under a campaign budget: Meta sets the bid strategy on the campaign.");
    if (st.bid_strategy === "LOWEST_COST_WITH_MIN_ROAS") throw new ToolError("invalid_argument", "Meta does not allow switching away from LOWEST_COST_WITH_MIN_ROAS.");
    if (BID_STRATEGIES_WITH_AMOUNT.has(a.bid_strategy) && a.bid_amount === undefined && st.bid_amount === null) throw new ToolError("invalid_argument", `${a.bid_strategy} needs a bid_amount.`);
    params.bid_strategy = a.bid_strategy;
    changes.push({ ...ref, field: "bid_strategy", before: st.bid_strategy, after: a.bid_strategy, unit: "text", effect: "increase_spend" }); // direction unknown: the riskier reading
  }
  if (a.bid_amount !== undefined) {
    if (!strategy || !BID_STRATEGIES_WITH_AMOUNT.has(strategy)) throw new ToolError("invalid_argument", `A bid_amount applies only with LOWEST_COST_WITH_BID_CAP or COST_CAP (this ad set uses ${strategy ?? "no bid strategy"}).`);
    const v = minor(a.bid_amount, cur, "bid_amount");
    if (v !== st.bid_amount) (params.bid_amount = String(v)), changes.push(money(ref, "bid_amount", st.bid_amount, v, cur));
  }
  if (a.end_time !== undefined) {
    const t = epoch(a.end_time)!;
    if (t <= now) throw new ToolError("invalid_argument", "end_time must be in the future.");
    if (st.start_time !== null && t <= st.start_time) throw new ToolError("invalid_argument", "end_time must be after the ad set's start time.");
    if (t !== st.end_time) {
      params.end_time = String(t);
      // A later (or newly set beyond an open run) end keeps delivering longer; an earlier one stops it sooner.
      const later = st.end_time === null || t > st.end_time;
      changes.push({ ...ref, field: "end_time", before: st.end_time === null ? null : new Date(st.end_time * 1000).toISOString(), after: new Date(t * 1000).toISOString(), unit: "text", effect: st.end_time !== null && later ? "enable" : "pause" });
    }
  }
  if (!changes.length) throw nothing();
  return { params, changes, summary: summarize("ad set", st.name, a.ad_set_id, changes) };
}

export const adSetEditDef = stateDef({
  name: "update_meta_ad_set",
  title: "Update Meta ad set",
  risk: "high_impact",
  description:
    "Changes one Meta ad set after human approval: name, status (ACTIVE or PAUSED), its own budget (daily or lifetime, only when the ad set owns the budget and keeps the same type; ad sets under a campaign budget are refused), bid strategy (LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP or COST_CAP; not under a campaign budget; cap strategies need a bid amount), bid amount (with a cap strategy), and end time (future, after the start). Only fields that differ are sent, in one request. Activating, raising a budget or bid, changing the bid strategy and moving the end later are high impact; pausing, lowering, renaming, setting an end on an open-ended ad set and moving the end earlier do not. Meta rejects budget cuts below 110% of what was already spent. Targeting cannot be edited with this tool. Amounts are in the account currency. Confirmed by re-reading the ad set; never retried automatically.",
  input: adSetInput,
  output: z.object({ ad_set_id: z.string(), name: z.string().nullable(), status: z.string().nullable(), daily_budget: z.number().nullable(), lifetime_budget: z.number().nullable(), bid_amount: z.number().nullable(), bid_strategy: z.string().nullable(), end_time: z.string().nullable() }),
  read: (a, m) => readAdSet(m, a.ad_set_id),
  build: (a, st) => {
    const p = adSetPlan(a, st, Math.floor(Date.now() / 1000));
    return { summary: p.summary, changes: p.changes, post: { path: a.ad_set_id, params: p.params } };
  },
  landed: (a, before, after) => {
    if (!after.exists || !before.exists) return false;
    const cur = before.currency;
    return (
      landedCommon(a, after, cur) &&
      (a.bid_amount === undefined || after.bid_amount === toMinor(a.bid_amount, cur)) &&
      (a.bid_strategy === undefined || after.bid_strategy === a.bid_strategy) &&
      (a.end_time === undefined || after.end_time === epoch(a.end_time))
    );
  },
  result: (a, after) => {
    if (!after.exists) throw new ToolError("internal", "The ad set could not be read back.");
    return { ad_set_id: a.ad_set_id, name: after.name, status: after.status, daily_budget: fromMinor(after.daily_budget, after.currency), lifetime_budget: fromMinor(after.lifetime_budget, after.currency), bid_amount: fromMinor(after.bid_amount, after.currency), bid_strategy: after.bid_strategy, end_time: after.end_time === null ? null : new Date(after.end_time * 1000).toISOString() };
  },
});
export const updateMetaAdSet = metaStateWrite(adSetEditDef);

// ------------------------------------------------------------------------------------------------------- update_meta_ad
async function readAd(m: MetaAdsClient, id: string) {
  const r = await readOwned(m, id, ["id", "name", "status"], "ad");
  return r ? { exists: true as const, name: s(r, "name"), status: s(r, "status") } : { exists: false as const };
}

export const adFields = { account_id: accountId, ad_id: metaId, name: nameInput.optional(), status: statusInput.optional() };
export const adEditDef = stateDef({
  name: "update_meta_ad",
  title: "Update Meta ad",
  risk: "high_impact",
  description:
    "Renames one Meta ad or changes its status (ACTIVE or PAUSED) after human approval. Activating is high impact; pausing and renaming do not. The creative (image, video, text, link) cannot be edited in place: Meta requires a new creative and a new ad, which the creation tools handle. Deleted or archived ads are refused. Confirmed by re-reading the ad; never retried automatically.",
  input: editInput(adFields),
  output: z.object({ ad_id: z.string(), name: z.string().nullable(), status: z.string().nullable() }),
  read: (a, m) => readAd(m, a.ad_id),
  build: (a, st) => {
    if (!st.exists) throw new ToolError("not_found", `No ad ${a.ad_id} in this ad account.`);
    editable(st.status, "ad");
    const ref = { resource: "ad", id: a.ad_id, name: st.name };
    const params: Record<string, string> = {};
    const changes: Change[] = [];
    diffNameStatus(a, st, ref, params, changes);
    if (!changes.length) throw nothing();
    return { summary: summarize("ad", st.name, a.ad_id, changes), changes, post: { path: a.ad_id, params } };
  },
  landed: (a, _b, after) => after.exists && sameNameStatus(a, after),
  result: (a, after) => ({ ad_id: a.ad_id, name: after.exists ? after.name : null, status: after.exists ? after.status : null }),
});
export const updateMetaAd = metaStateWrite(adEditDef);

// ----------------------------------------------------------------------------------------------- duplicate_meta_campaign
/** Most ads a synchronous deep copy may include (Campaign copies reference). */
export const SYNC_COPY_MAX_ADS = 3;

/** Ids of this account's campaigns copied from `source` (Campaign field source_campaign_id). Sorted, for a stable snapshot. */
async function copiesOf(m: MetaAdsClient, source: string): Promise<string[]> {
  const rows = await m.list(`${m.adAccountId}/campaigns`, { fields: "id,source_campaign_id" }, EDGE_CAP);
  return rows.filter((r) => String(r.source_campaign_id ?? "") === source).map((r) => String(r.id)).sort();
}

const dupInput = z.object({
  account_id: accountId,
  campaign_id: metaId,
  deep_copy: z.boolean().default(false).describe(`Also copy the ad sets and ads (at most ${SYNC_COPY_MAX_ADS} ads, Meta's limit for a synchronous copy).`),
  rename_suffix: z.string().trim().min(1).max(50).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters").optional().describe('Appended to the copy\'s name. Default: Meta\'s localized " - Copy".'),
});
type DupSnap = { source: { name: string | null; status: string | null }; existing_copies: string[]; ads: number | null };

async function dupState(m: MetaAdsClient, a: z.infer<typeof dupInput>): Promise<DupSnap> {
  const src = await m.getOwned(a.campaign_id, ["id", "name", "status"], "campaign");
  const ads = a.deep_copy ? (await m.list(`${a.campaign_id}/ads`, { fields: "id" }, EDGE_CAP)).length : null;
  return { source: { name: s(src, "name"), status: s(src, "status") }, existing_copies: await copiesOf(m, a.campaign_id), ads };
}

export const duplicateMetaCampaign = metaWrite({
  name: "duplicate_meta_campaign",
  title: "Duplicate Meta campaign",
  risk: "high_impact",
  description: `Copies one Meta campaign after a person approves it (POST /{campaign}/copies). The copy is always created PAUSED, so it spends nothing until someone activates it. With deep_copy the ad sets and ads are copied too, up to ${SYNC_COPY_MAX_ADS} ads (Meta's limit for a synchronous copy; larger copies are refused rather than started in the background). An optional suffix is added to the copy's name. The copy is confirmed by reading it back; if Meta returns no copy id the result is reported as unknown and is never retried automatically. Deleted campaigns cannot be copied.`,
  input: dupInput,
  output: z.object({ source_campaign_id: z.string(), copied_campaign_id: z.string(), status: z.string().nullable(), copied_objects: z.number().describe("Objects Meta reports as copied (campaign, ad sets, ads, creatives).") }),
  plan: async (a, ctx) => {
    const m = ctx.services.meta;
    const snap = await dupState(m, a);
    if (snap.source.status === "DELETED") throw new ToolError("invalid_argument", "A deleted campaign cannot be copied.");
    if (snap.ads !== null && snap.ads > SYNC_COPY_MAX_ADS) throw new ToolError("invalid_argument", `The campaign has ${snap.ads} ads. Meta copies at most ${SYNC_COPY_MAX_ADS} ads in one synchronous request; copy without deep_copy, or copy ad sets separately.`);
    const name = snap.source.name;
    return {
      summary: `Copy Meta campaign "${name ?? a.campaign_id}" (${a.campaign_id})${a.deep_copy ? " with its ad sets and ads" : " (campaign only)"}, created PAUSED${a.rename_suffix ? `, name suffix "${a.rename_suffix}"` : ""}`,
      snapshot: snap,
      changes: [{ resource: "campaign", id: "new", name: name ? `${name}${a.rename_suffix ?? " - Copy"}` : null, field: "copy_of", before: null, after: a.campaign_id, unit: "text", effect: "create" }],
    };
  },
  execute: async (a, ctx, run) => {
    const m = ctx.services.meta;
    const now = await dupState(m, a);
    if (canonicalJson(now) !== canonicalJson(run.snapshot)) throw new ToolError("conflict", "The campaign or its copies changed since this was requested. Nothing was copied; request it again.");
    const params: Record<string, string> = { deep_copy: String(a.deep_copy), status_option: "PAUSED" };
    if (a.rename_suffix) params.rename_options = JSON.stringify({ rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: a.rename_suffix });
    const res = await m.post<{ copied_campaign_id?: string; ad_object_ids?: unknown[] }>(`${a.campaign_id}/copies`, params);
    const id = res?.copied_campaign_id ? String(res.copied_campaign_id) : null;
    if (!id) throw new ToolError("unknown_outcome", "Meta accepted the copy request but returned no copied_campaign_id. The copy may still appear: check list_meta_campaigns before requesting it again. It will not be retried automatically.");
    const copy = await readOwned(m, id, ["id", "status", "source_campaign_id"], "campaign");
    if (!copy) throw new ToolError("unknown_outcome", `Meta returned copy ${id}, but it cannot be read back in this ad account yet.`);
    return { source_campaign_id: a.campaign_id, copied_campaign_id: id, status: s(copy, "status"), copied_objects: Array.isArray(res.ad_object_ids) ? res.ad_object_ids.length : 1 };
  },
  verify: async (a, ctx, run) => {
    // After a crash the copy id is lost; the copy is found through source_campaign_id: exactly one new copy since planning.
    const before = new Set((run.snapshot as DupSnap).existing_copies);
    const fresh = (await copiesOf(ctx.services.meta, a.campaign_id)).filter((id) => !before.has(id));
    if (fresh.length === 1) return { outcome: "applied" };
    if (fresh.length === 0) return { outcome: "not_applied" };
    return { outcome: "indeterminate", detail: `${fresh.length} new copies of the campaign appeared; check them before copying again.` };
  },
});

export const editTools = [updateMetaCampaign, updateMetaAdSet, updateMetaAd, duplicateMetaCampaign];
