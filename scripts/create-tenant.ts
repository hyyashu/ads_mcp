/**
 * Bootstraps a workspace and its first owner, who can then sign in at /login to connect accounts and approve changes.
 *   npm run tenant:create -- "Agency Name" owner@example.com
 * The password is read from the ADS_MCP_OWNER_PASSWORD environment variable (never from argv, so it stays out of shell history).
 */
import { hashPassword } from "../src/auth/passwords";
import { createDb, schema } from "../src/db";

const [name, emailArg] = process.argv.slice(2);
const password = process.env.ADS_MCP_OWNER_PASSWORD;
if (!name || !emailArg || !password) {
  console.error('Usage: ADS_MCP_OWNER_PASSWORD=... npm run tenant:create -- "Agency Name" owner@example.com');
  process.exit(1);
}
if (password.length < 12) {
  console.error("Password must be at least 12 characters.");
  process.exit(1);
}
const db = createDb({ pgliteDir: process.env.PGLITE_DIR ?? ".data/pglite" });
const [tenant] = await db.insert(schema.tenant).values({ name }).returning();
const [user] = await db.insert(schema.appUser).values({ tenantId: tenant!.id, email: emailArg.trim().toLowerCase(), role: "owner", passwordHash: await hashPassword(password) }).returning();
console.log(`Created workspace "${name}" (${tenant!.id}) with owner ${user!.email}`);
process.exit(0);
