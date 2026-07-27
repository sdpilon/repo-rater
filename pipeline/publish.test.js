"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb, ensureSchema } = require("./db");
const { buildRepoRecord } = require("./publish");
const { enrichRepo } = require("./enrich");

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
  await enrichRepo({
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
  assert.equal(record.assessment.pct, 50);
  assert.equal(record.assessment.band, "unknown");
  assert.equal(record.assessment.label, "Not yet assessed by a real reviewer");
  assert.ok(record.assessment.text.startsWith("Placeholder assessment for sdpilon/spilon.dev"));
  assert.deepEqual(record.assessment.gaps, ["real LLM assessment not implemented yet"]);
  await db.close();
});
