import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

/** Experiments: create (experiment, then arms), list, schedule, end and promote against a stateful fake of the API. */
const C = "customers/1234567890";
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

// A tiny GAQL WHERE evaluator: `f = v`, `f != v`, `f IN (...)` joined by AND.
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const get = (row: any, f: string) => f.split(".").reduce((o, k) => (o == null ? undefined : o[camel(k)]), row);
const unq = (s: string) => s.trim().replace(/^'(.*)'$/s, "$1").replace(/\\'/g, "'");
function matches(q: string, row: any): boolean {
  const where = /\bWHERE (.*?)(?: ORDER BY | LIMIT | PARAMETERS |$)/.exec(q)?.[1];
  if (!where) return true;
  return where.split(" AND ").every((c) => {
    const m = /^([a-z_.]+) (=|!=|IN) (.+)$/s.exec(c.trim());
    if (!m) throw new Error(`fake cannot evaluate: ${c}`);
    const vals = m[2] === "IN" ? m[3]!.slice(1, -1).split(", ").map(unq) : [unq(m[3]!)];
    const v = get(row, m[1]!);
    const s = v === undefined || v === null ? "" : String(v);
    return m[2] === "!=" ? s !== vals[0] : vals.includes(s);
  });
}

let camps: Record<string, any>;
let experiments: any[];
let arms: any[];
let calls: { path: string; body: any }[];
let queries: string[];
let armsFail: null | { status: number; code: string } = null;
let removeFails = false;
let dropActions = false;
let nextId = 700;

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    queries.push(q);
    const from = /\bFROM ([a-z_]+)/.exec(q)![1];
    const rows: any[] =
      from === "customer"
        ? [{ customer: { id: "1234567890", timeZone: "America/New_York" } }]
        : from === "campaign"
          ? Object.values(camps).map(({ budgetShared, ...c }) => ({ campaign: c, campaignBudget: { explicitlyShared: !!budgetShared } }))
          : from === "experiment"
            ? experiments.map((e) => ({ experiment: e }))
            : from === "experiment_arm"
              ? q.includes("PARAMETERS include_drafts = true")
                ? arms.map((a) => ({ experimentArm: a }))
                : arms.map(({ inDesignCampaigns: _hidden, ...a }) => ({ experimentArm: a }))
              : [];
    return J({ results: rows.filter((r) => matches(q, r)) });
  }
  calls.push({ path, body });
  if (path.endsWith("experiments:mutate")) {
    const op = body.operations[0];
    if (op.remove) {
      if (removeFails) return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: "CANNOT_REMOVE_IN_CREATION_EXPERIMENT" } }, 400);
      experiments.find((e) => e.resourceName === op.remove).status = "REMOVED";
      return J({ results: [{ resourceName: op.remove }] });
    }
    const id = String(nextId++);
    experiments.push({ resourceName: `${C}/experiments/${id}`, experimentId: id, ...op.create });
    return J({ results: [{ resourceName: `${C}/experiments/${id}` }] });
  }
  if (path.endsWith("experimentArms:mutate")) {
    if (armsFail) return J({ error: { code: armsFail.status, status: armsFail.code, message: "arms refused" } }, armsFail.status);
    const exp = body.operations[0].create.experiment.split("/").pop();
    body.operations.forEach((op: any, i: number) => {
      const a = op.create;
      const draft = String(nextId++);
      if (!a.control) camps[draft] = { id: draft, name: `${camps["11"].name} [test]`, status: "ENABLED", advertisingChannelType: "SEARCH", experimentType: "DRAFT" };
      arms.push({ resourceName: `${C}/experimentArms/${exp}~${i + 1}`, experiment: a.experiment, name: a.name, control: a.control, trafficSplit: a.trafficSplit, campaigns: a.campaigns ?? [], ...(a.control ? {} : { inDesignCampaigns: [`${C}/campaigns/${draft}`] }) });
    });
    return J({ results: body.operations.map((_: unknown, i: number) => ({ resourceName: `${C}/experimentArms/${exp}~${i + 1}` })) });
  }
  const action = /experiments\/(\d+):(scheduleExperiment|endExperiment|promoteExperiment)$/.exec(path);
  if (action) {
    const e = experiments.find((x) => x.experimentId === action[1]);
    if (!dropActions) {
      if (action[2] === "scheduleExperiment") Object.assign(e, { status: "INITIATED", longRunningOperation: `${C}/operations/sched-${e.experimentId}` });
      if (action[2] === "endExperiment") Object.assign(e, { status: "HALTED", endDate: "2026-11-11" });
      if (action[2] === "promoteExperiment") Object.assign(e, { promoteStatus: "IN_PROGRESS", longRunningOperation: `${C}/operations/promo-${e.experimentId}` });
    }
    return J(action[2] === "endExperiment" ? {} : { name: `${C}/operations/op-${e.experimentId}` });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("EXP", fake);
});
beforeEach(() => {
  camps = {
    "11": { id: "11", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH", experimentType: "BASE", endDateTime: "2099-12-31 23:59:59" },
    "12": { id: "12", name: "Banners", status: "ENABLED", advertisingChannelType: "DISPLAY", experimentType: "BASE" },
    "13": { id: "13", name: "Shared", status: "ENABLED", advertisingChannelType: "SEARCH", experimentType: "BASE", budgetShared: true },
    "14": { id: "14", name: "Brand [taken]", status: "ENABLED", advertisingChannelType: "SEARCH", experimentType: "BASE" },
  };
  experiments = [
    { resourceName: `${C}/experiments/501`, experimentId: "501", name: "Running", type: "SEARCH_CUSTOM", status: "ENABLED", suffix: " [run]", startDate: "2026-10-01", endDate: "2026-12-01", syncEnabled: false, promoteStatus: "NOT_STARTED" },
    { resourceName: `${C}/experiments/502`, experimentId: "502", name: "Designing", type: "SEARCH_CUSTOM", status: "SETUP", suffix: " [d]" },
    { resourceName: `${C}/experiments/503`, experimentId: "503", name: "PMax test", type: "PMAX_REPLACEMENT_SHOPPING", status: "ENABLED" },
    { resourceName: `${C}/experiments/504`, experimentId: "504", name: "Old", type: "DISPLAY_CUSTOM", status: "REMOVED" },
  ];
  arms = [
    { resourceName: `${C}/experimentArms/501~1`, experiment: `${C}/experiments/501`, name: "Control", control: true, trafficSplit: "60", campaigns: [`${C}/campaigns/11`] },
    { resourceName: `${C}/experimentArms/501~2`, experiment: `${C}/experiments/501`, name: "Treatment", control: false, trafficSplit: "40", campaigns: [`${C}/campaigns/601`], inDesignCampaigns: [] },
    { resourceName: `${C}/experimentArms/502~1`, experiment: `${C}/experiments/502`, name: "Control", control: true, trafficSplit: "50", campaigns: [`${C}/campaigns/11`] },
    { resourceName: `${C}/experimentArms/502~2`, experiment: `${C}/experiments/502`, name: "Treatment", control: false, trafficSplit: "50", campaigns: [], inDesignCampaigns: [`${C}/campaigns/602`] },
  ];
  calls = [];
  queries = [];
  armsFail = null;
  removeFails = false;
  dropActions = false;
  nextId = 700;
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (id: string, by = kit.second) => kit.approveAs(id, by);
const err = async (name: string, args: Record<string, unknown>) => (await run(name, args)).error;
const exp = { name: "Bidding test", type: "SEARCH_CUSTOM", base_campaign_id: "11", suffix: " [test]", control_traffic_split: 60, treatment_traffic_split: 40 };

describe("list_experiments", () => {
  it("lists experiments with arms, base campaign and in-design campaigns (queried with include_drafts)", async () => {
    const d = (await run("list_experiments", {})).data as any;
    expect(d).toMatchObject({ returned: 3, truncated: false });
    expect(d.experiments.map((e: any) => e.experiment_id)).toEqual(["501", "502", "503"]);
    expect(d.experiments[1]).toEqual({
      experiment_id: "502", name: "Designing", description: null, type: "SEARCH_CUSTOM", status: "SETUP", promote_status: null, start_date: null, end_date: null, suffix: " [d]", sync_enabled: null, long_running_operation: null, base_campaign_id: "11",
      arms: [
        { arm_id: "1", name: "Control", control: true, traffic_split: 50, campaign_ids: ["11"], in_design_campaign_ids: [] },
        { arm_id: "2", name: "Treatment", control: false, traffic_split: 50, campaign_ids: [], in_design_campaign_ids: ["602"] },
      ],
    });
    expect(queries[0]).toContain("FROM experiment WHERE experiment.status != 'REMOVED' ORDER BY experiment.experiment_id DESC LIMIT 51");
    expect(queries[1]).toMatch(/FROM experiment_arm WHERE experiment_arm\.experiment IN \(.*\) PARAMETERS include_drafts = true$/);
  });

  it("filters by status and id", async () => {
    const d = (await run("list_experiments", { statuses: ["REMOVED", "SETUP"], experiment_ids: ["502", "504"] })).data as any;
    expect(d.experiments.map((e: any) => e.experiment_id)).toEqual(["502", "504"]);
    expect((await err("list_experiments", { statuses: ["RUNNING"] }))?.code).toBe("invalid_argument");
  });
});

describe("create_experiment", () => {
  it("creates the experiment then both arms in one request; high impact; returns the in-design campaign", async () => {
    const r = await run("create_experiment", { ...exp, description: "Try tCPA", end_date: "2099-06-30", sync_enabled: true });
    expect(r.approval).toMatchObject({ risk: "high_impact", change_set: { changes: [{ resource: "experiment", id: "new", effect: "create" }] } });
    expect(r.approval?.summary).toContain('treatment campaign "Brand [test]"');
    const done = await approve(r.approval!.approval_id);
    expect(done.status, JSON.stringify(done.result)).toBe("executed");
    expect(calls.map((c) => c.path)).toEqual([`${C}/experiments:mutate`, `${C}/experimentArms:mutate`]);
    expect(calls[0]!.body).toEqual({ operations: [{ create: { name: "Bidding test", type: "SEARCH_CUSTOM", suffix: " [test]", status: "SETUP", description: "Try tCPA", endDate: "2099-06-30", syncEnabled: true } }] });
    expect(calls[1]!.body).toEqual({
      operations: [
        { create: { experiment: `${C}/experiments/700`, name: "Control", control: true, campaigns: [`${C}/campaigns/11`], trafficSplit: "60" } },
        { create: { experiment: `${C}/experiments/700`, name: "Treatment", control: false, trafficSplit: "40" } },
      ],
    });
    const res = done.result as any;
    expect(res.in_design_campaign_id).toBe("702");
    expect(res.experiment).toMatchObject({ experiment_id: "700", status: "SETUP", base_campaign_id: "11", arms: [{ control: true, traffic_split: 60 }, { control: false, traffic_split: 40, in_design_campaign_ids: ["702"] }] });
    expect(res.next_step).toContain("schedule_experiment with experiment_id 700");
  });

  it("validates splits, campaign type, budget, names and dates", async () => {
    expect((await err("create_experiment", { ...exp, treatment_traffic_split: 50 }))?.message).toContain("sum to 100");
    expect((await err("create_experiment", { ...exp, control_traffic_split: 100, treatment_traffic_split: 0 }))?.code).toBe("invalid_argument");
    expect((await err("create_experiment", { ...exp, type: "DISPLAY_CUSTOM" }))?.message).toContain("needs a DISPLAY campaign; campaign 11 is SEARCH");
    expect((await err("create_experiment", { ...exp, type: "YOUTUBE_CUSTOM" }))?.code).toBe("invalid_argument");
    expect((await err("create_experiment", { ...exp, base_campaign_id: "13" }))?.message).toContain("shared budget");
    expect((await err("create_experiment", { ...exp, base_campaign_id: "99" }))?.code).toBe("not_found");
    expect((await err("create_experiment", { ...exp, name: "Designing" }))?.message).toContain("already exists (id 502)");
    expect((await err("create_experiment", { ...exp, suffix: " [taken]" }))?.message).toContain("campaign 14 already uses");
    expect((await err("create_experiment", { ...exp, start_date: "2020-01-01" }))?.message).toContain("cannot be in the past");
    expect((await err("create_experiment", { ...exp, start_date: "2098-01-01" }))?.message).toContain("one year");
    expect((await err("create_experiment", { ...exp, end_date: "2100-01-15" }))?.message).toContain("campaign ends 2099-12-31");
    camps["11"].experimentType = "EXPERIMENT";
    expect((await err("create_experiment", exp))?.message).toContain("use its base campaign");
    expect(calls).toHaveLength(0);
  });

  it("when Google rejects the arms, the empty experiment is removed again and the request fails cleanly", async () => {
    const r = await run("create_experiment", exp);
    armsFail = { status: 400, code: "INVALID_ARGUMENT" };
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect((done.result as any).error.message).toContain("was removed again, so the account is unchanged");
    expect(calls.map((c) => c.path)).toEqual([`${C}/experiments:mutate`, `${C}/experimentArms:mutate`, `${C}/experiments:mutate`]);
    expect(calls[2]!.body).toEqual({ operations: [{ remove: `${C}/experiments/700` }] });
  });

  it("when the empty experiment cannot be removed, or the arms request is ambiguous, the outcome is unknown, never success", async () => {
    const r = await run("create_experiment", exp);
    armsFail = { status: 400, code: "INVALID_ARGUMENT" };
    removeFails = true;
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("unknown_outcome");
    expect((done.result as any).error.message).toContain("could not be removed automatically");

    const r2 = await run("create_experiment", { ...exp, name: "Second try" });
    armsFail = { status: 500, code: "INTERNAL" };
    calls = [];
    const done2 = await approve(r2.approval!.approval_id);
    expect(done2.status).toBe("unknown_outcome");
    expect((done2.result as any).error.message).toContain("unconfirmed outcome");
    expect(calls.map((c) => c.path)).toEqual([`${C}/experiments:mutate`, `${C}/experimentArms:mutate`]); // no removal on an ambiguous failure
  });

  it("drift applies nothing; verify reports not_applied, applied or indeterminate from the live state", async () => {
    const r = await run("create_experiment", { ...exp, name: "Drift test" });
    camps["11"].name = "Brand 2";
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    expect(calls).toHaveLength(0);

    const tool = kit.deps.registry.get("create_experiment")!;
    if (tool.kind !== "write") throw new Error("write tool expected");
    const services = await kit.deps.createServices({ tenantId: kit.tenantId, account: { id: kit.accountId, platform: "google_ads", externalId: "1234567890", loginCustomerId: "5550001111", connectionId: "x" } });
    const args = { account_id: kit.accountId, ...exp, control_arm_name: "Control", treatment_arm_name: "Treatment", sync_enabled: false };
    expect(await tool.verify(args as never, { services } as never, { snapshot: null })).toEqual({ outcome: "not_applied" });
    experiments.push({ resourceName: `${C}/experiments/800`, experimentId: "800", name: "Bidding test", type: "SEARCH_CUSTOM", status: "SETUP" });
    expect((await tool.verify(args as never, { services } as never, { snapshot: null })).outcome).toBe("indeterminate");
    arms.push({ resourceName: `${C}/experimentArms/800~1`, experiment: `${C}/experiments/800`, name: "Control", control: true, trafficSplit: "60", campaigns: [`${C}/campaigns/11`] }, { resourceName: `${C}/experimentArms/800~2`, experiment: `${C}/experiments/800`, name: "Treatment", control: false, trafficSplit: "40", campaigns: [] });
    expect(await tool.verify(args as never, { services } as never, { snapshot: null })).toEqual({ outcome: "applied" });
  });
});

describe("schedule, end and promote", () => {
  it("schedule_experiment calls ScheduleExperiment and reports the long-running state honestly", async () => {
    const r = await run("schedule_experiment", { experiment_id: "502" });
    expect(r.approval?.risk).toBe("high_impact");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls).toEqual([{ path: `${C}/experiments/502:scheduleExperiment`, body: {} }]);
    expect(done.result).toMatchObject({ experiment_id: "502", status: "INITIATED", state: "in_progress", long_running_operation: `${C}/operations/sched-502` });
    expect((done.result as any).message).toContain("not finished yet");
  });

  it("schedule refuses experiments that are not in SETUP or do not exist", async () => {
    expect((await err("schedule_experiment", { experiment_id: "501" }))?.message).toContain("Nothing would change: the experiment is already scheduled");
    expect((await err("schedule_experiment", { experiment_id: "504" }))?.message).toContain("Only an experiment in SETUP");
    expect((await err("schedule_experiment", { experiment_id: "999" }))?.code).toBe("not_found");
    experiments.push({ resourceName: `${C}/experiments/505`, experimentId: "505", name: "No arms", type: "SEARCH_CUSTOM", status: "SETUP" });
    expect((await err("schedule_experiment", { experiment_id: "505" }))?.message).toContain("no control and treatment arms");
    expect(calls).toHaveLength(0);
  });

  it("end_experiment halts a running experiment; the base campaign gets all traffic back", async () => {
    const r = await run("end_experiment", { experiment_id: "501" });
    expect(r.approval?.risk).toBe("high_impact");
    expect(r.approval?.change_set?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "experiment", field: "status", before: "ENABLED", after: "HALTED" }),
        expect.objectContaining({ resource: "campaign", id: "601", before: "40%", after: "0%", effect: "pause" }),
        expect.objectContaining({ resource: "campaign", id: "11", before: "60%", after: "100%", effect: "increase_spend" }),
      ]),
    );
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls).toEqual([{ path: `${C}/experiments/501:endExperiment`, body: {} }]);
    expect(done.result).toMatchObject({ experiment_id: "501", status: "HALTED", end_date: "2026-11-11", state: "ended" });
    expect((await err("end_experiment", { experiment_id: "501" }))?.message).toContain("Nothing would change");
    expect((await err("end_experiment", { experiment_id: "502" }))?.message).toContain("Only a scheduled or running experiment");
  });

  it("promote_experiment starts the promotion and reports it as in progress; refuses PMax-vs-Shopping and repeats", async () => {
    const r = await run("promote_experiment", { experiment_id: "501" });
    expect(r.approval?.risk).toBe("high_impact");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls).toEqual([{ path: `${C}/experiments/501:promoteExperiment`, body: {} }]);
    expect(done.result).toMatchObject({ experiment_id: "501", promote_status: "IN_PROGRESS", state: "in_progress", long_running_operation: `${C}/operations/promo-501` });
    expect((await err("promote_experiment", { experiment_id: "501" }))?.message).toContain("already in progress");
    expect((await err("promote_experiment", { experiment_id: "503" }))?.message).toContain("cannot be promoted");
    expect((await err("promote_experiment", { experiment_id: "502" }))?.message).toContain("Only a scheduled, running or ended experiment");
  });

  it("an action Google accepts but that does not read back is unknown_outcome", async () => {
    experiments.push({ resourceName: `${C}/experiments/506`, experimentId: "506", name: "Ended", type: "SEARCH_CUSTOM", status: "HALTED" });
    const r = await run("promote_experiment", { experiment_id: "506" });
    dropActions = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});
