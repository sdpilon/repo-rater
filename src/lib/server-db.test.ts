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
    await expect(getDb()).rejects.toThrow(/DATABASE_URL/);
  });

  it("memoizes the client across calls, applying migrations only once", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getDb } = await import("./server-db");
    const fakeDb = {};
    const dbFactory = vi.fn().mockReturnValue(fakeDb);
    const migrateFn = vi.fn().mockResolvedValue(undefined);

    const first = await getDb(dbFactory, migrateFn);
    const second = await getDb(dbFactory, migrateFn);

    expect(first).toBe(second);
    expect(dbFactory).toHaveBeenCalledTimes(1);
    expect(migrateFn).toHaveBeenCalledTimes(1);
  });

  it("applies drizzle migrations on first call, same as the settings-UI save path", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getDb } = await import("./server-db");
    const fakeDb = {};
    const dbFactory = vi.fn().mockReturnValue(fakeDb);
    const migrateFn = vi.fn().mockResolvedValue(undefined);
    const materialize = vi.fn().mockResolvedValue("/tmp/fake-migrations");

    await getDb(dbFactory, migrateFn, materialize);

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(migrateFn).toHaveBeenCalledWith(fakeDb, {
      migrationsFolder: "/tmp/fake-migrations",
    });
  });

  it("does not cache the client when migration fails, so a later call can retry", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getDb } = await import("./server-db");
    const fakeDb = {};
    const dbFactory = vi.fn().mockReturnValue(fakeDb);
    const migrateFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    await expect(getDb(dbFactory, migrateFn)).rejects.toThrow("boom");
    const db = await getDb(dbFactory, migrateFn);

    expect(db).toBe(fakeDb);
    expect(dbFactory).toHaveBeenCalledTimes(2);
    expect(migrateFn).toHaveBeenCalledTimes(2);
  });
});
