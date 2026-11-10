import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { statusChange } from "../../../policy/change-set";
import { type MetaAdsClient, fromMinor } from "../client";
import { withHidden } from "../../core/hidden";
import { accountId, metaId, metaRead, s } from "./common";
import { metaStateWrite } from "./write-kit";

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

/** A campaign's live status (null when it does not exist in this ad account). Never throws for missing campaigns, so the
 * same read serves planning, execution and crash-recovery verification. */
async function readCampaign(m: MetaAdsClient, id: string) {
  let r: Record<string, unknown> | null = null;
  try {
    r = await m.getOwned(id, ["id", "name", "status", "effective_status"], "campaign");
  } catch (e) {
    if (!(e instanceof ToolError && e.code === "not_found")) throw e;
  }
  if (r && !s(r, "status")) throw new ToolError("internal", "Meta did not return the campaign's status.");
  return withHidden({ status: r ? s(r, "status") : null }, { name: r ? s(r, "name") : null });
}

function statusTool(name: "pause_meta_campaign" | "resume_meta_campaign", to: "PAUSED" | "ACTIVE", risk: "write" | "high_impact") {
  const verb = to === "PAUSED" ? "Pause" : "Resume";
  const output = z.object({ campaign_id: z.string(), status: z.literal(to), previous_status: z.string() });
  return metaStateWrite({
    name,
    title: `${verb} Meta campaign`,
    risk,
    description: `${verb}s one Meta campaign after human approval${to === "ACTIVE" ? ", which is high impact because resuming can start spend immediately (ad sets and ads inside must also be active to deliver)" : ""}. Deleted or archived campaigns cannot be changed. Confirmed by re-reading the campaign from Meta.`,
    input: z.object({ account_id: accountId, campaign_id: metaId }),
    output,
    read: (a, m) => readCampaign(m, a.campaign_id),
    build: (a, cur) => {
      if (cur.status === null) throw new ToolError("not_found", `No campaign ${a.campaign_id} in this ad account.`);
      if (cur.status === "DELETED" || cur.status === "ARCHIVED") throw new ToolError("invalid_argument", `The campaign is ${cur.status.toLowerCase()} and cannot be changed.`);
      if (cur.status === to) throw new ToolError("invalid_argument", `The campaign is already ${to.toLowerCase()}.`);
      return {
        summary: `${verb} Meta campaign "${cur.__hidden.name ?? a.campaign_id}" (${a.campaign_id}): ${cur.status} -> ${to}`,
        changes: [statusChange({ resource: "campaign", id: a.campaign_id, name: cur.__hidden.name }, cur.status, to)],
        post: { path: a.campaign_id, params: { status: to } },
      };
    },
    landed: (_a, _b, after) => after.status === to,
    result: (a, _after, before) => ({ campaign_id: a.campaign_id, status: to, previous_status: before.status! }) as z.infer<typeof output>,
  });
}

export const pauseMetaCampaign = statusTool("pause_meta_campaign", "PAUSED", "write");
export const resumeMetaCampaign = statusTool("resume_meta_campaign", "ACTIVE", "high_impact");
export const campaignTools = [listMetaCampaigns, pauseMetaCampaign, resumeMetaCampaign];
