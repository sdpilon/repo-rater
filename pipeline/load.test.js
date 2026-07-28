"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb, ensureSchema, getWatermark } = require("./db");
const { loadRun, applySuggestedIgnoreDefaults } = require("./load");

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
  fs.writeFileSync(
    path.join(dir, `${repoId}_prs.json`),
    JSON.stringify([
      {
        number: 5,
        title: "Add feature",
        state: "closed",
        createdAt: "2026-07-01T00:00:00Z",
        mergedAt: "2026-07-02T00:00:00Z",
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
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "prs",
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
  const prs = await db.all(
    "SELECT title, merged_at FROM pull_requests WHERE repo_id = 1",
  );
  assert.equal(prs.length, 1);
  assert.equal(prs[0].title, "Add feature");
  assert.ok(prs[0].merged_at instanceof Date);
  const watermark = await getWatermark(db, 1, "commits");
  assert.ok(watermark instanceof Date);
  const prsWatermark = await getWatermark(db, 1, "prs");
  assert.ok(prsWatermark instanceof Date);
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

test("loadRun preserves is_ignored across repeated runs instead of resetting it", async () => {
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
  await db.run("UPDATE repos SET is_ignored = true WHERE repo_id = 1");
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
  const rows = await db.all("SELECT is_ignored FROM repos WHERE repo_id = 1");
  assert.equal(rows[0].is_ignored, true);
  await db.close();
});

test("loadRun preserves ignore_source across repeated runs instead of resetting it to auto", async () => {
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
  await db.run(
    "UPDATE repos SET is_ignored = true, ignore_source = 'manual' WHERE repo_id = 1",
  );
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
    "SELECT ignore_source FROM repos WHERE repo_id = 1",
  );
  assert.equal(rows[0].ignore_source, "manual");
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
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "prs",
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
  assert.equal(summary.failuresRecorded, 1);
  const commits = await db.all("SELECT sha FROM commits WHERE repo_id = 1");
  assert.equal(commits.length, 1);
  const issues = await db.all(
    "SELECT COUNT(*)::INTEGER AS n FROM issues WHERE repo_id = 1",
  );
  assert.equal(issues[0].n, 0);
  const prs = await db.all(
    "SELECT COUNT(*)::INTEGER AS n FROM pull_requests WHERE repo_id = 1",
  );
  assert.equal(prs[0].n, 1);
  const commitsWatermark = await getWatermark(db, 1, "commits");
  assert.ok(commitsWatermark instanceof Date);
  const issuesWatermark = await getWatermark(db, 1, "issues");
  assert.equal(issuesWatermark, null);
  const prsWatermark = await getWatermark(db, 1, "prs");
  assert.ok(prsWatermark instanceof Date);
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

test("loadRun throws a clear 'Required bronze file missing' error, not a raw ENOENT, when the meta bronze file is absent", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  // Deliberately do not write any fixture bronze files for this run/repo.
  const extractResults = [
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "meta",
      status: "ok",
    },
  ];
  await assert.rejects(
    () =>
      loadRun({
        db,
        runId: "run_1",
        bronzeDir,
        extractResults,
        now: "2026-07-22T00:00:00.000Z",
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Required bronze file missing/);
      assert.doesNotMatch(err.message, /ENOENT/);
      return true;
    },
  );
  await db.close();
});

test("loadRun throws a clear 'Required bronze file missing' error, not a raw ENOENT, when the commits bronze file is absent", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  const dir = path.join(bronzeDir, "run_1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "1_meta.json"),
    JSON.stringify({
      repoId: 1,
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
  // Deliberately do not write the commits bronze file.
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
  ];
  await assert.rejects(
    () =>
      loadRun({
        db,
        runId: "run_1",
        bronzeDir,
        extractResults,
        now: "2026-07-22T00:00:00.000Z",
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Required bronze file missing/);
      assert.doesNotMatch(err.message, /ENOENT/);
      return true;
    },
  );
  await db.close();
});

async function insertRepo(db, repoId, { isFork = false, isArchived = false } = {}) {
  await db.run(
    `INSERT INTO repos
      (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, is_ignored, first_seen_at, last_seen_at)
     VALUES (?, 'sdpilon/x', null, null, 'main', null, 0, false, ?, ?, false, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')`,
    repoId,
    isFork,
    isArchived,
  );
}

function writeReadmeBronze(bronzeDir, runId, repoId, readme) {
  const dir = path.join(bronzeDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${repoId}_readme.json`),
    JSON.stringify(readme),
  );
}

test("applySuggestedIgnoreDefaults ignores a fork and marks ignore_source auto", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await insertRepo(db, 1, { isFork: true });
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  writeReadmeBronze(bronzeDir, "run_1", 1, "# real readme");

  await applySuggestedIgnoreDefaults(db, [1], { bronzeDir, runId: "run_1" });

  const rows = await db.all(
    "SELECT is_ignored, ignore_source FROM repos WHERE repo_id = 1",
  );
  assert.equal(rows[0].is_ignored, true);
  assert.equal(rows[0].ignore_source, "auto");
  await db.close();
});

test("applySuggestedIgnoreDefaults leaves a real, active repo not ignored", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await insertRepo(db, 1);
  await db.run(
    `INSERT INTO commits (repo_id, sha, author_name, authored_at, message, first_ingested_run_id)
     VALUES (1, 'aaa', 'Spencer', '2026-07-01T00:00:00Z', 'fix', 'run_1')`,
  );
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  writeReadmeBronze(bronzeDir, "run_1", 1, "# real readme");

  await applySuggestedIgnoreDefaults(db, [1], { bronzeDir, runId: "run_1" });

  const rows = await db.all(
    "SELECT is_ignored, ignore_source FROM repos WHERE repo_id = 1",
  );
  assert.equal(rows[0].is_ignored, false);
  assert.equal(rows[0].ignore_source, "auto");
  await db.close();
});

test("applySuggestedIgnoreDefaults does not touch a repo whose ignore_source is manual, even if signals match", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await insertRepo(db, 1, { isFork: true });
  await db.run(
    "UPDATE repos SET is_ignored = false, ignore_source = 'manual' WHERE repo_id = 1",
  );
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  writeReadmeBronze(bronzeDir, "run_1", 1, "# real readme");

  await applySuggestedIgnoreDefaults(db, [1], { bronzeDir, runId: "run_1" });

  const rows = await db.all(
    "SELECT is_ignored, ignore_source FROM repos WHERE repo_id = 1",
  );
  assert.equal(rows[0].is_ignored, false);
  assert.equal(rows[0].ignore_source, "manual");
  await db.close();
});

test("applySuggestedIgnoreDefaults flips a previously auto-ignored repo back to not-ignored once its signals stop matching", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await insertRepo(db, 1, { isFork: true });
  await db.run(
    `INSERT INTO commits (repo_id, sha, author_name, authored_at, message, first_ingested_run_id)
     VALUES (1, 'aaa', 'Spencer', '2026-07-01T00:00:00Z', 'fix', 'run_1')`,
  );
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  writeReadmeBronze(bronzeDir, "run_1", 1, "# real readme");
  await applySuggestedIgnoreDefaults(db, [1], { bronzeDir, runId: "run_1" });

  await db.run("UPDATE repos SET is_fork = false WHERE repo_id = 1");
  await applySuggestedIgnoreDefaults(db, [1], { bronzeDir, runId: "run_1" });

  const rows = await db.all(
    "SELECT is_ignored, ignore_source FROM repos WHERE repo_id = 1",
  );
  assert.equal(rows[0].is_ignored, false);
  assert.equal(rows[0].ignore_source, "auto");
  await db.close();
});
