import { describe, expect, it } from "vitest";
import { mapTool } from "../../inventory/mapping";
import { loadInventory } from "../inventory";
import { googleTools } from "../platforms/google";

const inv = loadInventory();

describe("implementation plan (inventory/mapping.ts)", () => {
  it("maps every inventory tool to an API surface", () => {
    const unmapped = inv.filter((t) => mapTool(t).api.startsWith("UNMAPPED")).map((t) => t.name);
    expect(unmapped).toEqual([]);
  });

  it("risk tiers agree with the inventory: reads are read, deletes are destructive, other mutations are write or high_impact", () => {
    for (const t of inv) {
      const { risk } = mapTool(t);
      if (!t.modifies_data) expect(risk, t.name).toBe("read");
      else if (t.action_type === "Delete") expect(risk, t.name).toBe("destructive");
      else expect(["write", "high_impact"], t.name).toContain(risk);
    }
  });

  it("every tool that talks to a platform documents the permission it needs", () => {
    for (const t of inv) {
      const m = mapTool(t);
      if (m.accountScope === "required") expect(m.platformPermissions.length, t.name).toBeGreaterThan(0);
      else expect(m.feasibility, t.name).toBe("internal");
    }
  });

  it("known corrections stay corrected (negative keywords, PMax audience signals)", () => {
    const api = (n: string) => mapTool(inv.find((t) => t.name === n)!).api;
    expect(api("add_negative_keywords")).toMatch(/negative/);
    expect(api("add_pmax_audience_signal")).toMatch(/AssetGroupSignalService/);
    expect(api("add_negative_keywords_to_list")).toMatch(/SharedCriterionService/);
  });

  it("flags tools that cannot be assumed feasible instead of hiding them", () => {
    const flagged = inv.map((t) => ({ n: t.name, f: mapTool(t).feasibility })).filter((x) => x.f === "limitation_candidate" || x.f === "needs_decision").map((x) => x.n);
    // Business-profile tools are decided (read/update supported Google Ads assets). get_meta_audience_insights is resolved: it
    // implements the documented capability only (delivery breakdowns). The rest depend on platform support that must be verified.
    expect(flagged.sort()).toEqual(["get_benchmark_context", "validate_video"]);
  });

  it("creation of campaigns, resuming spend and budget/bid changes are high impact", () => {
    const risk = (n: string) => mapTool(inv.find((t) => t.name === n)!).risk;
    for (const n of ["create_search_campaign", "create_meta_image_campaign", "resume_campaign", "resume_meta_campaign", "update_campaign", "update_bid_strategy", "bulk_update_campaign_status", "duplicate_meta_campaign"]) expect(risk(n), n).toBe("high_impact");
    for (const n of ["pause_campaign", "pause_meta_campaign", "add_keywords"]) expect(risk(n), n).toBe("write");
  });

  it("every implemented tool declares exactly the risk tier the plan assigns it (a mis-tiered resume_* could be self-approved)", () => {
    expect(googleTools.length).toBeGreaterThan(0);
    for (const tool of googleTools) {
      const t = inv.find((i) => i.name === tool.name);
      expect(t, `${tool.name} is not in the inventory`).toBeDefined();
      const planned = mapTool(t!).risk;
      const declared = tool.kind === "read" ? "read" : tool.risk;
      expect(declared, `${tool.name}: declared ${declared}, planned ${planned}`).toBe(planned);
    }
  });
});
