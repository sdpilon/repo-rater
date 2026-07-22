"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb, ensureSchema } = require("./db");
const { extractRepo } = require("./extract");

function fakeGhApiJson(pathAndQuery) {
  if (pathAndQuery === "repos/sdpilon/spilon.dev") {
    return {
      id: 1,
      full_name: "sdpilon/spilon.dev",
      description: "site",
      html_url: "https://github.com/sdpilon/spilon.dev",
      default_branch: "main",
      language: "Astro",
      stargazers_count: 1,
      private: false,
      fork: false,
      archived: false,
    };
  }
  if (pathAndQuery === "repos/sdpilon/spilon.dev/readme") {
    return { content: Buffer.from("# Hello").toString("base64") };
  }
  if (pathAndQuery.startsWith("repos/sdpilon/spilon.dev/commits")) {
    return [
      { sha: "aaa", commit: { author: { name: "Spencer", date: "2026-07-01T00:00:00Z" }, message: "fix\nbody" } },
    ];
  }
  if (pathAndQuery.startsWith("repos/sdpilon/spilon.dev/issues")) {
    return [
      { number: 1, title: "Bug", state: "open", created_at: "2026-07-01T00:00:00Z", closed_at: null, labels: [], pull_request: null },
    ];
  }
  throw new Error(`unexpected path: ${pathAndQuery}`);
}

test("extractRepo writes bronze files for meta, readme, commits, and issues on first run", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  const results = await extractRepo({ fullName: "sdpilon/spilon.dev", db, runId: "run_1", bronzeDir, ghApiJson: fakeGhApiJson });
  assert.equal(results.filter((r) => r.status === "ok").length, 3);
  const runDir = path.join(bronzeDir, "run_1");
  assert.ok(fs.existsSync(path.join(runDir, "1_meta.json")));
  assert.ok(fs.existsSync(path.join(runDir, "1_readme.json")));
  assert.ok(fs.existsSync(path.join(runDir, "1_commits.json")));
  assert.ok(fs.existsSync(path.join(runDir, "1_issues.json")));
  const readme = JSON.parse(fs.readFileSync(path.join(runDir, "1_readme.json"), "utf8"));
  assert.equal(readme, "# Hello");
  const commits = JSON.parse(fs.readFileSync(path.join(runDir, "1_commits.json"), "utf8"));
  assert.equal(commits[0].sha, "aaa");
  await db.close();
});

test("extractRepo records a per-data-type error result without throwing when a GitHub call fails", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  const flaky = (pathAndQuery) => {
    if (pathAndQuery === "repos/sdpilon/spilon.dev") {
      return {
        id: 1, full_name: "sdpilon/spilon.dev", description: null, html_url: "u",
        default_branch: "main", language: null, stargazers_count: 0, private: false, fork: false, archived: false,
      };
    }
    if (pathAndQuery === "repos/sdpilon/spilon.dev/readme") return { content: Buffer.from("").toString("base64") };
    if (pathAndQuery.startsWith("repos/sdpilon/spilon.dev/commits")) throw new Error("rate limited");
    return [];
  };
  const results = await extractRepo({ fullName: "sdpilon/spilon.dev", db, runId: "run_1", bronzeDir, ghApiJson: flaky });
  const commitResult = results.find((r) => r.dataType === "commits");
  assert.equal(commitResult.status, "error");
  assert.match(commitResult.error, /rate limited/);
  const issueResult = results.find((r) => r.dataType === "issues");
  assert.equal(issueResult.status, "ok");
  await db.close();
});

test("extractRepo uses the stored watermark as the since= cursor on the second run", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const { setWatermark } = require("./db");
  await setWatermark(db, 1, "commits", "2026-07-15T00:00:00Z", "run_1");
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  let capturedSince = null;
  const capturing = (pathAndQuery) => {
    if (pathAndQuery.startsWith("repos/sdpilon/spilon.dev/commits")) {
      capturedSince = new URL(`https://x/${pathAndQuery}`).searchParams.get("since");
      return [];
    }
    return fakeGhApiJson(pathAndQuery);
  };
  await extractRepo({ fullName: "sdpilon/spilon.dev", db, runId: "run_2", bronzeDir, ghApiJson: capturing });
  assert.equal(capturedSince, "2026-07-15T00:00:00.000Z");
  await db.close();
});
