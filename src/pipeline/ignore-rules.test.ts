import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { repos } from "../db/schema";
import {
  applyIgnoreDefaultForRepo,
  computeSuggestedIgnore,
} from "./ignore-rules";
import { createTestDb } from "./test-helpers/pglite-db";
import type { DrizzleDb } from "./db-types";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

describe("computeSuggestedIgnore", () => {
  it("flags a fork", () => {
    const { ignored, reasons } = computeSuggestedIgnore({
      isFork: true,
      isArchived: false,
      readme: "# hi",
      commitCount: 1,
      issueCount: 0,
      prCount: 0,
    });
    expect(ignored).toBe(true);
    expect(reasons).toEqual(["fork"]);
  });

  it("flags an archived repo", () => {
    const { reasons } = computeSuggestedIgnore({
      isFork: false,
      isArchived: true,
      readme: "# hi",
      commitCount: 1,
      issueCount: 0,
      prCount: 0,
    });
    expect(reasons).toEqual(["archived"]);
  });

  it("flags a missing or whitespace-only README", () => {
    expect(
      computeSuggestedIgnore({
        isFork: false,
        isArchived: false,
        readme: "",
        commitCount: 1,
        issueCount: 0,
        prCount: 0,
      }).reasons,
    ).toEqual(["no README"]);
    expect(
      computeSuggestedIgnore({
        isFork: false,
        isArchived: false,
        readme: "   \n",
        commitCount: 1,
        issueCount: 0,
        prCount: 0,
      }).reasons,
    ).toEqual(["no README"]);
  });

  it("flags zero total activity across commits/issues/prs", () => {
    const { ignored, reasons } = computeSuggestedIgnore({
      isFork: false,
      isArchived: false,
      readme: "# hi",
      commitCount: 0,
      issueCount: 0,
      prCount: 0,
    });
    expect(ignored).toBe(true);
    expect(reasons).toEqual(["no activity"]);
  });

  it("does not ignore an active, non-fork, non-archived repo with a README", () => {
    const { ignored, reasons } = computeSuggestedIgnore({
      isFork: false,
      isArchived: false,
      readme: "# hi",
      commitCount: 1,
      issueCount: 0,
      prCount: 0,
    });
    expect(ignored).toBe(false);
    expect(reasons).toEqual([]);
  });

  it("collects every matching reason at once", () => {
    const { reasons } = computeSuggestedIgnore({
      isFork: true,
      isArchived: true,
      readme: "",
      commitCount: 0,
      issueCount: 0,
      prCount: 0,
    });
    expect(reasons).toEqual(["fork", "archived", "no README", "no activity"]);
  });
});

async function insertRepo(
  db: DrizzleDb,
  overrides: Partial<typeof repos.$inferInsert> = {},
): Promise<void> {
  await db.insert(repos).values({
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    isFork: false,
    isArchived: false,
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });
}

describe("applyIgnoreDefaultForRepo", () => {
  it("sets is_ignored true, ignore_source 'auto', and ignore_reasons for a repo with no activity", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db);

    const result = await applyIgnoreDefaultForRepo(db, 1, {
      readme: "",
      commitCount: 0,
      issueCount: 0,
      prCount: 0,
    });
    expect(result.ignored).toBe(true);
    expect(result.reasons).toEqual(["no README", "no activity"]);

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(true);
    expect(row.ignoreSource).toBe("auto");
    expect(row.ignoreReasons).toEqual(["no README", "no activity"]);
  });

  it("sets is_ignored false and clears ignore_reasons for an active repo", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { isIgnored: true, ignoreReasons: ["no activity"] });

    const result = await applyIgnoreDefaultForRepo(db, 1, {
      readme: "# hi",
      commitCount: 3,
      issueCount: 0,
      prCount: 0,
    });
    expect(result.ignored).toBe(false);
    expect(result.reasons).toEqual([]);

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(false);
    expect(row.ignoreReasons).toEqual([]);
  });

  it("never recomputes or overwrites a manually-set ignore_source", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { isIgnored: false, ignoreSource: "manual" });

    const result = await applyIgnoreDefaultForRepo(db, 1, {
      readme: "",
      commitCount: 0,
      issueCount: 0,
      prCount: 0,
    });
    expect(result.ignored).toBe(false);
    expect(result.reasons).toEqual([]);

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(false);
    expect(row.ignoreSource).toBe("manual");
  });
});
