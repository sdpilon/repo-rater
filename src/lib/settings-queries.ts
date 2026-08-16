import type Anthropic from "@anthropic-ai/sdk";
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function validateDatabaseUrl(
  databaseUrl: string,
  dbFactory: typeof createDb = createDb,
): Promise<ValidationResult> {
  const db = dbFactory(databaseUrl);
  try {
    await db.$client.query("SELECT 1");
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
    const octokit = octokitFactory({ PIPELINE_GH_TOKEN: token } as NodeJS.ProcessEnv);
    await octokit.rest.users.getAuthenticated();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function validateAnthropicKey(
  apiKey: string,
  anthropicFactory: (env: NodeJS.ProcessEnv) => Anthropic = createAnthropicClient,
): Promise<ValidationResult> {
  try {
    const client = anthropicFactory({ ANTHROPIC_API_KEY: apiKey } as NodeJS.ProcessEnv);
    await client.models.list();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
