"use strict";

function makeRunId(now = new Date()) {
  return `run_${now.toISOString().replace(/[:.]/g, "-")}`;
}

async function recordRunStart(db, runId, startedAt, reposDiscovered) {
  await db.run(
    `INSERT INTO runs (run_id, started_at, status, repos_discovered, repos_fetched_ok, repos_failed, llm_calls_made, llm_calls_skipped)
     VALUES (?, ?, 'partial', ?, 0, 0, 0, 0)`,
    runId,
    startedAt,
    reposDiscovered,
  );
}

async function recordRunFinish(db, runId, finishedAt, counts) {
  await db.run(
    `UPDATE runs SET finished_at = ?, status = ?, repos_fetched_ok = ?, repos_failed = ?, llm_calls_made = ?, llm_calls_skipped = ?
     WHERE run_id = ?`,
    finishedAt,
    counts.status,
    counts.reposFetchedOk,
    counts.reposFailed,
    counts.llmCallsMade,
    counts.llmCallsSkipped,
    runId,
  );
}

module.exports = { makeRunId, recordRunStart, recordRunFinish };
