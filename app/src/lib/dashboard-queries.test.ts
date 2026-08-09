import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { commits, issues, pullRequests, repoAssessments, repos } from "../db/schema";
import type { DrizzleDb } from "../pipeline/db-types";
import { createTestDb } from "../pipeline/test-helpers/pglite-db";
import { getDashboardView, setRepoIgnoreControl } from "./dashboard-queries";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

async function insertRepo(
  db: DrizzleDb,
  overrides: Partial<typeof repos.$inferInsert> = {},
): Promise<void> {
  await db.insert(repos).values({
    repoId: 1,
    fullName: "sdpilon/example",
    isFork: false,
    isArchived: false,
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });
}

describe("getDashboardView", () => {
  it("returns a repo's latest assessment, including README from its input snapshot", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { isPrivate: true });
    await db.insert(repoAssessments).values([
      {
        repoId: 1,
        runId: "run-1",
        inputHash: "hash-1",
        pct: 40,
        band: "warn",
        label: "In progress",
        text: "old assessment",
        gaps: ["old gap"],
        inputSnapshot: { readmeText: "old readme" },
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        repoId: 1,
        runId: "run-2",
        inputHash: "hash-2",
        pct: 80,
        band: "good",
        label: "Shipped",
        text: "new assessment",
        gaps: [],
        inputSnapshot: { readmeText: "new readme" },
        createdAt: new Date("2026-02-01T00:00:00Z"),
      },
    ]);

    const view = await getDashboardView(db);
    expect(view.repos).toHaveLength(1);
    expect(view.repos[0].assessment).toEqual({
      pct: 80,
      band: "good",
      label: "Shipped",
      text: "new assessment",
      gaps: [],
      readmeText: "new readme",
    });
    expect(view.totals.privateCount).toBe(1);
  });

  it("falls back to 'Not yet assessed' with no README for a repo with no assessment row", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db);

    const view = await getDashboardView(db);
    expect(view.repos[0].assessment).toEqual({
      pct: null,
      band: "none",
      label: "Not yet assessed",
      text: "",
      gaps: [],
      readmeText: null,
    });
  });

  it("only surfaces ignore_reasons for auto-ignored repos, not manually-ignored ones", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, {
      isIgnored: true,
      ignoreSource: "auto",
      ignoreReasons: ["no README", "no activity"],
    });

    const view = await getDashboardView(db);
    expect(view.repos[0].ignoreReasons).toEqual(["no README", "no activity"]);

    await db.update(repos).set({ ignoreSource: "manual" }).where(eq(repos.repoId, 1));
    const manualView = await getDashboardView(db);
    expect(manualView.repos[0].ignoreReasons).toEqual([]);
  });

  it("aggregates totals across multiple repos' commits/issues/prs", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { repoId: 1, fullName: "sdpilon/one" });
    await insertRepo(db, { repoId: 2, fullName: "sdpilon/two" });
    await db.insert(commits).values([
      { repoId: 1, sha: "a", firstIngestedRunId: "run-1" },
      { repoId: 2, sha: "b", firstIngestedRunId: "run-1" },
    ]);
    await db.insert(pullRequests).values([
      { repoId: 1, number: 1, state: "open", lastUpdatedRunId: "run-1" },
      {
        repoId: 2,
        number: 1,
        state: "closed",
        mergedAt: new Date("2026-01-05T00:00:00Z"),
        lastUpdatedRunId: "run-1",
      },
    ]);
    await db.insert(issues).values([{ repoId: 1, number: 1, state: "open", lastUpdatedRunId: "run-1" }]);

    const view = await getDashboardView(db);
    expect(view.totals).toEqual({
      repoCount: 2,
      privateCount: 0,
      commitCount: 2,
      prCount: 2,
      mergedPrCount: 1,
      issueCount: 1,
    });
  });

  it("derives ignoreControl from ignore_source and is_ignored", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { ignoreSource: "auto", isIgnored: false });

    const autoView = await getDashboardView(db);
    expect(autoView.repos[0].ignoreControl).toBe("auto");

    await db.update(repos).set({ ignoreSource: "manual", isIgnored: true }).where(eq(repos.repoId, 1));
    const yesView = await getDashboardView(db);
    expect(yesView.repos[0].ignoreControl).toBe("yes");

    await db.update(repos).set({ ignoreSource: "manual", isIgnored: false }).where(eq(repos.repoId, 1));
    const noView = await getDashboardView(db);
    expect(noView.repos[0].ignoreControl).toBe("no");

    await db.update(repos).set({ ignoreSource: "auto", isIgnored: true }).where(eq(repos.repoId, 1));
    const autoIgnoredView = await getDashboardView(db);
    expect(autoIgnoredView.repos[0].ignoreControl).toBe("auto");
  });
});

describe("setRepoIgnoreControl", () => {
  it("'yes' sets is_ignored true and marks ignore_source manual", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { ignoreSource: "auto" });

    await setRepoIgnoreControl(db, 1, "yes");

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(true);
    expect(row.ignoreSource).toBe("manual");
  });

  it("'no' sets is_ignored false and marks ignore_source manual", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { ignoreSource: "auto", isIgnored: true });

    await setRepoIgnoreControl(db, 1, "no");

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(false);
    expect(row.ignoreSource).toBe("manual");
  });

  it("'auto' restores ignore_source without recomputing is_ignored", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { ignoreSource: "manual", isIgnored: true });

    await setRepoIgnoreControl(db, 1, "auto");

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.ignoreSource).toBe("auto");
    expect(row.isIgnored).toBe(true); // unchanged until the next pipeline run
  });
});

