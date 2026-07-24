"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb, ensureSchema } = require("./db");
const {
  makeRunId,
  recordRunStart,
  recordRunFinish,
} = require("./run-tracking");

test("makeRunId formats a timestamp-based id with no colons or dots", () => {
  const id = makeRunId(new Date("2026-07-24T11:19:53.533Z"));
  assert.equal(id, "run_2026-07-24T11-19-53-533Z");
});

test("recordRunStart inserts a partial-status row, recordRunFinish completes it", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);

  await recordRunStart(db, "run_1", "2026-07-24T00:00:00.000Z", 65);
  let rows = await db.all("SELECT * FROM runs WHERE run_id = 'run_1'");
  assert.equal(rows[0].status, "partial");
  assert.equal(rows[0].repos_discovered, 65);
  assert.equal(rows[0].finished_at, null);

  await recordRunFinish(db, "run_1", "2026-07-24T00:05:00.000Z", {
    status: "success",
    reposFetchedOk: 65,
    reposFailed: 0,
    llmCallsMade: 3,
    llmCallsSkipped: 62,
  });
  rows = await db.all("SELECT * FROM runs WHERE run_id = 'run_1'");
  assert.equal(rows[0].status, "success");
  assert.equal(rows[0].repos_fetched_ok, 65);
  assert.equal(rows[0].llm_calls_skipped, 62);
  assert.notEqual(rows[0].finished_at, null);

  await db.close();
});
