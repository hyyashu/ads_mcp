import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const PLATFORMS = ["google_ads", "meta_ads", "google_search_console", "google_analytics", "google_tag_manager", "bing_webmaster"] as const;
export type Platform = (typeof PLATFORMS)[number];

const InventoryTool = z.object({
  platform: z.enum(PLATFORMS),
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  action_type: z.enum(["Read", "Analyze", "Create", "Update", "Delete"]),
  modifies_data: z.boolean(),
  connected: z.boolean(),
  implementation_status: z.string(),
  input_schema_status: z.string(),
  approval_required: z.boolean(),
});
export type InventoryTool = z.infer<typeof InventoryTool>;

const Inventory = z.object({ schema_version: z.literal(1), tools: z.array(InventoryTool) });

/** Per platform. The 2026-11-10 additions file each combined tool under the platform of the account its account_id names. */
export const EXPECTED = { google_ads: 216, meta_ads: 61, google_search_console: 13, google_analytics: 23, google_tag_manager: 13, bing_webmaster: 56, total: 382 } as const;

export function loadInventory(path = fileURLToPath(new URL("../inventory/tool-registry.json", import.meta.url))): InventoryTool[] {
  return Inventory.parse(JSON.parse(readFileSync(path, "utf8"))).tools;
}

/** Everything that must hold for the inventory to be a trustworthy source of truth. Returns problems; empty = valid. */
export function validateInventory(tools: InventoryTool[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) problems.push(`duplicate tool name: ${t.name}`);
    seen.add(t.name);
    const mutates = t.action_type === "Create" || t.action_type === "Update" || t.action_type === "Delete";
    if (t.modifies_data !== mutates) problems.push(`${t.name}: modifies_data=${t.modifies_data} contradicts action_type=${t.action_type}`);
    if (t.approval_required !== t.modifies_data) problems.push(`${t.name}: approval_required must equal modifies_data`);
  }
  const count = (p: Platform) => tools.filter((t) => t.platform === p).length;
  for (const p of PLATFORMS) if (count(p) !== EXPECTED[p]) problems.push(`expected ${EXPECTED[p]} ${p} tools, found ${count(p)}`);
  if (tools.length !== EXPECTED.total) problems.push(`expected ${EXPECTED.total} tools, found ${tools.length}`);
  return problems;
}
