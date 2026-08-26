import { eq } from "drizzle-orm";
import type { Octokit } from "octokit";
import { afterEach, describe, expect, it } from "vitest";
import { repoDiscoveries, repos, runs } from "../db/schema";
import { discoverRepos, runDiscoveryScaffold } from "./discover";
import type { RepoMeta } from "./github/client";
import { recordRunFinish, recordRunStart } from "./runs";
import { createTestDb } from "./test-helpers/pglite-db";

function eqRunId(runId: string) {
  return eq(repoDiscoveries.runId, runId);
}
function eqRunIdRuns(runId: string) {
  return eq(runs.runId, runId);
}
function eqRepoId(repoId: number) {
  return eq(repos.repoId, repoId);
}

// A fake Octokit is enough here — `fetchRepos` is always overridden in
// these tests, so the real `fetchAccountRepos(octokit)` call is never made.
// Mirrors the fake-Octokit pattern in `github/client.test.ts`.
const fakeOctokit = {} as Octokit;

const TWO_REPOS: RepoMeta[] = [
  {
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    description: "site",
    htmlUrl: "https://github.com/sdpilon/spilon.dev",
    defaultBranch: "main",
    language: "Astro",
    stargazersCount: 1,
    isPrivate: false,
    isFork: false,
    isArchived: false,
  },
  {
    repoId: 2,
    fullName: "sdpilon/typst-resume",
    description: "resume",
    htmlUrl: "https://github.com/sdpilon/typst-resume",
    defaultBranch: "main",
    language: "Typst",
    stargazersCount: 0,
    isPrivate: false,
    isFork: true,
    isArchived: false,
  },
];

async function fakeFetchRepos(): Promise<RepoMeta[]> {
  return TWO_REPOS;
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

describe("discoverRepos", () => {
  it("upserts each repo into repos and records a repo_discoveries row for the run", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const { count } = await discoverRepos({
      db,
      runId: "run_1",
      now: new Date("2026-07-23T00:00:00.000Z"),
      octokit: fakeOctokit,
      fetchRepos: fakeFetchRepos,
    });

    expect(count).toBe(2);

    const repoRows = await db.select().from(repos).orderBy(repos.repoId);
    expect(repoRows.map((r) => r.fullName)).toEqual([
      "sdpilon/spilon.dev",
      "sdpilon/typst-resume",
    ]);

    const discoveryRows = await db
      .select()
      .from(repoDiscoveries)
      .where(eqRunId("run_1"))
      .orderBy(repoDiscoveries.repoId);
    expect(discoveryRows).toHaveLength(2);
  });

  it("run twice with different runIds appends distinct repo_discoveries rows instead of overwriting", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await discoverRepos({
      db,
      runId: "run_1",
      now: new Date("2026-07-23T00:00:00.000Z"),
      octokit: fakeOctokit,
      fetchRepos: fakeFetchRepos,
    });
    await discoverRepos({
      db,
      runId: "run_2",
      now: new Date("2026-07-24T00:00:00.000Z"),
      octokit: fakeOctokit,
      fetchRepos: fakeFetchRepos,
    });

    const allDiscoveries = await db.select().from(repoDiscoveries);
    const countsByRun = new Map<string, number>();
    for (const row of allDiscoveries) {
      countsByRun.set(row.runId, (countsByRun.get(row.runId) ?? 0) + 1);
    }
    expect(Object.fromEntries(countsByRun)).toEqual({ run_1: 2, run_2: 2 });
  });

  it("preserves first_seen_at across repeated runs while advancing last_seen_at", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await discoverRepos({
      db,
      runId: "run_1",
      now: new Date("2026-07-23T00:00:00.000Z"),
      octokit: fakeOctokit,
      fetchRepos: fakeFetchRepos,
    });
    await discoverRepos({
      db,
      runId: "run_2",
      now: new Date("2026-07-24T00:00:00.000Z"),
      octokit: fakeOctokit,
      fetchRepos: fakeFetchRepos,
    });

    const rows = await db.select().from(repos).where(eqRepoId(1));
    expect(rows[0].firstSeenAt.toISOString()).toBe("2026-07-23T00:00:00.000Z");
    expect(rows[0].lastSeenAt.toISOString()).toBe("2026-07-24T00:00:00.000Z");
  });

  it("records a per-repo error result and keeps processing the rest of the batch", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    // repoId: null violates the NOT NULL primary key at the DB level (same
    // trick the old DuckDB test used), forcing upsertRepo to reject this
    // repo without aborting the whole batch.
    const flakyRepos: RepoMeta[] = [
      {
        ...TWO_REPOS[0],
        repoId: null as unknown as number,
        fullName: "sdpilon/broken-repo",
      },
      TWO_REPOS[1],
    ];

    const { count, results } = await discoverRepos({
      db,
      runId: "run_1",
      now: new Date("2026-07-23T00:00:00.000Z"),
      octokit: fakeOctokit,
      fetchRepos: async () => flakyRepos,
    });

    expect(count).toBe(2);
    const broken = results.find((r) => r.fullName === "sdpilon/broken-repo");
    expect(broken?.status).toBe("error");
    const ok = results.find((r) => r.fullName === "sdpilon/typst-resume");
    expect(ok?.status).toBe("ok");

    const repoRows = await db.select().from(repos);
    expect(repoRows).toHaveLength(1);
  });

  it("returns an error result instead of throwing when the account listing itself fails", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const result = await discoverRepos({
      db,
      runId: "run_1",
      now: new Date("2026-07-23T00:00:00.000Z"),
      octokit: fakeOctokit,
      fetchRepos: async () => {
        throw new Error("rate limited");
      },
    });

    expect(result.count).toBe(0);
    expect(result.error).toMatch(/rate limited/);

    const repoRows = await db.select().from(repos);
    expect(repoRows).toHaveLength(0);
  });
});

