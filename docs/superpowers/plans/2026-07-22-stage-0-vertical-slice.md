# Stage 0 Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove out the full medallion pipeline described in `ARCHITECTURE.md` (bronze extract → silver load → hash-gated enrich → gold publish) end-to-end for a tiny, hardcoded set of 2 repos, without building the Discovery stage.

**Architecture:** A new `pipeline/` directory of small Node.js modules, one per stage, orchestrated by `pipeline/run.js`. Bronze stays flat JSON files on disk (`bronze/<run_id>/<repo_id>_<name>.json`), silver/gold/metadata live in a DuckDB file (`tracker.duckdb`) built from the existing `schema.sql`. The existing `fetch.sh` / current `repos.json` / `tracker.html` pipeline is left completely untouched and keeps working — this is a new, parallel path, not a replacement, until it's proven out.

**Tech Stack:** Node.js (built-in `node:test` test runner, `node:assert/strict`, `child_process`, `crypto`), the `duckdb` npm package (native DuckDB bindings, promisified), the existing `gh` CLI (already authenticated) for GitHub API calls, pnpm for dependency management.

## Global Constraints

- Discovery is **out of scope** for this slice — the repo list is a hardcoded array in `pipeline/config.js`, matching today's `fetch.sh` pattern. Do not build `gh api /user/repos` enumeration in this plan.
- Only 2 repos and 2 data types (`commits`, `issues`) are in scope. Pull requests are structurally identical to issues (same watermark/upsert shape) and are explicitly parked for the widening pass — do not add a `prs` fetch path in this plan.
- Rendering AI-generated assessments into `tracker.html` (extending `inject.js`'s splice markers to also cover the `ASSESS` block) is **out of scope**. This plan proves the hash-gate and append-only history by writing to `repo_assessments` and querying it directly — it does not wire that data into the dashboard UI.
- `generateAssessment()` is a deterministic stub, not a real LLM call. Real AI-engineering integration is explicitly a non-goal of `ARCHITECTURE.md` and stays a non-goal here.
- Do not modify `inject.js`'s splice mechanism (per `ARCHITECTURE.md`'s explicit non-goal: the publish stage's data source changes, not the splicing mechanism itself).
- Do not modify `fetch.sh` or delete `repos.json` — the existing pipeline must keep working unmodified.
- Every DuckDB write goes through the `duckdb` npm package's callback API wrapped with `util.promisify`, never a raw SQL string built from unescaped user/API data (labels/gaps arrays are bound as separate `?` parameters via `list_value(...)`, never string-concatenated into the SQL).

---

## File Structure

New files, all under the repo root:

- `package.json` — new; declares the `duckdb` dependency and a `test` script.
- `.gitignore` — new; excludes `node_modules/`, `tracker.duckdb`, and `bronze/`.
- `pipeline/config.js` — hardcoded repo list, DB path, bronze directory path.
- `pipeline/db.js` — DuckDB connection helper (promisified `exec`/`run`/`all`/`close`), schema bootstrap, watermark read/write.
- `pipeline/github.js` — thin GitHub API layer: `fetchRepoMeta`, `fetchReadme`, `fetchCommitsSince`, `fetchIssuesSince`. Each accepts an injectable `ghApiJson` function so it's testable without shelling out to `gh` or hitting the network.
- `pipeline/extract.js` — bronze stage: fetches meta/readme/commits/issues per repo and writes them to `bronze/<run_id>/`.
- `pipeline/load.js` — silver stage: reads bronze files for a run, upserts `repos`/`commits`/`issues`, advances `fetch_watermarks`, records `fetch_failures`.
- `pipeline/enrich.js` — enrich stage: content-hash gate over `repo_assessments`, stub assessment generator.
- `pipeline/publish.js` — gold stage: queries DuckDB, regenerates `repos.json` in the existing shape, shells out to the unchanged `node inject.js`.
- `pipeline/run.js` — orchestrator: wires the stages together under one `run_id`, writes/updates the `runs` row, prints the observability summary line.
- `pipeline/*.test.js` — one test file per stage module above (except `run.js`, which is verified manually — see Task 6).

---

### Task 1: Project scaffolding, DuckDB connection helper, schema bootstrap

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `pipeline/db.js`
- Test: `pipeline/db.test.js`

**Interfaces:**
- Produces: `openDb(dbPath: string) => { exec, run, all, close }` (all promisified), `ensureSchema(db, schemaPath?) => Promise<void>`, `getWatermark(db, repoId: number, dataType: string) => Promise<Date|null>`, `setWatermark(db, repoId: number, dataType: string, lastFetchedAt: string, runId: string) => Promise<void>`.

- [ ] **Step 1: Initialize the Node project and add the DuckDB dependency**

```bash
cd /Users/sp/Projects/_Claude/github-project-tracker
pnpm init
pnpm add duckdb
```

This generates `package.json` with a `dependencies.duckdb` entry already pinned to whatever version pnpm resolved — leave that line as-is. Add a `type` and `test` script alongside it (merge these two keys into the generated file; don't touch the `dependencies` block):

```json
{
  "type": "commonjs",
  "scripts": {
    "test": "node --test pipeline/"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
tracker.duckdb
bronze/
```

- [ ] **Step 3: Sanity-check how the installed `duckdb` driver maps types**

Real pipelines live or die on knowing what your driver actually returns, not what you assume. Before writing any assertions against TIMESTAMP or LIST columns, run this throwaway check:

```bash
node -e "
const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');
const con = db.connect();
con.run(\"CREATE TABLE t (ts TIMESTAMP, xs VARCHAR[])\");
con.run(\"INSERT INTO t VALUES ('2026-07-01T00:00:00Z', list_value('a','b'))\");
con.all('SELECT * FROM t', (err, rows) => {
  if (err) throw err;
  console.log(rows[0].ts, rows[0].ts.constructor.name);
  console.log(rows[0].xs, Array.isArray(rows[0].xs));
});
"
```

Expected: the `ts` column logs as a `Date` object (constructor name `Date`) and `xs` logs as a plain JS array (`Array.isArray` → `true`). If your installed version behaves differently, adjust the assertions in Steps 4 and onward (and in every later task's tests that touch TIMESTAMP/LIST columns) to match what you actually observed here — don't guess.

- [ ] **Step 4: Write the failing tests for `db.js`**

Create `pipeline/db.test.js`:

```js
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
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `node --test pipeline/db.test.js`
Expected: FAIL — `Cannot find module './db'` (file doesn't exist yet).

- [ ] **Step 6: Implement `pipeline/db.js`**

```js
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

async function ensureSchema(db, schemaPath = path.join(__dirname, "..", "schema.sql")) {
  const existing = await db.all(
    "SELECT table_name FROM information_schema.tables WHERE table_name = 'repos'"
  );
  if (existing.length === 0) {
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    await db.exec(schemaSql);
  }
}

async function getWatermark(db, repoId, dataType) {
  const rows = await db.all(
    "SELECT last_fetched_at FROM fetch_watermarks WHERE repo_id = ? AND data_type = ?",
    repoId,
    dataType
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
    runId
  );
}

module.exports = { openDb, ensureSchema, getWatermark, setWatermark };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test pipeline/db.test.js`
Expected: PASS (3 tests)

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml .gitignore pipeline/db.js pipeline/db.test.js
git commit -m "feat(pipeline): add DuckDB connection helper and schema bootstrap"
```

---

### Task 2: GitHub API layer (`pipeline/github.js`)

**Files:**
- Create: `pipeline/github.js`
- Test: `pipeline/github.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `fetchRepoMeta(fullName, ghApiJson?) => {repoId, fullName, description, htmlUrl, defaultBranch, language, stargazersCount, isPrivate, isFork, isArchived}`, `fetchReadme(fullName, ghApiJson?) => string`, `fetchCommitsSince(fullName, since, ghApiJson?) => Array<{sha, authorName, authoredAt, message}>`, `fetchIssuesSince(fullName, since, ghApiJson?) => Array<{number, title, state, createdAt, closedAt, labels: string[]}>`, `defaultGhApiJson(pathAndQuery: string) => any`.

- [ ] **Step 1: Write the failing tests**

Create `pipeline/github.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchRepoMeta, fetchReadme, fetchCommitsSince, fetchIssuesSince } = require("./github");

test("fetchRepoMeta maps raw GitHub fields to camelCase repo meta", () => {
  const fakeGhApiJson = (pathAndQuery) => {
    assert.equal(pathAndQuery, "repos/sdpilon/spilon.dev");
    return {
      id: 123,
      full_name: "sdpilon/spilon.dev",
      description: "my site",
      html_url: "https://github.com/sdpilon/spilon.dev",
      default_branch: "main",
      language: "Astro",
      stargazers_count: 2,
      private: false,
      fork: false,
      archived: false,
    };
  };
  const meta = fetchRepoMeta("sdpilon/spilon.dev", fakeGhApiJson);
  assert.deepEqual(meta, {
    repoId: 123,
    fullName: "sdpilon/spilon.dev",
    description: "my site",
    htmlUrl: "https://github.com/sdpilon/spilon.dev",
    defaultBranch: "main",
    language: "Astro",
    stargazersCount: 2,
    isPrivate: false,
    isFork: false,
    isArchived: false,
  });
});

test("fetchReadme base64-decodes the readme content", () => {
  const fakeGhApiJson = (pathAndQuery) => {
    assert.equal(pathAndQuery, "repos/sdpilon/spilon.dev/readme");
    return { content: Buffer.from("# Hello").toString("base64") };
  };
  assert.equal(fetchReadme("sdpilon/spilon.dev", fakeGhApiJson), "# Hello");
});

test("fetchCommitsSince maps commits and takes the first line of the message", () => {
  const fakeGhApiJson = () => [
    {
      sha: "abc123",
      commit: {
        author: { name: "Spencer", date: "2026-07-01T00:00:00Z" },
        message: "fix bug\n\nlonger body",
      },
    },
  ];
  const commits = fetchCommitsSince("sdpilon/spilon.dev", "2026-01-01T00:00:00Z", fakeGhApiJson);
  assert.deepEqual(commits, [
    { sha: "abc123", authorName: "Spencer", authoredAt: "2026-07-01T00:00:00Z", message: "fix bug" },
  ]);
});

test("fetchIssuesSince filters out pull requests and maps labels to names", () => {
  const fakeGhApiJson = () => [
    {
      number: 1,
      title: "Bug",
      state: "open",
      created_at: "2026-01-01T00:00:00Z",
      closed_at: null,
      labels: [{ name: "bug" }],
      pull_request: null,
    },
    {
      number: 2,
      title: "A PR",
      state: "open",
      created_at: "2026-01-02T00:00:00Z",
      closed_at: null,
      labels: [],
      pull_request: {},
    },
  ];
  const issues = fetchIssuesSince("sdpilon/spilon.dev", "2026-01-01T00:00:00Z", fakeGhApiJson);
  assert.deepEqual(issues, [
    { number: 1, title: "Bug", state: "open", createdAt: "2026-01-01T00:00:00Z", closedAt: null, labels: ["bug"] },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pipeline/github.test.js`
Expected: FAIL — `Cannot find module './github'`

- [ ] **Step 3: Implement `pipeline/github.js`**

```js
"use strict";
const { execFileSync } = require("child_process");

function defaultGhApiJson(pathAndQuery) {
  const out = execFileSync("gh", ["api", pathAndQuery], { encoding: "utf8" });
  return JSON.parse(out);
}

function fetchRepoMeta(fullName, ghApiJson = defaultGhApiJson) {
  const raw = ghApiJson(`repos/${fullName}`);
  return {
    repoId: raw.id,
    fullName: raw.full_name,
    description: raw.description,
    htmlUrl: raw.html_url,
    defaultBranch: raw.default_branch,
    language: raw.language,
    stargazersCount: raw.stargazers_count,
    isPrivate: raw.private,
    isFork: raw.fork,
    isArchived: raw.archived,
  };
}

function fetchReadme(fullName, ghApiJson = defaultGhApiJson) {
  const raw = ghApiJson(`repos/${fullName}/readme`);
  return Buffer.from(raw.content, "base64").toString("utf8");
}

function fetchCommitsSince(fullName, since, ghApiJson = defaultGhApiJson) {
  const raw = ghApiJson(`repos/${fullName}/commits?since=${since}&per_page=100`);
  return raw.map((c) => ({
    sha: c.sha,
    authorName: c.commit.author ? c.commit.author.name : null,
    authoredAt: c.commit.author ? c.commit.author.date : null,
    message: c.commit.message.split("\n")[0],
  }));
}

function fetchIssuesSince(fullName, since, ghApiJson = defaultGhApiJson) {
  const raw = ghApiJson(`repos/${fullName}/issues?state=all&since=${since}&per_page=100`);
  return raw
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      createdAt: issue.created_at,
      closedAt: issue.closed_at,
      labels: issue.labels.map((label) => label.name),
    }));
}

module.exports = { fetchRepoMeta, fetchReadme, fetchCommitsSince, fetchIssuesSince, defaultGhApiJson };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test pipeline/github.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline/github.js pipeline/github.test.js
git commit -m "feat(pipeline): add GitHub API layer for repo meta, readme, commits, issues"
```

---

### Task 3: Bronze extract stage (`pipeline/extract.js`)

**Files:**
- Create: `pipeline/extract.js`
- Test: `pipeline/extract.test.js`

**Interfaces:**
- Consumes: `getWatermark` from `./db` (Task 1); `fetchRepoMeta`, `fetchReadme`, `fetchCommitsSince`, `fetchIssuesSince`, `defaultGhApiJson` from `./github` (Task 2).
- Produces: `writeBronze(bronzeDir, runId, repoId, name, payload)`, `extractRepo({fullName, db, runId, bronzeDir, ghApiJson?, now?}) => Promise<Array<{fullName, repoId, dataType, status: 'ok'|'error', since?, fetchedAt?, error?}>>`, `extractAll({repos, db, runId, bronzeDir, ghApiJson?}) => Promise<Array<same shape>>`. Later tasks (Load, Task 4) rely on this exact result-array shape, keyed by `dataType` values `'meta' | 'readme' | 'commits' | 'issues'`.

- [ ] **Step 1: Write the failing tests**

Create `pipeline/extract.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pipeline/extract.test.js`
Expected: FAIL — `Cannot find module './extract'`

- [ ] **Step 3: Implement `pipeline/extract.js`**

```js
"use strict";
const fs = require("fs");
const path = require("path");
const { getWatermark } = require("./db");
const { fetchRepoMeta, fetchReadme, fetchCommitsSince, fetchIssuesSince, defaultGhApiJson } = require("./github");

const DATA_TYPES = ["commits", "issues"];
const DEFAULT_SINCE = "2020-01-01T00:00:00Z";

function writeBronze(bronzeDir, runId, repoId, name, payload) {
  const dir = path.join(bronzeDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${repoId}_${name}.json`), JSON.stringify(payload, null, 2));
}

async function extractRepo({ fullName, db, runId, bronzeDir, ghApiJson = defaultGhApiJson, now = () => new Date().toISOString() }) {
  const results = [];
  let meta;
  try {
    meta = fetchRepoMeta(fullName, ghApiJson);
    writeBronze(bronzeDir, runId, meta.repoId, "meta", meta);
  } catch (err) {
    results.push({ fullName, repoId: null, dataType: "meta", status: "error", error: String(err) });
    return results;
  }

  try {
    const readme = fetchReadme(fullName, ghApiJson);
    writeBronze(bronzeDir, runId, meta.repoId, "readme", readme);
    results.push({ fullName, repoId: meta.repoId, dataType: "readme", status: "ok" });
  } catch (err) {
    writeBronze(bronzeDir, runId, meta.repoId, "readme", "");
    results.push({ fullName, repoId: meta.repoId, dataType: "readme", status: "error", error: String(err) });
  }

  for (const dataType of DATA_TYPES) {
    try {
      const watermark = await getWatermark(db, meta.repoId, dataType);
      const since = watermark ? watermark.toISOString() : DEFAULT_SINCE;
      const rows =
        dataType === "commits"
          ? fetchCommitsSince(fullName, since, ghApiJson)
          : fetchIssuesSince(fullName, since, ghApiJson);
      writeBronze(bronzeDir, runId, meta.repoId, dataType, rows);
      results.push({ fullName, repoId: meta.repoId, dataType, status: "ok", since, fetchedAt: now() });
    } catch (err) {
      results.push({ fullName, repoId: meta.repoId, dataType, status: "error", error: String(err) });
    }
  }
  return results;
}

async function extractAll({ repos, db, runId, bronzeDir, ghApiJson = defaultGhApiJson }) {
  const allResults = [];
  for (const fullName of repos) {
    allResults.push(...(await extractRepo({ fullName, db, runId, bronzeDir, ghApiJson })));
  }
  return allResults;
}

module.exports = { extractRepo, extractAll, writeBronze, DATA_TYPES, DEFAULT_SINCE };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test pipeline/extract.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline/extract.js pipeline/extract.test.js
git commit -m "feat(pipeline): add watermark-driven bronze extract stage"
```

---

### Task 4: Silver load stage (`pipeline/load.js`)

**Files:**
- Create: `pipeline/load.js`
- Test: `pipeline/load.test.js`

**Interfaces:**
- Consumes: `setWatermark` from `./db` (Task 1); the extract-result array shape from Task 3 (`{fullName, repoId, dataType, status, since?, fetchedAt?, error?}`).
- Produces: `loadRun({db, runId, bronzeDir, extractResults, now}) => Promise<{reposLoaded: number, failuresRecorded: number}>`. Later tasks rely on: after `loadRun`, `repos`/`commits`/`issues` tables are populated, `fetch_watermarks` is advanced only for successful `(repoId, dataType)` pairs, and `fetch_failures` has one row per failed pair.

- [ ] **Step 1: Write the failing tests**

Create `pipeline/load.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb, ensureSchema, getWatermark } = require("./db");
const { loadRun } = require("./load");

function writeFixtureBronze(bronzeDir, runId, repoId) {
  const dir = path.join(bronzeDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${repoId}_meta.json`),
    JSON.stringify({
      repoId, fullName: "sdpilon/spilon.dev", description: "site", htmlUrl: "u",
      defaultBranch: "main", language: "Astro", stargazersCount: 1, isPrivate: false, isFork: false, isArchived: false,
    })
  );
  fs.writeFileSync(
    path.join(dir, `${repoId}_commits.json`),
    JSON.stringify([{ sha: "aaa", authorName: "Spencer", authoredAt: "2026-07-01T00:00:00Z", message: "fix" }])
  );
  fs.writeFileSync(
    path.join(dir, `${repoId}_issues.json`),
    JSON.stringify([{ number: 1, title: "Bug", state: "open", createdAt: "2026-07-01T00:00:00Z", closedAt: null, labels: ["bug"] }])
  );
}

test("loadRun upserts repo, commits, and issues, and advances watermarks on success", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  writeFixtureBronze(bronzeDir, "run_1", 1);
  const extractResults = [
    { fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "meta", status: "ok" },
    { fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "readme", status: "ok" },
    { fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "commits", status: "ok", since: "2020-01-01T00:00:00Z", fetchedAt: "2026-07-22T00:00:00.000Z" },
    { fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "issues", status: "ok", since: "2020-01-01T00:00:00Z", fetchedAt: "2026-07-22T00:00:00.000Z" },
  ];
  const summary = await loadRun({ db, runId: "run_1", bronzeDir, extractResults, now: "2026-07-22T00:00:00.000Z" });
  assert.equal(summary.reposLoaded, 1);
  assert.equal(summary.failuresRecorded, 0);

  const repos = await db.all("SELECT full_name FROM repos WHERE repo_id = 1");
  assert.equal(repos[0].full_name, "sdpilon/spilon.dev");
  const commits = await db.all("SELECT sha FROM commits WHERE repo_id = 1");
  assert.equal(commits.length, 1);
  const issues = await db.all("SELECT labels FROM issues WHERE repo_id = 1");
  assert.deepEqual(issues[0].labels, ["bug"]);
  const watermark = await getWatermark(db, 1, "commits");
  assert.ok(watermark instanceof Date);
  await db.close();
});

test("loadRun preserves first_seen_at across repeated runs while advancing last_seen_at", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  writeFixtureBronze(bronzeDir, "run_1", 1);
  const extractResults = [{ fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "meta", status: "ok" }];
  await loadRun({ db, runId: "run_1", bronzeDir, extractResults, now: "2026-07-20T00:00:00.000Z" });
  writeFixtureBronze(bronzeDir, "run_2", 1);
  await loadRun({ db, runId: "run_2", bronzeDir, extractResults: [{ fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "meta", status: "ok" }], now: "2026-07-22T00:00:00.000Z" });
  const rows = await db.all("SELECT first_seen_at, last_seen_at FROM repos WHERE repo_id = 1");
  assert.equal(rows[0].first_seen_at.toISOString(), "2026-07-20T00:00:00.000Z");
  assert.equal(rows[0].last_seen_at.toISOString(), "2026-07-22T00:00:00.000Z");
  await db.close();
});

