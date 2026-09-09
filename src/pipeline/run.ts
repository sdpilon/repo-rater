import type Anthropic from "@anthropic-ai/sdk";
import type { Octokit } from "octokit";
import { createDb } from "../db/client";
import { resolveConfig } from "../lib/config";
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
 * Phase 1+2 orchestrator: Discover -> Extract+Load -> Enrich. There is no
 * publish step — the SolidStart SSR route queries Postgres directly.
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
 * Builds the `{repoId, fullName}` pairs `extractLoadAll` needs (see
 * `extract-load.ts`'s module comment for why meta isn't re-fetched per data
 * type). Only repos `discoverRepos` actually recorded successfully
 * (`status === "ok"`, with a real `repoId`) are included — a repo discovery
 * couldn't upsert has nothing valid to extract/load against.
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
 * Computes per-run repo counts from `ExtractLoadResult`s. A repo counts as
 * failed if *any* of its data-type results errored, even if others
 * succeeded — one bad data type fails the whole repo. `repoId` is always a
 * real number (never null): a repo only ever reaches `extractLoadAll` after
 * discovery already gave it a valid `repoId`.
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
  fetchRepos?: (
    octokit: Octokit,
  ) => Promise<import("./github/client").RepoMeta[]>;
  /** Injectable in tests in place of the real Octokit-backed fetch functions. */
  fetchCommits?: (
    fullName: string,
    since: string,
    octokit: Octokit,
  ) => Promise<Commit[]>;
  fetchIssues?: (
    fullName: string,
    since: string,
    octokit: Octokit,
  ) => Promise<Issue[]>;
  fetchPrs?: (
    fullName: string,
    since: string,
    octokit: Octokit,
  ) => Promise<PullRequest[]>;
  /** Injectable in tests in place of the real Octokit-backed fetchReadme. */
  fetchReadme?: (fullName: string, octokit: Octokit) => Promise<string>;
  /** Injectable in tests in place of the real Anthropic-backed assessment call. */
  generateAssessment?: (
    client: Anthropic,
    input: AssessmentInput,
  ) => Promise<Assessment>;
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
    await recordRunStart(db, runId, startedAt, discoveredCount);
    await recordRunFinish(db, runId, new Date(), {
      status: "failed",
      reposFetchedOk: 0,
      reposFailed: 0,
      llmCallsMade: 0,
      llmCallsSkipped: 0,
    });
    return undefined;
  }

  if (args.dryRun) {
    await recordRunStart(db, runId, startedAt, discoveredCount);
    const repoIds = new Set(
      buildRepoList(discoveryResults, args.limit).map((r) => r.repoId),
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
  const { repoIds, reposFetchedOk, reposFailed } =
    computeRunCounts(extractResults);

  // No `publish` step — it's removed from the architecture entirely; the
  // SolidStart SSR route queries Postgres directly once the frontend phase
  // lands.
  const { llmCallsMade, llmCallsSkipped, llmCallsFailed } = await enrichAll({
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
    status: reposFailed > 0 || llmCallsFailed > 0 ? "partial" : "success",
    reposFetchedOk,
    reposFailed,
    llmCallsMade,
    // Errored enrichment attempts are folded into the persisted "skipped"
    // count (there's no separate failed-count column), but they still flip
    // `status` to "partial" above and are called out explicitly in the log
    // line below so a run where enrichment silently stopped working doesn't
    // read as an unremarkable success.
    llmCallsSkipped: llmCallsSkipped + llmCallsFailed,
  });

  console.log(
    `run ${runId}: ${reposFetchedOk} repos ok, ${reposFailed} repos with fetch errors, ` +
      `${llmCallsMade} enrichment calls made, ${llmCallsSkipped} skipped, ${llmCallsFailed} failed` +
      (args.limit
        ? ` (limited to ${args.limit} of ${discoveredCount} discovered repos)`
        : ""),
  );

  return { runId, discoveredCount, reposFetchedOk, reposFailed };
}

/**
 * The same credential checks `main()` used to do inline, factored out so
 * both the CLI entrypoint and a UI-triggerable path can share them —
 * returning a reportable result instead of throwing, since a UI caller
 * needs to surface a missing credential as a message, not an uncaught
 * exception.
 */
export function resolvePipelineCredentials():
  | {
      ok: true;
      databaseUrl: string;
      githubToken: string;
      anthropicApiKey: string;
    }
  | { ok: false; error: string } {
  const databaseUrl = resolveConfig("DATABASE_URL");
  if (!databaseUrl) {
    return {
      ok: false,
      error:
        "DATABASE_URL is not configured — set the DATABASE_URL environment variable or configure it via the dashboard settings before running `node run.js`.",
    };
  }
  const githubToken = resolveConfig("PIPELINE_GH_TOKEN");
  if (!githubToken) {
    return {
      ok: false,
      error:
        "PIPELINE_GH_TOKEN is not configured — set the PIPELINE_GH_TOKEN environment variable or configure it via the dashboard settings before running `node run.js`.",
    };
  }
  const anthropicApiKey = resolveConfig("ANTHROPIC_API_KEY");
  if (!anthropicApiKey) {
    return {
      ok: false,
      error:
        "ANTHROPIC_API_KEY is not configured — set the ANTHROPIC_API_KEY environment variable or configure it via the dashboard settings before running `node run.js`.",
    };
  }
  return { ok: true, databaseUrl, githubToken, anthropicApiKey };
}

/**
 * Resolves credentials, builds a real db/Octokit/Anthropic client, runs the
 * pipeline, and closes the db connection — the shared implementation behind
 * both `main()` (CLI) and the UI's on-demand trigger action. Returns a
 * reportable result rather than throwing on a missing credential; opens its
 * own db connection (not `src/lib/server-db.ts`'s cached singleton) so it
 * can close it when done, same as `main()` always has.
 */
export async function runPipelineFromConfig(
  args: ParsedArgs,
): Promise<
  | { ok: true; summary: RunPipelineSummary | undefined }
  | { ok: false; error: string }
> {
  const credentials = resolvePipelineCredentials();
  if (!credentials.ok) {
    return { ok: false, error: credentials.error };
  }

  const db = createDb(credentials.databaseUrl);
  const octokit = createOctokit({
    PIPELINE_GH_TOKEN: credentials.githubToken,
  } as NodeJS.ProcessEnv);
  const anthropicClient = createAnthropicClient({
    ANTHROPIC_API_KEY: credentials.anthropicApiKey,
  } as NodeJS.ProcessEnv);

  try {
    const summary = await runPipeline({ db, octokit, anthropicClient, args });
    return { ok: true, summary };
  } finally {
    await db.$client.end();
  }
}

/**
 * Real CLI entrypoint. Delegates to `runPipelineFromConfig` and throws on
 * a missing credential or a downstream failure, preserving the existing
 * fail-fast CLI behavior (the bottom-of-file `main().catch(...)` still logs
 * and exits 1).
 */
export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArgs(argv);
  const result = await runPipelineFromConfig(args);
  if (!result.ok) {
    throw new Error(result.error);
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
