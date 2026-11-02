import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GoogleAdsClient } from "../client";
import { Gaql, lit, pick } from "../gaql";
import { accountId, googleWrite } from "./common";

type Status = "ENABLED" | "PAUSED";

interface Kind {
  /** GAQL resource, also the field prefix. */
  resource: "campaign" | "ad_group";
  /** REST mutate service. */
  service: "campaigns" | "adGroups";
  idField: "campaign_id" | "ad_group_id";
  label: string;
}
const CAMPAIGN: Kind = { resource: "campaign", service: "campaigns", idField: "campaign_id", label: "campaign" };
const AD_GROUP: Kind = { resource: "ad_group", service: "adGroups", idField: "ad_group_id", label: "ad group" };

async function current(ads: GoogleAdsClient, k: Kind, id: string): Promise<{ name: string | null; status: string; resourceName: string }> {
  const q = new Gaql().select(`${k.resource}.id`, `${k.resource}.name`, `${k.resource}.status`, `${k.resource}.resource_name`).from(k.resource).where(`${k.resource}.id = ${lit.id(id)}`).limit(1);
  const [row] = await ads.query(q, { maxRows: 1 });
  const status = row && pick(row, `${k.resource}.status`);
  if (!row || typeof status !== "string") throw new ToolError("not_found", `No ${k.label} ${id} in this account.`);
  const name = pick(row, `${k.resource}.name`);
  return { name: typeof name === "string" ? name : null, status, resourceName: String(pick(row, `${k.resource}.resource_name`) ?? `customers/${ads.customerId}/${k.service}/${id}`) };
}

/** Builds a pause or resume tool for a campaign or ad group. */
function statusTool(k: Kind, to: Status, risk: "write" | "high_impact", name: string) {
  const verb = to === "PAUSED" ? "Pause" : "Resume";
  const output = z.object({ [k.idField]: z.string(), status: z.literal(to), previous_status: z.string() });
  return googleWrite({
    name,
    title: `${verb} ${k.label}`,
    risk,
    description: `${verb}s one Google Ads ${k.label} after human approval. ${to === "ENABLED" ? "Resuming can start spend immediately, so it needs a second approver. " : ""}Removed ${k.label}s cannot be changed. Confirmed by re-reading the status from Google Ads.`,
    input: z.object({ account_id: accountId, [k.idField]: z.string().regex(/^\d{1,20}$/, "numeric id") }),
    output,
    plan: async (a, ctx) => {
      const id = a[k.idField] as string;
      const cur = await current(ctx.services.ads, k, id);
      if (cur.status === "REMOVED") throw new ToolError("invalid_argument", `The ${k.label} is removed and cannot be changed.`);
      if (cur.status === to) throw new ToolError("invalid_argument", `The ${k.label} is already ${to.toLowerCase()}.`);
      return { summary: `${verb} ${k.label} "${cur.name ?? id}" (${id}): ${cur.status} -> ${to}`, snapshot: { id, status: cur.status } };
    },
    verify: async (a, ctx, run) => {
      const cur = await current(ctx.services.ads, k, a[k.idField] as string);
      const before = (run.snapshot as { status: string }).status;
      if (cur.status === to) return { outcome: "applied" };
      if (cur.status === before) return { outcome: "not_applied" };
      return { outcome: "indeterminate", detail: `status is ${cur.status}, expected ${before} or ${to}` };
    },
    execute: async (a, ctx, run) => {
      const id = a[k.idField] as string;
      const cur = await current(ctx.services.ads, k, id);
      const before = (run.snapshot as { status: string }).status;
      if (cur.status !== before) throw new ToolError("conflict", `The ${k.label} changed since it was requested (now ${cur.status}).`);
      await ctx.services.ads.mutate(k.service, [{ update: { resourceName: cur.resourceName, status: to }, updateMask: "status" }]);
      // Never claim success without confirmation: read the state back.
      const after = await current(ctx.services.ads, k, id);
      if (after.status !== to) throw new ToolError("unknown_outcome", `Google accepted the request but the ${k.label} reads ${after.status}.`);
      return { [k.idField]: id, status: to, previous_status: before } as z.infer<typeof output>;
    },
  });
}

export const pauseCampaign = statusTool(CAMPAIGN, "PAUSED", "write", "pause_campaign");
export const resumeCampaign = statusTool(CAMPAIGN, "ENABLED", "high_impact", "resume_campaign");
export const pauseAdGroup = statusTool(AD_GROUP, "PAUSED", "write", "pause_ad_group");
export const resumeAdGroup = statusTool(AD_GROUP, "ENABLED", "high_impact", "resume_ad_group");
export const statusTools = [pauseCampaign, resumeCampaign, pauseAdGroup, resumeAdGroup];
