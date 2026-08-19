import { afterEach, describe, expect, it } from "vitest";
import { commits, issues, pullRequests, repoAssessments, repos } from "../db/schema";
import { seedFakeData } from "./seed-fake-data";
import { createTestDb } from "./test-helpers/pglite-db";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

describe("seedFakeData", () => {
  it("refuses to run when the repos table already has rows, without --force", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await db.insert(repos).values({
      repoId: 1,
      fullName: "someone/existing-repo",
      isIgnored: false,
      ignoreSource: "auto",
      assessmentSource: "auto",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    await expect(seedFakeData(db)).rejects.toThrow(/already has repos/i);
  });

  it("seeds anyway when the repos table already has rows and force is true", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await db.insert(repos).values({
      repoId: 1,
      fullName: "someone/existing-repo",
      isIgnored: false,
      ignoreSource: "auto",
      assessmentSource: "auto",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    await seedFakeData(db, { force: true });

    const allRepos = await db.select().from(repos);
    expect(allRepos.length).toBeGreaterThan(1);
  });

  it("re-seeding with force is idempotent, without primary-key collisions on its own fixture rows", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const first = await seedFakeData(db);
    await expect(seedFakeData(db, { force: true })).resolves.toEqual(first);

    const allRepos = await db.select().from(repos);
    expect(allRepos).toHaveLength(first.repoCount);
  });

  it("populates repos spanning good/warn/crit/unassessed/ignored/private variety", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await seedFakeData(db);

    const repoRows = await db.select().from(repos);
    expect(repoRows.length).toBeGreaterThanOrEqual(6);

    const assessmentRows = await db.select().from(repoAssessments);
    const bands = new Set(assessmentRows.map((a) => a.band));
    expect(bands).toContain("good");
    expect(bands).toContain("warn");
    expect(bands).toContain("crit");

    const assessedRepoIds = new Set(assessmentRows.map((a) => a.repoId));
    expect(repoRows.some((r) => !assessedRepoIds.has(r.repoId))).toBe(true);
    expect(repoRows.some((r) => r.isIgnored)).toBe(true);
    expect(repoRows.some((r) => r.isPrivate)).toBe(true);
  });

  it("gives assessed repos a rendered README via the assessment's input snapshot", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await seedFakeData(db);

    const assessmentRows = await db.select().from(repoAssessments);
    expect(assessmentRows.length).toBeGreaterThan(0);
    for (const row of assessmentRows) {
      const snapshot = row.inputSnapshot;
      expect(snapshot).toMatchObject({ readmeText: expect.any(String) });
      expect((snapshot as { readmeText: string }).readmeText.length).toBeGreaterThan(0);
    }
  });

  it("seeds commits, issues, and pull requests for the fake repos", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await seedFakeData(db);

    const [commitRows, issueRows, prRows] = await Promise.all([
      db.select().from(commits),
      db.select().from(issues),
      db.select().from(pullRequests),
    ]);
    expect(commitRows.length).toBeGreaterThan(0);
    expect(issueRows.length).toBeGreaterThan(0);
    expect(prRows.length).toBeGreaterThan(0);
  });

  it("gives each repo a full_name namespaced under a clearly fake account", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await seedFakeData(db);

    const repoRows = await db.select({ fullName: repos.fullName }).from(repos);
    for (const { fullName } of repoRows) {
      expect(fullName).toMatch(/^demo-user\//);
    }
  });
});
