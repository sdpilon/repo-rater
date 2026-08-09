import { eq } from "drizzle-orm";
import type { Octokit } from "octokit";
import { afterEach, describe, expect, it } from "vitest";
import { commits, fetchFailures, issues, pullRequests } from "../db/schema";
import {
  DEFAULT_SINCE,
  extractLoadAll,
  extractLoadRepo,
  getWatermark,
  recordFailure,
  setWatermark,
  upsertCommit,
  upsertIssue,
  upsertPr,
} from "./extract-load";
import type { Commit, Issue, PullRequest } from "./github/client";
import { createTestDb } from "./test-helpers/pglite-db";

// A fake Octokit is enough — every test injects fetchCommits/fetchIssues/
// fetchPrs, so the real Octokit-backed functions are never called. Mirrors
// the fake-Octokit pattern in discover.test.ts / github/client.test.ts.
const fakeOctokit = {} as Octokit;

const COMMIT: Commit = {
  sha: "aaa",
  authorName: "Spencer",
  authoredAt: "2026-07-01T00:00:00Z",
  message: "fix",
};

const ISSUE: Issue = {
  number: 1,
  title: "Bug",
  state: "open",
  createdAt: "2026-07-01T00:00:00Z",
  closedAt: null,
  labels: ["bug"],
};

const PR: PullRequest = {
  number: 5,
  title: "Add feature",
  state: "closed",
  createdAt: "2026-07-01T00:00:00Z",
  mergedAt: "2026-07-02T00:00:00Z",
};

async function okCommits(): Promise<Commit[]> {
  return [COMMIT];
}
async function okIssues(): Promise<Issue[]> {
  return [ISSUE];
}
async function okPrs(): Promise<PullRequest[]> {
  return [PR];
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

describe("getWatermark / setWatermark", () => {
  it("returns null when no watermark is stored yet", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const watermark = await getWatermark(db, 1, "commits");
    expect(watermark).toBeNull();
  });

  it("returns the stored watermark after setWatermark, and overwrites both columns on a second call", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await setWatermark(db, 1, "commits", new Date("2026-07-01T00:00:00.000Z"), "run_1");
    expect((await getWatermark(db, 1, "commits"))?.toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );

    await setWatermark(db, 1, "commits", new Date("2026-07-02T00:00:00.000Z"), "run_2");
    expect((await getWatermark(db, 1, "commits"))?.toISOString()).toBe(
      "2026-07-02T00:00:00.000Z",
    );
  });
});

describe("upsertCommit", () => {
  it("preserves first_ingested_run_id across repeated upserts of the same commit", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await upsertCommit(db, 1, COMMIT, "run_1");
    await upsertCommit(db, 1, { ...COMMIT, message: "fix v2" }, "run_2");

    const rows = await db.select().from(commits).where(eq(commits.sha, "aaa"));
    expect(rows).toHaveLength(1);
    expect(rows[0].firstIngestedRunId).toBe("run_1");
    expect(rows[0].message).toBe("fix v2");
  });
});

describe("upsertIssue / upsertPr", () => {
  it("upserts an issue with labels and last_updated_run_id", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await upsertIssue(db, 1, ISSUE, "run_1");
    const rows = await db.select().from(issues).where(eq(issues.number, 1));
    expect(rows[0].labels).toEqual(["bug"]);
    expect(rows[0].lastUpdatedRunId).toBe("run_1");
  });

  it("upserts a pull request with merged_at", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await upsertPr(db, 1, PR, "run_1");
    const rows = await db.select().from(pullRequests).where(eq(pullRequests.number, 5));
    expect(rows[0].title).toBe("Add feature");
    expect(rows[0].mergedAt?.toISOString()).toBe("2026-07-02T00:00:00.000Z");
  });
});

