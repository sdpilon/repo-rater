import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Shared config resolver used by both the web app and the pipeline CLI: env
 * var wins, falling back to a local JSON config file so a self-hoster can
 * either export env vars (Docker Compose env_file, k8s secrets) or set
 * credentials through the dashboard UI, which writes to this same file.
 */

export interface ConfigOptions {
  configFilePath?: string;
}

function resolveConfigFilePath(options?: ConfigOptions): string {
  return options?.configFilePath ?? process.env.CONFIG_FILE_PATH ?? "./data/config.json";
}

function readConfigFile(configFilePath: string): Record<string, string> {
  try {
    const raw = readFileSync(configFilePath, "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** Empty/whitespace-only values are treated as unset from either source — a blank submitted field (see settings.ts) or a blank env var shouldn't count as "configured". */
function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

export function resolveConfig(key: string, options?: ConfigOptions): string | undefined {
  const envValue = process.env[key];
  if (!isBlank(envValue)) return envValue;
  const fileValue = readConfigFile(resolveConfigFilePath(options))[key];
  if (!isBlank(fileValue)) return fileValue;
  return undefined;
}

export function isConfigured(key: string, options?: ConfigOptions): boolean {
  return resolveConfig(key, options) !== undefined;
}

/**
 * Which source (if any) a key currently resolves from — used by the
 * settings UI to tell a self-hoster "this is set via environment variable,
 * changes here won't take effect" instead of silently no-op-ing a save.
 */
export function resolveConfigSource(key: string, options?: ConfigOptions): "env" | "file" | "unset" {
  if (!isBlank(process.env[key])) return "env";
  if (!isBlank(readConfigFile(resolveConfigFilePath(options))[key])) return "file";
  return "unset";
}

export function setConfigValue(key: string, value: string, options?: ConfigOptions): void {
  const configFilePath = resolveConfigFilePath(options);
  const current = readConfigFile(configFilePath);
  current[key] = value;
  // Config secrets (DB connection string, GitHub PAT, Anthropic key) should
  // never land world-readable on a shared homelab box. `mode` on mkdirSync/
  // writeFileSync only applies when the directory/file is newly created —
  // it's silently ignored if either already exists (e.g. a Docker bind-mount
  // pre-created it with the host's umask) — so chmod explicitly afterward.
  const configDir = dirname(configFilePath);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  writeFileSync(configFilePath, JSON.stringify(current, null, 2), { mode: 0o600 });
  chmodSync(configFilePath, 0o600);
}
