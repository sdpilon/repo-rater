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

// Shared open→ensureSchema→runId→discoverRepos sequence used by both this
// module's own CLI (below) and run.js's main(). Deliberately stops short of
// recordRunStart/recordRunFinish: this main() records both unconditionally
// (even on a discovery error, so the failure is visible in `runs`), while
// run.js's main() only reaches recordRunStart when there was no discovery
// error, and defers recordRunFinish until after the rest of its pipeline
// (extract/load/enrich/publish) completes with different counts entirely.
// Folding those calls in here would either add a run.js row that wasn't
// there before or silently drop this module's failed-run bookkeeping — so
// each caller keeps recording start/finish itself, on top of this scaffold.
async function runDiscoveryScaffold({ dbPath, ghApiJson = defaultGhApiJson }) {
  const db = openDb(dbPath);
  await ensureSchema(db);
  const runId = makeRunId();
  const startedAt = new Date().toISOString();
  const result = await discoverRepos({ db, runId, now: startedAt, ghApiJson });
  return { db, runId, startedAt, ...result };
}

async function main() {
  const { db, runId, startedAt, repos, count, results, error } =
    await runDiscoveryScaffold({ dbPath: DB_PATH });

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

module.exports = { discoverRepos, recordDiscovery, runDiscoveryScaffold };
