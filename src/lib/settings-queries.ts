import type Anthropic from "@anthropic-ai/sdk";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Octokit } from "octokit";
import { createDb } from "~/db/client";
import { createAnthropicClient } from "~/pipeline/anthropic/client";
import { createOctokit } from "~/pipeline/github/client";

/**
 * Save-time validation for each self-host credential: attempt a real call
 * against the actual service before the settings actions in ./settings.ts
 * persist anything, so a self-hoster pasting a malformed value finds out
 * immediately instead of on next real use. Each function takes an
 * injectable factory (defaulting to the real one) so tests never hit a real
 * DB/GitHub/Anthropic — same DI pattern createOctokit/createAnthropicClient
 * already use.
 */

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** How long save-time DB validation waits for a connection before giving up
 *  — an unreachable host/port (wrong IP, firewalled) would otherwise hang
 *  indefinitely, since `pg` has no connect timeout by default. */
const VALIDATION_CONNECT_TIMEOUT_MS = 5000;

/**
 * `pg` throws a Node `AggregateError` with an empty `.message` whenever a
 * hostname resolves to multiple addresses — exactly what happens for
 * `localhost` (`::1` + `127.0.0.1`), the single most likely first thing a
 * self-hoster types. Left unhandled, `err.message` is `""` and the
 * validation UI shows nothing at all. Join the wrapped sub-errors' messages
 * instead, and never return an empty string.
 */
function errorMessage(err: unknown): string {
  if (typeof AggregateError !== "undefined" && err instanceof AggregateError) {
    const joined = err.errors.map((subErr) => errorMessage(subErr)).join("; ");
    if (joined) return joined;
  }
  // Skip String(err) as a fallback for Error instances — Error.prototype.toString()
  // always yields at least "Error" (the name) even when .message is "", so it can
  // never actually surface the "never empty" fallback below.
  if (err instanceof Error) return err.message || "Connection failed";
  return String(err) || "Connection failed";
}

export async function validateDatabaseUrl(
  databaseUrl: string,
  dbFactory: typeof createDb = createDb,
  migrateFn: typeof migrate = migrate,
): Promise<ValidationResult> {
  const db = dbFactory(databaseUrl, {
    connectionTimeoutMillis: VALIDATION_CONNECT_TIMEOUT_MS,
  });
  try {
    await db.$client.query("SELECT 1");
    // Applies drizzle/*.sql if they haven't been (idempotent — tracked in
    // its own table) so a self-hoster pasting in a brand-new, schema-less
    // Postgres never reaches the dashboard before it has tables.
    await migrateFn(db, { migrationsFolder: "./drizzle" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    await db.$client.end();
  }
}

export async function validateGithubToken(
  token: string,
  octokitFactory: (env: NodeJS.ProcessEnv) => Octokit = createOctokit,
): Promise<ValidationResult> {
  try {
    const octokit = octokitFactory({
      PIPELINE_GH_TOKEN: token,
    } as NodeJS.ProcessEnv);
    await octokit.rest.users.getAuthenticated();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function validateAnthropicKey(
  apiKey: string,
  anthropicFactory: (
    env: NodeJS.ProcessEnv,
  ) => Anthropic = createAnthropicClient,
): Promise<ValidationResult> {
  try {
    const client = anthropicFactory({
      ANTHROPIC_API_KEY: apiKey,
    } as NodeJS.ProcessEnv);
    await client.models.list();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
