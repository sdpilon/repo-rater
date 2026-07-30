import { and, eq } from "drizzle-orm";
import type { Octokit } from "octokit";
import { commits, fetchFailures, fetchWatermarks, issues, pullRequests } from "../db/schema";
import type { DrizzleDb } from "./db-types";
import {
  type Commit,
  fetchCommitsSince,
  type Issue,
  fetchIssuesSince,
  type PullRequest,
  fetchPrsSince,
} from "./github/client";

/**
 * Per-repo, per-data-type fetch-and-upsert step, merging what the old
 * repo-root `pipeline/extract.js` (fetch → write to bronze flat files) and
 * `pipeline/load.js` (read bronze → upsert to DuckDB) did into a single step
 * that fetches from GitHub (via Octokit) and upserts straight into Postgres.
 *
 * **No bronze flat-file layer** — this is a deliberate, approved
 * architecture decision, not an oversight. Bronze's only value in the old
 * system was "replay from raw without re-hitting GitHub," which doesn't
 * survive on ephemeral compute anyway, and GitHub is cheap to re-query at
 * this project's scale. Fetch results go straight into `commits` /
 * `issues` / `pull_requests` without ever touching disk.
 *
 * **No repo meta here** — `discover.ts`'s `upsertRepo` already upserts repo
 * metadata every run from the account-listing data (`fetchAccountRepos`),
 * which has the same fields the old per-repo `fetchRepoMeta` call would
 * return. The old system's separate per-repo `fetchRepoMeta` in
 * `extract.js`, followed by `load.js` upserting it *again*, was redundant
 * 1:1 field duplication (both went through the same `mapRawRepo`). This
 * module doesn't replicate that redundancy — it only handles
 * commits/issues/prs.
 *
 * **No readme here either** — the old system never persisted readme to a
 * silver DB table at all; it re-fetched it fresh into bronze every run, and
 * `enrich.js` read it straight from there ("readme has no silver table and
 * no watermark — it's small enough to refetch in full every run"). There's
 * still no `readme` column anywhere in the new Postgres schema, and no
 * consumer of readme data in this phase (enrichment is Phase 2). So this
 * module doesn't fetch or store readme at all — Phase 2's `enrich.ts` will
 * call `fetchReadme` directly via Octokit right when it needs it, matching
 * the old "always fresh, never cached" semantic just via a direct fetch
 * instead of a bronze intermediate.
 */

export const DATA_TYPES = ["commits", "issues", "prs"] as const;
export type DataType = (typeof DATA_TYPES)[number];

export const DEFAULT_SINCE = "2020-01-01T00:00:00Z";

type FetchCommitsFn = typeof fetchCommitsSince;
type FetchIssuesFn = typeof fetchIssuesSince;
type FetchPrsFn = typeof fetchPrsSince;

function toDate(iso: string): Date {
  return new Date(iso);
}

function toDateOrNull(iso: string | null): Date | null {
  return iso ? new Date(iso) : null;
}

/**
 * Returns the stored watermark for `(repoId, dataType)`, or `null` when
 * none exists yet (a genuinely new repo/data-type pair).
 */
export async function getWatermark(
  db: DrizzleDb,
  repoId: number,
  dataType: DataType,
): Promise<Date | null> {
  const rows = await db
    .select({ lastFetchedAt: fetchWatermarks.lastFetchedAt })
    .from(fetchWatermarks)
    .where(and(eq(fetchWatermarks.repoId, repoId), eq(fetchWatermarks.dataType, dataType)));
  return rows.length > 0 ? rows[0].lastFetchedAt : null;
}

/**
 * Upserts the watermark for `(repoId, dataType)`. Straightforward full
 * upsert — both remaining columns (`lastFetchedAt`, `lastSuccessRunId`) are
 * always overwritten, no preserved fields, matching the old `setWatermark`.
 *
 * Callers must pass the run's `now`/`fetchedAt` timestamp here, not
 * anything derived from the fetched rows — watermark advances to run time,
 * not max-event time in the data, because GitHub's `since=` semantics vary
 * slightly by endpoint and run-time is a safe, simple lower bound that
 * never skips data created mid-fetch. See `extractLoadRepo` below, the only
 * caller.
 */
