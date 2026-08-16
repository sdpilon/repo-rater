import { action, query } from "@solidjs/router";
import { assertAuthenticated } from "./auth-guard";
import { isConfigured, setConfigValue } from "./config";
import { validateAnthropicKey, validateDatabaseUrl, validateGithubToken } from "./settings-queries";

export const getCredentialStatus = query(async () => {
  "use server";
  assertAuthenticated();
  return {
    databaseConfigured: isConfigured("DATABASE_URL"),
    githubTokenConfigured: isConfigured("PIPELINE_GH_TOKEN"),
    anthropicKeyConfigured: isConfigured("ANTHROPIC_API_KEY"),
  };
}, "credentialStatus");

export const saveDatabaseUrl = action(async (formData: FormData) => {
  "use server";
  assertAuthenticated();
  const value = String(formData.get("databaseUrl") ?? "").trim();
  const result = await validateDatabaseUrl(value);
  if (!result.ok) return { error: result.error };
  setConfigValue("DATABASE_URL", value);
  return { error: null };
}, "saveDatabaseUrl");

export const saveGithubToken = action(async (formData: FormData) => {
  "use server";
  assertAuthenticated();
  const value = String(formData.get("githubToken") ?? "").trim();
  const result = await validateGithubToken(value);
  if (!result.ok) return { error: result.error };
  setConfigValue("PIPELINE_GH_TOKEN", value);
  return { error: null };
}, "saveGithubToken");

export const saveAnthropicKey = action(async (formData: FormData) => {
  "use server";
  assertAuthenticated();
  const value = String(formData.get("anthropicKey") ?? "").trim();
  const result = await validateAnthropicKey(value);
  if (!result.ok) return { error: result.error };
  setConfigValue("ANTHROPIC_API_KEY", value);
  return { error: null };
}, "saveAnthropicKey");
