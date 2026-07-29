import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DrizzleDb } from "../db-types";

/**
 * Real (WASM, in-process, no server/network) Postgres for pipeline tests,
 * via PGlite + Drizzle's `drizzle-orm/pglite` driver — Drizzle's own
 * documented approach for testing against real Postgres semantics without a
 * live server. Used in place of the old suite's DuckDB `:memory:` database
 * so upsert/ON CONFLICT behavior is exercised for real, not just asserted
 * against a mocked query builder.
 *
 * Schema is applied by running the generated migration SQL
 * (`drizzle/0000_sweet_selene.sql`) directly against a fresh PGlite
 * instance, mirroring the old tests' `ensureSchema(db)` call.
 */

const migrationPath = fileURLToPath(new URL("../../../drizzle/0000_sweet_selene.sql", import.meta.url));

export async function createTestDb(): Promise<{ db: DrizzleDb; close: () => Promise<void> }> {
  const client = new PGlite();
  const migrationSql = readFileSync(migrationPath, "utf8");
  for (const statement of migrationSql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) {
      await client.exec(trimmed);
    }
  }
  const db = drizzle(client);
  return { db, close: () => client.close() };
}
