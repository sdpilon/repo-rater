"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb, ensureSchema } = require("./db");
const {
  extractRepo,
  extractAll,
  readBronzeJson,
  readBronzeJsonRequired,
} = require("./extract");

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
      {
        sha: "aaa",
        commit: {
          author: { name: "Spencer", date: "2026-07-01T00:00:00Z" },
          message: "fix\nbody",
        },
      },
    ];
  }
  if (pathAndQuery.startsWith("repos/sdpilon/spilon.dev/issues")) {
    return [
      {
        number: 1,
        title: "Bug",
        state: "open",
        created_at: "2026-07-01T00:00:00Z",
        closed_at: null,
        labels: [],
        pull_request: null,
      },
    ];
  }
  if (pathAndQuery.startsWith("repos/sdpilon/spilon.dev/pulls")) {
    return [
      {
        number: 2,
        title: "Add feature",
        state: "open",
        created_at: "2026-07-01T00:00:00Z",
        merged_at: null,
        updated_at: "2026-07-01T00:00:00Z",
      },
    ];
  }
  throw new Error(`unexpected path: ${pathAndQuery}`);
}

test("extractRepo writes bronze files for meta, readme, commits, issues, and prs on first run", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  const results = await extractRepo({
    fullName: "sdpilon/spilon.dev",
    db,
    runId: "run_1",
    bronzeDir,
    ghApiJson: fakeGhApiJson,
  });
  assert.equal(results.filter((r) => r.status === "ok").length, 4);
  const runDir = path.join(bronzeDir, "run_1");
  assert.ok(fs.existsSync(path.join(runDir, "1_meta.json")));
  assert.ok(fs.existsSync(path.join(runDir, "1_readme.json")));
  assert.ok(fs.existsSync(path.join(runDir, "1_commits.json")));
  assert.ok(fs.existsSync(path.join(runDir, "1_issues.json")));
  assert.ok(fs.existsSync(path.join(runDir, "1_prs.json")));
  const readme = JSON.parse(
    fs.readFileSync(path.join(runDir, "1_readme.json"), "utf8"),
  );
  assert.equal(readme, "# Hello");
  const commits = JSON.parse(
    fs.readFileSync(path.join(runDir, "1_commits.json"), "utf8"),
  );
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
        id: 1,
        full_name: "sdpilon/spilon.dev",
        description: null,
        html_url: "u",
        default_branch: "main",
        language: null,
        stargazers_count: 0,
        private: false,
        fork: false,
        archived: false,
      };
    }
    if (pathAndQuery === "repos/sdpilon/spilon.dev/readme")
      return { content: Buffer.from("").toString("base64") };
    if (pathAndQuery.startsWith("repos/sdpilon/spilon.dev/commits"))
      throw new Error("rate limited");
    return [];
  };
  const results = await extractRepo({
    fullName: "sdpilon/spilon.dev",
    db,
    runId: "run_1",
    bronzeDir,
    ghApiJson: flaky,
  });
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
      capturedSince = new URL(`https://x/${pathAndQuery}`).searchParams.get(
        "since",
      );
      return [];
    }
    return fakeGhApiJson(pathAndQuery);
  };
  await extractRepo({
    fullName: "sdpilon/spilon.dev",
    db,
    runId: "run_2",
    bronzeDir,
    ghApiJson: capturing,
  });
  assert.equal(capturedSince, "2026-07-15T00:00:00.000Z");
  await db.close();
});

test("extractRepo records a readme error result without throwing when the readme fetch fails", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  const flakyReadme = (pathAndQuery) => {
    if (pathAndQuery === "repos/sdpilon/spilon.dev") {
      return {
        id: 1,
        full_name: "sdpilon/spilon.dev",
        description: null,
        html_url: "u",
        default_branch: "main",
        language: null,
        stargazers_count: 0,
        private: false,
        fork: false,
        archived: false,
      };
    }
    if (pathAndQuery === "repos/sdpilon/spilon.dev/readme")
      throw new Error("readme not found");
    if (pathAndQuery.startsWith("repos/sdpilon/spilon.dev/commits")) return [];
    if (pathAndQuery.startsWith("repos/sdpilon/spilon.dev/issues")) return [];
    throw new Error(`unexpected path: ${pathAndQuery}`);
  };
  const results = await extractRepo({
    fullName: "sdpilon/spilon.dev",
    db,
    runId: "run_1",
    bronzeDir,
    ghApiJson: flakyReadme,
  });
  const readmeResult = results.find((r) => r.dataType === "readme");
  assert.equal(readmeResult.status, "error");
  assert.match(readmeResult.error, /readme not found/);
  await db.close();
});

test("extractAll continues with the remaining repos when one repo throws unexpectedly", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  const throwing = () => {
    throw new Error("totally unexpected failure");
  };
  const results = await extractAll({
    repos: ["sdpilon/broken-repo", "sdpilon/spilon.dev"],
    db,
    runId: "run_1",
    bronzeDir,
    ghApiJson: (pathAndQuery) => {
      if (pathAndQuery.startsWith("repos/sdpilon/broken-repo"))
        return throwing();
      return fakeGhApiJson(pathAndQuery);
    },
  });
  const brokenResult = results.find(
    (r) => r.fullName === "sdpilon/broken-repo",
  );
  assert.equal(brokenResult.status, "error");
  assert.match(brokenResult.error, /totally unexpected failure/);
  const okResults = results.filter(
    (r) => r.fullName === "sdpilon/spilon.dev" && r.status === "ok",
  );
  assert.equal(okResults.length, 4);
  await db.close();
});

test("readBronzeJson returns null when the bronze file does not exist", () => {
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  const result = readBronzeJson(bronzeDir, "run_1", 1, "meta");
  assert.equal(result, null);
});

test("readBronzeJson returns the parsed JSON when the bronze file exists", () => {
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  const dir = path.join(bronzeDir, "run_1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "1_meta.json"),
    JSON.stringify({ repoId: 1, fullName: "sdpilon/spilon.dev" }),
  );
  const result = readBronzeJson(bronzeDir, "run_1", 1, "meta");
  assert.deepEqual(result, { repoId: 1, fullName: "sdpilon/spilon.dev" });
});

test("readBronzeJsonRequired throws a descriptive error when the bronze file does not exist", () => {
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  assert.throws(
    () => readBronzeJsonRequired(bronzeDir, "run_1", 1, "meta"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Required bronze file missing/);
      return true;
    },
  );
});

test("readBronzeJsonRequired returns the parsed JSON when the bronze file exists", () => {
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  const dir = path.join(bronzeDir, "run_1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "1_meta.json"),
    JSON.stringify({ repoId: 1, fullName: "sdpilon/spilon.dev" }),
  );
  const result = readBronzeJsonRequired(bronzeDir, "run_1", 1, "meta");
  assert.deepEqual(result, { repoId: 1, fullName: "sdpilon/spilon.dev" });
});
