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

function computeRunCounts(extractResults) {
  const failedFullNames = new Set(
    extractResults.filter((r) => r.status === "error").map((r) => r.fullName),
  );
  const okFullNames = new Set(
    extractResults.filter((r) => r.repoId).map((r) => r.fullName),
  );
  const repoIds = new Set(
    extractResults.filter((r) => r.repoId).map((r) => r.repoId),
  );
  const reposFetchedOk = new Set(
    [...okFullNames].filter((name) => !failedFullNames.has(name)),
  ).size;
  const reposFailed = failedFullNames.size;
  return { repoIds, reposFetchedOk, reposFailed };
}

function readBronzeJson(bronzeDir, runId, repoId, name) {
  const p = path.join(bronzeDir, runId, `${repoId}_${name}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

// Commits/issues are watermarked (incremental) — a given run's bronze file
// only holds *new* rows since the last fetch, which is empty on almost every
// run after the first. Hashing that delta would make the content-hash gate
// see a "change" on every run regardless of whether anything actually
// changed. Enrichment needs the repo's full current state, so this reads
// commits/issues from the silver layer (DuckDB) instead of this run's
// bronze delta. Only readme has no watermark — it's refetched in full every
// run, so this run's bronze copy of it already is the current full state.
async function readEnrichInputs(db, bronzeDir, runId, repoId) {
  const readmeText = readBronzeJson(bronzeDir, runId, repoId, "readme") || "";
  const commits = await db.all(
    "SELECT message FROM commits WHERE repo_id = ?",
    repoId,
  );
  const issues = await db.all(
    "SELECT title FROM issues WHERE repo_id = ?",
    repoId,
  );
  return {
    readmeText,
    commitMessages: commits.map((c) => c.message),
    issueTitles: issues.map((i) => i.title),
  };
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

async function main() {
  const db = openDb(DB_PATH);
  await ensureSchema(db);
  const runId = makeRunId();
  const startedAt = new Date().toISOString();
  await recordRunStart(db, runId, startedAt, REPOS.length);

  const extractResults = await extractAll({
    repos: REPOS,
    db,
    runId,
    bronzeDir: BRONZE_DIR,
  });
  const loadSummary = await loadRun({
    db,
    runId,
    bronzeDir: BRONZE_DIR,
    extractResults,
    now: startedAt,
  });

  const { repoIds, reposFetchedOk, reposFailed } =
    computeRunCounts(extractResults);

  let llmCallsMade = 0;
  let llmCallsSkipped = 0;
  for (const repoId of repoIds) {
    const meta = readBronzeJson(BRONZE_DIR, runId, repoId, "meta");
    const { readmeText, commitMessages, issueTitles } = await readEnrichInputs(
      db,
      BRONZE_DIR,
      runId,
      repoId,
    );
    const result = await enrichRepo({
      db,
      repoId,
      fullName: meta.fullName,
      runId,
      readmeText,
      commitMessages,
      issueTitles,
      now: new Date().toISOString(),
    });
    if (result.called) llmCallsMade += 1;
    else llmCallsSkipped += 1;
  }

  await publish({ db, repoIds: Array.from(repoIds) });

  const finishedAt = new Date().toISOString();
  await recordRunFinish(db, runId, finishedAt, {
    status: reposFailed > 0 ? "partial" : "success",
    reposFetchedOk,
    reposFailed,
    llmCallsMade,
    llmCallsSkipped,
  });

  console.log(
    `run ${runId}: ${reposFetchedOk} repos ok, ${reposFailed} repos with fetch errors, ` +
      `${loadSummary.failuresRecorded} failures recorded, ${llmCallsMade} LLM calls made, ${llmCallsSkipped} skipped`,
  );
  await db.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  makeRunId,
  main,
  computeRunCounts,
  readEnrichInputs,
  recordRunStart,
  recordRunFinish,
};
