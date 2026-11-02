import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadInventory } from "../inventory";
import { ToolRegistry, reconcile, validateTool } from "../mcp/registry";
import type { ReadTool, WriteTool } from "../mcp/tool";
import { allTools } from "../platforms";
import { fixtureTools } from "./helpers";

const inv = loadInventory();
const byName = (n: string) => inv.find((t) => t.name === n);
const calls = { read: 0, execute: 0, verify: 0, verifyOutcome: "applied" as const, snapshot: null as unknown };
const [read, , , write] = fixtureTools(calls) as [ReadTool, ReadTool, ReadTool, WriteTool];

describe("tool validation", () => {
  it("accepts a well-formed read and write tool", () => {
    expect(validateTool(read, byName("list_campaigns"))).toEqual([]);
    expect(validateTool(write, byName("pause_campaign"))).toEqual([]);
  });

  it("rejects a tool that is not in the inventory", () => {
    expect(validateTool({ ...read, name: "made_up_tool" }, undefined)[0]).toMatch(/not in the tool inventory/);
  });

  it("rejects a platform mismatch", () => {
    expect(validateTool({ ...read, platform: "meta_ads" }, byName("list_campaigns")).join()).toMatch(/does not match inventory/);
  });

  it("rejects a read tool registered for a modifying inventory entry (and the reverse)", () => {
    expect(validateTool({ ...read, name: "pause_campaign" }, byName("pause_campaign")).join()).toMatch(/contradicts inventory/);
    expect(validateTool({ ...write, name: "list_campaigns" }, byName("list_campaigns")).join()).toMatch(/contradicts inventory/);
  });

  it("rejects unbounded array inputs (unsafe bulk operations)", () => {
    const t = { ...write, input: z.object({ account_id: z.string(), ids: z.array(z.string()) }) };
    expect(validateTool(t, byName("pause_campaign")).join()).toMatch(/array inputs must set \.max\(\)/);
    const ok = { ...write, input: z.object({ account_id: z.string(), ids: z.array(z.string()).max(50) }) };
    expect(validateTool(ok, byName("pause_campaign"))).toEqual([]);
  });

  it("requires account_id, a real description, and documented permissions", () => {
    expect(validateTool({ ...read, input: z.object({ limit: z.number() }) }, byName("list_campaigns")).join()).toMatch(/account_id/);
    expect(validateTool({ ...read, description: "short" }, byName("list_campaigns")).join()).toMatch(/description/);
    expect(validateTool({ ...read, permissions: { scope: "ads:read", platformPermissions: [] } }, byName("list_campaigns")).join()).toMatch(/platformPermissions/);
  });

  it("requires the right scope for the tool kind", () => {
    expect(validateTool({ ...write, permissions: { scope: "ads:read", platformPermissions: ["x"] } }, byName("pause_campaign")).join()).toMatch(/ads:write/);
  });

  it("rejects write tools that cannot reconcile an unknown outcome", () => {
    const noVerify = { ...write } as Partial<WriteTool>;
    delete noVerify.verify;
    expect(validateTool(noVerify as WriteTool, byName("pause_campaign")).join()).toMatch(/verify\(\)/);
  });

  it("registry refuses invalid and duplicate tools", () => {
    const reg = new ToolRegistry(inv);
    expect(() => reg.register({ ...read, name: "made_up_tool" })).toThrow(/Refusing to register/);
    reg.register(read);
    expect(() => reg.register(read)).toThrow(/duplicate registration/);
  });
});

describe("reconciliation against the inventory", () => {
  it("production registry reconciles with no errors and exposes no fixtures", () => {
    const reg = new ToolRegistry(inv).registerAll(allTools());
    const rec = reconcile(inv, reg, {});
    expect(rec.errors).toEqual([]);
    expect(rec.rows).toHaveLength(227);
    expect(rec.counts.implemented + rec.counts.external_limitation + rec.counts.pending).toBe(227);
    // Nothing is exposed that does not have a real handler.
    expect(reg.list().every((t) => typeof (t.kind === "read" ? t.handler : t.execute) === "function")).toBe(true);
  });

  it("classifies implemented, limited and pending tools; flags contradictions", () => {
    const reg = new ToolRegistry(inv).register(read);
    const rec = reconcile(inv, reg, { get_usage_status: { reason: "internal" } });
    expect(rec.rows.find((r) => r.name === "list_campaigns")?.status).toBe("implemented");
    expect(rec.rows.find((r) => r.name === "get_usage_status")?.status).toBe("external_limitation");
    expect(rec.rows.find((r) => r.name === "pause_campaign")?.status).toBe("pending");
    expect(rec.errors).toEqual([]);
    expect(reconcile(inv, reg, { list_campaigns: { reason: "x" } }).errors.join()).toMatch(/both implemented and declared/);
    expect(reconcile(inv, reg, { nope: { reason: "x" } }).errors.join()).toMatch(/unknown tool/);
    expect(reconcile(inv, reg, { get_usage_status: { reason: "" } }).errors.join()).toMatch(/needs a reason/);
  });
});
