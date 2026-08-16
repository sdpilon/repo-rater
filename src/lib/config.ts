import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function resolveConfig(key: string, options?: ConfigOptions): string | undefined {
  const envValue = process.env[key];
  if (envValue) return envValue;
  return readConfigFile(resolveConfigFilePath(options))[key];
}

export function isConfigured(key: string, options?: ConfigOptions): boolean {
  return resolveConfig(key, options) !== undefined;
}

export function setConfigValue(key: string, value: string, options?: ConfigOptions): void {
  const configFilePath = resolveConfigFilePath(options);
  const current = readConfigFile(configFilePath);
  current[key] = value;
  mkdirSync(dirname(configFilePath), { recursive: true });
  writeFileSync(configFilePath, JSON.stringify(current, null, 2));
}