describe("recordFailure", () => {
  it("records a fetch_failures row with the run id, repo id, data type, and error message", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await recordFailure(db, "run_1", 1, "commits", "rate limited", new Date("2026-07-22T00:00:00.000Z"));

    const rows = await db.select().from(fetchFailures).where(eq(fetchFailures.repoId, 1));
    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBe("run_1");
    expect(rows[0].dataType).toBe("commits");
    expect(rows[0].errorMessage).toBe("rate limited");
  });
});

describe("extractLoadRepo", () => {
  it("fetches and upserts commits/issues/prs, and advances all three watermarks on success", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const now = new Date("2026-07-22T00:00:00.000Z");
    const results = await extractLoadRepo({
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      db,
      runId: "run_1",
      octokit: fakeOctokit,
      now,
      fetchCommits: okCommits,
      fetchIssues: okIssues,
      fetchPrs: okPrs,
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "ok")).toBe(true);

    const commitRows = await db.select().from(commits).where(eq(commits.repoId, 1));
    expect(commitRows).toHaveLength(1);
    const issueRows = await db.select().from(issues).where(eq(issues.repoId, 1));
    expect(issueRows).toHaveLength(1);
    const prRows = await db.select().from(pullRequests).where(eq(pullRequests.repoId, 1));
    expect(prRows).toHaveLength(1);

    expect((await getWatermark(db, 1, "commits"))?.toISOString()).toBe(now.toISOString());
    expect((await getWatermark(db, 1, "issues"))?.toISOString()).toBe(now.toISOString());
    expect((await getWatermark(db, 1, "prs"))?.toISOString()).toBe(now.toISOString());
  });

  it("uses DEFAULT_SINCE as the since= cursor when no watermark is stored yet", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    let capturedSince: string | null = null;
    await extractLoadRepo({
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      db,
      runId: "run_1",
      octokit: fakeOctokit,
      now: new Date("2026-07-22T00:00:00.000Z"),
      fetchCommits: async (_fullName, since) => {
        capturedSince = since;
        return [];
      },
      fetchIssues: okIssues,
      fetchPrs: okPrs,
    });

    expect(capturedSince).toBe(DEFAULT_SINCE);
  });

  it("uses the stored watermark's timestamp as the since= cursor on a later run", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await setWatermark(db, 1, "commits", new Date("2026-07-15T00:00:00.000Z"), "run_1");

    let capturedSince: string | null = null;
    await extractLoadRepo({
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      db,
      runId: "run_2",
      octokit: fakeOctokit,
      now: new Date("2026-07-22T00:00:00.000Z"),
      fetchCommits: async (_fullName, since) => {
        capturedSince = since;
        return [];
      },
      fetchIssues: okIssues,
      fetchPrs: okPrs,
    });

    expect(capturedSince).toBe("2026-07-15T00:00:00.000Z");
  });

  it("isolates a single data-type failure: records fetch_failures and does not advance that watermark, without blocking the other data types", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const now = new Date("2026-07-22T00:00:00.000Z");
    const results = await extractLoadRepo({
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      db,
      runId: "run_1",
      octokit: fakeOctokit,
      now,
      fetchCommits: async () => {
        throw new Error("rate limited");
      },
      fetchIssues: okIssues,
      fetchPrs: okPrs,
    });

    const commitResult = results.find((r) => r.dataType === "commits");
    expect(commitResult?.status).toBe("error");
    expect(commitResult?.error).toMatch(/rate limited/);
    const issueResult = results.find((r) => r.dataType === "issues");
    expect(issueResult?.status).toBe("ok");
    const prResult = results.find((r) => r.dataType === "prs");
    expect(prResult?.status).toBe("ok");

    // commits watermark was not advanced
    expect(await getWatermark(db, 1, "commits")).toBeNull();
    // issues/prs watermarks were advanced despite the commits failure
    expect((await getWatermark(db, 1, "issues"))?.toISOString()).toBe(now.toISOString());
    expect((await getWatermark(db, 1, "prs"))?.toISOString()).toBe(now.toISOString());

    // no commit rows were written, but issues/prs were
    const commitRows = await db.select().from(commits).where(eq(commits.repoId, 1));
    expect(commitRows).toHaveLength(0);
    const issueRows = await db.select().from(issues).where(eq(issues.repoId, 1));
    expect(issueRows).toHaveLength(1);

    // a fetch_failures row was recorded for the failing data type only
    const failures = await db.select().from(fetchFailures).where(eq(fetchFailures.repoId, 1));
    expect(failures).toHaveLength(1);
    expect(failures[0].dataType).toBe("commits");
    expect(failures[0].errorMessage).toMatch(/rate limited/);
  });

  it("preserves first_ingested_run_id across a second extractLoadRepo run for the same commit", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await extractLoadRepo({
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      db,
      runId: "run_1",
      octokit: fakeOctokit,
      now: new Date("2026-07-20T00:00:00.000Z"),
      fetchCommits: okCommits,
      fetchIssues: async () => [],
      fetchPrs: async () => [],
    });

    await extractLoadRepo({
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      db,
      runId: "run_2",
      octokit: fakeOctokit,
      now: new Date("2026-07-22T00:00:00.000Z"),
      fetchCommits: async () => [{ ...COMMIT, message: "fix v2" }],
      fetchIssues: async () => [],
      fetchPrs: async () => [],
    });

    const rows = await db.select().from(commits).where(eq(commits.sha, "aaa"));
    expect(rows[0].firstIngestedRunId).toBe("run_1");
    expect(rows[0].message).toBe("fix v2");
  });
});

