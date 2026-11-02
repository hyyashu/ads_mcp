import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };

/** Production: DATABASE_URL (Postgres). Development/tests: embedded Postgres (PGlite). */
export function createDb(opts: { url?: string; pgliteDir?: string } = {}): Db {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (url) return drizzlePostgres(postgres(url, { max: 10 }), { schema }) as unknown as Db;
  const dir = opts.pgliteDir;
  if (dir && dir !== "memory://") mkdirSync(dirname(dir), { recursive: true });
  return drizzlePglite(new PGlite(dir), { schema }) as unknown as Db;
}
