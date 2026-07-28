"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { openDb, ensureSchema } = require("./db");
const { DB_PATH } = require("./config");

const REPO_ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 3000;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function resolveStaticPath(urlPath) {
  const clean = urlPath === "/" ? "/tracker" : urlPath;
  const withExt = path.extname(clean) ? clean : `${clean}.html`;
  const resolved = path.join(REPO_ROOT, withExt);
  if (!resolved.startsWith(REPO_ROOT)) return null; // path traversal guard
  return resolved;
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = resolveStaticPath(urlPath);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const contentType = CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
}

// POST /api/repos/:repoId/ignore  { "ignored": true|false }
// Persists the browser toggle in tracker.html straight to the repos table,
// so pipeline/run.js's enrichment loop (getIgnoredRepoIds) picks it up on
// the next run without needing repos.json/tracker.html to be regenerated.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleIgnoreRequest(req, res, db, repoId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  if (typeof body.ignored !== "boolean") {
    sendJson(res, 400, { error: "body.ignored must be a boolean" });
    return;
  }

  try {
    const [existing] = await db.all(
      "SELECT repo_id FROM repos WHERE repo_id = ?",
      repoId,
    );
    if (!existing) {
      sendJson(res, 404, { error: `no repo with repo_id ${repoId}` });
      return;
    }

    await db.run(
      "UPDATE repos SET is_ignored = ? WHERE repo_id = ?",
      body.ignored,
      repoId,
    );
    sendJson(res, 200, { repo_id: repoId, is_ignored: body.ignored });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function main() {
  const db = openDb(DB_PATH);
  await ensureSchema(db);

  const server = http.createServer((req, res) => {
    const ignoreMatch =
      req.method === "POST" &&
      req.url.match(/^\/api\/repos\/(\d+)\/ignore$/);
    if (ignoreMatch) {
      handleIgnoreRequest(req, res, db, Number(ignoreMatch[1]));
      return;
    }
    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`tracker server: http://127.0.0.1:${PORT}/tracker`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { resolveStaticPath, handleIgnoreRequest };
