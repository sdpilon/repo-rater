import type { PgDatabase } from "drizzle-orm/pg-core";

/**
 * Structural type for a Drizzle Postgres database instance. Both the
 * production driver (`drizzle-orm/node-postgres`, once a real `DATABASE_URL`
 * exists) and the test driver (`drizzle-orm/pglite`, see
 * `test-helpers/pglite-db.ts`) return objects that extend `PgDatabase`, so
 * functions typed against this can accept either without depending on a
 * specific driver package. Kept in its own module (rather than inside
 * discover.ts or runs.ts) so both can import it without importing each
 * other.
 *
 * `any` is intentional here (not a shortcut): `PgDatabase`'s query-result
 * type parameter is driver-specific (`NodePgQueryResultHKT` vs.
 * `PgliteQueryResultHKT`), and this type exists precisely to abstract over
 * that difference so pipeline code doesn't have to pick one driver.
 */
// biome-ignore lint/suspicious/noExplicitAny: see comment above — deliberately driver-agnostic
export type DrizzleDb = PgDatabase<any, any, any>;
