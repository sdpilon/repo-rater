"use strict";
const path = require("path");
const fs = require("fs");
const { openDb, ensureSchema } = require("./db");
const { extractAll } = require("./extract");
const { loadRun } = require("./load");
const { enrichRepo } = require("./enrich");
const { publish } = require("./publish");
const { REPOS, DB_PATH, BRONZE_DIR } = require("./config");

function makeRunId(now = new Date()) {
  return `run_${now.toISOString().replace(/[:.]/g, "-")}`;
}

function readBronzeJson(bronzeDir, runId, repoId, name) {
  const p = path.join(bronzeDir, runId, `${repoId}_${name}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

async function recordRunStart(db, runId, startedAt) {
  await db.run(
    `INSERT INTO runs (run_id, started_at, status, repos_discovered, repos_fetched_ok, repos_failed, llm_calls_made, llm_calls_skipped)
     VALUES (?, ?, 'partial', ?, 0, 0, 0, 0)`,
    runId, startedAt, REPOS.length
  );
}

async function recordRunFinish(db, runId, finishedAt, counts) {
  await db.run(
    `UPDATE runs SET finished_at = ?, status = ?, repos_fetched_ok = ?, repos_failed = ?, llm_calls_made = ?, llm_calls_skipped = ?
     WHERE run_id = ?`,
    finishedAt, counts.status, counts.reposFetchedOk, counts.reposFailed,
    counts.llmCallsMade, counts.llmCallsSkipped, runId
  );
}

async function main() {
  const db = openDb(DB_PATH);
  await ensureSchema(db);
  const runId = makeRunId();
  const startedAt = new Date().toISOString();
  await recordRunStart(db, runId, startedAt);

  const extractResults = await extractAll({ repos: REPOS, db, runId, bronzeDir: BRONZE_DIR });
  const loadSummary = await loadRun({ db, runId, bronzeDir: BRONZE_DIR, extractResults, now: startedAt });

  const failedRepoIds = new Set(extractResults.filter((r) => r.status === "error" && r.repoId).map((r) => r.repoId));
  const repoIds = new Set(extractResults.filter((r) => r.repoId).map((r) => r.repoId));
  const reposFetchedOk = new Set([...repoIds].filter((id) => !failedRepoIds.has(id))).size;

  let llmCallsMade = 0;
  let llmCallsSkipped = 0;
  for (const repoId of repoIds) {
    const meta = readBronzeJson(BRONZE_DIR, runId, repoId, "meta");
    const readmeText = readBronzeJson(BRONZE_DIR, runId, repoId, "readme") || "";
    const commits = readBronzeJson(BRONZE_DIR, runId, repoId, "commits") || [];
    const issues = readBronzeJson(BRONZE_DIR, runId, repoId, "issues") || [];
    const result = await enrichRepo({
      db, repoId, fullName: meta.fullName, runId,
      readmeText, commitMessages: commits.map((c) => c.message), issueTitles: issues.map((i) => i.title),
      now: new Date().toISOString(),
    });
    if (result.called) llmCallsMade += 1;
    else llmCallsSkipped += 1;
  }

  await publish({ db, repoIds: Array.from(repoIds) });

  const finishedAt = new Date().toISOString();
  await recordRunFinish(db, runId, finishedAt, {
    status: failedRepoIds.size > 0 ? "partial" : "success",
    reposFetchedOk, reposFailed: failedRepoIds.size, llmCallsMade, llmCallsSkipped,
  });

  console.log(
    `run ${runId}: ${reposFetchedOk} repos ok, ${failedRepoIds.size} repos with fetch errors, ` +
      `${loadSummary.failuresRecorded} failures recorded, ${llmCallsMade} LLM calls made, ${llmCallsSkipped} skipped`
  );
  await db.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { makeRunId, main };