export async function setWatermark(
  db: DrizzleDb,
  repoId: number,
  dataType: DataType,
  lastFetchedAt: Date,
  runId: string,
): Promise<void> {
  await db
    .insert(fetchWatermarks)
    .values({ repoId, dataType, lastFetchedAt, lastSuccessRunId: runId })
    .onConflictDoUpdate({
      target: [fetchWatermarks.repoId, fetchWatermarks.dataType],
      set: { lastFetchedAt, lastSuccessRunId: runId },
    });
}

/**
 * Upserts a single commit. `firstIngestedRunId` is deliberately omitted
 * from the `set` clause (same pattern as `discover.ts`'s `upsertRepo`) so
 * Postgres preserves whatever run first ingested this commit on conflict,
 * while the `values(...)` branch still supplies `runId` for a genuinely new
 * row. No pre-SELECT needed.
 */
export async function upsertCommit(
  db: DrizzleDb,
  repoId: number,
  commit: Commit,
  runId: string,
): Promise<void> {
  await db
    .insert(commits)
    .values({
      repoId,
      sha: commit.sha,
      authorName: commit.authorName,
      authoredAt: toDateOrNull(commit.authoredAt),
      message: commit.message,
      firstIngestedRunId: runId,
    })
    .onConflictDoUpdate({
      target: [commits.repoId, commits.sha],
      set: {
        authorName: commit.authorName,
        authoredAt: toDateOrNull(commit.authoredAt),
        message: commit.message,
        // firstIngestedRunId intentionally omitted — preserved on conflict.
      },
    });
}

/**
 * Upserts a single issue. Unlike `upsertCommit`, there's no "preserve on
 * conflict" field here, so the `set` clause includes every column,
 * including `lastUpdatedRunId`.
 */
export async function upsertIssue(
  db: DrizzleDb,
  repoId: number,
  issue: Issue,
  runId: string,
): Promise<void> {
  await db
    .insert(issues)
    .values({
      repoId,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      createdAt: toDate(issue.createdAt),
      closedAt: toDateOrNull(issue.closedAt),
      labels: issue.labels,
      lastUpdatedRunId: runId,
    })
    .onConflictDoUpdate({
      target: [issues.repoId, issues.number],
      set: {
        title: issue.title,
        state: issue.state,
        createdAt: toDate(issue.createdAt),
        closedAt: toDateOrNull(issue.closedAt),
        labels: issue.labels,
        lastUpdatedRunId: runId,
      },
    });
}

/**
 * Upserts a single pull request. Same "no preserved fields" shape as
 * `upsertIssue`.
 */
export async function upsertPr(
  db: DrizzleDb,
  repoId: number,
  pr: PullRequest,
  runId: string,
): Promise<void> {
  await db
    .insert(pullRequests)
    .values({
      repoId,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      createdAt: toDate(pr.createdAt),
      mergedAt: toDateOrNull(pr.mergedAt),
      lastUpdatedRunId: runId,
    })
    .onConflictDoUpdate({
      target: [pullRequests.repoId, pullRequests.number],
      set: {
        title: pr.title,
        state: pr.state,
        createdAt: toDate(pr.createdAt),
        mergedAt: toDateOrNull(pr.mergedAt),
        lastUpdatedRunId: runId,
      },
    });
}

/** Records a single `fetch_failures` row for a failed data-type fetch. */
export async function recordFailure(
  db: DrizzleDb,
  runId: string,
  repoId: number,
  dataType: DataType,
  errorMessage: string,
  occurredAt: Date,
): Promise<void> {
  await db.insert(fetchFailures).values({ runId, repoId, dataType, errorMessage, occurredAt });
}

export interface ExtractLoadResult {
  fullName: string;
  repoId: number;
  /** "repo" only appears for a whole-repo failure recorded by `extractLoadAll` — see its per-repo catch below. */
  dataType: DataType | "repo";
  status: "ok" | "error";
  since?: string;
  fetchedAt?: Date;
  error?: string;
}

export interface ExtractLoadRepoParams {
  fullName: string;
  repoId: number;
  db: DrizzleDb;
  runId: string;
  octokit: Octokit;
  now: Date;
  /** Injectable in tests in place of the real Octokit-backed fetch functions. */
  fetchCommits?: FetchCommitsFn;
  fetchIssues?: FetchIssuesFn;
  fetchPrs?: FetchPrsFn;
}

