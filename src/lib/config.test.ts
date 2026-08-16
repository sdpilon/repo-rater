import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isConfigured, resolveConfig, resolveConfigSource, setConfigValue } from "./config";

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

  // Finding 3: a blank DATABASE_URL submission must not be treated as
  // "configured" — otherwise isConfigured("DATABASE_URL") returns true for
  // an empty string, the route renders the "configured" branch, and getDb()
  // throws because resolveConfig("DATABASE_URL") is falsy. Both the env var
  // and the file value need this same blank-is-unset normalization.
  it("treats an empty-string file value as unset, not as configured", () => {
    delete process.env.TEST_CONFIG_KEY;
    setConfigValue("TEST_CONFIG_KEY", "", { configFilePath });
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath })).toBeUndefined();
    expect(isConfigured("TEST_CONFIG_KEY", { configFilePath })).toBe(false);
  });

  it("treats a whitespace-only env var as unset, falling back to the file", () => {
    process.env.TEST_CONFIG_KEY = "   ";
    setConfigValue("TEST_CONFIG_KEY", "from-file", { configFilePath });
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath })).toBe("from-file");
  });

  it("treats a whitespace-only file value as unset when the env var is also unset", () => {
    delete process.env.TEST_CONFIG_KEY;
    setConfigValue("TEST_CONFIG_KEY", "   ", { configFilePath });
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath })).toBeUndefined();
  });
});

describe("resolveConfigSource", () => {
  it("reports env, file, or unset depending on where the key resolves from", () => {
    delete process.env.TEST_CONFIG_KEY;
    expect(resolveConfigSource("TEST_CONFIG_KEY", { configFilePath })).toBe("unset");

    setConfigValue("TEST_CONFIG_KEY", "from-file", { configFilePath });
    expect(resolveConfigSource("TEST_CONFIG_KEY", { configFilePath })).toBe("file");

    process.env.TEST_CONFIG_KEY = "from-env";
    expect(resolveConfigSource("TEST_CONFIG_KEY", { configFilePath })).toBe("env");
  });

  it("reports unset for a blank value from either source", () => {
    process.env.TEST_CONFIG_KEY = "   ";
    expect(resolveConfigSource("TEST_CONFIG_KEY", { configFilePath })).toBe("unset");
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

  // Finding 4: the config file holds a GitHub PAT, Anthropic key, and DB
  // connection string/password — it must not land world-readable on a
  // shared homelab box.
  it("writes the config file 0600 and its parent directory 0700", () => {
    const nestedPath = join(tempDir, "secure", "config.json");
    setConfigValue("TEST_CONFIG_KEY", "value", { configFilePath: nestedPath });
    expect(statSync(nestedPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(nestedPath)).mode & 0o777).toBe(0o700);
  });
});
