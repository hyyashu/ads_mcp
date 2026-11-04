import { z } from "zod";
import type { InventoryTool } from "../inventory";
import type { AnyTool } from "./tool";

/** Rejects tool definitions that break the project's rules, with a message naming the tool and the rule. */
export function validateTool(tool: AnyTool, inv: InventoryTool | undefined): string[] {
  const p: string[] = [];
  const at = (msg: string) => p.push(`${tool.name}: ${msg}`);
  if (!inv) return [`${tool.name}: not in the tool inventory`];
  if (inv.platform !== tool.platform) at(`platform ${tool.platform} does not match inventory (${inv.platform})`);
  if (inv.modifies_data !== (tool.kind === "write")) at(`kind=${tool.kind} contradicts inventory modifies_data=${inv.modifies_data}`);
  if (!(tool.input instanceof z.ZodObject)) at("input must be a z.object(...)");
  if (!tool.output) at("output schema is required");
  if (!tool.description || tool.description.length < 30) at("description must explain the tool (30+ characters)");
  if (!tool.permissions?.scope) at("permissions.scope is required");
  if (tool.kind === "write" && tool.permissions.scope !== "ads:write") at("write tools require scope ads:write");
  if (tool.kind === "read" && tool.permissions.scope !== "ads:read") at("read tools require scope ads:read");
  if (tool.kind === "read" && tool.permissions.platformPermissions.length === 0 && tool.accountScope !== "none") {
    at("tools that call the platform must document platformPermissions");
  }
  if (tool.kind === "write" && typeof tool.plan !== "function") at("write tools need plan()");
  if (tool.kind === "write" && typeof tool.execute !== "function") at("write tools need execute()");
  if (tool.kind === "write" && typeof tool.verify !== "function") at("write tools need verify() so unknown outcomes can be reconciled before any retry");
  if (tool.kind === "read" && typeof tool.handler !== "function") at("read tools need handler()");
  if (tool.timeoutMs !== undefined && !(Number.isInteger(tool.timeoutMs) && tool.timeoutMs >= 100 && tool.timeoutMs <= 300_000)) at("timeoutMs must be an integer from 100 to 300000");

  if (tool.input instanceof z.ZodObject) {
    const shape = tool.input.shape as Record<string, unknown>;
    if ((tool.accountScope ?? "required") === "required" && !("account_id" in shape)) at("input must include account_id");
    // Unsafe bulk operations: every array in the input must declare a maximum size.
    const unbounded: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      if (n.type === "array" && typeof n.maxItems !== "number") unbounded.push(path || "(root)");
      for (const [k, v] of Object.entries(n)) {
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${k}[${i}]`));
        else walk(v, `${path}.${k}`);
      }
    };
    walk(z.toJSONSchema(tool.input), "");
    if (unbounded.length) at(`array inputs must set .max(): ${unbounded.join(", ")}`);
  }
  return p;
}

export class ToolRegistry {
  private tools = new Map<string, AnyTool>();

  constructor(private inventory: InventoryTool[]) {}

  register(tool: AnyTool): this {
    if (this.tools.has(tool.name)) throw new Error(`duplicate registration: ${tool.name}`);
    const problems = validateTool(tool, this.inventory.find((t) => t.name === tool.name));
    if (problems.length) throw new Error(`Refusing to register tool:\n  ${problems.join("\n  ")}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: AnyTool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  get(name: string) {
    return this.tools.get(name);
  }
  /** Operation category, taken from the inventory so it cannot drift from it: read | analyze | create | update | delete. */
  private operations?: Map<string, "read" | "analyze" | "create" | "update" | "delete">;
  /** The inventory's action type for a tool (looked up from a map built once, not a scan per call). */
  operationOf(name: string): "read" | "analyze" | "create" | "update" | "delete" {
    this.operations ??= new Map(this.inventory.map((t) => [t.name, t.action_type.toLowerCase() as "read" | "analyze" | "create" | "update" | "delete"]));
    return this.operations.get(name) ?? "read";
  }
  list(): AnyTool[] {
    return [...this.tools.values()];
  }
  has(name: string) {
    return this.tools.has(name);
  }
}

export type Limitation = { reason: string; alternative?: string };
export type Status = "implemented" | "external_limitation" | "pending";
export interface Reconciliation {
  rows: { name: string; platform: string; status: Status; note?: string }[];
  counts: Record<Status, number>;
  /** Problems that must fail the build: unknown tools, a tool both implemented and declared unsupported, etc. */
  errors: string[];
}

/** Every inventory tool must be exactly one of: implemented, documented external limitation, or pending. */
export function reconcile(inventory: InventoryTool[], registry: ToolRegistry, limitations: Record<string, Limitation>): Reconciliation {
  const errors: string[] = [];
  const names = new Set(inventory.map((t) => t.name));
  for (const t of registry.list()) if (!names.has(t.name)) errors.push(`registered tool not in inventory: ${t.name}`);
  for (const n of Object.keys(limitations)) {
    if (!names.has(n)) errors.push(`limitation for unknown tool: ${n}`);
    if (registry.has(n)) errors.push(`${n} is both implemented and declared an external limitation`);
    if (!limitations[n]?.reason) errors.push(`${n}: limitation needs a reason`);
  }
  const rows = inventory.map((t) => {
    const lim = limitations[t.name];
    const status: Status = registry.has(t.name) ? "implemented" : lim ? "external_limitation" : "pending";
    return { name: t.name, platform: t.platform, status, ...(lim ? { note: lim.reason } : {}) };
  });
  const counts: Record<Status, number> = { implemented: 0, external_limitation: 0, pending: 0 };
  for (const r of rows) counts[r.status]++;
  return { rows, counts, errors };
}
