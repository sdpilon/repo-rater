import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { Octokit } from "octokit";
import { afterEach, describe, expect, it } from "vitest";
import {
  commits,
  issues,
  pullRequests,
  repoAssessments,
  repoDiscoveries,
  repos,
  runs,
} from "../db/schema";
import type { Assessment } from "./anthropic/client";
import type { DiscoveryResult } from "./discover";
import type { ExtractLoadResult } from "./extract-load";
import type { Commit, Issue, PullRequest, RepoMeta } from "./github/client";
import { buildRepoList, computeRunCounts, parseArgs, runPipeline } from "./run";
import { createTestDb } from "./test-helpers/pglite-db";

// A fake Octokit/Anthropic client is enough — every non-dry-run test
// injects fetchRepos/fetchCommits/fetchIssues/fetchPrs/fetchReadme/
// generateAssessment, so the real Octokit- and Anthropic-backed functions
// are never called. Mirrors the fake-Octokit pattern in discover.test.ts /
// extract-load.test.ts / github/client.test.ts.
const fakeOctokit = {} as Octokit;
const fakeAnthropicClient = {} as Anthropic;

async function fakeFetchReadme(): Promise<string> {
  return "# Hello";
}

async function fakeGenerateAssessment(): Promise<Assessment> {
  return {
    pct: 80,
    band: "good",
    label: "On track",
    text: "Stub assessment for pipeline integration tests.",
    gaps: [],
  };
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

describe("parseArgs", () => {
  it("defaults to no dry-run and no limit", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, limit: null });
  });

  it("recognizes --dry-run", () => {
    expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true, limit: null });
  });

  it("recognizes --limit N", () => {
    expect(parseArgs(["--limit", "5"])).toEqual({ dryRun: false, limit: 5 });
  });

  it("rejects a non-positive-integer --limit value", () => {
    expect(() => parseArgs(["--limit", "abc"])).toThrow(
      /--limit requires a positive integer/,
    );
    expect(() => parseArgs(["--limit", "0"])).toThrow(
      /--limit requires a positive integer/,
    );
    expect(() => parseArgs(["--limit", "-3"])).toThrow(
      /--limit requires a positive integer/,
    );
  });
});

describe("buildRepoList", () => {
  it("maps successfully-discovered repos to RepoRef[]", () => {
    const discoveryResults: DiscoveryResult[] = [
      { repoId: 1, fullName: "sdpilon/a", status: "ok" },
      { repoId: 2, fullName: "sdpilon/b", status: "ok" },
    ];
    expect(buildRepoList(discoveryResults, null)).toEqual([
      { repoId: 1, fullName: "sdpilon/a" },
      { repoId: 2, fullName: "sdpilon/b" },
    ]);
  });

  it("excludes repos discovery couldn't upsert", () => {
    const discoveryResults: DiscoveryResult[] = [
      { repoId: 1, fullName: "sdpilon/a", status: "ok" },
      {
        repoId: null,
        fullName: "sdpilon/broken",
        status: "error",
        error: "boom",
      },
    ];
    expect(buildRepoList(discoveryResults, null)).toEqual([
      { repoId: 1, fullName: "sdpilon/a" },
    ]);
  });

  it("applies a limit by taking the first N", () => {
    const discoveryResults: DiscoveryResult[] = [
      { repoId: 1, fullName: "sdpilon/a", status: "ok" },
      { repoId: 2, fullName: "sdpilon/b", status: "ok" },
      { repoId: 3, fullName: "sdpilon/c", status: "ok" },
    ];
    expect(buildRepoList(discoveryResults, 2)).toEqual([
      { repoId: 1, fullName: "sdpilon/a" },
      { repoId: 2, fullName: "sdpilon/b" },
    ]);
  });
});

