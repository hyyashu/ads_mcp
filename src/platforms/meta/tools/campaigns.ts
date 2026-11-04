import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { statusChange } from "../../../policy/change-set";
import { type MetaAdsClient, fromMinor } from "../client";
import { accountId, metaId, metaRead, metaWrite, s } from "./common";

// Field names from the Marketing API Campaign reference (ad-campaign-group). Budgets are strings in the currency's minor unit.
const LIST_FIELDS = ["id", "name", "status", "effective_status", "objective", "buying_type", "bid_strategy", "daily_budget", "lifetime_budget", "start_time", "stop_time"];

const Money = z.number().nullable().describe("In the account's currency (converted from Meta's minor units); null when not set at campaign level.");
const campaignRow = z.object({
  campaign_id: z.string().min(1),
  name: z.string().nullable(),
  status: z.string().nullable().describe("Configured status: ACTIVE, PAUSED, DELETED or ARCHIVED."),
  effective_status: z.string().nullable().describe("What is actually happening, e.g. ACTIVE, PAUSED, CAMPAIGN_PAUSED, IN_PROCESS, WITH_ISSUES."),
  objective: z.string().nullable(),
  buying_type: z.string().nullable(),
  bid_strategy: z.string().nullable(),
  daily_budget: Money,
  lifetime_budget: Money,
  start_time: z.string().nullable(),
  stop_time: z.string().nullable(),
});

export const listMetaCampaigns = metaRead({
  name: "list_meta_campaigns",
  title: "List Meta campaigns",
  description:
    "Lists the campaigns of a Meta ad account with status, objective, bid strategy, budgets (campaign budget only; ad set budgets are not shown here) and schedule. Deleted and archived campaigns are left out unless include_archived is set. Fetched live from the Marketing API.",
  input: z.object({
    account_id: accountId,
    status: z.enum(["ACTIVE", "PAUSED"]).optional().describe("Only campaigns with this configured status."),
    include_archived: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  output: z.object({ campaigns: z.array(campaignRow), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    // Filtering is done here on the configured status, which is documented; nothing depends on undocumented edge filters.
    const rows = await m.list(`${m.adAccountId}/campaigns`, { fields: LIST_FIELDS.join(",") }, 5_000);
    const wanted = rows.filter((r) => {
      const st = s(r, "status");
      if (!a.include_archived && (st === "DELETED" || st === "ARCHIVED")) return false;
      return !a.status || st === a.status;
    });
    const shown = wanted.slice(0, a.limit).map((r) => ({
      campaign_id: String(r.id ?? ""),
      name: s(r, "name"),
      status: s(r, "status"),
      effective_status: s(r, "effective_status"),
      objective: s(r, "objective"),
      buying_type: s(r, "buying_type"),
      bid_strategy: s(r, "bid_strategy"),
      daily_budget: fromMinor(r.daily_budget, m.currency),
      lifetime_budget: fromMinor(r.lifetime_budget, m.currency),
      start_time: s(r, "start_time"),
      stop_time: s(r, "stop_time"),
    }));
    return { campaigns: shown, returned: shown.length, truncated: wanted.length > shown.length || rows.length >= 5_000 };
  },
});

async function current(m: MetaAdsClient, id: string) {
  const r = await m.getOwned(id, ["id", "name", "status", "effective_status"], "campaign");
  const status = s(r, "status");
  if (!status) throw new ToolError("internal", "Meta did not return the campaign's status.");
  return { name: s(r, "name"), status, effective: s(r, "effective_status") };
}

function statusTool(name: "pause_meta_campaign" | "resume_meta_campaign", to: "PAUSED" | "ACTIVE", risk: "write" | "high_impact") {
  const verb = to === "PAUSED" ? "Pause" : "Resume";
  const output = z.object({ campaign_id: z.string(), status: z.literal(to), previous_status: z.string() });
  return metaWrite({
    name,
    title: `${verb} Meta campaign`,
    risk,
    description: `${verb}s one Meta campaign after human approval${to === "ACTIVE" ? " from a second person, because resuming can start spend immediately (ad sets and ads inside must also be active to deliver)" : ""}. Deleted or archived campaigns cannot be changed. Confirmed by re-reading the campaign from Meta.`,
    input: z.object({ account_id: accountId, campaign_id: metaId }),
    output,
    plan: async (a, ctx) => {
      const cur = await current(ctx.services.meta, a.campaign_id);
      if (cur.status === "DELETED" || cur.status === "ARCHIVED") throw new ToolError("invalid_argument", `The campaign is ${cur.status.toLowerCase()} and cannot be changed.`);
      if (cur.status === to) throw new ToolError("invalid_argument", `The campaign is already ${to.toLowerCase()}.`);
      return {
        summary: `${verb} Meta campaign "${cur.name ?? a.campaign_id}" (${a.campaign_id}): ${cur.status} -> ${to}`,
        snapshot: { status: cur.status },
        changes: [statusChange({ resource: "campaign", id: a.campaign_id, name: cur.name }, cur.status, to)],
      };
    },
    verify: async (a, ctx, run) => {
      const cur = await current(ctx.services.meta, a.campaign_id);
      if (cur.status === to) return { outcome: "applied" };
      return cur.status === (run.snapshot as { status: string }).status ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: `status is ${cur.status}` };
    },
    execute: async (a, ctx, run) => {
      const m = ctx.services.meta;
      const before = (run.snapshot as { status: string }).status;
      const cur = await current(m, a.campaign_id);
      if (cur.status !== before) throw new ToolError("conflict", `The campaign changed since this was requested (now ${cur.status}).`);
      await m.post(a.campaign_id, { status: to });
      // Never claim success without confirmation: the live state decides, not the {success: true} body.
      const after = await current(m, a.campaign_id);
      if (after.status !== to) throw new ToolError("unknown_outcome", `Meta accepted the request but the campaign reads ${after.status}.`);
      return { campaign_id: a.campaign_id, status: to, previous_status: before } as z.infer<typeof output>;
    },
  });
}

export const pauseMetaCampaign = statusTool("pause_meta_campaign", "PAUSED", "write");
export const resumeMetaCampaign = statusTool("resume_meta_campaign", "ACTIVE", "high_impact");
export const campaignTools = [listMetaCampaigns, pauseMetaCampaign, resumeMetaCampaign];