describe("extractLoadAll", () => {
  it("processes multiple repos and returns results for all of them", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const results = await extractLoadAll({
      repos: [
        { repoId: 1, fullName: "sdpilon/spilon.dev" },
        { repoId: 2, fullName: "sdpilon/typst-resume" },
      ],
      db,
      runId: "run_1",
      octokit: fakeOctokit,
      now: new Date("2026-07-22T00:00:00.000Z"),
      fetchCommits: okCommits,
      fetchIssues: okIssues,
      fetchPrs: okPrs,
    });

    expect(results.filter((r) => r.status === "ok")).toHaveLength(6);
    const repo1Commits = await db.select().from(commits).where(eq(commits.repoId, 1));
    const repo2Commits = await db.select().from(commits).where(eq(commits.repoId, 2));
    expect(repo1Commits).toHaveLength(1);
    expect(repo2Commits).toHaveLength(1);
  });

  it("isolates one repo's total failure: the rest of the batch is still processed", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const results = await extractLoadAll({
      repos: [
        { repoId: 1, fullName: "sdpilon/broken-repo" },
        { repoId: 2, fullName: "sdpilon/spilon.dev" },
      ],
      db,
      runId: "run_1",
      octokit: fakeOctokit,
      now: new Date("2026-07-22T00:00:00.000Z"),
      fetchCommits: okCommits,
      fetchIssues: okIssues,
      fetchPrs: okPrs,
      extractLoadOne: async (params) => {
        if (params.repoId === 1) {
          throw new Error("totally unexpected failure");
        }
        return extractLoadRepo(params);
      },
    });

    const brokenResult = results.find((r) => r.fullName === "sdpilon/broken-repo");
    expect(brokenResult?.status).toBe("error");
    expect(brokenResult?.dataType).toBe("repo");
    expect(brokenResult?.error).toMatch(/totally unexpected failure/);

    const okResults = results.filter(
      (r) => r.fullName === "sdpilon/spilon.dev" && r.status === "ok",
    );
    expect(okResults).toHaveLength(3);

    const repo2Commits = await db.select().from(commits).where(eq(commits.repoId, 2));
    expect(repo2Commits).toHaveLength(1);
    // The broken repo never reached extractLoadRepo, so it has no rows at all.
    const repo1Commits = await db.select().from(commits).where(eq(commits.repoId, 1));
    expect(repo1Commits).toHaveLength(0);
  });
});
