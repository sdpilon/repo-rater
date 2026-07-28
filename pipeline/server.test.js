"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");
const { openDb, ensureSchema } = require("./db");
const { resolveStaticPath, handleIgnoreRequest } = require("./server");

function makeReq(bodyObj) {
  const req = new Readable();
  req._read = () => {};
  req.push(JSON.stringify(bodyObj));
  req.push(null);
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(data) {
      this.body = data;
    },
  };
}

async function seedRepo(db, repoId) {
  await db.run(
    `INSERT INTO repos (repo_id, full_name, is_private, is_fork, is_archived, is_ignored, first_seen_at, last_seen_at)
     VALUES (?, 'sdpilon/a', false, false, false, false, '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`,
    repoId,
  );
}

test("resolveStaticPath maps / and extensionless paths to .html files under the repo root", () => {
  assert.ok(resolveStaticPath("/").endsWith("tracker.html"));
  assert.ok(resolveStaticPath("/tracker").endsWith("tracker.html"));
  assert.ok(resolveStaticPath("/repos.json").endsWith("repos.json"));
});

test("resolveStaticPath refuses to resolve outside the repo root", () => {
  assert.equal(resolveStaticPath("/../../../etc/passwd"), null);
});

test("handleIgnoreRequest updates is_ignored and responds 200 for an existing repo", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await seedRepo(db, 1);
  const res = makeRes();
  await handleIgnoreRequest(makeReq({ ignored: true }), res, db, 1);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { repo_id: 1, is_ignored: true });
  const [row] = await db.all("SELECT is_ignored FROM repos WHERE repo_id = 1");
  assert.equal(row.is_ignored, true);
  await db.close();
});

test("handleIgnoreRequest responds 404 for a repo id that doesn't exist", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const res = makeRes();
  await handleIgnoreRequest(makeReq({ ignored: true }), res, db, 999);
  assert.equal(res.statusCode, 404);
  await db.close();
});

test("handleIgnoreRequest responds 400 when ignored is not a boolean", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await seedRepo(db, 1);
  const res = makeRes();
  await handleIgnoreRequest(makeReq({ ignored: "yes" }), res, db, 1);
  assert.equal(res.statusCode, 400);
  await db.close();
});

test("handleIgnoreRequest responds 400 on malformed JSON body", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await seedRepo(db, 1);
  const res = makeRes();
  const req = new Readable();
  req._read = () => {};
  req.push("not json");
  req.push(null);
  await handleIgnoreRequest(req, res, db, 1);
  assert.equal(res.statusCode, 400);
  await db.close();
});
