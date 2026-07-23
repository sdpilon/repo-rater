"use strict";
const duckdb = require("duckdb");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

function openDb(dbPath) {
  const database = new duckdb.Database(dbPath);
  const conn = database.connect();
  return {
    exec: promisify(conn.exec.bind(conn)),
    run: promisify(conn.run.bind(conn)),
    all: promisify(conn.all.bind(conn)),
    close: promisify(database.close.bind(database)),
  };
}

async function ensureSchema(
  db,
  schemaPath = path.join(__dirname, "..", "schema.sql"),
) {
  const existing = await db.all(
    "SELECT table_name FROM information_schema.tables WHERE table_name = 'repos'",
  );
  if (existing.length === 0) {
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    await db.exec(`BEGIN TRANSACTION;\n${schemaSql}\nCOMMIT;`);
  }
}

async function getWatermark(db, repoId, dataType) {
  const rows = await db.all(
    "SELECT last_fetched_at FROM fetch_watermarks WHERE repo_id = ? AND data_type = ?",
    repoId,
    dataType,
  );
  return rows.length > 0 ? rows[0].last_fetched_at : null;
}

async function setWatermark(db, repoId, dataType, lastFetchedAt, runId) {
  await db.run(
    `INSERT OR REPLACE INTO fetch_watermarks (repo_id, data_type, last_fetched_at, last_success_run_id)
     VALUES (?, ?, ?, ?)`,
    repoId,
    dataType,
    lastFetchedAt,
    runId,
  );
}

module.exports = { openDb, ensureSchema, getWatermark, setWatermark };
