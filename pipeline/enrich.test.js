"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb, ensureSchema } = require("./db");
const { enrichRepo } = require("./enrich");

test("enrichRepo inserts a new assessment on first run for a repo", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const result = await enrichRepo({
    db,
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    runId: "run_1",
    readmeText: "hello",
    commitMessages: ["fix bug"],
    issueTitles: ["Bug"],
    now: "2026-07-22T00:00:00.000Z",
  });
  assert.equal(result.called, true);
  const rows = await db.all(
    "SELECT COUNT(*)::INTEGER AS n FROM repo_assessments WHERE repo_id = 1",
  );
  assert.equal(rows[0].n, 1);
  await db.close();
});

test("enrichRepo skips the LLM call when the input hash has not changed since the last assessment", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const args = {
    db,
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    readmeText: "hello",
    commitMessages: ["fix bug"],
    issueTitles: ["Bug"],
  };
  await enrichRepo({
    ...args,
    runId: "run_1",
    now: "2026-07-22T00:00:00.000Z",
  });
  const second = await enrichRepo({
    ...args,
    runId: "run_2",
    now: "2026-07-23T00:00:00.000Z",
  });
  assert.equal(second.called, false);
  const rows = await db.all(
    "SELECT COUNT(*)::INTEGER AS n FROM repo_assessments WHERE repo_id = 1",
  );
  assert.equal(rows[0].n, 1);
  await db.close();
});

test("enrichRepo inserts a second, distinct assessment row when the input hash changes", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
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
  const second = await enrichRepo({
    db,
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    runId: "run_2",
    readmeText: "hello",
    commitMessages: ["fix bug", "add feature"],
    issueTitles: ["Bug"],
    now: "2026-07-23T00:00:00.000Z",
  });
  assert.equal(second.called, true);
  const rows = await db.all(
    "SELECT COUNT(*)::INTEGER AS n FROM repo_assessments WHERE repo_id = 1",
  );
  assert.equal(rows[0].n, 2);
  await db.close();
});
