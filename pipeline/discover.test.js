"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb, ensureSchema } = require("./db");
const { discoverRepos, runDiscoveryScaffold } = require("./discover");
const { recordRunStart, recordRunFinish } = require("./run-tracking");

function fakeGhApiJson(pathAndQuery) {
  const url = new URL(`https://x/${pathAndQuery}`);
  if (url.searchParams.get("page") !== "1") return [];
  return [
    {
      id: 1,
      full_name: "sdpilon/spilon.dev",
      description: "site",
      html_url: "https://github.com/sdpilon/spilon.dev",
      default_branch: "main",
      language: "Astro",
      stargazers_count: 1,
      private: false,
      fork: false,
      archived: false,
    },
    {
      id: 2,
      full_name: "sdpilon/typst-resume",
      description: "resume",
      html_url: "https://github.com/sdpilon/typst-resume",
      default_branch: "main",
      language: "Typst",
      stargazers_count: 0,
      private: false,
      fork: true,
      archived: false,
    },
  ];
}

test("discoverRepos upserts each repo into repos and records a repo_discoveries row for the run", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const { count } = await discoverRepos({
    db,
    runId: "run_1",
    now: "2026-07-23T00:00:00.000Z",
    ghApiJson: fakeGhApiJson,
  });
  assert.equal(count, 2);
  const repos = await db.all(
    "SELECT repo_id, full_name FROM repos ORDER BY repo_id",
  );
  assert.deepEqual(
    repos.map((r) => r.full_name),
    ["sdpilon/spilon.dev", "sdpilon/typst-resume"],
  );
  const discoveries = await db.all(
    "SELECT run_id, repo_id FROM repo_discoveries WHERE run_id = ? ORDER BY repo_id",
    "run_1",
  );
  assert.equal(discoveries.length, 2);
  await db.close();
});

test("discoverRepos run twice with different runIds appends distinct repo_discoveries rows instead of overwriting", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await discoverRepos({
    db,
    runId: "run_1",
    now: "2026-07-23T00:00:00.000Z",
    ghApiJson: fakeGhApiJson,
  });
  await discoverRepos({
    db,
    runId: "run_2",
    now: "2026-07-24T00:00:00.000Z",
    ghApiJson: fakeGhApiJson,
  });
  const allDiscoveries = await db.all(
    "SELECT run_id, COUNT(*) AS n FROM repo_discoveries GROUP BY run_id ORDER BY run_id",
  );
  assert.deepEqual(
    allDiscoveries.map((r) => ({ run_id: r.run_id, n: Number(r.n) })),
    [
      { run_id: "run_1", n: 2 },
      { run_id: "run_2", n: 2 },
    ],
  );
  await db.close();
});

test("discoverRepos preserves first_seen_at across repeated runs while advancing last_seen_at", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await discoverRepos({
    db,
    runId: "run_1",
    now: "2026-07-23T00:00:00.000Z",
    ghApiJson: fakeGhApiJson,
  });
  await discoverRepos({
    db,
    runId: "run_2",
    now: "2026-07-24T00:00:00.000Z",
    ghApiJson: fakeGhApiJson,
  });
  const rows = await db.all(
    "SELECT first_seen_at, last_seen_at FROM repos WHERE repo_id = 1",
  );
  assert.equal(rows[0].first_seen_at.toISOString(), "2026-07-23T00:00:00.000Z");
  assert.equal(rows[0].last_seen_at.toISOString(), "2026-07-24T00:00:00.000Z");
  await db.close();
});

