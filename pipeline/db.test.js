"use strict";
const test = require("node:test");
const { equal, ok, rejects } = require("node:assert/strict");
const { openDb, ensureSchema, getWatermark, setWatermark } = require("./db");

test("ensureSchema creates the repos table on a fresh in-memory database", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const rows = await db.all(
    "SELECT table_name FROM information_schema.tables WHERE table_name = 'repos'",
  );
  equal(rows.length, 1);
  await db.close();
});

test("ensureSchema is a no-op the second time it runs against the same database", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await ensureSchema(db);
  const rows = await db.all(
    "SELECT table_name FROM information_schema.tables WHERE table_name = 'repos'",
  );
  equal(rows.length, 1);
  await db.close();
});

test("getWatermark returns null before a watermark exists, then the stored timestamp after setWatermark", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  equal(await getWatermark(db, 123, "commits"), null);
  await setWatermark(db, 123, "commits", "2026-07-01T00:00:00Z", "run_1");
  const after = await getWatermark(db, 123, "commits");
  ok(after instanceof Date);
  equal(after.toISOString(), "2026-07-01T00:00:00.000Z");
  await db.close();
});

test("setWatermark replaces the existing row for the same (repoId, dataType) instead of erroring or duplicating", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await setWatermark(db, 123, "commits", "2026-07-01T00:00:00Z", "run_1");
  await setWatermark(db, 123, "commits", "2026-07-10T00:00:00Z", "run_2");
  const after = await getWatermark(db, 123, "commits");
  equal(after.toISOString(), "2026-07-10T00:00:00.000Z");
  const rows = await db.all(
    "SELECT COUNT(*)::INTEGER AS n FROM fetch_watermarks WHERE repo_id = 123 AND data_type = 'commits'",
  );
  equal(rows[0].n, 1);
  await db.close();
});

test("ensureSchema leaves no tables behind if the schema script fails partway through", async () => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const badSchemaPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "schema-")),
    "bad.sql",
  );
  fs.writeFileSync(
    badSchemaPath,
    "CREATE TABLE repos (repo_id BIGINT PRIMARY KEY);\nCREATE TABLE broken (this is not valid sql);",
  );
  const db = openDb(":memory:");
  await rejects(() => ensureSchema(db, badSchemaPath));
  const rows = await db.all(
    "SELECT table_name FROM information_schema.tables WHERE table_name = 'repos'",
  );
  equal(rows.length, 0);
  await db.close();
});
