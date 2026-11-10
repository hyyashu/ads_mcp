import { describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { crossTools } from "../../platforms/cross";
import { propertyLinkTools } from "../../platforms/cross/property-links";
import { ga4Tools } from "../../platforms/ga4";
import { googleTools } from "../../platforms/google";
import { gscTools } from "../../platforms/gsc";
import { gtmTools } from "../../platforms/gtm";

const inv = loadInventory();

describe("implementation plan (inventory/mapping.ts)", () => {
  it("maps every inventory tool to an API surface", () => {
    const unmapped = inv.filter((t) => mapTool(t).api.startsWith("UNMAPPED")).map((t) => t.name);
    expect(unmapped).toEqual([]);
  });

  it("risk tiers agree with the inventory: reads are read, deletes are destructive, other mutations are write or high_impact", () => {
    // Design 2026-11-10 section 6: publishing a Tag Manager version changes the live site with no API undo.
    // Bing (2026-11-10): removing pages from Bing results and moving the site are destructive although they create a setting.
    const destructiveUpdates = new Set(["publish_gtm_version", "block_bing_url", "submit_bing_site_move"]);
    for (const t of inv) {
      const { risk } = mapTool(t);
      if (!t.modifies_data) expect(risk, t.name).toBe("read");
      else if (t.action_type === "Delete" || destructiveUpdates.has(t.name)) expect(risk, t.name).toBe("destructive");
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

  it("Search Console, GA4 and Tag Manager tiers follow design section 6", () => {
    const risk = (n: string) => mapTool(inv.find((t) => t.name === n)!).risk;
    expect(Object.fromEntries(["submit_sitemap", "add_gsc_site", "delete_sitemap", "remove_gsc_site", "create_key_event", "remove_key_event", "create_custom_dimension", "create_ga4_audience", "create_gtm_tag", "update_gtm_tag", "create_gtm_trigger", "create_gtm_version", "publish_gtm_version"].map((n) => [n, risk(n)]))).toEqual({
      submit_sitemap: "write", add_gsc_site: "write", delete_sitemap: "destructive", remove_gsc_site: "destructive",
      create_key_event: "high_impact", remove_key_event: "destructive", create_custom_dimension: "write", create_ga4_audience: "write",
      create_gtm_tag: "high_impact", update_gtm_tag: "high_impact", create_gtm_trigger: "write", create_gtm_version: "write", publish_gtm_version: "destructive",
    });
  });

  it("every implemented tool declares exactly the risk tier the plan assigns it (a mis-tiered resume_* could be self-approved)", () => {
    expect(googleTools.length).toBeGreaterThan(0);
    // Google Ads plus the Search Console, GA4, Tag Manager and combined tools (their builders add to these lists).
    for (const tool of [...googleTools, ...gscTools, ...ga4Tools, ...gtmTools, ...propertyLinkTools, ...crossTools]) {
      const t = inv.find((i) => i.name === tool.name);
      expect(t, `${tool.name} is not in the inventory`).toBeDefined();
      const planned = mapTool(t!).risk;
      const declared = tool.kind === "read" ? "read" : tool.risk;
      expect(declared, `${tool.name}: declared ${declared}, planned ${planned}`).toBe(planned);
    }
  });
});
