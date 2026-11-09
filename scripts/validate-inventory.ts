import { EXPECTED, PLATFORMS, loadInventory, validateInventory } from "../src/inventory";

const inv = loadInventory();
const problems = validateInventory(inv);
if (problems.length) {
  console.error(`Inventory INVALID:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Inventory valid: ${inv.length} tools (${PLATFORMS.map((p) => `${EXPECTED[p]} ${p}`).join(", ")}), all names unique, flags consistent.`);
