import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change, Effect } from "../../../policy/change-set";
import { canonicalJson } from "../../../security/canonical";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, isRealDate, lit, num, pick } from "../gaql";
import { nowIn } from "./bidding-adjustments";
import { tailId } from "./campaign-reads";
import { accountId, googleRead, googleWrite, idSchema, str } from "./common";
import { rn, stateWrite } from "./write-kit";

/**
 * Campaign experiments (Experiment + ExperimentArm), following the v26 guides
 * developers.google.com/google-ads/api/docs/experiments/overview, .../system-managed and .../async-errors:
 *  - create the Experiment (status SETUP, a suffix), then all arms in ONE ExperimentArmService request: exactly one control
 *    arm naming the base campaign, a treatment arm for which Google creates an in-design (draft) copy of the campaign,
 *    traffic splits summing to 100. Partial failure is not allowed for arms;
 *  - make at least one change to the in-design campaign, then ScheduleExperiment (long-running: materializes the
 *    in-design campaign, status INITIATED until done, then ENABLED);
 *  - EndExperiment (synchronous, HALTED) or PromoteExperiment (long-running: copies the treatment's changes onto the base
 *    campaign; promote_status tracks it). PMAX_REPLACEMENT_SHOPPING experiments cannot be promoted.
 * Draft and in-design campaigns are only returned by GAQL with PARAMETERS include_drafts = true.
 */

const change = (ref: { resource: string; id: string; name?: string | null }, field: string, before: string | number | null, after: string | number | null, effect: Effect, unit: Change["unit"] = "text"): Change => ({ ...ref, field, before, after, unit, effect });

/** System-managed types this server creates. HOTEL_CUSTOM and YOUTUBE_CUSTOM need Hotel/Video campaigns, which are out of scope. */
const CREATE_TYPES = ["SEARCH_CUSTOM", "DISPLAY_CUSTOM"] as const;
const CHANNEL_OF: Record<(typeof CREATE_TYPES)[number], string> = { SEARCH_CUSTOM: "SEARCH", DISPLAY_CUSTOM: "DISPLAY" };
const STATUSES = ["SETUP", "INITIATED", "ENABLED", "HALTED", "PROMOTED", "GRADUATED", "REMOVED"] as const;

const EXP_FIELDS = ["experiment.resource_name", "experiment.experiment_id", "experiment.name", "experiment.description", "experiment.type", "experiment.status", "experiment.promote_status", "experiment.start_date", "experiment.end_date", "experiment.suffix", "experiment.sync_enabled", "experiment.long_running_operation"];

const armSchema = z.object({
  arm_id: z.string(),
  name: z.string().nullable(),
  control: z.boolean(),
  traffic_split: z.number().nullable().describe("Percent of traffic."),
  campaign_ids: z.array(z.string()).describe("Control: the base campaign. Treatment: the experiment (trial) campaign once scheduled."),
  in_design_campaign_ids: z.array(z.string()).describe("Treatment arm: the editable draft copy before scheduling."),
});
type Arm = z.infer<typeof armSchema>;
const experimentSchema = z.object({
  experiment_id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  type: z.string().nullable(),
  status: z.string().nullable(),
  promote_status: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  suffix: z.string().nullable(),
  sync_enabled: z.boolean().nullable(),
  long_running_operation: z.string().nullable().describe("The latest schedule or promote operation."),
  base_campaign_id: z.string().nullable().describe("The control arm's campaign."),
  arms: z.array(armSchema),
});
type Experiment = z.infer<typeof experimentSchema>;