test("discoverRepos records a per-repo error result and keeps processing the rest of the batch", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const flakyGhApiJson = (pathAndQuery) => {
    const url = new URL(`https://x/${pathAndQuery}`);
    if (url.searchParams.get("page") !== "1") return [];
    return [
      {
        id: null,
        full_name: "sdpilon/broken-repo",
        description: null,
        html_url: "u",
        default_branch: "main",
        language: null,
        stargazers_count: 0,
        private: false,
        fork: false,
        archived: false,
      },
      {
        id: 2,
        full_name: "sdpilon/typst-resume",
        description: "resume",
        html_url: "u2",
        default_branch: "main",
        language: "Typst",
        stargazers_count: 0,
        private: false,
        fork: false,
        archived: false,
      },
    ];
  };
  const { count, results } = await discoverRepos({
    db,
    runId: "run_1",
    now: "2026-07-23T00:00:00.000Z",
    ghApiJson: flakyGhApiJson,
  });
  assert.equal(count, 2);
  const broken = results.find((r) => r.fullName === "sdpilon/broken-repo");
  assert.equal(broken.status, "error");
  const ok = results.find((r) => r.fullName === "sdpilon/typst-resume");
  assert.equal(ok.status, "ok");
  const repos = await db.all("SELECT repo_id FROM repos");
  assert.equal(repos.length, 1);
  await db.close();
});

test("discoverRepos returns an error result instead of throwing when the account listing itself fails", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const throwingGhApiJson = () => {
    throw new Error("rate limited");
  };
  const result = await discoverRepos({
    db,
    runId: "run_1",
    now: "2026-07-23T00:00:00.000Z",
    ghApiJson: throwingGhApiJson,
  });
  assert.equal(result.count, 0);
  assert.match(result.error, /rate limited/);
  const repos = await db.all("SELECT repo_id FROM repos");
  assert.equal(repos.length, 0);
  await db.close();
});

test("runDiscoveryScaffold opens the db, ensures schema, generates a runId, and runs discovery against it", async () => {
  const { db, runId, startedAt, repos, count, results, error } =
    await runDiscoveryScaffold({
      dbPath: ":memory:",
      ghApiJson: fakeGhApiJson,
    });

  assert.equal(error, undefined);
  assert.equal(count, 2);
  assert.equal(repos.length, 2);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.status === "ok"));
  assert.equal(typeof runId, "string");
  assert.match(runId, /^run_/);
  assert.equal(typeof startedAt, "string");

  // Schema was ensured (not just opened) — repos/repo_discoveries exist and
  // were actually written to by the discoverRepos call inside the scaffold.
  const repoRows = await db.all(
    "SELECT repo_id, full_name FROM repos ORDER BY repo_id",
  );
  assert.deepEqual(
    repoRows.map((r) => r.full_name),
    ["sdpilon/spilon.dev", "sdpilon/typst-resume"],
  );

  const discoveryRows = await db.all(
    "SELECT run_id, repo_id FROM repo_discoveries WHERE run_id = ? ORDER BY repo_id",
    runId,
  );
  assert.equal(discoveryRows.length, 2);

  // The scaffold itself stops short of recordRunStart/recordRunFinish (see
  // the comment above runDiscoveryScaffold in discover.js: the two callers
  // record start/finish at different points with different semantics, so
  // unifying that into the scaffold would change run.js's behavior on a
  // discovery error). Confirm that's still true — no runs row yet — then
  // exercise the full sequence the way a real caller (e.g. discover.js's
  // own main()) does, layering recordRunStart/recordRunFinish on top, and
  // confirm that writes a runs row as expected.
  const runRowsBeforeRecord = await db.all(
    "SELECT run_id FROM runs WHERE run_id = ?",
    runId,
  );
  assert.equal(runRowsBeforeRecord.length, 0);

  await recordRunStart(db, runId, startedAt, count);
  await recordRunFinish(db, runId, new Date().toISOString(), {
    status: "success",
    reposFetchedOk: results.filter((r) => r.status === "ok").length,
    reposFailed: results.filter((r) => r.status === "error").length,
    llmCallsMade: 0,
    llmCallsSkipped: 0,
  });

  const runRows = await db.all(
    "SELECT run_id, status, repos_discovered FROM runs WHERE run_id = ?",
    runId,
  );
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0].status, "success");
  assert.equal(Number(runRows[0].repos_discovered), 2);

  await db.close();
});
