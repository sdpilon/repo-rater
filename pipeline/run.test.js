"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  computeRunCounts,
  readEnrichInputs,
  parseArgs,
  buildRepoList,
} = require("./run");
const { openDb, ensureSchema } = require("./db");

test("computeRunCounts counts a whole-repo meta-fetch failure as failed, not silently dropped", () => {
  const extractResults = [
    {
      fullName: "sdpilon/broken-repo",
      repoId: null,
      dataType: "meta",
      status: "error",
      error: "repo not found",
    },
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
    },
  ];
  const counts = computeRunCounts(extractResults);
  assert.equal(counts.reposFetchedOk, 1);
  assert.equal(counts.reposFailed, 1);
  assert.deepEqual([...counts.repoIds], [1]);
});

test("computeRunCounts counts a repo as failed (not ok) when only one of its data types errors", () => {
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
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "issues",
      status: "ok",
    },
  ];
  const counts = computeRunCounts(extractResults);
  assert.equal(counts.reposFetchedOk, 0);
  assert.equal(counts.reposFailed, 1);
});

test("computeRunCounts reports all repos ok when nothing failed", () => {
  const extractResults = [
    {
      fullName: "sdpilon/spilon.dev",
      repoId: 1,
      dataType: "meta",
      status: "ok",
    },
    {
      fullName: "sdpilon/typst-resume",
      repoId: 2,
      dataType: "meta",
      status: "ok",
    },
  ];
  const counts = computeRunCounts(extractResults);
  assert.equal(counts.reposFetchedOk, 2);
  assert.equal(counts.reposFailed, 0);
});

test("readEnrichInputs reads commits/issues from the silver layer's full accumulated state, not this run's (possibly empty) bronze delta", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await db.run(
    `INSERT INTO repos (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, first_seen_at, last_seen_at)
     VALUES (1, 'sdpilon/spilon.dev', 'site', 'u', 'main', 'Astro', 1, false, false, false, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
  );
  await db.run(
    `INSERT INTO commits (repo_id, sha, author_name, authored_at, message, first_ingested_run_id)
     VALUES (1, 'aaa', 'Spencer', '2026-07-01T00:00:00Z', 'first commit', 'run_1')`,
  );
  await db.run(
    `INSERT INTO issues (repo_id, number, title, state, created_at, closed_at, labels, last_updated_run_id)
     VALUES (1, 1, 'Bug', 'open', '2026-07-01T00:00:00Z', NULL, [], 'run_1')`,
  );

  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  const runDir = path.join(bronzeDir, "run_2");
  fs.mkdirSync(runDir, { recursive: true });
  // Simulate the real scenario: run_2's incremental fetch found nothing new,
  // so its own bronze commits/issues files are empty — but the repo's full
  // history (inserted above) already lives in the silver tables from run_1.
  fs.writeFileSync(path.join(runDir, "1_commits.json"), "[]");
  fs.writeFileSync(path.join(runDir, "1_issues.json"), "[]");
  fs.writeFileSync(
    path.join(runDir, "1_readme.json"),
    JSON.stringify("# Hello"),
  );

  const inputs = await readEnrichInputs(db, bronzeDir, "run_2", 1);
  assert.deepEqual(inputs.commitMessages, ["first commit"]);
  assert.deepEqual(inputs.issueTitles, ["Bug"]);
  assert.equal(inputs.readmeText, "# Hello");
  await db.close();
});

test("parseArgs defaults to no dry-run and no limit", () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, limit: null });
});

test("parseArgs recognizes --dry-run", () => {
  assert.deepEqual(parseArgs(["--dry-run"]), { dryRun: true, limit: null });
});

test("parseArgs recognizes --limit N", () => {
  assert.deepEqual(parseArgs(["--limit", "5"]), { dryRun: false, limit: 5 });
});

test("parseArgs rejects a non-positive-integer --limit value", () => {
  assert.throws(() => parseArgs(["--limit", "abc"]), /--limit requires a positive integer/);
  assert.throws(() => parseArgs(["--limit", "0"]), /--limit requires a positive integer/);
  assert.throws(() => parseArgs(["--limit", "-3"]), /--limit requires a positive integer/);
});

test("buildRepoList maps discovered repo objects to their fullName", () => {
  const discovered = [
    { repoId: 1, fullName: "sdpilon/a" },
    { repoId: 2, fullName: "sdpilon/b" },
  ];
  assert.deepEqual(buildRepoList(discovered, null), ["sdpilon/a", "sdpilon/b"]);
});

test("buildRepoList applies a limit by taking the first N", () => {
  const discovered = [
    { repoId: 1, fullName: "sdpilon/a" },
    { repoId: 2, fullName: "sdpilon/b" },
    { repoId: 3, fullName: "sdpilon/c" },
  ];
  assert.deepEqual(buildRepoList(discovered, 2), ["sdpilon/a", "sdpilon/b"]);
});
