"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb, ensureSchema, getWatermark } = require("./db");
const { loadRun } = require("./load");

function writeFixtureBronze(bronzeDir, runId, repoId) {
  const dir = path.join(bronzeDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${repoId}_meta.json`),
    JSON.stringify({
      repoId,
      fullName: "sdpilon/spilon.dev",
      description: "site",
      htmlUrl: "u",
      defaultBranch: "main",
      language: "Astro",
      stargazersCount: 1,
      isPrivate: false,
      isFork: false,
      isArchived: false,
    }),
  );
  fs.writeFileSync(
    path.join(dir, `${repoId}_commits.json`),
    JSON.stringify([
      {
        sha: "aaa",
        authorName: "Spencer",
        authoredAt: "2026-07-01T00:00:00Z",
        message: "fix",
      },
    ]),
  );
  fs.writeFileSync(
    path.join(dir, `${repoId}_issues.json`),
    JSON.stringify([
      {
        number: 1,
        title: "Bug",
        state: "open",
        createdAt: "2026-07-01T00:00:00Z",
        closedAt: null,
        labels: ["bug"],
      },
    ]),
  );
}

test("loadRun upserts repo, commits, and issues, and advances watermarks on success", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  writeFixtureBronze(bronzeDir, "run_1", 1);
  const extractResults = [
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "meta",
      status: "ok",
    },
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "readme",
      status: "ok",
    },
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "commits",
      status: "ok",
      since: "2020-01-01T00:00:00Z",
      fetchedAt: "2026-07-22T00:00:00.000Z",
    },
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "issues",
      status: "ok",
      since: "2020-01-01T00:00:00Z",
      fetchedAt: "2026-07-22T00:00:00.000Z",
    },
  ];
  const summary = await loadRun({
    db,
    runId: "run_1",
    bronzeDir,
    extractResults,
    now: "2026-07-22T00:00:00.000Z",
  });
  assert.equal(summary.reposLoaded, 1);
  assert.equal(summary.failuresRecorded, 0);

  const repos = await db.all("SELECT full_name FROM repos WHERE repo_id = 1");
  assert.equal(repos[0].full_name, "sdpilon/spilon.dev");
  const commits = await db.all("SELECT sha FROM commits WHERE repo_id = 1");
  assert.equal(commits.length, 1);
  const issues = await db.all("SELECT labels FROM issues WHERE repo_id = 1");
  assert.deepEqual(issues[0].labels, ["bug"]);
  const watermark = await getWatermark(db, 1, "commits");
  assert.ok(watermark instanceof Date);
  await db.close();
});

test("loadRun preserves first_seen_at across repeated runs while advancing last_seen_at", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  writeFixtureBronze(bronzeDir, "run_1", 1);
  const extractResults = [
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "meta",
      status: "ok",
    },
  ];
  await loadRun({
    db,
    runId: "run_1",
    bronzeDir,
    extractResults,
    now: "2026-07-20T00:00:00.000Z",
  });
  writeFixtureBronze(bronzeDir, "run_2", 1);
  await loadRun({
    db,
    runId: "run_2",
    bronzeDir,
    extractResults: [
      {
        fullName: "sdpilon/spilon.dev",
        repoId: 1,
        dataType: "meta",
        status: "ok",
      },
    ],
    now: "2026-07-22T00:00:00.000Z",
  });
  const rows = await db.all(
    "SELECT first_seen_at, last_seen_at FROM repos WHERE repo_id = 1",
  );
  assert.equal(rows[0].first_seen_at.toISOString(), "2026-07-20T00:00:00.000Z");
  assert.equal(rows[0].last_seen_at.toISOString(), "2026-07-22T00:00:00.000Z");
  await db.close();
});

test("loadRun records a fetch_failures row and does not advance the watermark when extract failed", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  writeFixtureBronze(bronzeDir, "run_1", 1);
  const extractResults = [
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "meta",
      status: "ok",
    },
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "commits",
      status: "error",
      error: "rate limited",
    },
  ];
  const summary = await loadRun({
    db,
    runId: "run_1",
    bronzeDir,
    extractResults,
    now: "2026-07-22T00:00:00.000Z",
  });
  assert.equal(summary.failuresRecorded, 1);
  const failures = await db.all(
    "SELECT error_message FROM fetch_failures WHERE repo_id = 1",
  );
  assert.equal(failures[0].error_message, "rate limited");
  const watermark = await getWatermark(db, 1, "commits");
  assert.equal(watermark, null);
  await db.close();
});

test("loadRun does not crash and does not record a fetch_failures row when extract failed before a repo_id was known", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  const extractResults = [
    {
      fullName: "sdpilon/broken-repo",
      repoId: null,
      dataType: "repo",
      status: "error",
      error: "totally unexpected failure",
    },
  ];
  const summary = await loadRun({
    db,
    runId: "run_1",
    bronzeDir,
    extractResults,
    now: "2026-07-22T00:00:00.000Z",
  });
  assert.equal(summary.reposLoaded, 0);
  assert.equal(summary.failuresRecorded, 0);
  const failures = await db.all(
    "SELECT COUNT(*)::INTEGER AS n FROM fetch_failures",
  );
  assert.equal(failures[0].n, 0);
  await db.close();
});

test("loadRun loads a successful data type and records a failure for a different data type on the same repo, independently", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  writeFixtureBronze(bronzeDir, "run_1", 1);
  const extractResults = [
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "meta",
      status: "ok",
    },
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "commits",
      status: "ok",
      since: "2020-01-01T00:00:00Z",
      fetchedAt: "2026-07-22T00:00:00.000Z",
    },
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "issues",
      status: "error",
      error: "issues endpoint timed out",
    },
  ];
  const summary = await loadRun({
    db,
    runId: "run_1",
    bronzeDir,
    extractResults,
    now: "2026-07-22T00:00:00.000Z",
  });
  assert.equal(summary.failuresRecorded, 1);
  const commits = await db.all("SELECT sha FROM commits WHERE repo_id = 1");
  assert.equal(commits.length, 1);
  const issues = await db.all(
    "SELECT COUNT(*)::INTEGER AS n FROM issues WHERE repo_id = 1",
  );
  assert.equal(issues[0].n, 0);
  const commitsWatermark = await getWatermark(db, 1, "commits");
  assert.ok(commitsWatermark instanceof Date);
  const issuesWatermark = await getWatermark(db, 1, "issues");
  assert.equal(issuesWatermark, null);
  await db.close();
});

test("loadRun preserves first_ingested_run_id across repeated loads of the same commit", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  writeFixtureBronze(bronzeDir, "run_1", 1);
  const extractResultsRun1 = [
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "meta",
      status: "ok",
    },
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "commits",
      status: "ok",
      since: "2020-01-01T00:00:00Z",
      fetchedAt: "2026-07-20T00:00:00.000Z",
    },
  ];
  await loadRun({
    db,
    runId: "run_1",
    bronzeDir,
    extractResults: extractResultsRun1,
    now: "2026-07-20T00:00:00.000Z",
  });
  writeFixtureBronze(bronzeDir, "run_2", 1);
  const extractResultsRun2 = [
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "meta",
      status: "ok",
    },
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "commits",
      status: "ok",
      since: "2020-01-01T00:00:00Z",
      fetchedAt: "2026-07-22T00:00:00.000Z",
    },
  ];
  await loadRun({
    db,
    runId: "run_2",
    bronzeDir,
    extractResults: extractResultsRun2,
    now: "2026-07-22T00:00:00.000Z",
  });
  const rows = await db.all(
    "SELECT first_ingested_run_id FROM commits WHERE repo_id = 1 AND sha = 'aaa'",
  );
  assert.equal(rows[0].first_ingested_run_id, "run_1");
  await db.close();
});
