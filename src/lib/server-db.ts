import { createDb } from "~/db/client";
import { isConfigured, resolveConfig } from "./config";

let cachedDb: ReturnType<typeof createDb> | undefined;

/** Cheap presence check — never creates a client. */
export function isDbConfigured(): boolean {
  return isConfigured("DATABASE_URL");
}

/** How long a live request waits for a DB connection before giving up — an
 *  unreachable host/port (wrong value, firewalled) would otherwise hang
 *  indefinitely, since `pg` has no connect timeout by default. Same value
 *  and reasoning as `VALIDATION_CONNECT_TIMEOUT_MS` in `./settings-queries.ts`. */
const CONNECT_TIMEOUT_MS = 5000;

/**
 * Lazy, memoized DB client. Resolves DATABASE_URL (env var, else the local
 * config file) on first call and caches the client after. Editing an
 * already-set DATABASE_URL via the settings UI requires a server restart to
 * take effect — no hot-reconnect, by design (see spec).
 */
export function getDb(): ReturnType<typeof createDb> {
  if (!cachedDb) {
    const databaseUrl = resolveConfig("DATABASE_URL");
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is not configured — set the DATABASE_URL environment variable or configure it via the dashboard settings.",
      );
    }
    cachedDb = createDb(databaseUrl, {
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
  }
  return cachedDb;
}
