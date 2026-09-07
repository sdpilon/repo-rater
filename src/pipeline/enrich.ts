import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { count, desc, eq, inArray } from "drizzle-orm";
import type { Octokit } from "octokit";
import {
  commits,
  issues,
  pullRequests,
  repoAssessments,
  repos,
} from "../db/schema";
import { generateAssessment as realGenerateAssessment } from "./anthropic/client";
import type { Assessment, AssessmentInput } from "./anthropic/client";
import type { DrizzleDb } from "./db-types";
import { fetchReadme as realFetchReadme } from "./github/client";
import { applyIgnoreDefaultForRepo } from "./ignore-rules";

/**
 * Content-hash-gated, Anthropic-backed assessment generation, appended to
 * the always-append-only `repo_assessments` table. Commit/issue/PR queries
 * use an explicit `ORDER BY` so the hash is deterministic.
 *
 * `enrichAll` recomputes the ignore default and runs enrichment in a single
 * per-repo pass, rather than two separate full passes over every touched
 * repo. There's no cache for README (see `extract-load.ts`'s module
 * comment), so a second pass would fetch each repo's README from GitHub
 * twice; a single pass still preserves the critical guarantee that ignore
 * state is recomputed before the skip-check.
 */

export function computeInputHash(
  readmeText: string,
  commitMessages: string[],
  issueTitles: string[],
  issueStates: string[],
  prTitles: string[],
  prStates: string[],
): string {
  const combined = [
    readmeText || "",
    ...commitMessages,
    ...issueTitles,
    ...issueStates,
    ...prTitles,
    ...prStates,
  ].join("\n---\n");
  return createHash("sha256").update(combined).digest("hex");
}

export interface EnrichInputs {
  commitMessages: string[];
  issueTitles: string[];
  issueStates: string[];
  prTitles: string[];
  prStates: string[];
}

/**
 * Reads the full current state of a repo's commits/issues/prs from
 * Postgres — not just this run's delta — since the content-hash gate needs
 * to see the same input set every run regardless of what's newly fetched.
 * README isn't read here; it has no watermark and is fetched fresh by
 * `enrichAll` right when it's needed — always fresh, never cached.
 */
export async function readEnrichInputs(
  db: DrizzleDb,
  repoId: number,
): Promise<EnrichInputs> {
  const commitRows = await db
    .select({ message: commits.message })
    .from(commits)
    .where(eq(commits.repoId, repoId))
    .orderBy(commits.sha);
  const issueRows = await db
    .select({ title: issues.title, state: issues.state })
    .from(issues)
    .where(eq(issues.repoId, repoId))
    .orderBy(issues.number);
  const prRows = await db
    .select({ title: pullRequests.title, state: pullRequests.state })
    .from(pullRequests)
    .where(eq(pullRequests.repoId, repoId))
    .orderBy(pullRequests.number);

  return {
    commitMessages: commitRows.map((r) => r.message ?? ""),
    issueTitles: issueRows.map((r) => r.title ?? ""),
    issueStates: issueRows.map((r) => r.state ?? ""),
    prTitles: prRows.map((r) => r.title ?? ""),
    prStates: prRows.map((r) => r.state ?? ""),
  };
}

async function getActivityCounts(
  db: DrizzleDb,
  repoId: number,
): Promise<{ commitCount: number; issueCount: number; prCount: number }> {
  const [commitRows, issueRows, prRows] = await Promise.all([
    db
      .select({ count: count() })
      .from(commits)
      .where(eq(commits.repoId, repoId)),
    db.select({ count: count() }).from(issues).where(eq(issues.repoId, repoId)),
    db
      .select({ count: count() })
      .from(pullRequests)
      .where(eq(pullRequests.repoId, repoId)),
  ]);
  return {
    commitCount: Number(commitRows[0]?.count ?? 0),
    issueCount: Number(issueRows[0]?.count ?? 0),
    prCount: Number(prRows[0]?.count ?? 0),
  };
}

export interface EnrichRepoParams extends EnrichInputs {
  client: Anthropic;
  db: DrizzleDb;
  repoId: number;
  runId: string;
  fullName: string;
  readmeText: string;
  now: Date;
  /** Injectable in tests in place of the real Anthropic-backed call. */
  generateAssessment?: (
    client: Anthropic,
    input: AssessmentInput,
  ) => Promise<Assessment>;
}

/**
 * Content-hash gate: skips the LLM call (and any DB write) when the latest
 * `repo_assessments` row for this repo already has the same `input_hash`.
 * `repo_assessments` is append-only — a changed hash always inserts a new
 * row, never updates one in place; "current" = latest row by `created_at`.
 */