const ids = (v: unknown) => ((v as unknown[] | undefined) ?? []).map((x) => tailId(x) ?? String(x));
function toArm(r: Row): Arm {
  const res = str(r, "experiment_arm.resource_name") ?? "";
  const tf = pick(r, "experiment_arm.traffic_split");
  return {
    arm_id: res.split("~").pop() ?? res,
    name: str(r, "experiment_arm.name"),
    control: pick(r, "experiment_arm.control") === true,
    traffic_split: tf === undefined || tf === null ? null : num(tf),
    campaign_ids: ids(pick(r, "experiment_arm.campaigns")),
    in_design_campaign_ids: ids(pick(r, "experiment_arm.in_design_campaigns")),
  };
}
function toExperiment(r: Row, arms: Arm[]): Experiment {
  const sync = pick(r, "experiment.sync_enabled");
  return {
    experiment_id: String(pick(r, "experiment.experiment_id") ?? ""),
    name: str(r, "experiment.name"),
    description: str(r, "experiment.description"),
    type: str(r, "experiment.type"),
    status: str(r, "experiment.status"),
    promote_status: str(r, "experiment.promote_status"),
    start_date: str(r, "experiment.start_date"),
    end_date: str(r, "experiment.end_date"),
    suffix: str(r, "experiment.suffix"),
    sync_enabled: typeof sync === "boolean" ? sync : null,
    long_running_operation: str(r, "experiment.long_running_operation"),
    base_campaign_id: arms.find((x) => x.control)?.campaign_ids[0] ?? null,
    arms: [...arms].sort((x, y) => Number(y.control) - Number(x.control) || x.arm_id.localeCompare(y.arm_id)),
  };
}

/** Arms of the given experiments (resource names), with in-design campaigns (include_drafts). */
async function armsOf(ads: GoogleAdsClient, experimentRns: string[]): Promise<Map<string, Arm[]>> {
  const out = new Map<string, Arm[]>();
  if (!experimentRns.length) return out;
  const rows = await ads.query(
    new Gaql()
      .select("experiment_arm.resource_name", "experiment_arm.experiment", "experiment_arm.name", "experiment_arm.control", "experiment_arm.traffic_split", "experiment_arm.campaigns", "experiment_arm.in_design_campaigns")
      .from("experiment_arm")
      .where(`experiment_arm.experiment IN ${lit.list(experimentRns.map(lit.str))}`)
      .parameters("include_drafts = true"),
    { maxRows: 5000 },
  );
  for (const r of rows) {
    const e = str(r, "experiment_arm.experiment") ?? "";
    out.set(e, [...(out.get(e) ?? []), toArm(r)]);
  }
  return out;
}

/** One experiment with its arms, or null when it does not exist in this account. */
async function readExperiment(ads: GoogleAdsClient, where: string): Promise<Experiment | null> {
  const [r] = await ads.query(new Gaql().select(...EXP_FIELDS).from("experiment").where(where).orderBy("experiment.experiment_id").limit(1), { maxRows: 1 });
  if (!r) return null;
  const expRn = str(r, "experiment.resource_name") ?? rn(ads, "experiments", String(pick(r, "experiment.experiment_id")));
  return toExperiment(r, (await armsOf(ads, [expRn])).get(expRn) ?? []);
}
const byId = (ads: GoogleAdsClient, id: string) => readExperiment(ads, `experiment.experiment_id = ${lit.id(id)}`);
/** The non-removed experiment with this name (names are unique among active experiments). */
const byName = (ads: GoogleAdsClient, n: string) => readExperiment(ads, `experiment.name = ${lit.str(n)} AND experiment.status != 'REMOVED'`);

