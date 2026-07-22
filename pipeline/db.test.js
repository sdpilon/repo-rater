"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb, ensureSchema, getWatermark, setWatermark } = require("./db");

test("ensureSchema creates the repos table on a fresh in-memory database", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const rows = await db.all(
    "SELECT table_name FROM information_schema.tables WHERE table_name = 'repos'"
  );
  assert.equal(rows.length, 1);
  await db.close();
});

test("ensureSchema is a no-op the second time it runs against the same database", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await ensureSchema(db);
  const rows = await db.all("SELECT table_name FROM information_schema.tables WHERE table_name = 'repos'");
  assert.equal(rows.length, 1);
  await db.close();
});

test("getWatermark returns null before a watermark exists, then the stored timestamp after setWatermark", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  assert.equal(await getWatermark(db, 123, "commits"), null);
  await setWatermark(db, 123, "commits", "2026-07-01T00:00:00Z", "run_1");
  const after = await getWatermark(db, 123, "commits");
  assert.ok(after instanceof Date);
  assert.equal(after.toISOString(), "2026-07-01T00:00:00.000Z");
  await db.close();
});
