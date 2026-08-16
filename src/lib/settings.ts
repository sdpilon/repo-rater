import { action, query } from "@solidjs/router";
import { isAppPasswordConfigured } from "./auth";
import { assertAuthenticated } from "./auth-guard";
import { resolveConfigSource, setConfigValue } from "./config";
import { validateAnthropicKey, validateDatabaseUrl, validateGithubToken } from "./settings-queries";

export interface CredentialFieldStatus {
  configured: boolean;
  /**
   * Which source a credential currently resolves from. The UI uses this to
   * disable the field and explain itself when a credential is set via env
   * var — saving through the form in that case would write the file but the
   * app would keep using the (unchanged) env var forever, silently.
   */
  source: "env" | "file" | "unset";
}

function fieldStatus(key: string): CredentialFieldStatus {
  const source = resolveConfigSource(key);
  return { configured: source !== "unset", source };
}

export const getCredentialStatus = query(async () => {
  "use server";
  assertAuthenticated();
  return {
    database: fieldStatus("DATABASE_URL"),
    githubToken: fieldStatus("PIPELINE_GH_TOKEN"),
    anthropicKey: fieldStatus("ANTHROPIC_API_KEY"),
    // APP_PASSWORD is deliberately not a UI field (see spec) — this is
    // surfaced only so the panel can show a one-line no-auth-gate notice.
    appPasswordConfigured: isAppPasswordConfigured(),
  };
}, "credentialStatus");

/**
 * Persists a validated credential, guarding against `setConfigValue`
 * throwing (e.g. EROFS/EACCES on a read-only filesystem) so the action
 * always resolves to `{ error: string | null }` instead of rejecting.
 */
function persist(key: string, value: string): { error: string | null } {
  try {
    setConfigValue(key, value);
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to save the value." };
  }
}

export const saveDatabaseUrl = action(async (formData: FormData) => {
  "use server";
  assertAuthenticated();
  const value = String(formData.get("databaseUrl") ?? "").trim();
  if (!value) return { error: "Database connection string is required." };
  const result = await validateDatabaseUrl(value);
  if (!result.ok) return { error: result.error };
  return persist("DATABASE_URL", value);
}, "saveDatabaseUrl");

export const saveGithubToken = action(async (formData: FormData) => {
  "use server";
  assertAuthenticated();
  const value = String(formData.get("githubToken") ?? "").trim();
  if (!value) return { error: "GitHub personal access token is required." };
  const result = await validateGithubToken(value);
  if (!result.ok) return { error: result.error };
  return persist("PIPELINE_GH_TOKEN", value);
}, "saveGithubToken");

export const saveAnthropicKey = action(async (formData: FormData) => {
  "use server";
  assertAuthenticated();
  const value = String(formData.get("anthropicKey") ?? "").trim();
  if (!value) return { error: "Anthropic API key is required." };
  const result = await validateAnthropicKey(value);
  if (!result.ok) return { error: result.error };
  return persist("ANTHROPIC_API_KEY", value);
}, "saveAnthropicKey");
