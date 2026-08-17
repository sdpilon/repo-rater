import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route resolveConfig/isConfigured straight through process.env for this
// test file — same behavior the old direct process.env.DATABASE_URL read
// had, without coupling these tests to any real config file on disk.
vi.mock("./config", () => ({
  resolveConfig: (key: string) => process.env[key],
  isConfigured: (key: string) => process.env[key] !== undefined,
}));

const originalDatabaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("isDbConfigured", () => {
  it("is false when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const { isDbConfigured } = await import("./server-db");
    expect(isDbConfigured()).toBe(false);
  });

  it("is true when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { isDbConfigured } = await import("./server-db");
    expect(isDbConfigured()).toBe(true);
  });
});

describe("getDb", () => {
  it("throws a clear error when unconfigured", async () => {
    delete process.env.DATABASE_URL;
    const { getDb } = await import("./server-db");
    expect(() => getDb()).toThrow(/DATABASE_URL/);
  });

  it("memoizes the client across calls", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getDb } = await import("./server-db");
    expect(getDb()).toBe(getDb());
  });
});
