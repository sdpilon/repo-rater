"use strict";
const { openDb, ensureSchema, getIgnoredRepoIds } = require("./db");
const { extractAll, readBronzeJson } = require("./extract");
const { loadRun } = require("./load");
const { enrichRepo } = require("./enrich");
const { publish } = require("./publish");
const { discoverRepos } = require("./discover");
const { DB_PATH, BRONZE_DIR } = require("./config");
const {
  makeRunId,
  recordRunStart,
  recordRunFinish,
} = require("./run-tracking");

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

function parseArgs(argv) {
  const args = { dryRun: false, limit: null };
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

function buildRepoList(discoveredRepos, limit) {
  const fullNames = discoveredRepos.map((r) => r.fullName);
  return typeof limit === "number" ? fullNames.slice(0, limit) : fullNames;
}

async function countUnassessedRepos(db, repoIds) {
  if (repoIds.length === 0) return 0;
  const placeholders = repoIds.map(() => "?").join(",");
  const rows = await db.all(
    `SELECT DISTINCT repo_id FROM repo_assessments WHERE repo_id IN (${placeholders})`,
    ...repoIds,
  );
  const assessedIds = new Set(rows.map((r) => Number(r.repo_id)));
  return repoIds.filter((id) => !assessedIds.has(id)).length;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const db = openDb(DB_PATH);
  await ensureSchema(db);
  const runId = makeRunId();
  const startedAt = new Date().toISOString();

  const {
    repos: discovered,
    count: discoveredCount,
    error: discoverError,
  } = await discoverRepos({ db, runId, now: startedAt });

  if (discoverError) {
    console.error(`run ${runId}: discovery failed, aborting: ${discoverError}`);
    await db.close();
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    await recordRunStart(db, runId, startedAt, discoveredCount);
    const repoIds = discovered.map((r) => r.repoId);
    const unassessed = await countUnassessedRepos(db, repoIds);
    console.log(
      `run ${runId} (dry-run): ${discoveredCount} repos discovered, ` +
        `${unassessed} have no prior assessment`,
    );
    const finishedAt = new Date().toISOString();
    await recordRunFinish(db, runId, finishedAt, {
      status: "success",
      reposFetchedOk: 0,
      reposFailed: 0,
      llmCallsMade: 0,
      llmCallsSkipped: 0,
    });
    await db.close();
    return;
  }

  const repos = buildRepoList(discovered, args.limit);
  await recordRunStart(db, runId, startedAt, discoveredCount);

  const extractResults = await extractAll({
    repos,
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

  const ignoredRepoIds = await getIgnoredRepoIds(db, Array.from(repoIds));

  let llmCallsMade = 0;
  let llmCallsSkipped = 0;
  for (const repoId of repoIds) {
    if (ignoredRepoIds.has(repoId)) {
      llmCallsSkipped += 1;
      continue;
    }
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

  await publish({
    db,
    repoIds: Array.from(repoIds),
    runId,
    bronzeDir: BRONZE_DIR,
  });

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
      `${loadSummary.failuresRecorded} failures recorded, ${llmCallsMade} enrichment calls made, ${llmCallsSkipped} skipped` +
      (args.limit
        ? ` (limited to ${args.limit} of ${discoveredCount} discovered repos)`
        : ""),
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
  main,
  computeRunCounts,
  readEnrichInputs,
  parseArgs,
  buildRepoList,
  countUnassessedRepos,
};
