import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { materializeMigrationsFolder } from "./migrations";

describe("materializeMigrationsFolder", () => {
  it("writes out a folder drizzle-orm's own migrator reads identically to the real drizzle/ folder", async () => {
    const dir = await materializeMigrationsFolder();

    const fromMaterialized = readMigrationFiles({ migrationsFolder: dir });
    const fromReal = readMigrationFiles({ migrationsFolder: "./drizzle" });

    expect(fromMaterialized).toEqual(fromReal);
    expect(fromMaterialized.length).toBeGreaterThan(0);
  });

  it("returns a fresh directory on each call", async () => {
    const first = await materializeMigrationsFolder();
    const second = await materializeMigrationsFolder();
    expect(first).not.toBe(second);
  });
});
