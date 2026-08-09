import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Real Postgres connection factory (`drizzle-orm/node-postgres`), for
 * production/CLI use in place of the PGlite driver used in tests (see
 * `../pipeline/test-helpers/pglite-db.ts`). Kept as a thin factory rather
 * than a module-level singleton so callers (the pipeline orchestrator, and
 * eventually SolidStart server routes) control the connection's lifetime
 * explicitly.
 *
 * Returns the concrete `NodePgDatabase` (which structurally satisfies the
 * driver-agnostic `DrizzleDb` type used elsewhere in `pipeline/`) rather
 * than widening to `DrizzleDb` here, so callers keep access to `$client`
 * (the underlying `pg` `Pool`) to close the connection when done — `main()`
 * in `pipeline/run.ts` is the intended caller for that.
 */
export function createDb(databaseUrl: string): NodePgDatabase<typeof schema> & { $client: Pool } {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema });
}
