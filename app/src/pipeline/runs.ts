import { eq } from "drizzle-orm";
import { runs } from "../db/schema";
import type { DrizzleDb } from "./db-types";

/**
 * Run bookkeeping (the `runs` table), ported from repo-root
 * `pipeline/run-tracking.js` (read-only reference) to Drizzle/Postgres.
 * Logic is unchanged from the old version — only the storage calls differ.
 */

export function makeRunId(now: Date = new Date()): string {
  return `run_${now.toISOString().replace(/[:.]/g, "-")}`;
}

export async function recordRunStart(
  db: DrizzleDb,
  runId: string,
  startedAt: Date,
  reposDiscovered: number,
): Promise<void> {
  await db.insert(runs).values({
    runId,
    startedAt,
    status: "partial",
    reposDiscovered,
    reposFetchedOk: 0,
    reposFailed: 0,
    llmCallsMade: 0,
    llmCallsSkipped: 0,
  });
}

export interface RunFinishCounts {
  status: "success" | "partial" | "failed";
  reposFetchedOk: number;
  reposFailed: number;
  llmCallsMade: number;
  llmCallsSkipped: number;
}

export async function recordRunFinish(
  db: DrizzleDb,
  runId: string,
  finishedAt: Date,
  counts: RunFinishCounts,
): Promise<void> {
  await db
    .update(runs)
    .set({
      finishedAt,
      status: counts.status,
      reposFetchedOk: counts.reposFetchedOk,
      reposFailed: counts.reposFailed,
      llmCallsMade: counts.llmCallsMade,
      llmCallsSkipped: counts.llmCallsSkipped,
    })
    .where(eq(runs.runId, runId));
}
