import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isConfigured, resolveConfig, setConfigValue } from "./config";

let tempDir: string;
let configFilePath: string;
const originalTestKey = process.env.TEST_CONFIG_KEY;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tracker-config-test-"));
  configFilePath = join(tempDir, "config.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (originalTestKey === undefined) delete process.env.TEST_CONFIG_KEY;
  else process.env.TEST_CONFIG_KEY = originalTestKey;
});

describe("resolveConfig", () => {
  it("returns undefined when neither env var nor file has the key", () => {
    delete process.env.TEST_CONFIG_KEY;
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath })).toBeUndefined();
  });

  it("returns the env var value when set, ignoring the file", () => {
    process.env.TEST_CONFIG_KEY = "from-env";
    setConfigValue("TEST_CONFIG_KEY", "from-file", { configFilePath });
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath })).toBe("from-env");
  });

  it("falls back to the config file when the env var is unset", () => {
    delete process.env.TEST_CONFIG_KEY;
    setConfigValue("TEST_CONFIG_KEY", "from-file", { configFilePath });
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath })).toBe("from-file");
  });

  it("returns undefined when the config file doesn't exist yet", () => {
    delete process.env.TEST_CONFIG_KEY;
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath: join(tempDir, "missing.json") })).toBeUndefined();
  });
});

describe("isConfigured", () => {
  it("is false when unresolved, true once set", () => {
    delete process.env.TEST_CONFIG_KEY;
    expect(isConfigured("TEST_CONFIG_KEY", { configFilePath })).toBe(false);
    setConfigValue("TEST_CONFIG_KEY", "value", { configFilePath });
    expect(isConfigured("TEST_CONFIG_KEY", { configFilePath })).toBe(true);
  });
});

describe("setConfigValue", () => {
  it("creates the parent directory and file if missing", () => {
    const nestedPath = join(tempDir, "nested", "dir", "config.json");
    setConfigValue("TEST_CONFIG_KEY", "value", { configFilePath: nestedPath });
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath: nestedPath })).toBe("value");
  });

  it("merges with existing keys instead of overwriting the file", () => {
    setConfigValue("FIRST_KEY", "first", { configFilePath });
    setConfigValue("SECOND_KEY", "second", { configFilePath });
    expect(resolveConfig("FIRST_KEY", { configFilePath })).toBe("first");
    expect(resolveConfig("SECOND_KEY", { configFilePath })).toBe("second");
  });

  it("overwrites an existing value for the same key", () => {
    setConfigValue("TEST_CONFIG_KEY", "old", { configFilePath });
    setConfigValue("TEST_CONFIG_KEY", "new", { configFilePath });
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath })).toBe("new");
  });
});