test("loadRun records a fetch_failures row and does not advance the watermark when extract failed", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const bronzeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-"));
  writeFixtureBronze(bronzeDir, "run_1", 1);
  const extractResults = [
    { fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "meta", status: "ok" },
    { fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "commits", status: "error", error: "rate limited" },
  ];
  const summary = await loadRun({ db, runId: "run_1", bronzeDir, extractResults, now: "2026-07-22T00:00:00.000Z" });
  assert.equal(summary.failuresRecorded, 1);
  const failures = await db.all("SELECT error_message FROM fetch_failures WHERE repo_id = 1");
  assert.equal(failures[0].error_message, "rate limited");
  const watermark = await getWatermark(db, 1, "commits");
  assert.equal(watermark, null);
  await db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pipeline/load.test.js`
Expected: FAIL — `Cannot find module './load'`

- [ ] **Step 3: Implement `pipeline/load.js`**

```js
"use strict";
const fs = require("fs");
const path = require("path");
const { setWatermark } = require("./db");

function readBronze(bronzeDir, runId, repoId, name) {
  return JSON.parse(fs.readFileSync(path.join(bronzeDir, runId, `${repoId}_${name}.json`), "utf8"));
}

async function upsertRepo(db, meta, now) {
  const existing = await db.all("SELECT first_seen_at FROM repos WHERE repo_id = ?", meta.repoId);
  const firstSeenAt = existing.length > 0 ? existing[0].first_seen_at : now;
  await db.run(
    `INSERT OR REPLACE INTO repos
      (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, first_seen_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    meta.repoId, meta.fullName, meta.description, meta.htmlUrl, meta.defaultBranch,
    meta.language, meta.stargazersCount, meta.isPrivate, meta.isFork, meta.isArchived,
    firstSeenAt, now
  );
}

async function upsertCommit(db, repoId, commit, runId) {
  await db.run(
    `INSERT OR REPLACE INTO commits (repo_id, sha, author_name, authored_at, message, first_ingested_run_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    repoId, commit.sha, commit.authorName, commit.authoredAt, commit.message, runId
  );
}

async function upsertIssue(db, repoId, issue, runId) {
  const labelsFragment = issue.labels.length === 0 ? "[]" : `list_value(${issue.labels.map(() => "?").join(", ")})`;
  await db.run(
    `INSERT OR REPLACE INTO issues (repo_id, number, title, state, created_at, closed_at, labels, last_updated_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ${labelsFragment}, ?)`,
    repoId, issue.number, issue.title, issue.state, issue.createdAt, issue.closedAt,
    ...issue.labels,
    runId
  );
}

async function recordFailure(db, runId, repoId, dataType, errorMessage, occurredAt) {
  await db.run(
    `INSERT INTO fetch_failures (run_id, repo_id, data_type, error_message, occurred_at)
     VALUES (?, ?, ?, ?, ?)`,
    runId, repoId, dataType, errorMessage, occurredAt
  );
}

async function loadRun({ db, runId, bronzeDir, extractResults, now }) {
  const summary = { reposLoaded: 0, failuresRecorded: 0 };
  const repoIds = new Set(extractResults.filter((r) => r.repoId).map((r) => r.repoId));

  for (const repoId of repoIds) {
    const meta = readBronze(bronzeDir, runId, repoId, "meta");
    await upsertRepo(db, meta, now);
    summary.reposLoaded += 1;
  }

  for (const result of extractResults) {
    if (result.dataType === "meta") continue;
    if (result.status === "error") {
      await recordFailure(db, runId, result.repoId, result.dataType, result.error, now);
      summary.failuresRecorded += 1;
      continue;
    }
    if (result.dataType === "commits" || result.dataType === "issues") {
      const rows = readBronze(bronzeDir, runId, result.repoId, result.dataType);
      if (result.dataType === "commits") {
        for (const commit of rows) await upsertCommit(db, result.repoId, commit, runId);
      } else {
        for (const issue of rows) await upsertIssue(db, result.repoId, issue, runId);
      }
      // Watermark advances to run time, not max-event time in the data — GitHub's
      // since= semantics vary slightly by endpoint, and run-time is a safe, simple
      // lower bound that never skips data created mid-fetch.
      await setWatermark(db, result.repoId, result.dataType, result.fetchedAt, runId);
    }
    // "readme" has no silver table and no watermark — it's small enough to refetch
    // in full every run; enrich reads it straight from bronze.
  }

  return summary;
}

module.exports = { loadRun, upsertRepo, upsertCommit, upsertIssue, recordFailure };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test pipeline/load.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline/load.js pipeline/load.test.js
git commit -m "feat(pipeline): add silver load stage with idempotent upserts and dead-letter failures"
```

---

### Task 5: Enrich stage with content-hash gate (`pipeline/enrich.js`)

**Files:**
- Create: `pipeline/enrich.js`
- Test: `pipeline/enrich.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (takes a `db` handle from `./db`, opened by the caller).
- Produces: `computeInputHash(repoId, readmeText, commitMessages: string[], issueTitles: string[]) => string`, `generateAssessment(fullName, inputHash) => {pct, band, label, text, gaps: string[]}` (stub, not a real LLM call), `enrichRepo({db, repoId, fullName, runId, readmeText, commitMessages, issueTitles, now}) => Promise<{repoId, called: boolean}>`. Task 6 (`run.js`) calls `enrichRepo` once per repo per run and tallies `called` into `llmCallsMade`/`llmCallsSkipped`.

- [ ] **Step 1: Write the failing tests**

Create `pipeline/enrich.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb, ensureSchema } = require("./db");
const { enrichRepo } = require("./enrich");

test("enrichRepo inserts a new assessment on first run for a repo", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const result = await enrichRepo({
    db, repoId: 1, fullName: "sdpilon/spilon.dev", runId: "run_1",
    readmeText: "hello", commitMessages: ["fix bug"], issueTitles: ["Bug"], now: "2026-07-22T00:00:00.000Z",
  });
  assert.equal(result.called, true);
  const rows = await db.all("SELECT COUNT(*)::INTEGER AS n FROM repo_assessments WHERE repo_id = 1");
  assert.equal(rows[0].n, 1);
  await db.close();
});

test("enrichRepo skips the LLM call when the input hash has not changed since the last assessment", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const args = {
    db, repoId: 1, fullName: "sdpilon/spilon.dev",
    readmeText: "hello", commitMessages: ["fix bug"], issueTitles: ["Bug"],
  };
  await enrichRepo({ ...args, runId: "run_1", now: "2026-07-22T00:00:00.000Z" });
  const second = await enrichRepo({ ...args, runId: "run_2", now: "2026-07-23T00:00:00.000Z" });
  assert.equal(second.called, false);
  const rows = await db.all("SELECT COUNT(*)::INTEGER AS n FROM repo_assessments WHERE repo_id = 1");
  assert.equal(rows[0].n, 1);
  await db.close();
});

test("enrichRepo inserts a second, distinct assessment row when the input hash changes", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await enrichRepo({
    db, repoId: 1, fullName: "sdpilon/spilon.dev", runId: "run_1",
    readmeText: "hello", commitMessages: ["fix bug"], issueTitles: ["Bug"], now: "2026-07-22T00:00:00.000Z",
  });
  const second = await enrichRepo({
    db, repoId: 1, fullName: "sdpilon/spilon.dev", runId: "run_2",
    readmeText: "hello", commitMessages: ["fix bug", "add feature"], issueTitles: ["Bug"], now: "2026-07-23T00:00:00.000Z",
  });
  assert.equal(second.called, true);
  const rows = await db.all("SELECT COUNT(*)::INTEGER AS n FROM repo_assessments WHERE repo_id = 1");
  assert.equal(rows[0].n, 2);
  await db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pipeline/enrich.test.js`
Expected: FAIL — `Cannot find module './enrich'`

- [ ] **Step 3: Implement `pipeline/enrich.js`**

```js
"use strict";
const crypto = require("crypto");

function computeInputHash(repoId, readmeText, commitMessages, issueTitles) {
  const combined = [readmeText || "", ...commitMessages, ...issueTitles].join("\n---\n");
  return crypto.createHash("sha256").update(combined).digest("hex");
}

// Stub: proves the hash-gate and append-only history pattern. Replace with a
// real LLM call in a later stage — that's an AI-engineering concern, explicitly
// out of scope for ARCHITECTURE.md and for this slice.
function generateAssessment(fullName, inputHash) {
  return {
    pct: 50,
    band: "unknown",
    label: "Not yet assessed by a real reviewer",
    text: `Placeholder assessment for ${fullName} (input hash ${inputHash.slice(0, 8)}).`,
    gaps: ["real LLM assessment not implemented yet"],
  };
}

async function enrichRepo({ db, repoId, fullName, runId, readmeText, commitMessages, issueTitles, now }) {
  const inputHash = computeInputHash(repoId, readmeText, commitMessages, issueTitles);
  const latest = await db.all(
    "SELECT input_hash FROM repo_assessments WHERE repo_id = ? ORDER BY created_at DESC LIMIT 1",
    repoId
  );
  if (latest.length > 0 && latest[0].input_hash === inputHash) {
    return { repoId, called: false };
  }
  const assessment = generateAssessment(fullName, inputHash);
  const gapsFragment = assessment.gaps.length === 0 ? "[]" : `list_value(${assessment.gaps.map(() => "?").join(", ")})`;
  await db.run(
    `INSERT INTO repo_assessments (repo_id, run_id, input_hash, pct, band, label, text, gaps, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${gapsFragment}, ?)`,
    repoId, runId, inputHash, assessment.pct, assessment.band, assessment.label, assessment.text,
    ...assessment.gaps,
    now
  );
  return { repoId, called: true };
}

module.exports = { computeInputHash, generateAssessment, enrichRepo };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test pipeline/enrich.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline/enrich.js pipeline/enrich.test.js
git commit -m "feat(pipeline): add content-hash-gated enrich stage over append-only assessments"
```

---

### Task 6: Gold publish stage, config, and orchestrator (`pipeline/publish.js`, `pipeline/config.js`, `pipeline/run.js`)

**Files:**
- Create: `pipeline/publish.js`
- Create: `pipeline/config.js`
- Create: `pipeline/run.js`
- Test: `pipeline/publish.test.js`

**Interfaces:**
- Consumes: `openDb`, `ensureSchema` from `./db`; `extractAll` from `./extract`; `loadRun` from `./load`; `enrichRepo` from `./enrich`.
- Produces: `buildRepoRecord(db, repoId) => Promise<repoJsonRecord>`, `publish({db, repoIds, repoRoot?}) => Promise<void>` (writes `repos.json`, then runs the existing unmodified `node inject.js`), `REPOS`/`DB_PATH`/`BRONZE_DIR` config constants, `main()` in `run.js` as the CLI entry point.

- [ ] **Step 1: Write the failing test for `buildRepoRecord`**

Create `pipeline/publish.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb, ensureSchema } = require("./db");
const { buildRepoRecord } = require("./publish");

test("buildRepoRecord shapes DB rows into the existing repos.json record format", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await db.run(
    `INSERT INTO repos (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, first_seen_at, last_seen_at)
     VALUES (1, 'sdpilon/spilon.dev', 'site', 'https://github.com/sdpilon/spilon.dev', 'main', 'Astro', 2, false, false, false, '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`
  );
  await db.run(
    `INSERT INTO commits (repo_id, sha, author_name, authored_at, message, first_ingested_run_id)
     VALUES (1, 'aaaaaaaaaaaaaaaaaaaa', 'Spencer', '2026-07-01T00:00:00Z', 'fix bug', 'run_1')`
  );
  await db.run(
    `INSERT INTO issues (repo_id, number, title, state, created_at, closed_at, labels, last_updated_run_id)
     VALUES (1, 1, 'Bug', 'open', '2026-07-01T00:00:00Z', NULL, list_value('bug'), 'run_1')`
  );
  const record = await buildRepoRecord(db, 1);
  assert.equal(record.name, "sdpilon/spilon.dev");
  assert.equal(record.meta.language, "Astro");
  assert.equal(record.meta.stargazers_count, 2);
  assert.equal(record.commits[0].sha, "aaaaaaa");
  assert.equal(record.commits[0].message, "fix bug");
  assert.deepEqual(record.issues[0].labels, ["bug"]);
  assert.deepEqual(record.prs, []);
  await db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test pipeline/publish.test.js`
Expected: FAIL — `Cannot find module './publish'`

- [ ] **Step 3: Implement `pipeline/publish.js`**

```js
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

async function buildRepoRecord(db, repoId) {
  const [repoRow] = await db.all(
    `SELECT full_name, description, html_url, default_branch, stargazers_count, is_private, language
     FROM repos WHERE repo_id = ?`,
    repoId
  );
  const commits = await db.all(
    `SELECT sha, authored_at, message, author_name FROM commits WHERE repo_id = ? ORDER BY authored_at DESC`,
    repoId
  );
  const issues = await db.all(
    `SELECT number, title, state, created_at, closed_at, labels FROM issues WHERE repo_id = ? ORDER BY created_at DESC`,
    repoId
  );
  return {
    name: repoRow.full_name,
    meta: {
      private: repoRow.is_private,
      description: repoRow.description,
      html_url: repoRow.html_url,
      default_branch: repoRow.default_branch,
      stargazers_count: repoRow.stargazers_count,
      language: repoRow.language,
    },
    readme: "",
    issues: issues.map((i) => ({
      number: i.number, title: i.title, state: i.state, created_at: i.created_at, closed_at: i.closed_at, labels: i.labels,
    })),
    prs: [],
    commits: commits.map((c) => ({
      sha: c.sha.slice(0, 7), date: c.authored_at, message: c.message, author: c.author_name,
    })),
  };
}

async function publish({ db, repoIds, repoRoot = path.join(__dirname, "..") }) {
  const records = [];
  for (const repoId of repoIds) records.push(await buildRepoRecord(db, repoId));
  fs.writeFileSync(path.join(repoRoot, "repos.json"), JSON.stringify(records, null, 2));
  execFileSync("node", ["inject.js"], { cwd: repoRoot, stdio: "inherit" });
}

module.exports = { buildRepoRecord, publish };
```

Note: `readme: ""` is a deliberate simplification — the existing `tracker.html` reads `readme` per repo for display, but wiring the bronze-stored readme text back through gold is straightforward and identical in shape to the commits/issues mapping above; it's left out here only to keep this task's diff focused on proving the DB-to-JSON shape conversion. If you want the dashboard's README panel populated in this slice, add a `readme` bronze read to `buildRepoRecord` following the same pattern as `commits`/`issues` before moving on.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test pipeline/publish.test.js`
Expected: PASS (1 test)

- [ ] **Step 5: Implement `pipeline/config.js`**

```js
"use strict";
module.exports = {
  REPOS: ["sdpilon/spilon.dev", "sdpilon/typst-resume"],
  DB_PATH: "tracker.duckdb",
  BRONZE_DIR: "bronze",
};
```

- [ ] **Step 6: Implement `pipeline/run.js`**

```js
"use strict";
const path = require("path");
const fs = require("fs");
const { openDb, ensureSchema } = require("./db");
const { extractAll } = require("./extract");
const { loadRun } = require("./load");
const { enrichRepo } = require("./enrich");
const { publish } = require("./publish");
const { REPOS, DB_PATH, BRONZE_DIR } = require("./config");

function makeRunId(now = new Date()) {
  return `run_${now.toISOString().replace(/[:.]/g, "-")}`;
}

function readBronzeJson(bronzeDir, runId, repoId, name) {
  const p = path.join(bronzeDir, runId, `${repoId}_${name}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

async function recordRunStart(db, runId, startedAt) {
  await db.run(
    `INSERT INTO runs (run_id, started_at, status, repos_discovered, repos_fetched_ok, repos_failed, llm_calls_made, llm_calls_skipped)
     VALUES (?, ?, 'partial', ?, 0, 0, 0, 0)`,
    runId, startedAt, REPOS.length
  );
}

async function recordRunFinish(db, runId, finishedAt, counts) {
  await db.run(
    `UPDATE runs SET finished_at = ?, status = ?, repos_fetched_ok = ?, repos_failed = ?, llm_calls_made = ?, llm_calls_skipped = ?
     WHERE run_id = ?`,
    finishedAt, counts.status, counts.reposFetchedOk, counts.reposFailed,
    counts.llmCallsMade, counts.llmCallsSkipped, runId
  );
}

async function main() {
  const db = openDb(DB_PATH);
  await ensureSchema(db);
  const runId = makeRunId();
  const startedAt = new Date().toISOString();
  await recordRunStart(db, runId, startedAt);

  const extractResults = await extractAll({ repos: REPOS, db, runId, bronzeDir: BRONZE_DIR });
  const loadSummary = await loadRun({ db, runId, bronzeDir: BRONZE_DIR, extractResults, now: startedAt });

  const failedRepoIds = new Set(extractResults.filter((r) => r.status === "error" && r.repoId).map((r) => r.repoId));
  const repoIds = new Set(extractResults.filter((r) => r.repoId).map((r) => r.repoId));
  const reposFetchedOk = new Set([...repoIds].filter((id) => !failedRepoIds.has(id))).size;

  let llmCallsMade = 0;
  let llmCallsSkipped = 0;
  for (const repoId of repoIds) {
    const meta = readBronzeJson(BRONZE_DIR, runId, repoId, "meta");
    const readmeText = readBronzeJson(BRONZE_DIR, runId, repoId, "readme") || "";
    const commits = readBronzeJson(BRONZE_DIR, runId, repoId, "commits") || [];
    const issues = readBronzeJson(BRONZE_DIR, runId, repoId, "issues") || [];
    const result = await enrichRepo({
      db, repoId, fullName: meta.fullName, runId,
      readmeText, commitMessages: commits.map((c) => c.message), issueTitles: issues.map((i) => i.title),
      now: new Date().toISOString(),
    });
    if (result.called) llmCallsMade += 1;
    else llmCallsSkipped += 1;
  }

  await publish({ db, repoIds: Array.from(repoIds) });

  const finishedAt = new Date().toISOString();
  await recordRunFinish(db, runId, finishedAt, {
    status: failedRepoIds.size > 0 ? "partial" : "success",
    reposFetchedOk, reposFailed: failedRepoIds.size, llmCallsMade, llmCallsSkipped,
  });

  console.log(
    `run ${runId}: ${reposFetchedOk} repos ok, ${failedRepoIds.size} repos with fetch errors, ` +
      `${loadSummary.failuresRecorded} failures recorded, ${llmCallsMade} LLM calls made, ${llmCallsSkipped} skipped`
  );
  await db.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { makeRunId, main };
```

- [ ] **Step 7: Manually verify the full run end-to-end**

This orchestrator exercises the real `gh` CLI, a real DuckDB file, and real filesystem writes — that's the actual proof this slice works, so verify it by running it for real rather than mocking every dependency:

```bash
cd /Users/sp/Projects/_Claude/github-project-tracker
rm -f tracker.duckdb
rm -rf bronze
node pipeline/run.js
```

Expected: a summary line like `run run_2026-...: 2 repos ok, 0 repos with fetch errors, 0 failures recorded, 2 LLM calls made, 0 skipped`, plus:

- `bronze/<run_id>/` contains `1_meta.json`/`1_readme.json`/`1_commits.json`/`1_issues.json`-style files for both configured repos (numeric prefixes will be the repos' real GitHub ids, not `1`/`2`).
- `tracker.duckdb` exists and `git diff --stat repos.json` shows it changed to reflect the two configured repos' real commits/issues.
- `tracker.html` shows a byte-length change from the `inject.js` run (printed by `inject.js`'s own `console.log`).

Then run it a **second time immediately** and confirm the incremental/idempotent behavior:

```bash
node pipeline/run.js
```

Expected: `0 LLM calls made, 2 skipped` (input hash unchanged since nothing changed upstream), and re-running does not create duplicate commit/issue rows — verify with:

```bash
node -e "
const { openDb } = require('./pipeline/db');
const db = openDb('tracker.duckdb');
db.all('SELECT COUNT(*)::INTEGER AS n FROM repo_assessments').then((r) => console.log('assessments:', r[0].n));
db.all('SELECT repo_id, COUNT(*)::INTEGER AS n FROM commits GROUP BY repo_id').then((r) => console.log('commits per repo:', r));
"
```

Expected: `assessments: 2` (one per repo, not four — the hash gate skipped the second run), and commit counts unchanged between the two `run.js` invocations.

- [ ] **Step 8: Commit**

```bash
git add pipeline/publish.js pipeline/publish.test.js pipeline/config.js pipeline/run.js
git commit -m "feat(pipeline): add gold publish stage and Stage 0 orchestrator"
```

---

### Task 7: Documentation sync (ARCHITECTURE.md + CLAUDE.md)

**Added post-hoc**, after Tasks 1-6 landed: `ARCHITECTURE.md`'s "Status"
section and `CLAUDE.md`'s "Future direction" section both currently claim
"design only, nothing implemented yet." That becomes false the moment this
branch merges — Stage 0 is a real, tested, partial implementation. This task
brings both docs in line with what actually exists, and is explicit about
what still doesn't (Discovery, PRs, ASSESS wiring, the ~60-repo widen).

**Files:**
- Modify: `ARCHITECTURE.md` (intro paragraph + "Status" section)
- Modify: `CLAUDE.md` ("Future direction" section)

- [ ] **Step 1: Update `ARCHITECTURE.md`'s intro paragraph**

Change:

```
This is a design draft for evolving the tracker from a hardcoded 9-repo,
full-refetch-every-time script into a pipeline that can run against a full
GitHub account (~60 repos) incrementally. Nothing described here is
implemented yet — `fetch.sh` / `inject.js` / `tracker.html` are still the
current, working baseline. This document exists to capture the design so
implementation can proceed against it later.
```

to:

```
This is the design for evolving the tracker from a hardcoded 9-repo,
full-refetch-every-time script into a pipeline that can run against a full
GitHub account (~60 repos) incrementally. A first vertical slice (Stage 0)
is implemented in `pipeline/` — see the "Status" section below for exactly
what that covers. `fetch.sh` / `inject.js` / `tracker.html` remain the
pipeline that actually produces the checked-in dashboard until Discovery
and the ~60-repo widen land and it's cut over.
```

- [ ] **Step 2: Replace `ARCHITECTURE.md`'s "Status" section**

Change:

```
## Status

Design only. No implementation has started. The existing `fetch.sh` →
`node inject.js` → `tracker.html` pipeline remains the working baseline
until these stages are actually built.
```

to:

```
## Status

**Stage 0 (a thin vertical slice) is implemented in `pipeline/`**, run
end-to-end for a hardcoded 2-repo scope: Extract → Load → Enrich → Publish,
with DuckDB-backed watermarking, idempotent upserts, content-hash-gated
enrichment, and dead-letter failure isolation all proven out. See
`docs/superpowers/plans/2026-07-22-stage-0-vertical-slice.md` for what was
built and why (thinnest end-to-end slice first, Discovery deliberately
last since it's the easiest stage in isolation).

**Not yet implemented:** Discovery (the repo list is still a hardcoded array
in `pipeline/config.js`, same as `fetch.sh`'s today), the `prs` data type,
wiring `repo_assessments` into `tracker.html` (would require extending
`inject.js`'s splice markers to a second marker pair), and widening from 2
repos to the full ~60-repo account.

**The existing `fetch.sh` → `node inject.js` → `tracker.html` pipeline
remains the actual production baseline** — Stage 0's `pipeline/` code is a
proven-out parallel path, not a replacement, until Discovery and widening
land and it's cut over.
```

- [ ] **Step 3: Update `CLAUDE.md`'s "Future direction" section**

Change:

```
## Future direction

The pipeline above is the current, working baseline for a small hardcoded repo list. `ARCHITECTURE.md` and `schema.sql` describe a not-yet-implemented redesign to scale this to a full GitHub account (~60 repos): repo discovery instead of a hardcoded list, a bronze/silver/gold DuckDB-backed storage layer, incremental per-repo watermarked extraction, content-hash-gated AI re-assessment, and per-repo failure isolation. Consult those files before assuming the pipeline still works the way this section describes.
```

to:

```
## Future direction

The pipeline above is the current, working baseline for a small hardcoded repo list. `ARCHITECTURE.md` and `schema.sql` describe a redesign to scale this to a full GitHub account (~60 repos): repo discovery instead of a hardcoded list, a bronze/silver/gold DuckDB-backed storage layer, incremental per-repo watermarked extraction, content-hash-gated AI re-assessment, and per-repo failure isolation.

A first vertical slice of that redesign (Stage 0) is implemented in `pipeline/` — Extract → Load → Enrich → Publish for a hardcoded 2-repo scope. Discovery is not yet implemented (the repo list is still hardcoded), and `pipeline/` does not yet replace `fetch.sh`/`inject.js` as the pipeline that produces the checked-in `tracker.html` — it's a parallel, proven-out path, not yet the production one. Consult `ARCHITECTURE.md`'s "Status" section and `docs/superpowers/plans/` before assuming how much of the redesign exists.
```

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md CLAUDE.md
git commit -m "docs: sync ARCHITECTURE.md and CLAUDE.md status with Stage 0 implementation"
```

---

## Self-Review Notes

- **Spec coverage:** Extract (bronze, watermarked, per-repo/per-datatype failure isolation) → Task 3. Load (silver, idempotent upsert, dead-letter) → Task 4. Enrich (content-hash gate, append-only) → Task 5. Publish (gold, reads DB not `repos.json` fetch output) → Task 6. `runs` observability row with `llm_calls_skipped` → Task 6. Discovery is explicitly excluded per the brainstorm's sequencing decision (build hardest/least-familiar stages first, Discovery last since it's the easiest stage in isolation). Documentation staying in sync with what actually landed → Task 7 (added after the fact, once the risk of `ARCHITECTURE.md`/`CLAUDE.md` going stale was raised).
- **Parked for the next plan (widening pass):** replacing the hardcoded `REPOS` list with the real `gh api /user/repos` Discovery stage and `repo_discoveries` table; adding the `prs` data type (same shape as `issues`); wiring `repo_assessments` into `tracker.html` by extending `inject.js`'s splice markers to also cover `ASSESS`; widening from 2 repos to ~60.