/**
 * Fetches and upserts commits/issues/prs for a single repo. Each data type
 * is isolated in its own try/catch: a failure fetching or upserting one
 * data type is recorded as a `fetch_failures` row and does not advance that
 * data type's watermark, but does not stop (and is not affected by) the
 * other data types for the same repo. This function itself never throws —
 * see `extractLoadAll` for the additional per-repo isolation layer around
 * whole-repo failures.
 */
export async function extractLoadRepo({
  fullName,
  repoId,
  db,
  runId,
  octokit,
  now,
  fetchCommits = fetchCommitsSince,
  fetchIssues = fetchIssuesSince,
  fetchPrs = fetchPrsSince,
}: ExtractLoadRepoParams): Promise<ExtractLoadResult[]> {
  const results: ExtractLoadResult[] = [];

  for (const dataType of DATA_TYPES) {
    try {
      const watermark = await getWatermark(db, repoId, dataType);
      const since = watermark ? watermark.toISOString() : DEFAULT_SINCE;

      if (dataType === "commits") {
        const rows = await fetchCommits(fullName, since, octokit);
        for (const commit of rows) {
          await upsertCommit(db, repoId, commit, runId);
        }
      } else if (dataType === "issues") {
        const rows = await fetchIssues(fullName, since, octokit);
        for (const issue of rows) {
          await upsertIssue(db, repoId, issue, runId);
        }
      } else {
        const rows = await fetchPrs(fullName, since, octokit);
        for (const pr of rows) {
          await upsertPr(db, repoId, pr, runId);
        }
      }

      // Advance to run time, not max-event time in the fetched rows — see
      // the comment on setWatermark above.
      await setWatermark(db, repoId, dataType, now, runId);
      results.push({ fullName, repoId, dataType, status: "ok", since, fetchedAt: now });
    } catch (err) {
      await recordFailure(db, runId, repoId, dataType, String(err), now);
      results.push({ fullName, repoId, dataType, status: "error", error: String(err) });
    }
  }

  return results;
}

export interface RepoRef {
  repoId: number;
  fullName: string;
}

export interface ExtractLoadAllParams {
  repos: RepoRef[];
  db: DrizzleDb;
  runId: string;
  octokit: Octokit;
  now: Date;
  fetchCommits?: FetchCommitsFn;
  fetchIssues?: FetchIssuesFn;
  fetchPrs?: FetchPrsFn;
  /**
   * Injectable in tests in place of the real `extractLoadRepo`, so a whole
   * per-repo failure (the old `extractAll`'s per-repo try/catch scenario —
   * e.g. the entire GitHub call for a repo throwing before any per-data-type
   * isolation would even apply) can be exercised without contriving a real
   * DB failure. Defaults to the real `extractLoadRepo`.
   */
  extractLoadOne?: (params: ExtractLoadRepoParams) => Promise<ExtractLoadResult[]>;
}

/**
 * Runs `extractLoadRepo` across multiple repos. Adds a second, outer layer
 * of failure isolation on top of `extractLoadRepo`'s per-data-type
 * isolation: if the call for one repo throws entirely (rather than being
 * caught and turned into a per-data-type error result), that's recorded as
 * a single "repo"-level error result and the rest of the batch still runs —
 * mirroring the old `extractAll`'s per-repo try/catch around the whole
 * per-repo call.
 */
export async function extractLoadAll({
  repos: repoList,
  db,
  runId,
  octokit,
  now,
  fetchCommits,
  fetchIssues,
  fetchPrs,
  extractLoadOne = extractLoadRepo,
}: ExtractLoadAllParams): Promise<ExtractLoadResult[]> {
  const allResults: ExtractLoadResult[] = [];
  for (const repo of repoList) {
    try {
      const results = await extractLoadOne({
        fullName: repo.fullName,
        repoId: repo.repoId,
        db,
        runId,
        octokit,
        now,
        fetchCommits,
        fetchIssues,
        fetchPrs,
      });
      allResults.push(...results);
    } catch (err) {
      allResults.push({
        fullName: repo.fullName,
        repoId: repo.repoId,
        dataType: "repo",
        status: "error",
        error: String(err),
      });
    }
  }
  return allResults;
}