describe("runDiscoveryScaffold", () => {
  it("generates a runId, and runs discovery against the given db", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const {
      runId,
      startedAt,
      repos: repoList,
      count,
      results,
      error,
    } = await runDiscoveryScaffold({
      db,
      octokit: fakeOctokit,
      fetchRepos: fakeFetchRepos,
    });

    expect(error).toBeUndefined();
    expect(count).toBe(2);
    expect(repoList).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(typeof runId).toBe("string");
    expect(runId).toMatch(/^run_/);
    expect(startedAt).toBeInstanceOf(Date);

    // Schema was actually written to by the discoverRepos call inside the
    // scaffold.
    const repoRows = await db.select().from(repos).orderBy(repos.repoId);
    expect(repoRows.map((r) => r.fullName)).toEqual([
      "sdpilon/spilon.dev",
      "sdpilon/typst-resume",
    ]);

    const discoveryRows = await db
      .select()
      .from(repoDiscoveries)
      .where(eqRunId(runId))
      .orderBy(repoDiscoveries.repoId);
    expect(discoveryRows).toHaveLength(2);

    // The scaffold itself stops short of recordRunStart/recordRunFinish
    // (see the comment above runDiscoveryScaffold in discover.ts): no runs
    // row yet. Then exercise the full sequence the way a real caller
    // would, layering recordRunStart/recordRunFinish on top.
    const runRowsBeforeRecord = await db
      .select()
      .from(runs)
      .where(eqRunIdRuns(runId));
    expect(runRowsBeforeRecord).toHaveLength(0);

    await recordRunStart(db, runId, startedAt, count);
    await recordRunFinish(db, runId, new Date(), {
      status: "success",
      reposFetchedOk: results.filter((r) => r.status === "ok").length,
      reposFailed: results.filter((r) => r.status === "error").length,
      llmCallsMade: 0,
      llmCallsSkipped: 0,
    });

    const runRows = await db.select().from(runs).where(eqRunIdRuns(runId));
    expect(runRows).toHaveLength(1);
    expect(runRows[0].status).toBe("success");
    expect(runRows[0].reposDiscovered).toBe(2);
  });
});
