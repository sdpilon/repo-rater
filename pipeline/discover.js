"use strict";
const { openDb, ensureSchema } = require("./db");
const { fetchAccountRepos, defaultGhApiJson } = require("./github");
const { upsertRepo } = require("./load");
const { DB_PATH } = require("./config");
const {
  makeRunId,
  recordRunStart,
  recordRunFinish,
} = require("./run-tracking");

async function recordDiscovery(db, runId, repoId, seenAt) {
  await db.run(
    `INSERT OR REPLACE INTO repo_discoveries (run_id, repo_id, seen_at) VALUES (?, ?, ?)`,
    runId,
    repoId,
    seenAt,
  );
}

async function discoverRepos({ db, runId, now, ghApiJson = defaultGhApiJson }) {
  let repos;
  try {
    repos = fetchAccountRepos(ghApiJson);
  } catch (err) {
    return { repos: [], count: 0, results: [], error: String(err) };
  }

  const results = [];
  for (const meta of repos) {
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
  return { repos, count: repos.length, results };
}

async function main() {
  const db = openDb(DB_PATH);
  await ensureSchema(db);
  const runId = makeRunId();
  const startedAt = new Date().toISOString();
  const { repos, count, results, error } = await discoverRepos({
    db,
    runId,
    now: startedAt,
  });

  const reposRecordedOk = results.filter((r) => r.status === "ok").length;
  const reposFailed = results.filter((r) => r.status === "error").length;
  const finishedAt = new Date().toISOString();
  await recordRunStart(db, runId, startedAt, count);
  await recordRunFinish(db, runId, finishedAt, {
    status: error ? "failed" : reposFailed > 0 ? "partial" : "success",
    reposFetchedOk: reposRecordedOk,
    reposFailed,
    llmCallsMade: 0,
    llmCallsSkipped: 0,
  });

  if (error) {
    console.error(
      `discover ${runId}: failed to enumerate account repos: ${error}`,
    );
  } else {
    const forkCount = repos.filter((r) => r.isFork).length;
    const archivedCount = repos.filter((r) => r.isArchived).length;
    console.log(
      `discover ${runId}: ${count} repos discovered (${forkCount} forks, ${archivedCount} archived), ` +
        `${reposRecordedOk} recorded ok, ${reposFailed} failed`,
    );
    for (const r of repos) console.log(`  ${r.fullName}`);
  }
  await db.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { discoverRepos, recordDiscovery };
