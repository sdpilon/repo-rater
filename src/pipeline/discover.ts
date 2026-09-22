import type { Octokit } from "octokit";
import { repoDiscoveries, repos } from "../db/schema";
import type { DrizzleDb } from "./db-types";
import { fetchAccountRepos, type RepoMeta } from "./github/client";
import { makeRunId } from "./runs";

/**
 * Repo discovery via Octokit, upserted into Postgres.
 */

export interface DiscoveryResult {
  repoId: number | null;
  fullName: string;
  status: "ok" | "error";
  error?: string;
}

export interface DiscoverReposResult {
  repos: RepoMeta[];
  count: number;
  results: DiscoveryResult[];
  error?: string;
}

/**
 * Upsert a single repo's metadata.
 *
 * A single atomic `INSERT ... ON CONFLICT DO UPDATE SET ...`: any column
 * omitted from the `set` clause below is left untouched on conflict, so
 * `firstSeenAt`/`isIgnored`/`ignoreSource`/`assessmentSource` are
 * deliberately left out of `set` to preserve whatever was already there for
 * an existing row, while the `values(...)` branch still supplies sane
 * defaults for a genuinely new row. No pre-SELECT needed.
 */
export async function upsertRepo(
  db: DrizzleDb,
  meta: RepoMeta,
  now: Date,
): Promise<void> {
  await db
    .insert(repos)
    .values({
      repoId: meta.repoId,
      fullName: meta.fullName,
      description: meta.description,
      htmlUrl: meta.htmlUrl,
      defaultBranch: meta.defaultBranch,
      language: meta.language,
      stargazersCount: meta.stargazersCount,
      isPrivate: meta.isPrivate,
      isFork: meta.isFork,
      isArchived: meta.isArchived,
      isIgnored: false,
      ignoreSource: "auto",
      assessmentSource: "auto",
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: repos.repoId,
      set: {
        fullName: meta.fullName,
        description: meta.description,
        htmlUrl: meta.htmlUrl,
        defaultBranch: meta.defaultBranch,
        language: meta.language,
        stargazersCount: meta.stargazersCount,
        isPrivate: meta.isPrivate,
        isFork: meta.isFork,
        isArchived: meta.isArchived,
        lastSeenAt: now,
      },
    });
}

/**
 * Record that `repoId` was seen by `runId` at `seenAt`. `(run_id, repo_id)`
 * is the composite primary key, so a re-run with the same runId replaces
 * the row while different runIds accumulate distinct rows.
 */
export async function recordDiscovery(
  db: DrizzleDb,
  runId: string,
  repoId: number,
  seenAt: Date,
): Promise<void> {
  await db
    .insert(repoDiscoveries)
    .values({ runId, repoId, seenAt })
    .onConflictDoUpdate({
      target: [repoDiscoveries.runId, repoDiscoveries.repoId],
      set: { seenAt },
    });
}

export async function discoverRepos({
  db,
  runId,
  now,
  octokit,
  fetchRepos = fetchAccountRepos,
}: {
  db: DrizzleDb;
  runId: string;
  now: Date;
  octokit: Octokit;
  /** Injectable in tests in place of the real `fetchAccountRepos` Octokit call. */
  fetchRepos?: (octokit: Octokit) => Promise<RepoMeta[]>;
}): Promise<DiscoverReposResult> {
  let repoList: RepoMeta[];
  try {
    repoList = await fetchRepos(octokit);
  } catch (err) {
    return { repos: [], count: 0, results: [], error: String(err) };
  }

  const results: DiscoveryResult[] = [];
  for (const meta of repoList) {
    try {
      await upsertRepo(db, meta, now);
      await recordDiscovery(db, runId, meta.repoId, now);
      results.push({
        repoId: meta.repoId,
        fullName: meta.fullName,
        status: "ok",
      });
    } catch (err) {
      results.push({
        repoId: meta.repoId,
        fullName: meta.fullName,
        status: "error",
        error: String(err),
      });
    }
  }
  return { repos: repoList, count: repoList.length, results };
}

/**
 * Shared runId→discoverRepos sequence used by orchestrator callers.
 * Deliberately stops short of recordRunStart/recordRunFinish: different
 * callers record start/finish at different points with different
 * semantics, so folding those calls in here would bake in one caller's
 * behavior for all of them. Each caller records start/finish itself, on
 * top of this scaffold.
 *
 * Takes an already-open Drizzle `db` instance — Postgres connections are
 * managed outside this module, and schema setup is handled by migrations,
 * not a runtime step here.
 */
export async function runDiscoveryScaffold({
  db,
  octokit,
  fetchRepos,
}: {
  db: DrizzleDb;
  octokit: Octokit;
  fetchRepos?: (octokit: Octokit) => Promise<RepoMeta[]>;
}): Promise<{ runId: string; startedAt: Date } & DiscoverReposResult> {
  const runId = makeRunId();
  const startedAt = new Date();
  const result = await discoverRepos({
    db,
    runId,
    now: startedAt,
    octokit,
    fetchRepos,
  });
  return { runId, startedAt, ...result };
}