export async function enrichRepo({
  client,
  db,
  repoId,
  runId,
  fullName,
  readmeText,
  commitMessages,
  issueTitles,
  issueStates,
  prTitles,
  prStates,
  now,
  generateAssessment = realGenerateAssessment,
}: EnrichRepoParams): Promise<{ repoId: number; called: boolean }> {
  const inputHash = computeInputHash(
    readmeText,
    commitMessages,
    issueTitles,
    issueStates,
    prTitles,
    prStates,
  );

  const [latest] = await db
    .select({ inputHash: repoAssessments.inputHash })
    .from(repoAssessments)
    .where(eq(repoAssessments.repoId, repoId))
    .orderBy(desc(repoAssessments.createdAt))
    .limit(1);

  if (latest && latest.inputHash === inputHash) {
    return { repoId, called: false };
  }

  const assessmentInput: AssessmentInput = {
    fullName,
    readmeText,
    commitMessages,
    issueTitles,
    issueStates,
    prTitles,
    prStates,
  };
  const assessment = await generateAssessment(client, assessmentInput);

  await db.insert(repoAssessments).values({
    repoId,
    runId,
    inputHash,
    pct: assessment.pct,
    band: assessment.band,
    label: assessment.label,
    text: assessment.text,
    gaps: assessment.gaps,
    inputSnapshot: assessmentInput,
    createdAt: now,
  });

  return { repoId, called: true };
}

/** Used by `run.ts`'s dry-run branch. */
export async function countUnassessedRepos(
  db: DrizzleDb,
  repoIds: Set<number>,
): Promise<number> {
  const ids = Array.from(repoIds);
  if (ids.length === 0) return 0;
  const assessedRows = await db
    .selectDistinct({ repoId: repoAssessments.repoId })
    .from(repoAssessments)
    .where(inArray(repoAssessments.repoId, ids));
  const assessedIds = new Set(assessedRows.map((r) => r.repoId));
  return ids.filter((id) => !assessedIds.has(id)).length;
}

async function fetchReadmeSafely(
  fetchReadme: (fullName: string, octokit: Octokit) => Promise<string>,
  fullName: string,
  octokit: Octokit,
): Promise<string> {
  try {
    return await fetchReadme(fullName, octokit);
  } catch {
    // A missing/inaccessible README is not a fatal error for ignore-checking
    // or enrichment — treated as "no README".
    return "";
  }
}

export interface EnrichAllParams {
  db: DrizzleDb;
  octokit: Octokit;
  anthropicClient: Anthropic;
  repoIds: Set<number>;
  runId: string;
  now: Date;
  /** Injectable in tests in place of the real Octokit-backed fetchReadme. */
  fetchReadme?: (fullName: string, octokit: Octokit) => Promise<string>;
  /** Injectable in tests in place of the real Anthropic-backed call. */
  generateAssessment?: (
    client: Anthropic,
    input: AssessmentInput,
  ) => Promise<Assessment>;
}

/**
 * Per-repo orchestration: recompute the ignore default, skip enrichment for
 * ignored repos or repos with a manually-overridden assessment
 * (`assessment_source === 'manual'`), otherwise run the content-hash-gated
 * enrichment. Wrapped in a try/catch per repo — a failure anywhere in a
 * single repo's handling is logged and counted as skipped, never aborts the
 * run for the rest of the batch (the same failure-isolation pattern as
 * `extractLoadAll`).
 */
export async function enrichAll({
  db,
  octokit,
  anthropicClient,
  repoIds,
  runId,
  now,
  fetchReadme = realFetchReadme,
  generateAssessment = realGenerateAssessment,
}: EnrichAllParams): Promise<{
  llmCallsMade: number;
  llmCallsSkipped: number;
  llmCallsFailed: number;
}> {
  let llmCallsMade = 0;
  let llmCallsSkipped = 0;
  let llmCallsFailed = 0;

  for (const repoId of repoIds) {
    try {
      const [repoRow] = await db
        .select({
          fullName: repos.fullName,
          ignoreSource: repos.ignoreSource,
          assessmentSource: repos.assessmentSource,
          isIgnored: repos.isIgnored,
        })
        .from(repos)
        .where(eq(repos.repoId, repoId));

      if (!repoRow) {
        llmCallsSkipped += 1;
        continue;
      }

      let isIgnored = repoRow.isIgnored;
      let readmeText: string | null = null;

      if (repoRow.ignoreSource !== "manual") {
        readmeText = await fetchReadmeSafely(
          fetchReadme,
          repoRow.fullName,
          octokit,
        );
        const counts = await getActivityCounts(db, repoId);
        const result = await applyIgnoreDefaultForRepo(db, repoId, {
          readme: readmeText,
          ...counts,
        });
        isIgnored = result.ignored;
      }

      if (isIgnored || repoRow.assessmentSource === "manual") {
        llmCallsSkipped += 1;
        continue;
      }

      if (readmeText === null) {
        readmeText = await fetchReadmeSafely(
          fetchReadme,
          repoRow.fullName,
          octokit,
        );
      }

      const inputs = await readEnrichInputs(db, repoId);
      const result = await enrichRepo({
        client: anthropicClient,
        db,
        repoId,
        runId,
        fullName: repoRow.fullName,
        readmeText,
        ...inputs,
        now,
        generateAssessment,
      });

      if (result.called) llmCallsMade += 1;
      else llmCallsSkipped += 1;
    } catch (err) {
      console.error(
        `run ${runId}: enrichment failed for repo ${repoId}, skipping: ${String(err)}`,
      );
      llmCallsFailed += 1;
    }
  }

  return { llmCallsMade, llmCallsSkipped, llmCallsFailed };
}
