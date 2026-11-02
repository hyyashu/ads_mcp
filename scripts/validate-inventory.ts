import { EXPECTED, loadInventory, validateInventory } from "../src/inventory";

const inv = loadInventory();
const problems = validateInventory(inv);
if (problems.length) {
  console.error(`Inventory INVALID:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Inventory valid: ${inv.length} tools (${EXPECTED.google_ads} Google Ads, ${EXPECTED.meta_ads} Meta Ads), all names unique, flags consistent.`);