describe("computeRunCounts", () => {
  it("counts a whole-repo extract-load failure as failed, not silently dropped", () => {
    const extractResults: ExtractLoadResult[] = [
      {
        fullName: "sdpilon/broken-repo",
        repoId: 99,
        dataType: "repo",
        status: "error",
        error: "repo not found",
      },
      {
        fullName: "sdpilon/spilon.dev",
        repoId: 1,
        dataType: "commits",
        status: "ok",
      },
    ];
    const counts = computeRunCounts(extractResults);
    expect(counts.reposFetchedOk).toBe(1);
    expect(counts.reposFailed).toBe(1);
    expect([...counts.repoIds]).toEqual([99, 1]);
  });

  it("counts a repo as failed (not ok) when only one of its data types errors", () => {
    const extractResults: ExtractLoadResult[] = [
      {
        fullName: "sdpilon/spilon.dev",
        repoId: 1,
        dataType: "commits",
        status: "ok",
      },
      {
        fullName: "sdpilon/spilon.dev",
        repoId: 1,
        dataType: "issues",
        status: "error",
        error: "rate limited",
      },
      {
        fullName: "sdpilon/spilon.dev",
        repoId: 1,
        dataType: "prs",
        status: "ok",
      },
    ];
    const counts = computeRunCounts(extractResults);
    expect(counts.reposFetchedOk).toBe(0);
    expect(counts.reposFailed).toBe(1);
  });

  it("reports all repos ok when nothing failed", () => {
    const extractResults: ExtractLoadResult[] = [
      {
        fullName: "sdpilon/spilon.dev",
        repoId: 1,
        dataType: "commits",
        status: "ok",
      },
      {
        fullName: "sdpilon/typst-resume",
        repoId: 2,
        dataType: "commits",
        status: "ok",
      },
    ];
    const counts = computeRunCounts(extractResults);
    expect(counts.reposFetchedOk).toBe(2);
    expect(counts.reposFailed).toBe(0);
  });
});

// --- Integration: Discover -> Extract+Load wiring, against real PGlite
// Postgres semantics with injected fakes, per the project's own postmortem
// lesson (see CLAUDE.md's "Verifying pipeline changes") that unit tests of
// the pieces alone can miss orchestration bugs — this covers `runPipeline`
// (the orchestration `main()` wraps) actually wiring discovery's output into
// extract-load, end to end.

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

async function fakeFetchCommits(fullName: string): Promise<Commit[]> {
  return [
    {
      sha: `${fullName}-sha1`,
      authorName: "Spencer",
      authoredAt: "2026-07-01T00:00:00Z",
      message: "first commit",
    },
  ];
}

async function fakeFetchIssues(fullName: string): Promise<Issue[]> {
  return [
    {
      number: 1,
      title: `Bug in ${fullName}`,
      state: "open",
      createdAt: "2026-07-01T00:00:00Z",
      closedAt: null,
      labels: ["bug"],
    },
  ];
}

async function fakeFetchPrs(): Promise<PullRequest[]> {
  return [];
}

