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
export interface CreateDbOptions {
  /** Passed straight through to `pg.Pool` — how long to wait for a new
   *  connection before rejecting, instead of `pg`'s default of no timeout.
   *  Left unset for the pipeline's long-lived connection; save-time
   *  credential validation sets this so an unreachable host/port fails
   *  fast instead of hanging indefinitely. */
  connectionTimeoutMillis?: number;
}

export function createDb(
  databaseUrl: string,
  options?: CreateDbOptions,
): NodePgDatabase<typeof schema> & { $client: Pool } {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: options?.connectionTimeoutMillis,
  });
  return drizzle(pool, { schema });
}
