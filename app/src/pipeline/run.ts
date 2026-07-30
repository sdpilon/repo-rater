import type Anthropic from "@anthropic-ai/sdk";
import type { Octokit } from "octokit";
import { createDb } from "../db/client";
import { createAnthropicClient } from "./anthropic/client";
import type { Assessment, AssessmentInput } from "./anthropic/client";
import type { DrizzleDb } from "./db-types";
import type { DiscoveryResult } from "./discover";
import { runDiscoveryScaffold } from "./discover";
import { countUnassessedRepos, enrichAll } from "./enrich";
import {
  type DataType,
  type ExtractLoadResult,
  extractLoadAll,
  type RepoRef,
} from "./extract-load";
import type { Commit, Issue, PullRequest } from "./github/client";
import { createOctokit } from "./github/client";
import { recordRunFinish, recordRunStart } from "./runs";

/**
 * Phase 1+2 orchestrator: Discover -> Extract+Load -> Enrich, ported from
 * repo-root `pipeline/run.js` (read-only reference). Publish is removed
 * from the architecture entirely — the eventual SolidStart SSR route will
 * query Postgres directly once the frontend phase lands.
 */

export interface ParsedArgs {
  dryRun: boolean;
  limit: number | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { dryRun: false, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") {
      args.dryRun = true;
    } else if (argv[i] === "--limit") {
      const raw = argv[i + 1];
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--limit requires a positive integer, got ${raw}`);
      }
      args.limit = value;
      i += 1;
    }
  }
  return args;
}

/**
 * Adapted from the old `buildRepoList`: the old version only needed
 * `fullName` strings (extract.js re-fetched meta itself per repo), but the
 * new `extractLoadAll` needs `{repoId, fullName}` pairs since meta is no
 * longer re-fetched per data type (see `extract-load.ts`'s module comment).
 * Only repos `discoverRepos` actually recorded successfully (`status ===
 * "ok"`, with a real `repoId`) are included — a repo discovery couldn't
 * upsert has nothing valid to extract/load against.
 */
export function buildRepoList(
  discoveryResults: DiscoveryResult[],
  limit: number | null,
): RepoRef[] {
  const refs: RepoRef[] = [];
  for (const result of discoveryResults) {
    if (result.status === "ok" && result.repoId !== null) {
      refs.push({ repoId: result.repoId, fullName: result.fullName });
    }
  }
  return typeof limit === "number" ? refs.slice(0, limit) : refs;
}

/**
 * Ported from the old `computeRunCounts`, adapted to `ExtractLoadResult`'s
 * shape. The counting logic is unchanged: a repo counts as failed if *any*
 * of its data-type results errored, even if others succeeded — matching the
 * old "a whole-repo meta-fetch failure is failed, not silently dropped" and
 * "one bad data type fails the whole repo" behaviors. Unlike the old shape,
 * `ExtractLoadResult.repoId` is always a real number (never null) — the
 * old `r.repoId` truthiness filter existed only to exclude the old
 * "meta"-fetch-failed-so-no-repoId-yet" case, which has no equivalent here
 * (a repo only ever reaches `extractLoadAll` after discovery already gave it
 * a valid `repoId`) — so this version doesn't need that filter.
 */
export function computeRunCounts(extractResults: ExtractLoadResult[]): {
  repoIds: Set<number>;
  reposFetchedOk: number;
  reposFailed: number;
} {
  const failedFullNames = new Set(
    extractResults.filter((r) => r.status === "error").map((r) => r.fullName),
  );
  const okFullNames = new Set(extractResults.map((r) => r.fullName));
  const repoIds = new Set(extractResults.map((r) => r.repoId));
  const reposFetchedOk = new Set(
    [...okFullNames].filter((name) => !failedFullNames.has(name)),
  ).size;
  const reposFailed = failedFullNames.size;
  return { repoIds, reposFetchedOk, reposFailed };
}

export interface RunPipelineParams {
  db: DrizzleDb;
  octokit: Octokit;
  anthropicClient: Anthropic;
  args: ParsedArgs;
  /** Injectable in tests in place of the real `fetchAccountRepos` Octokit call. */
  fetchRepos?: (octokit: Octokit) => Promise<import("./github/client").RepoMeta[]>;
  /** Injectable in tests in place of the real Octokit-backed fetch functions. */
  fetchCommits?: (fullName: string, since: string, octokit: Octokit) => Promise<Commit[]>;
  fetchIssues?: (fullName: string, since: string, octokit: Octokit) => Promise<Issue[]>;
  fetchPrs?: (fullName: string, since: string, octokit: Octokit) => Promise<PullRequest[]>;
  /** Injectable in tests in place of the real Octokit-backed fetchReadme. */
  fetchReadme?: (fullName: string, octokit: Octokit) => Promise<string>;
  /** Injectable in tests in place of the real Anthropic-backed assessment call. */
  generateAssessment?: (client: Anthropic, input: AssessmentInput) => Promise<Assessment>;
}

export interface RunPipelineSummary {
  runId: string;
  discoveredCount: number;
  reposFetchedOk: number;
  reposFailed: number;
}

/**
 * The actual Discover -> Extract+Load orchestration, factored out of
 * `main()` so it can be exercised directly in tests against an injected
 * PGlite `db` and injected fake Octokit-fetch functions, without going
 * through `main()`'s env-var reading / real `createDb`/`createOctokit`
 * wiring. `main()` below is a thin wrapper around this for real CLI use.
 */
export async function runPipeline({
  db,
  octokit,
  anthropicClient,
  args,
  fetchRepos,
  fetchCommits,
  fetchIssues,
  fetchPrs,
  fetchReadme,
  generateAssessment,
}: RunPipelineParams): Promise<RunPipelineSummary | undefined> {
  const {
    runId,
    startedAt,
    count: discoveredCount,
    results: discoveryResults,
    error: discoverError,
  } = await runDiscoveryScaffold({ db, octokit, fetchRepos });

  if (discoverError) {
    console.error(`run ${runId}: discovery failed, aborting: ${discoverError}`);
    return undefined;
  }

  if (args.dryRun) {
    await recordRunStart(db, runId, startedAt, discoveredCount);
    const repoIds = new Set(
      discoveryResults
        .filter((r) => r.status === "ok" && r.repoId !== null)
        .map((r) => r.repoId as number),
    );
    const unassessed = await countUnassessedRepos(db, repoIds);
    console.log(
      `run ${runId} (dry-run): ${discoveredCount} repos discovered, ${unassessed} have no prior assessment`,
    );
    await recordRunFinish(db, runId, new Date(), {
      status: "success",
      reposFetchedOk: 0,
      reposFailed: 0,
      llmCallsMade: 0,
      llmCallsSkipped: 0,
    });
    return { runId, discoveredCount, reposFetchedOk: 0, reposFailed: 0 };
  }

  const repoList = buildRepoList(discoveryResults, args.limit);
  await recordRunStart(db, runId, startedAt, discoveredCount);

  const extractResults = await extractLoadAll({
    repos: repoList,
    db,
    runId,
    octokit,
    now: startedAt,
    fetchCommits,
    fetchIssues,
    fetchPrs,
  });
  const { repoIds, reposFetchedOk, reposFailed } = computeRunCounts(extractResults);

  // No `publish` step — it's removed from the architecture entirely; the
  // SolidStart SSR route queries Postgres directly once the frontend phase
  // lands.
  const { llmCallsMade, llmCallsSkipped } = await enrichAll({
    db,
    octokit,
    anthropicClient,
    repoIds,
    runId,
    now: startedAt,
    fetchReadme,
    generateAssessment,
  });

  const finishedAt = new Date();
  await recordRunFinish(db, runId, finishedAt, {
    status: reposFailed > 0 ? "partial" : "success",
    reposFetchedOk,
    reposFailed,
    llmCallsMade,
    llmCallsSkipped,
  });

  console.log(
    `run ${runId}: ${reposFetchedOk} repos ok, ${reposFailed} repos with fetch errors, ` +
      `${llmCallsMade} enrichment calls made, ${llmCallsSkipped} skipped` +
      (args.limit ? ` (limited to ${args.limit} of ${discoveredCount} discovered repos)` : ""),
  );

  return { runId, discoveredCount, reposFetchedOk, reposFailed };
}

/**
 * Real CLI entrypoint. Reads `DATABASE_URL`/`GITHUB_TOKEN` from the
 * environment and fails fast with a clear error if either is missing
 * (rather than letting a missing env var surface later as a cryptic
 * downstream connection error), builds a real db/Octokit, runs the
 * pipeline, then closes the db connection.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL environment variable is required to run the pipeline — set it before running `node run.js`.",
    );
  }
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error(
      "GITHUB_TOKEN environment variable is required to run the pipeline — set it before running `node run.js`.",
    );
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required to run the pipeline — set it before running `node run.js`.",
    );
  }

  const db = createDb(databaseUrl);
  const octokit = createOctokit(process.env);
  const anthropicClient = createAnthropicClient(process.env);

  try {
    await runPipeline({ db, octokit, anthropicClient, args });
  } finally {
    await db.$client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Re-exported so callers/tests that only need the type don't have to reach
// into extract-load.ts directly.
export type { DataType };
