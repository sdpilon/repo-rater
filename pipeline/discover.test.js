"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb, ensureSchema } = require("./db");
const { discoverRepos } = require("./discover");

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
