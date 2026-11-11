import { describe, expect, it } from "vitest";
import { EXPECTED, PLATFORMS, loadInventory, validateInventory } from "../../inventory";

describe("tool inventory", () => {
  const inv = loadInventory();

  it("contains exactly the 383 expected tools (217 Google Ads, 61 Meta, 13 Search Console, 23 GA4, 13 Tag Manager, 56 Bing Webmaster) with unique names", () => {
    expect(inv).toHaveLength(EXPECTED.total);
    for (const p of PLATFORMS) expect(inv.filter((t) => t.platform === p), p).toHaveLength(EXPECTED[p]);
    expect(new Set(inv.map((t) => t.name)).size).toBe(EXPECTED.total);
  });

  it("is internally consistent", () => {
    expect(validateInventory(inv)).toEqual([]);
  });

  it("every modifying tool requires approval and no read/analyze tool does", () => {
    for (const t of inv) expect(t.approval_required).toBe(t.action_type === "Create" || t.action_type === "Update" || t.action_type === "Delete");
  });

  it("detects corruption", () => {
    const dup = [...inv, inv[0]!];
    expect(validateInventory(dup).join("\n")).toMatch(/duplicate tool name/);
    const lie = inv.map((t, i) => (i === 0 ? { ...t, modifies_data: !t.modifies_data } : t));
    expect(validateInventory(lie).join("\n")).toMatch(/contradicts action_type/);
    expect(validateInventory(inv.slice(1)).join("\n")).toMatch(/expected 383/);
  });
});
