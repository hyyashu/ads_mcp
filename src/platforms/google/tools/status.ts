import { statusChange } from "../../../policy/change-set";
import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GoogleAdsClient } from "../client";
import { Gaql, lit, pick } from "../gaql";
import { accountId } from "./common";
import { stateWrite, withHidden } from "./write-kit";

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

/** Live status of a campaign or ad group (null when it does not exist). Never throws on missing or removed items, so the
 * same read serves planning, execution and crash-recovery verification. */
async function readStatus(ads: GoogleAdsClient, k: Kind, id: string) {
  const q = new Gaql().select(`${k.resource}.id`, `${k.resource}.name`, `${k.resource}.status`, `${k.resource}.resource_name`).from(k.resource).where(`${k.resource}.id = ${lit.id(id)}`).limit(1);
  const [row] = await ads.query(q, { maxRows: 1 });
  const status = row && pick(row, `${k.resource}.status`);
  const name = row && pick(row, `${k.resource}.name`);
  // Only the status is the approved snapshot; name and resource name are carried alongside without being compared.
  return withHidden({ status: typeof status === "string" ? status : null }, { name: typeof name === "string" ? name : null, resourceName: String((row && pick(row, `${k.resource}.resource_name`)) ?? `customers/${ads.customerId}/${k.service}/${id}`) });
}

/** Builds a pause or resume tool for a campaign or ad group on the shared state-write kit. */
function statusTool(k: Kind, to: Status, risk: "write" | "high_impact", name: string) {
  const verb = to === "PAUSED" ? "Pause" : "Resume";
  const output = z.object({ [k.idField]: z.string(), status: z.literal(to), previous_status: z.string() });
  return stateWrite({
    name,
    title: `${verb} ${k.label}`,
    risk,
    description: `${verb}s one Google Ads ${k.label} after human approval. ${to === "ENABLED" ? "Resuming can start spend immediately, so it is high impact. " : ""}Removed ${k.label}s cannot be changed. Confirmed by re-reading the status from Google Ads.`,
    input: z.object({ account_id: accountId, [k.idField]: z.string().regex(/^\d{1,20}$/, "numeric id") }),
    output,
    read: (a, ads) => readStatus(ads, k, a[k.idField] as string),
    build: (a, s) => {
      const id = a[k.idField] as string;
      if (s.status === null) throw new ToolError("not_found", `No ${k.label} ${id} in this account.`);
      if (s.status === "REMOVED") throw new ToolError("invalid_argument", `The ${k.label} is removed and cannot be changed.`);
      if (s.status === to) throw new ToolError("invalid_argument", `The ${k.label} is already ${to.toLowerCase()}.`);
      return {
        summary: `${verb} ${k.label} "${s.__hidden.name ?? id}" (${id}): ${s.status} -> ${to}`,
        changes: [statusChange({ resource: k.resource, id, name: s.__hidden.name }, s.status, to)],
        ops: [],
        mutate: { service: k.service, operations: [{ update: { resourceName: s.__hidden.resourceName, status: to }, updateMask: "status" }] },
      };
    },
    landed: (_a, _b, after) => after.status === to,
    result: (a, _after, _r, before) => ({ [k.idField]: a[k.idField] as string, status: to, previous_status: before.status! }) as z.infer<typeof output>,
  });
}

export const pauseCampaign = statusTool(CAMPAIGN, "PAUSED", "write", "pause_campaign");
export const resumeCampaign = statusTool(CAMPAIGN, "ENABLED", "high_impact", "resume_campaign");
export const pauseAdGroup = statusTool(AD_GROUP, "PAUSED", "write", "pause_ad_group");
export const resumeAdGroup = statusTool(AD_GROUP, "ENABLED", "high_impact", "resume_ad_group");
export const statusTools = [pauseCampaign, resumeCampaign, pauseAdGroup, resumeAdGroup];
