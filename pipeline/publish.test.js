"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb, ensureSchema } = require("./db");
const { buildRepoRecord } = require("./publish");
const { enrichRepo } = require("./enrich");
const { writeBronze } = require("./extract");

test("buildRepoRecord shapes DB rows into the existing repos.json record format", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await db.run(
    `INSERT INTO repos (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, first_seen_at, last_seen_at)
     VALUES (1, 'sdpilon/spilon.dev', 'site', 'https://github.com/sdpilon/spilon.dev', 'main', 'Astro', 2, false, false, false, '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`,
  );
  await db.run(
    `INSERT INTO commits (repo_id, sha, author_name, authored_at, message, first_ingested_run_id)
     VALUES (1, 'aaaaaaaaaaaaaaaaaaaa', 'Spencer', '2026-07-01T00:00:00Z', 'fix bug', 'run_1')`,
  );
  await db.run(
    `INSERT INTO issues (repo_id, number, title, state, created_at, closed_at, labels, last_updated_run_id)
     VALUES (1, 1, 'Bug', 'open', '2026-07-01T00:00:00Z', NULL, list_value('bug'), 'run_1')`,
  );
  await db.run(
    `INSERT INTO pull_requests (repo_id, number, title, state, created_at, merged_at, last_updated_run_id)
     VALUES (1, 5, 'Add feature', 'closed', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 'run_1')`,
  );
  const record = await buildRepoRecord(db, 1);
  assert.equal(record.name, "sdpilon/spilon.dev");
  assert.equal(record.repo_id, 1);
  assert.equal(record.meta.ignored, false);
  assert.equal(record.meta.language, "Astro");
  assert.equal(record.meta.stargazers_count, 2);
  assert.equal(record.commits[0].sha, "aaaaaaa");
  assert.equal(record.commits[0].message, "fix bug");
  assert.deepEqual(record.issues[0].labels, ["bug"]);
  assert.equal(record.prs.length, 1);
  assert.equal(record.prs[0].number, 5);
  assert.equal(record.prs[0].title, "Add feature");
  assert.equal(record.prs[0].state, "closed");
  assert.ok(record.prs[0].merged_at instanceof Date);
  assert.equal(record.assessment, null);
  await db.close();
});

test("buildRepoRecord includes the latest repo_assessments row when one exists", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await db.run(
    `INSERT INTO repos (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, first_seen_at, last_seen_at)
     VALUES (1, 'sdpilon/spilon.dev', 'site', 'https://github.com/sdpilon/spilon.dev', 'main', 'Astro', 2, false, false, false, '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`,
  );
  const stubAssessment = {
    pct: 50,
    band: "warn",
    label: "Assessed by a stub reviewer",
    text: "Stub assessment for sdpilon/spilon.dev.",
    gaps: ["stub assessment, not a real LLM call"],
  };
  const client = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify(stubAssessment) }],
      }),
    },
  };
  await enrichRepo({
    client,
    db,
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    runId: "run_1",
    readmeText: "hello",
    commitMessages: ["fix bug"],
    issueTitles: ["Bug"],
    now: "2026-07-22T00:00:00.000Z",
  });
  const record = await buildRepoRecord(db, 1);
  assert.equal(record.assessment.pct, stubAssessment.pct);
  assert.equal(record.assessment.band, stubAssessment.band);
  assert.equal(record.assessment.label, stubAssessment.label);
  assert.equal(record.assessment.text, stubAssessment.text);
  assert.deepEqual(record.assessment.gaps, stubAssessment.gaps);
  await db.close();
});

test("buildRepoRecord reads the real README text from bronze when runId/bronzeDir are given", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await db.run(
    `INSERT INTO repos (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, first_seen_at, last_seen_at)
     VALUES (1, 'sdpilon/spilon.dev', 'site', 'https://github.com/sdpilon/spilon.dev', 'main', 'Astro', 2, false, false, false, '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`,
  );
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-test-"));
  writeBronze(bronzeDir, "run_1", 1, "readme", "# Hello\n\nReal readme text.");
  const record = await buildRepoRecord(db, 1, "run_1", bronzeDir);
  assert.equal(record.readme, "# Hello\n\nReal readme text.");
  await db.close();
  fs.rmSync(bronzeDir, { recursive: true, force: true });
});

test("buildRepoRecord falls back to an empty readme when runId/bronzeDir are omitted", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await db.run(
    `INSERT INTO repos (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, first_seen_at, last_seen_at)
     VALUES (1, 'sdpilon/spilon.dev', 'site', 'https://github.com/sdpilon/spilon.dev', 'main', 'Astro', 2, false, false, false, '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`,
  );
  const record = await buildRepoRecord(db, 1);
  assert.equal(record.readme, "");
  await db.close();
});

test("buildRepoRecord includes ignoreReasons when auto-ignored", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await db.run(
    `INSERT INTO repos (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, is_ignored, ignore_source, first_seen_at, last_seen_at)
     VALUES (1, 'sdpilon/a-fork', null, 'https://github.com/sdpilon/a-fork', 'main', null, 0, false, true, false, true, 'auto', '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`,
  );
  await db.run(
    `INSERT INTO commits (repo_id, sha, author_name, authored_at, message, first_ingested_run_id)
     VALUES (1, 'aaaaaaaaaaaaaaaaaaaa', 'Spencer', '2026-07-01T00:00:00Z', 'fix', 'run_1')`,
  );
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-test-"));
  writeBronze(bronzeDir, "run_1", 1, "readme", "# real readme");
  const record = await buildRepoRecord(db, 1, "run_1", bronzeDir);
  assert.deepEqual(record.meta.ignoreReasons, ["fork"]);
  await db.close();
  fs.rmSync(bronzeDir, { recursive: true, force: true });
});

test("buildRepoRecord omits ignoreReasons when the repo was manually ignored", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await db.run(
    `INSERT INTO repos (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, is_ignored, ignore_source, first_seen_at, last_seen_at)
     VALUES (1, 'sdpilon/a-fork', null, 'https://github.com/sdpilon/a-fork', 'main', null, 0, false, true, false, true, 'manual', '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`,
  );
  const record = await buildRepoRecord(db, 1);
  assert.deepEqual(record.meta.ignoreReasons, []);
  await db.close();
});

test("buildRepoRecord has no ignoreReasons for a repo that isn't ignored at all", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await db.run(
    `INSERT INTO repos (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, first_seen_at, last_seen_at)
     VALUES (1, 'sdpilon/spilon.dev', 'site', 'https://github.com/sdpilon/spilon.dev', 'main', 'Astro', 2, false, false, false, '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`,
  );
  const record = await buildRepoRecord(db, 1);
  assert.deepEqual(record.meta.ignoreReasons, []);
  await db.close();
});