// ------------------------------------------------------------------------------------------------ list_experiments
export const listExperiments = googleRead({
  name: "list_experiments",
  title: "List experiments",
  description:
    "Lists campaign experiments: name, type (e.g. SEARCH_CUSTOM), status (SETUP = being designed, INITIATED = being scheduled, ENABLED = scheduled or running, HALTED = ended, PROMOTED, GRADUATED), promotion status, start and end dates, suffix, the base (control) campaign and each arm with its traffic split, campaigns and in-design (draft) treatment campaign. Names are untrusted text.",
  input: z.object({
    account_id: accountId,
    experiment_ids: z.array(idSchema).min(1).max(50).optional(),
    statuses: z.array(z.enum(STATUSES)).min(1).max(STATUSES.length).optional().describe("Only these statuses. Removed experiments are listed only when REMOVED is included."),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ experiments: z.array(experimentSchema), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const fetched = await ads.query(
      new Gaql()
        .select(...EXP_FIELDS)
        .from("experiment")
        .where(a.experiment_ids ? `experiment.experiment_id IN ${lit.list(a.experiment_ids.map(lit.id))}` : undefined)
        .where(a.statuses ? `experiment.status IN ${lit.list(a.statuses.map((s) => lit.enumLit(s, STATUSES)))}` : "experiment.status != 'REMOVED'")
        .orderBy("experiment.experiment_id", "DESC")
        .limit(a.limit + 1),
      { maxRows: a.limit + 1, partial: true },
    );
    const rows = fetched.slice(0, a.limit);
    const rns = rows.map((r) => str(r, "experiment.resource_name") ?? rn(ads, "experiments", String(pick(r, "experiment.experiment_id"))));
    const arms = await armsOf(ads, rns);
    const experiments = rows.map((r, i) => toExperiment(r, arms.get(rns[i]!) ?? []));
    return { experiments, returned: experiments.length, truncated: fetched.length > a.limit };
  },
});

// ------------------------------------------------------------------------------------------------ create_experiment
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").refine(isRealDate, "not a real date");
const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");
const createInput = z
  .object({
    account_id: accountId,
    name: text(1024).describe("Unique among the account's experiments."),
    type: z.enum(CREATE_TYPES).describe("SEARCH_CUSTOM for a Search base campaign, DISPLAY_CUSTOM for a Display one."),
    base_campaign_id: idSchema.describe("The control campaign the treatment is copied from."),
    // Not trimmed: Google appends it as given, so a leading space separates it from the campaign name.
    suffix: z.string().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters").refine((v) => v.trim().length > 0, "not only spaces").describe('Appended as given to the base campaign name to name the treatment campaign, e.g. " [test]".'),
    control_traffic_split: z.number().int().min(1).max(99).default(50).describe("Percent of traffic for the control (base) campaign."),
    treatment_traffic_split: z.number().int().min(1).max(99).default(50).describe("Percent for the treatment; the two must sum to 100."),
    control_arm_name: text(1024).default("Control"),
    treatment_arm_name: text(1024).default("Treatment"),
    description: text(2048).optional(),
    start_date: day.optional().describe("YYYY-MM-DD in the account's time zone, today or later and within a year. Default: when scheduled, or the campaign's start date if later."),
    end_date: day.optional().describe("YYYY-MM-DD; default: the campaign's end date."),
    sync_enabled: z.boolean().default(false).describe("Copy later changes of the base campaign to the treatment campaign. Can only be set now."),
  })
  .refine((v) => v.control_traffic_split + v.treatment_traffic_split === 100, "control_traffic_split and treatment_traffic_split must sum to 100")
  .refine((v) => v.control_arm_name !== v.treatment_arm_name, "the two arms need different names")
  .refine((v) => !v.start_date || !v.end_date || v.start_date <= v.end_date, "end_date must not be before start_date");
type CreateArgs = z.infer<typeof createInput>;

interface CreateSnapshot {
  time_zone: string | null;
  base: { id: string; name: string | null; status: string | null; channel: string | null; experiment_type: string | null; budget_shared: boolean; end_date_time: string | null };
  name_taken: string | null;
  trial_name_taken: string | null;
}
async function readCreate(a: CreateArgs, ads: GoogleAdsClient): Promise<CreateSnapshot> {
  const [c] = await ads.query(
    new Gaql().select("campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type", "campaign.experiment_type", "campaign.end_date_time", "campaign_budget.explicitly_shared").from("campaign").where(`campaign.id = ${lit.id(a.base_campaign_id)}`).limit(1),
    { maxRows: 1 },
  );
  if (!c) throw new ToolError("not_found", `No campaign ${a.base_campaign_id} in this account.`);
  const base = { id: a.base_campaign_id, name: str(c, "campaign.name"), status: str(c, "campaign.status"), channel: str(c, "campaign.advertising_channel_type"), experiment_type: str(c, "campaign.experiment_type"), budget_shared: pick(c, "campaign_budget.explicitly_shared") === true, end_date_time: str(c, "campaign.end_date_time") };
  const [tz] = await ads.query(new Gaql().select("customer.id", "customer.time_zone").from("customer").limit(1), { maxRows: 1 });
  const same = await byName(ads, a.name);
  // Google names the treatment campaign base name + suffix and rejects a name that an existing campaign already has.
  const trialName = `${base.name ?? ""}${a.suffix}`;
  const [clash] = await ads.query(new Gaql().select("campaign.id").from("campaign").where(`campaign.name = ${lit.str(trialName)}`).where("campaign.status != 'REMOVED'").limit(1), { maxRows: 1 });
  return { time_zone: tz ? str(tz, "customer.time_zone") : null, base, name_taken: same?.experiment_id ?? null, trial_name_taken: clash ? String(pick(clash, "campaign.id")) : null };
}
function planCreate(a: CreateArgs, s: CreateSnapshot): { summary: string; changes: Change[] } {
  const b = s.base;
  if (b.status === "REMOVED") throw new ToolError("invalid_argument", "The base campaign is removed.");
  if (b.experiment_type && b.experiment_type !== "BASE") throw new ToolError("invalid_argument", `Campaign ${b.id} is itself a ${b.experiment_type.toLowerCase()} campaign; use its base campaign.`);
  if (b.channel !== CHANNEL_OF[a.type]) throw new ToolError("invalid_argument", `A ${a.type} experiment needs a ${CHANNEL_OF[a.type]} campaign; campaign ${b.id} is ${b.channel}.`);
  if (b.budget_shared) throw new ToolError("invalid_argument", "The base campaign uses a shared budget, which experiments do not allow. Give it its own budget first.");
  if (s.name_taken) throw new ToolError("invalid_argument", `An experiment named "${a.name}" already exists (id ${s.name_taken}). Use another name.`);
  if (s.trial_name_taken) throw new ToolError("invalid_argument", `The treatment campaign would be named "${b.name}${a.suffix}", which campaign ${s.trial_name_taken} already uses. Use another suffix.`);
  const today = nowIn(s.time_zone).slice(0, 10);
  if (a.start_date && a.start_date < today) throw new ToolError("invalid_argument", `start_date cannot be in the past (today is ${today} in the account's time zone).`);
  if (a.start_date) {
    const limit = new Date(Date.parse(`${today}T00:00:00Z`));
    limit.setUTCFullYear(limit.getUTCFullYear() + 1);
    if (a.start_date > limit.toISOString().slice(0, 10)) throw new ToolError("invalid_argument", "start_date can be at most one year in the future.");
  }
  if (a.end_date && a.end_date < today) throw new ToolError("invalid_argument", `end_date cannot be in the past (today is ${today} in the account's time zone).`);
  const campaignEnd = b.end_date_time?.slice(0, 10) ?? null;
  if (a.end_date && campaignEnd && a.end_date > campaignEnd) throw new ToolError("invalid_argument", `The experiment must end within the base campaign's dates; the campaign ends ${campaignEnd}.`);
  const dates = `${a.start_date ?? "when scheduled"} to ${a.end_date ?? (campaignEnd ? `${campaignEnd} (campaign end)` : "no end date")}`;
  const what = `${a.type} on "${b.name}": control ${a.control_traffic_split}% / treatment ${a.treatment_traffic_split}%, treatment campaign "${b.name}${a.suffix}", ${dates}${a.sync_enabled ? ", sync on" : ""}`;
  return {
    summary: `Create experiment "${a.name}": ${what}. Google creates an editable in-design copy of the campaign for the treatment; nothing serves until schedule_experiment.`,
    changes: [change({ resource: "experiment", id: "new", name: a.name }, "experiment", null, what, "create")],
  };
}
/** The created experiment matches the request: both arms, the control on the base campaign, the requested splits. */
function createLanded(a: CreateArgs, e: Experiment | null): boolean {
  if (!e || e.type !== a.type) return false;
  const control = e.arms.find((x) => x.control);
  const treatment = e.arms.find((x) => !x.control);
  return e.arms.length === 2 && control?.campaign_ids[0] === a.base_campaign_id && control.traffic_split === a.control_traffic_split && treatment?.traffic_split === a.treatment_traffic_split;
}

/** Google Ads rejected the request outright (a 4xx), so it did not apply. Anything else may have applied. */
const REJECTED = new Set(["invalid_argument", "not_found", "conflict", "platform_permission_denied", "permission_denied", "quota_exceeded", "auth_expired", "unsupported"]);

export const createExperiment = googleWrite({
  name: "create_experiment",
  title: "Create experiment",
  // inventory/mapping.ts plans this tool as "write"; its change set marks the effect, so approvals come out high_impact.
  risk: "high_impact",
  description:
    "Creates a campaign experiment (A/B test) after approval: SEARCH_CUSTOM for a Search campaign or DISPLAY_CUSTOM for a Display one. Google copies the base campaign into an editable in-design treatment campaign and splits traffic between control and treatment (each 1-99%, summing to 100). Returns the in-design campaign id: make at least one change to it (Google requires that), then call schedule_experiment. Nothing serves until then. The base campaign must not use a shared budget. Takes two requests (the experiment, then both arms in one request, as Google's guide requires); if Google rejects the arms, the empty experiment is removed again and the result says so; an unconfirmed step is reported as unknown outcome, never as success. Confirmed by re-reading.",
  input: createInput,
  output: z.object({ experiment: experimentSchema, in_design_campaign_id: z.string().nullable(), next_step: z.string() }),
  plan: async (a, ctx) => {
    const s = await readCreate(a, ctx.services.ads);
    return { ...planCreate(a, s), snapshot: s };
  },
  verify: async (a, ctx) => {
    const e = await byName(ctx.services.ads, a.name);
    if (!e) return { outcome: "not_applied" };
    if (createLanded(a, e)) return { outcome: "applied" };
    return { outcome: "indeterminate", detail: `experiment ${e.experiment_id} exists but its arms do not match the request (${e.arms.length} arm(s))` };
  },
  execute: async (a, ctx, run) => {
    const ads = ctx.services.ads;
    const s = await readCreate(a, ads);
    if (canonicalJson(s) !== canonicalJson(run.snapshot)) throw new ToolError("conflict", "The account changed since this was requested. Nothing was applied; request the change again.");
    planCreate(a, s);
    // Step 1: the experiment, in SETUP.
    const created = await ads.mutate("experiments", [
      { create: { name: a.name, type: a.type, suffix: a.suffix, status: "SETUP", ...(a.description ? { description: a.description } : {}), ...(a.start_date ? { startDate: a.start_date } : {}), ...(a.end_date ? { endDate: a.end_date } : {}), ...(a.sync_enabled ? { syncEnabled: true } : {}) } },
    ]);
    const expRn = str(created.results[0] ?? {}, "resource_name") ?? (await byName(ads, a.name))?.experiment_id;
    if (!expRn) throw new ToolError("unknown_outcome", `Google accepted the experiment "${a.name}" but it cannot be read back. Check list_experiments before retrying.`);
    const fullRn = expRn.startsWith("customers/") ? expRn : rn(ads, "experiments", expRn);
    const expId = tailId(fullRn)!;
    // Step 2: both arms in one request (all or none; the guide forbids partial failure here).
    try {
      await ads.mutate("experimentArms", [
        { create: { experiment: fullRn, name: a.control_arm_name, control: true, campaigns: [rn(ads, "campaigns", a.base_campaign_id)], trafficSplit: String(a.control_traffic_split) } },
        { create: { experiment: fullRn, name: a.treatment_arm_name, control: false, trafficSplit: String(a.treatment_traffic_split) } },
      ]);
    } catch (e) {
      const err = e instanceof ToolError ? e : new ToolError("internal", "Unexpected error while creating the experiment arms.");
      const now = await byId(ads, expId).catch(() => undefined);
      if (!(now && createLanded(a, now))) {
        if (!REJECTED.has(err.code)) throw new ToolError("unknown_outcome", `Experiment ${expId} was created, but the request that creates its control and treatment arms has an unconfirmed outcome (${err.message}). Check list_experiments with experiment_ids [${expId}] before trying again.`);
        // Google rejected the arms, so the experiment exists without arms. Undo step 1 so the account is left as it was.
        try {
          await ads.mutate("experiments", [{ remove: fullRn }]);
        } catch (e2) {
          throw new ToolError("unknown_outcome", `Google rejected the experiment arms: ${err.message}. Experiment ${expId} was created without arms and could not be removed automatically (${(e2 as Error).message}). It is in SETUP and serves nothing; remove it in Google Ads (Experiments) before creating "${a.name}" again.`);
        }
        const left = await byId(ads, expId).catch(() => undefined);
        if (left === null || left?.status === "REMOVED") throw new ToolError(err.code, `Google rejected the experiment arms: ${err.message}. The experiment created in the first step (${expId}) was removed again, so the account is unchanged.`);
        throw new ToolError("unknown_outcome", `Google rejected the experiment arms: ${err.message}. Removing the empty experiment ${expId} was sent but is not confirmed; check list_experiments with experiment_ids [${expId}].`);
      }
    }
    const after = await byId(ads, expId);
    if (!createLanded(a, after)) throw new ToolError("unknown_outcome", `Google accepted the experiment (${expId}) and its arms, but they do not read back as requested. Check list_experiments with experiment_ids [${expId}].`);
    const inDesign = after!.arms.find((x) => !x.control)?.in_design_campaign_ids[0] ?? null;
    return {
      experiment: after!,
      in_design_campaign_id: inDesign,
      next_step: inDesign
        ? `Make at least one change to the in-design treatment campaign ${inDesign} (Google requires it), then call schedule_experiment with experiment_id ${expId}.`
        : `Google did not report an in-design campaign for the treatment arm yet; check list_experiments with experiment_ids [${expId}] before scheduling.`,
    };
  },
});

// ------------------------------------------------------------------------------------------------ lifecycle actions
interface State {
  experiment: Experiment | null;
}
const experimentInput = z.object({ account_id: accountId, experiment_id: idSchema });
const readState = async (a: { experiment_id: string }, ads: GoogleAdsClient): Promise<State> => ({ experiment: await byId(ads, a.experiment_id) });
function need(a: { experiment_id: string }, s: State): Experiment {
  if (!s.experiment) throw new ToolError("not_found", `No experiment ${a.experiment_id} in this account (list_experiments shows them).`);
  return s.experiment;
}
const ref = (e: Experiment) => ({ resource: "experiment", id: e.experiment_id, name: e.name });
const lifecycleOutput = z.object({ experiment_id: z.string(), status: z.string().nullable(), promote_status: z.string().nullable(), end_date: z.string().nullable(), long_running_operation: z.string().nullable(), state: z.string(), message: z.string() });
const opName = (responses: Row[]) => (typeof responses[0]?.name === "string" ? (responses[0].name as string) : null);

export const scheduleExperiment = stateWrite({
  name: "schedule_experiment",
  title: "Schedule experiment",
  // inventory/mapping.ts plans this tool as "write"; its change set marks the effect, so approvals come out high_impact.
  risk: "high_impact",
  description:
    "Schedules an experiment in SETUP after approval (ExperimentService.ScheduleExperiment): Google turns the in-design treatment campaign into a real experiment campaign that serves from the start date with the agreed traffic split. Google requires at least one change to the in-design campaign first. This is a long-running operation: the result reports what Google shows right after the call (INITIATED = still materializing, ENABLED = done) and never claims completion it cannot see. If materializing fails, Google lists the reasons in the experiment's asynchronous errors (Google Ads UI); list_experiments shows the status. High impact: it starts serving a new campaign.",
  input: experimentInput,
  output: lifecycleOutput,
  read: readState,
  build: (a, s, ads) => {
    const e = need(a, s);
    if (e.status === "INITIATED" || e.status === "ENABLED") throw new ToolError("invalid_argument", `Nothing would change: the experiment is already scheduled (status ${e.status}).`);
    if (e.status !== "SETUP") throw new ToolError("invalid_argument", `Only an experiment in SETUP can be scheduled; this one is ${e.status}.`);
    const treatment = e.arms.find((x) => !x.control);
    if (!e.arms.some((x) => x.control) || !treatment) throw new ToolError("invalid_argument", "The experiment has no control and treatment arms yet; it cannot be scheduled.");
    const trial = treatment.in_design_campaign_ids[0] ?? treatment.campaign_ids[0] ?? "the treatment";
    return {
      summary: `Schedule experiment "${e.name}" (${e.type}): campaign ${trial} starts serving ${e.start_date ? `on ${e.start_date}` : "as soon as it is ready"} with ${treatment.traffic_split}% of the base campaign ${e.base_campaign_id}'s traffic${e.end_date ? `, until ${e.end_date}` : ""}.`,
      changes: [change(ref(e), "status", e.status, "INITIATED", "enable", "status"), change({ resource: "campaign", id: trial, name: null }, "traffic_share", null, `${treatment.traffic_split}%`, "enable")],
      ops: [],
      rpc: { path: `customers/${ads.customerId}/experiments/${e.experiment_id}:scheduleExperiment`, body: {} },
    };
  },
  landed: (_a, _b, after) => after.experiment?.status === "INITIATED" || after.experiment?.status === "ENABLED",
  result: (a, after, responses) => {
    const e = after.experiment!;
    const done = e.status === "ENABLED";
    return {
      experiment_id: a.experiment_id,
      status: e.status,
      promote_status: e.promote_status,
      end_date: e.end_date,
      long_running_operation: e.long_running_operation ?? opName(responses),
      state: done ? "scheduled" : "in_progress",
      message: done ? "Scheduled: the experiment campaign exists and serves from the start date." : "Google accepted the schedule request and is materializing the experiment campaign (status INITIATED). That is not finished yet; check list_experiments: ENABLED means it is scheduled.",
    };
  },
});

export const endExperiment = stateWrite({
  name: "end_experiment",
  title: "End experiment",
  // inventory/mapping.ts plans this tool as "write"; its change set marks the effect, so approvals come out high_impact.
  risk: "high_impact",
  description:
    "Ends a running experiment immediately after approval (ExperimentService.EndExperiment; the end date becomes now and the experiment is HALTED). The treatment campaign stops serving (it is not removed) and the base campaign gets all of its traffic back; the treatment's changes are NOT applied (use promote_experiment for that). Cannot be undone. Confirmed by re-reading.",
  input: experimentInput,
  output: lifecycleOutput,
  read: readState,
  build: (a, s, ads) => {
    const e = need(a, s);
    if (e.status === "HALTED") throw new ToolError("invalid_argument", "Nothing would change: the experiment has already ended.");
    if (e.status !== "ENABLED") throw new ToolError("invalid_argument", `Only a scheduled or running experiment (ENABLED) can be ended; this one is ${e.status}.`);
    const control = e.arms.find((x) => x.control);
    const changes = [change(ref(e), "status", e.status, "HALTED", "pause", "status")];
    for (const arm of e.arms.filter((x) => !x.control)) for (const c of arm.campaign_ids) changes.push(change({ resource: "campaign", id: c, name: null }, "traffic_share", `${arm.traffic_split}%`, "0%", "pause"));
    // The base campaign serves all traffic again: more delivery for it.
    changes.push(change({ resource: "campaign", id: control?.campaign_ids[0] ?? e.base_campaign_id ?? "base", name: null }, "traffic_share", control?.traffic_split === null || control === undefined ? null : `${control.traffic_split}%`, "100%", "increase_spend"));
    return { summary: `End experiment "${e.name}" now: the treatment stops serving and base campaign ${e.base_campaign_id} gets all traffic back. Its changes are not applied.`, changes, ops: [], rpc: { path: `customers/${ads.customerId}/experiments/${e.experiment_id}:endExperiment`, body: {} } };
  },
  // Google documents the end date moving to the time of the request and the status HALTED; either shows it applied.
  landed: (_a, before, after) => after.experiment?.status === "HALTED" || (!!after.experiment && after.experiment.end_date !== before.experiment?.end_date),
  result: (a, after) => {
    const e = after.experiment!;
    return { experiment_id: a.experiment_id, status: e.status, promote_status: e.promote_status, end_date: e.end_date, long_running_operation: e.long_running_operation, state: "ended", message: "Ended: the treatment campaign no longer serves." };
  },
});

const PROMOTING = ["IN_PROGRESS", "COMPLETED", "COMPLETED_WITH_WARNING"];
export const promoteExperiment = stateWrite({
  name: "promote_experiment",
  title: "Promote experiment",
  // inventory/mapping.ts plans this tool as "write"; its change set marks the effect, so approvals come out high_impact.
  risk: "high_impact",
  description:
    "Promotes an experiment after approval (ExperimentService.PromoteExperiment): copies the treatment campaign's changes onto the base campaign and stops the treatment from serving. Cannot be undone. PMAX_REPLACEMENT_SHOPPING experiments cannot be promoted. This is a long-running operation: the result reports Google's promote_status right after the call (IN_PROGRESS or COMPLETED) and never claims completion it cannot see; list_experiments shows later progress. If it fails, Google lists the reasons in the experiment's asynchronous errors (Google Ads UI). High impact: it changes the live base campaign.",
  input: experimentInput,
  output: lifecycleOutput,
  read: readState,
  build: (a, s, ads) => {
    const e = need(a, s);
    if (e.type === "PMAX_REPLACEMENT_SHOPPING") throw new ToolError("invalid_argument", "PMAX_REPLACEMENT_SHOPPING experiments cannot be promoted (Google's experiments guide).");
    if (e.status === "PROMOTED" || e.promote_status === "COMPLETED" || e.promote_status === "COMPLETED_WITH_WARNING") throw new ToolError("invalid_argument", "Nothing would change: the experiment is already promoted.");
    if (e.promote_status === "IN_PROGRESS") throw new ToolError("invalid_argument", "Nothing would change: a promotion is already in progress.");
    if (e.status !== "ENABLED" && e.status !== "HALTED") throw new ToolError("invalid_argument", `Only a scheduled, running or ended experiment can be promoted; this one is ${e.status}.`);
    const base = e.base_campaign_id ?? "the base campaign";
    const changes = [change({ resource: "campaign", id: base, name: null }, "settings", "current settings", `the treatment's changes from experiment ${e.experiment_id}`, "increase_spend"), change(ref(e), "status", e.status, "PROMOTED", "neutral", "status")];
    return { summary: `Promote experiment "${e.name}": apply the treatment's changes to base campaign ${base} and stop the treatment from serving.`, changes, ops: [], rpc: { path: `customers/${ads.customerId}/experiments/${e.experiment_id}:promoteExperiment`, body: {} } };
  },
  landed: (_a, _b, after) => after.experiment?.status === "PROMOTED" || PROMOTING.includes(after.experiment?.promote_status ?? ""),
  result: (a, after, responses) => {
    const e = after.experiment!;
    const done = e.promote_status === "COMPLETED" || e.promote_status === "COMPLETED_WITH_WARNING";
    return {
      experiment_id: a.experiment_id,
      status: e.status,
      promote_status: e.promote_status,
      end_date: e.end_date,
      long_running_operation: e.long_running_operation ?? opName(responses),
      state: done ? "promoted" : "in_progress",
      message: done ? `Promoted${e.promote_status === "COMPLETED_WITH_WARNING" ? " with warnings (see the experiment in Google Ads)" : ""}: the base campaign now has the treatment's changes.` : "Google accepted the promote request and is applying the changes (promote_status IN_PROGRESS or not yet reported). That is not finished yet; check list_experiments: promote_status COMPLETED means done, FAILED means it did not apply.",
    };
  },
});

export const experimentTools = [listExperiments, createExperiment, scheduleExperiment, endExperiment, promoteExperiment];