describe("runPipeline", () => {
  it("wires Discover -> Extract+Load: lands repos, repo_discoveries, commits/issues, and a runs row with success status/counts", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const summary = await runPipeline({
      db,
      octokit: fakeOctokit,
      anthropicClient: fakeAnthropicClient,
      args: { dryRun: false, limit: null },
      fetchRepos: fakeFetchRepos,
      fetchCommits: fakeFetchCommits,
      fetchIssues: fakeFetchIssues,
      fetchPrs: fakeFetchPrs,
      fetchReadme: fakeFetchReadme,
      generateAssessment: fakeGenerateAssessment,
    });

    expect(summary).toBeDefined();
    expect(summary?.discoveredCount).toBe(2);
    expect(summary?.reposFetchedOk).toBe(2);
    expect(summary?.reposFailed).toBe(0);

    const repoRows = await db.select().from(repos).orderBy(repos.repoId);
    expect(repoRows.map((r) => r.fullName)).toEqual([
      "sdpilon/spilon.dev",
      "sdpilon/typst-resume",
    ]);
    // typst-resume is a fork (see TWO_REPOS), so it's auto-ignored and
    // enrichment skips it; spilon.dev is not, so it gets enriched.
    expect(repoRows[1].isIgnored).toBe(true);
    expect(repoRows[1].ignoreSource).toBe("auto");

    const runId = summary?.runId ?? "";
    const discoveryRows = await db
      .select()
      .from(repoDiscoveries)
      .where(eq(repoDiscoveries.runId, runId));
    expect(discoveryRows).toHaveLength(2);

    const commitRows = await db.select().from(commits).orderBy(commits.repoId);
    expect(commitRows).toHaveLength(2);
    expect(commitRows.map((c) => c.repoId)).toEqual([1, 2]);

    const issueRows = await db.select().from(issues).orderBy(issues.repoId);
    expect(issueRows).toHaveLength(2);

    const prRows = await db.select().from(pullRequests);
    expect(prRows).toHaveLength(0);

    const runRows = await db.select().from(runs).where(eq(runs.runId, runId));
    expect(runRows).toHaveLength(1);
    expect(runRows[0].status).toBe("success");
    expect(runRows[0].reposDiscovered).toBe(2);
    expect(runRows[0].reposFetchedOk).toBe(2);
    expect(runRows[0].reposFailed).toBe(0);
    expect(runRows[0].llmCallsMade).toBe(1);
    expect(runRows[0].llmCallsSkipped).toBe(1);
    expect(runRows[0].finishedAt).not.toBeNull();

    const assessmentRows = await db
      .select()
      .from(repoAssessments)
      .where(eq(repoAssessments.repoId, 1));
    expect(assessmentRows).toHaveLength(1);
    expect(assessmentRows[0].band).toBe("good");
  });

  it("marks the run partial and reposFailed=1 when one repo's extract-load fails entirely, without blocking the other repo", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const summary = await runPipeline({
      db,
      octokit: fakeOctokit,
      anthropicClient: fakeAnthropicClient,
      args: { dryRun: false, limit: null },
      fetchRepos: fakeFetchRepos,
      fetchCommits: async (fullName: string) => {
        if (fullName === "sdpilon/typst-resume") {
          throw new Error("rate limited");
        }
        return fakeFetchCommits(fullName);
      },
      fetchIssues: fakeFetchIssues,
      fetchPrs: fakeFetchPrs,
      fetchReadme: fakeFetchReadme,
      generateAssessment: fakeGenerateAssessment,
    });

    expect(summary?.reposFetchedOk).toBe(1);
    expect(summary?.reposFailed).toBe(1);

    const runId = summary?.runId ?? "";
    const runRows = await db.select().from(runs).where(eq(runs.runId, runId));
    expect(runRows[0].status).toBe("partial");
    expect(runRows[0].reposFetchedOk).toBe(1);
    expect(runRows[0].reposFailed).toBe(1);
  });

  it("respects --limit: only the first N discovered repos are extracted/loaded", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const summary = await runPipeline({
      db,
      octokit: fakeOctokit,
      anthropicClient: fakeAnthropicClient,
      args: { dryRun: false, limit: 1 },
      fetchRepos: fakeFetchRepos,
      fetchCommits: fakeFetchCommits,
      fetchIssues: fakeFetchIssues,
      fetchPrs: fakeFetchPrs,
      fetchReadme: fakeFetchReadme,
      generateAssessment: fakeGenerateAssessment,
    });

    expect(summary?.discoveredCount).toBe(2);
    expect(summary?.reposFetchedOk).toBe(1);

    // Both repos were still discovered/upserted...
    const repoRows = await db.select().from(repos);
    expect(repoRows).toHaveLength(2);
    // ...but only the first (limited) repo had commits extracted/loaded.
    const commitRows = await db.select().from(commits);
    expect(commitRows).toHaveLength(1);
    expect(commitRows[0].repoId).toBe(1);
  });

  it("dry-run records a run row but performs no extract/load", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const summary = await runPipeline({
      db,
      octokit: fakeOctokit,
      anthropicClient: fakeAnthropicClient,
      args: { dryRun: true, limit: null },
      fetchRepos: fakeFetchRepos,
    });

    expect(summary?.discoveredCount).toBe(2);

    const repoRows = await db.select().from(repos);
    expect(repoRows).toHaveLength(2);

    const commitRows = await db.select().from(commits);
    expect(commitRows).toHaveLength(0);

    const runId = summary?.runId ?? "";
    const runRows = await db.select().from(runs).where(eq(runs.runId, runId));
    expect(runRows[0].status).toBe("success");
    expect(runRows[0].reposDiscovered).toBe(2);
  });

  it("aborts without recording a run row when discovery itself fails", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const summary = await runPipeline({
      db,
      octokit: fakeOctokit,
      anthropicClient: fakeAnthropicClient,
      args: { dryRun: false, limit: null },
      fetchRepos: async () => {
        throw new Error("GitHub API down");
      },
    });

    expect(summary).toBeUndefined();

    const runRows = await db.select().from(runs);
    expect(runRows).toHaveLength(0);
  });
});
