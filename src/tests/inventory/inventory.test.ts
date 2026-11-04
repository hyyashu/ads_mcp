import { describe, expect, it } from "vitest";
import { EXPECTED, loadInventory, validateInventory } from "../../inventory";

describe("tool inventory", () => {
  const inv = loadInventory();

  it("contains exactly the 232 expected tools (172 Google, 60 Meta) with unique names", () => {
    expect(inv).toHaveLength(EXPECTED.total);
    expect(inv.filter((t) => t.platform === "google_ads")).toHaveLength(EXPECTED.google_ads);
    expect(inv.filter((t) => t.platform === "meta_ads")).toHaveLength(EXPECTED.meta_ads);
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
    expect(validateInventory(inv.slice(1)).join("\n")).toMatch(/expected 232/);
  });
});
