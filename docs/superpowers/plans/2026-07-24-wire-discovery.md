# Wire Discovery Into the Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm pipeline` publish the whole GitHub account (~60+ repos) by sourcing its repo list from `discoverRepos()` instead of `pipeline/config.js`'s hardcoded 2-repo `REPOS` array, with a safe way to preview a run before committing to full scope.

**Architecture:** `run.js`'s `main()` calls `discoverRepos()` first (already proven standalone), turns its output into a `fullName` list for `extractAll()`, and gains two new flags — `--dry-run` (report scope with zero pipeline side effects) and `--limit N` (run for real against only the first N discovered repos). Wiring `discoverRepos()` into `run.js` would recreate a circular `require` between `run.js` and `discover.js` (discover.js currently imports run-tracking helpers from `run.js`), so those helpers move to a new `pipeline/run-tracking.js` module first.

**Tech Stack:** Node.js (CommonJS, `"use strict"`), `node:test` + `node:assert/strict`, DuckDB (`pipeline/db.js`'s `openDb`/`ensureSchema`), `gh api` via `pipeline/github.js`.

## Global Constraints

- No filtering: every repo `discoverRepos()` returns is tracked — no fork/archived/allow-deny logic (spec Non-Goals).
- `pipeline/config.js`'s `REPOS` constant is deleted outright; no references left anywhere (spec P0 #3).
- A preview mode must exist before a full run commits to full scope (spec P0 #2).
- Live end-to-end verification against the real account is required, run twice, per this project's standing rule that orchestration wiring needs a live check, not just unit tests (`CLAUDE.md`, spec P0 #5).
- No GraphQL batching, concurrency tuning, or rate-limit handling (spec Non-Goals; ~240 req/run stays well under GitHub's 5,000/hour limit).
- `prs` data type, `repo_assessments` → `tracker.html` wiring, and retiring `fetch.sh` are out of scope for this plan (spec Non-Goals).
- Code style: `"use strict"`, double-quoted strings, CommonJS `require`/`module.exports`, matching `biome.json` and every existing `pipeline/*.js` file.
- Tests: `node --test "pipeline/**/*.test.js"` (`package.json`'s `test` script) — new test files must match that glob and follow the existing pattern (`node:test`, `node:assert/strict`, `openDb(":memory:")` + `ensureSchema` for DB-backed tests).

## Design Notes

★ Insight — carried over from the spec review, and reinforced while writing this plan ─────────────────────────────────────

- **The riskiest part of "wiring two already-tested modules together" is never either module — it's the seam.** `discoverRepos()` returns `{repoId, fullName, isFork, ...}` objects; `extractAll()` expects a plain array of `fullName` strings. Neither module's own test suite catches this, because each tests itself against inputs it already assumes are correctly shaped. This is exactly the class of bug this project's own Stage 0 postmortem called out: 28 passing unit tests, still shipped a broken content-hash gate, because the bug lived at the integration boundary, not inside any single tested unit.
- **Reading the code for this plan surfaced a second, sharper instance of the same pattern before it ever hit a test run:** `discover.js` currently does `require("./run")` to get `makeRunId`/`recordRunStart`/`recordRunFinish`. The moment `run.js` adds `require("./discover")` to get `discoverRepos`, that becomes a circular `require`. Node doesn't error on this — it silently hands `discover.js` a *partial* `module.exports` from `run.js` (whatever was assigned before the require call, i.e. nothing yet), so `makeRunId` etc. would destructure to `undefined` and `pnpm pipeline:discover` would break at runtime with no test catching it, since `discover.test.js` never exercises the require path through a would-be-circular `run.js`. Task 1 below exists solely to defuse this before it can happen, by giving both modules a shared, cycle-free dependency instead of depending on each other.
- **A third correction, found by reading `enrich.js` rather than trusting `ARCHITECTURE.md`'s prose:** `generateAssessment()` is a stub — a deterministic placeholder, not a real LLM call (see its own comment: "Replace with a real LLM call in a later stage"). The spec's "~60 LLM calls on first run" framing describes the *pattern* being practiced (content-hash gate, `llm_calls_made`/`llm_calls_skipped`), not real spend today — there is no API being paid for yet. The `--dry-run`/`--limit` flags built here are still worth having (they preview real scope, real GitHub API calls, and a real overwrite of tracked `repos.json`/`tracker.html`), just not framed as guarding against a cost that doesn't exist yet.

─────────────────────────────────────────────────

## File Structure

- **Create** `pipeline/run-tracking.js` — `makeRunId`, `recordRunStart`, `recordRunFinish`, moved verbatim out of `run.js` so both `run.js` and `discover.js` can depend on them without depending on each other.
- **Create** `pipeline/run-tracking.test.js` — unit tests for the three functions above (none exist today).
- **Modify** `pipeline/run.js` — drop the three functions (now imported from `run-tracking.js`), drop the `REPOS` import, add `parseArgs`, `buildRepoList`, `countUnassessedRepos`, rewrite `main()` to discover repos and branch on `--dry-run`/`--limit`.
- **Modify** `pipeline/run.test.js` — add tests for `parseArgs`, `buildRepoList`, `countUnassessedRepos`.
- **Modify** `pipeline/discover.js` — `require("./run")` → `require("./run-tracking")`.
- **Modify** `pipeline/config.js` — delete the `REPOS` export.
- **Modify** `ARCHITECTURE.md`, `ROADMAP.md`, `CLAUDE.md` — sync "Status"/"Next"/"Future direction" once Task 6's live run confirms the new behavior.

---

### Task 1: Extract run-tracking helpers to break the coming circular dependency

**Files:**
- Create: `pipeline/run-tracking.js`
- Create: `pipeline/run-tracking.test.js`
- Modify: `pipeline/run.js`
- Modify: `pipeline/discover.js`

**Interfaces:**
- Produces: `makeRunId(now = new Date()) => string`, `recordRunStart(db, runId, startedAt, reposDiscovered) => Promise<void>`, `recordRunFinish(db, runId, finishedAt, counts) => Promise<void>` where `counts = {status, reposFetchedOk, reposFailed, llmCallsMade, llmCallsSkipped}` — exported from `pipeline/run-tracking.js`.

- [ ] **Step 1: Write the failing test**

Create `pipeline/run-tracking.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test pipeline/run-tracking.test.js`
Expected: FAIL — `Cannot find module './run-tracking'`

- [ ] **Step 3: Create `pipeline/run-tracking.js`**

```js
"use strict";

function makeRunId(now = new Date()) {
  return `run_${now.toISOString().replace(/[:.]/g, "-")}`;
}

async function recordRunStart(db, runId, startedAt, reposDiscovered) {
  await db.run(
    `INSERT INTO runs (run_id, started_at, status, repos_discovered, repos_fetched_ok, repos_failed, llm_calls_made, llm_calls_skipped)
     VALUES (?, ?, 'partial', ?, 0, 0, 0, 0)`,
    runId,
    startedAt,
    reposDiscovered,
  );
}

async function recordRunFinish(db, runId, finishedAt, counts) {
  await db.run(
    `UPDATE runs SET finished_at = ?, status = ?, repos_fetched_ok = ?, repos_failed = ?, llm_calls_made = ?, llm_calls_skipped = ?
     WHERE run_id = ?`,
    finishedAt,
    counts.status,
    counts.reposFetchedOk,
    counts.reposFailed,
    counts.llmCallsMade,
    counts.llmCallsSkipped,
    runId,
  );
}

module.exports = { makeRunId, recordRunStart, recordRunFinish };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test pipeline/run-tracking.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Remove the moved functions from `pipeline/run.js`**

In `pipeline/run.js`:
- Delete the `makeRunId`, `recordRunStart`, `recordRunFinish` function definitions (lines 11-13, 62-83 in the current file).
- Add near the top: `const { makeRunId, recordRunStart, recordRunFinish } = require("./run-tracking");`
- In the `module.exports` block at the bottom, remove `makeRunId`, `recordRunStart`, `recordRunFinish` (nothing outside this file imports them from `run.js` — confirmed by `grep -rn "makeRunId\|recordRunStart\|recordRunFinish" --include="*.js" .`, the only other caller is `discover.js`, updated in the next step).

- [ ] **Step 6: Point `pipeline/discover.js` at the new module**

In `pipeline/discover.js`, change:

```js
const { makeRunId, recordRunStart, recordRunFinish } = require("./run");
```

to:

```js
const { makeRunId, recordRunStart, recordRunFinish } = require("./run-tracking");
```

- [ ] **Step 7: Run the full suite to confirm nothing else broke**

Run: `pnpm test`
Expected: PASS — all existing suites (`db`, `discover`, `enrich`, `extract`, `github`, `load`, `publish`, `run`, `run-tracking`) still pass. `discover.test.js` passing here is the confirmation that `discoverRepos()`'s runtime behavior is unchanged by this move.

- [ ] **Step 8: Commit**

```bash
git add pipeline/run-tracking.js pipeline/run-tracking.test.js pipeline/run.js pipeline/discover.js
git commit -m "refactor(pipeline): extract run-tracking helpers to break upcoming run/discover cycle"
```

---

### Task 2: Add `parseArgs` and `buildRepoList` to `run.js`

**Files:**
- Modify: `pipeline/run.js`
- Modify: `pipeline/run.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `parseArgs(argv) => {dryRun: boolean, limit: number|null}`, `buildRepoList(discoveredRepos, limit) => string[]` where `discoveredRepos` is the array `discoverRepos()` returns as its `repos` field (objects with a `.fullName` string field) — both exported from `pipeline/run.js`, both used by `main()` in Task 4.

- [ ] **Step 1: Write the failing tests**

Add to `pipeline/run.test.js` (extend the existing `require("./run")` destructure to include the two new names):

```js
const {
  computeRunCounts,
  readEnrichInputs,
  parseArgs,
  buildRepoList,
} = require("./run");
```

```js
test("parseArgs defaults to no dry-run and no limit", () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, limit: null });
});

test("parseArgs recognizes --dry-run", () => {
  assert.deepEqual(parseArgs(["--dry-run"]), { dryRun: true, limit: null });
});

test("parseArgs recognizes --limit N", () => {
  assert.deepEqual(parseArgs(["--limit", "5"]), { dryRun: false, limit: 5 });
});

test("parseArgs rejects a non-positive-integer --limit value", () => {
  assert.throws(() => parseArgs(["--limit", "abc"]), /--limit requires a positive integer/);
  assert.throws(() => parseArgs(["--limit", "0"]), /--limit requires a positive integer/);
  assert.throws(() => parseArgs(["--limit", "-3"]), /--limit requires a positive integer/);
});

test("buildRepoList maps discovered repo objects to their fullName", () => {
  const discovered = [
    { repoId: 1, fullName: "sdpilon/a" },
    { repoId: 2, fullName: "sdpilon/b" },
  ];
  assert.deepEqual(buildRepoList(discovered, null), ["sdpilon/a", "sdpilon/b"]);
});

test("buildRepoList applies a limit by taking the first N", () => {
  const discovered = [
    { repoId: 1, fullName: "sdpilon/a" },
    { repoId: 2, fullName: "sdpilon/b" },
    { repoId: 3, fullName: "sdpilon/c" },
  ];
  assert.deepEqual(buildRepoList(discovered, 2), ["sdpilon/a", "sdpilon/b"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pipeline/run.test.js`
Expected: FAIL — `parseArgs is not a function` / `buildRepoList is not a function`

- [ ] **Step 3: Implement both functions in `pipeline/run.js`**

Add above `main()`:

```js
function parseArgs(argv) {
  const args = { dryRun: false, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") {
      args.dryRun = true;
    } else if (argv[i] === "--limit") {
      const raw = argv[i + 1];
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--limit requires a positive integer, got ${raw}`);
      }
      args.limit = value;
      i += 1;
    }
  }
  return args;
}

function buildRepoList(discoveredRepos, limit) {
  const fullNames = discoveredRepos.map((r) => r.fullName);
  return typeof limit === "number" ? fullNames.slice(0, limit) : fullNames;
}
```

Add both to the `module.exports` block at the bottom of `pipeline/run.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test pipeline/run.test.js`
Expected: PASS (all tests, including the pre-existing `computeRunCounts`/`readEnrichInputs` ones)

- [ ] **Step 5: Commit**

```bash
git add pipeline/run.js pipeline/run.test.js
git commit -m "feat(pipeline): add parseArgs and buildRepoList to run.js"
```

---

### Task 3: Add `countUnassessedRepos` for dry-run reporting

**Files:**
- Modify: `pipeline/run.js`
- Modify: `pipeline/run.test.js`

**Interfaces:**
- Consumes: nothing new from Task 2.
- Produces: `countUnassessedRepos(db, repoIds) => Promise<number>` — count of `repoIds` with zero rows in `repo_assessments`, exported from `pipeline/run.js`, used by `main()`'s `--dry-run` branch in Task 4.

- [ ] **Step 1: Write the failing test**

Add to `pipeline/run.test.js` (extend the `require("./run")` destructure with `countUnassessedRepos`, and add `openDb`/`ensureSchema` if not already imported — they already are, from the existing `readEnrichInputs` test):

```js
test("countUnassessedRepos counts only repos with no repo_assessments row", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  await db.run(
    `INSERT INTO repos (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, first_seen_at, last_seen_at)
     VALUES (1, 'sdpilon/a', null, 'u', 'main', null, 0, false, false, false, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
  );
  await db.run(
    `INSERT INTO repo_assessments (repo_id, run_id, input_hash, pct, band, label, text, gaps, created_at)
     VALUES (1, 'run_0', 'hash1', 50, 'unknown', 'x', 'y', [], '2026-07-01T00:00:00Z')`,
  );

  const count = await countUnassessedRepos(db, [1, 2, 3]);
  assert.equal(count, 2);

  await db.close();
});

test("countUnassessedRepos returns 0 for an empty repo list without querying", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  assert.equal(await countUnassessedRepos(db, []), 0);
  await db.close();
});
```

(Check `repo_assessments`'s exact column list in `schema.sql` before running this — the `INSERT` above must match it column-for-column, including `created_at`/whatever timestamp column it actually uses.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test pipeline/run.test.js`
Expected: FAIL — `countUnassessedRepos is not a function`

- [ ] **Step 3: Implement in `pipeline/run.js`**

```js
async function countUnassessedRepos(db, repoIds) {
  if (repoIds.length === 0) return 0;
  const placeholders = repoIds.map(() => "?").join(",");
  const rows = await db.all(
    `SELECT DISTINCT repo_id FROM repo_assessments WHERE repo_id IN (${placeholders})`,
    ...repoIds,
  );
  const assessedIds = new Set(rows.map((r) => Number(r.repo_id)));
  return repoIds.filter((id) => !assessedIds.has(id)).length;
}
```

Add to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test pipeline/run.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/run.js pipeline/run.test.js
git commit -m "feat(pipeline): add countUnassessedRepos for dry-run scope preview"
```

---

### Task 4: Wire `discoverRepos()` into `main()`, delete `REPOS`

**Files:**
- Modify: `pipeline/run.js`
- Modify: `pipeline/config.js`

**Interfaces:**
- Consumes: `discoverRepos({db, runId, now}) => Promise<{repos, count, results, error?}>` from `pipeline/discover.js` (existing); `parseArgs`, `buildRepoList`, `countUnassessedRepos` from Tasks 2-3; `makeRunId`, `recordRunStart`, `recordRunFinish` from Task 1's `run-tracking.js`.
- Produces: `main(argv = process.argv.slice(2)) => Promise<void>` — now discovery-driven and flag-aware.

- [ ] **Step 1: Delete `REPOS` from `pipeline/config.js`**

```js
"use strict";
module.exports = {
  DB_PATH: "tracker.duckdb",
  BRONZE_DIR: "bronze",
};
```

- [ ] **Step 2: Rewrite the top of `pipeline/run.js` and its `main()`**

Change the imports block to:

```js
"use strict";
const path = require("path");
const fs = require("fs");
const { openDb, ensureSchema } = require("./db");
const { extractAll } = require("./extract");
const { loadRun } = require("./load");
const { enrichRepo } = require("./enrich");
const { publish } = require("./publish");
const { discoverRepos } = require("./discover");
const { DB_PATH, BRONZE_DIR } = require("./config");
const { makeRunId, recordRunStart, recordRunFinish } = require("./run-tracking");
```

(`makeRunId`/`recordRunStart`/`recordRunFinish` were already switched to this import in Task 1 — this step is only listed again here to show the full, final import block in context.)

Replace `main()` with:

```js
async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const db = openDb(DB_PATH);
  await ensureSchema(db);
  const runId = makeRunId();
  const startedAt = new Date().toISOString();

  const {
    repos: discovered,
    count: discoveredCount,
    error: discoverError,
  } = await discoverRepos({ db, runId, now: startedAt });

  if (discoverError) {
    console.error(`run ${runId}: discovery failed, aborting: ${discoverError}`);
    await db.close();
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    const repoIds = discovered.map((r) => r.repoId);
    const unassessed = await countUnassessedRepos(db, repoIds);
    console.log(
      `run ${runId} (dry-run): ${discoveredCount} repos discovered, ` +
        `${unassessed} have no prior assessment and would trigger an enrichment call on a real run`,
    );
    await db.close();
    return;
  }

  const repos = buildRepoList(discovered, args.limit);
  await recordRunStart(db, runId, startedAt, discoveredCount);

  const extractResults = await extractAll({
    repos,
    db,
    runId,
    bronzeDir: BRONZE_DIR,
  });
  const loadSummary = await loadRun({
    db,
    runId,
    bronzeDir: BRONZE_DIR,
    extractResults,
    now: startedAt,
  });

  const { repoIds, reposFetchedOk, reposFailed } =
    computeRunCounts(extractResults);

  let llmCallsMade = 0;
  let llmCallsSkipped = 0;
  for (const repoId of repoIds) {
    const meta = readBronzeJson(BRONZE_DIR, runId, repoId, "meta");
    const { readmeText, commitMessages, issueTitles } = await readEnrichInputs(
      db,
      BRONZE_DIR,
      runId,
      repoId,
    );
    const result = await enrichRepo({
      db,
      repoId,
      fullName: meta.fullName,
      runId,
      readmeText,
      commitMessages,
      issueTitles,
      now: new Date().toISOString(),
    });
    if (result.called) llmCallsMade += 1;
    else llmCallsSkipped += 1;
  }

  await publish({ db, repoIds: Array.from(repoIds) });

  const finishedAt = new Date().toISOString();
  await recordRunFinish(db, runId, finishedAt, {
    status: reposFailed > 0 ? "partial" : "success",
    reposFetchedOk,
    reposFailed,
    llmCallsMade,
    llmCallsSkipped,
  });

  console.log(
    `run ${runId}: ${reposFetchedOk} repos ok, ${reposFailed} repos with fetch errors, ` +
      `${loadSummary.failuresRecorded} failures recorded, ${llmCallsMade} enrichment calls made, ${llmCallsSkipped} skipped` +
      (args.limit ? ` (limited to ${args.limit} of ${discoveredCount} discovered repos)` : ""),
  );
  await db.close();
}
```

Update the final `module.exports` block to:

```js
module.exports = {
  main,
  parseArgs,
  buildRepoList,
  countUnassessedRepos,
  computeRunCounts,
  readEnrichInputs,
};
```

- [ ] **Step 3: Confirm no dangling `REPOS` references**

Run: `grep -rn "REPOS" pipeline/`
Expected: no output (the only remaining hits from before this task were `pipeline/config.js` and `pipeline/run.js`, both just edited).

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: PASS. Note `main()` itself has no direct unit test, consistent with its state before this plan — it's an orchestrator that shells out to `gh` and touches a real DuckDB file, so it's covered by Task 5's live run instead, the same way Stage 0's `main()` was.

- [ ] **Step 5: Commit**

```bash
git add pipeline/run.js pipeline/config.js
git commit -m "feat(pipeline): source run.js's repo list from Discovery instead of hardcoded REPOS"
```

---

### Task 5: Live end-to-end verification against the real account

**Files:** none (verification only).

This exercises real `gh api` calls and writes to the real (gitignored) `tracker.duckdb`/`bronze/`, plus the git-tracked `repos.json`/`tracker.html`. Nothing here gets committed automatically — `repos.json`/`tracker.html` changes stay unstaged until reviewed.

- [ ] **Step 1: Dry-run — verify scope with zero pipeline side effects**

Run: `node pipeline/run.js --dry-run`
Expected: a `run_... (dry-run): N repos discovered, M have no prior assessment...` line where N is close to the ~65 seen in `discover.js`'s own prior live verification (see `ARCHITECTURE.md`'s "Status" section). Confirm via `git status` that `repos.json`/`tracker.html` are untouched.

- [ ] **Step 2: Small real run — verify the full path end-to-end at low cost**

Run: `node pipeline/run.js --limit 3`
Expected: a `run_...: 3 repos ok, 0 repos with fetch errors, ...` summary line ending in `(limited to 3 of N discovered repos)`. Confirm:
- `repos`/`repo_discoveries` (via a DuckDB query) reflect the *full* discovered count, not just 3 — discovery is never limited, only extraction/enrich/publish are.
- `commits`/`issues`/`repo_assessments` have rows only for the 3 limited repos.
- `repos.json`/`tracker.html` now reflect exactly those 3 repos (`git diff --stat repos.json tracker.html`).

- [ ] **Step 3: STOP — confirm with the user before the full, unlimited run**

The next step overwrites the checked-in `repos.json`/`tracker.html` with the full ~65-repo account for the first time and makes ~65 enrichment calls (stub calls today, per the Design Notes above — no real LLM spend, but still the first real full-scope run). Do not proceed to Step 4 without explicit go-ahead in this session.

- [ ] **Step 4: Full run, twice — verify incremental behavior and doc-worthy counts**

Run: `node pipeline/run.js`
Expected: `run_...: N repos ok, 0 repos with fetch errors, ..., N enrichment calls made, 0 skipped` (first run — nothing has a prior assessment yet, so the gate can't skip anything).

Run: `node pipeline/run.js` again.
Expected: `run_...: N repos ok, 0 repos with fetch errors, ..., 0 enrichment calls made, N skipped` (second run — content hashes match, the gate skips everything). This is the concrete signal (per `ARCHITECTURE.md`) that the incremental enrichment gate is actually working, not just hoped to be working.

Record the real N (discovered/fetched-ok count) and confirm `tracker.html` renders all N repos in a browser — these numbers go into Task 6's doc updates.

- [ ] **Step 5: Do not commit yet**

Leave `repos.json`/`tracker.html` as unstaged changes. Committing them (or not) is a decision for the user in this session, not an automatic step of this plan.

---

### Task 6: Sync docs

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `ROADMAP.md`
- Modify: `CLAUDE.md`

Per `CLAUDE.md`'s own "Keeping docs in sync" rule: before finishing this branch, `ARCHITECTURE.md`'s "Status" section and `CLAUDE.md`'s "Future direction" section must describe what's now true, not what was true before this plan.

- [ ] **Step 1: Update `ARCHITECTURE.md`'s "Status" section**

Replace the paragraph starting "It does **not** replace `pipeline/config.js`'s `REPOS`..." with a statement that Discovery is now wired into `run.js`'s `main()`, `REPOS` is deleted, and cite Task 5's actual live counts (repos discovered/fetched ok, two-run skip behavior) in place of the old 2-repo description. Update the "Not yet implemented" paragraph to drop "widening from 2 repos to the full ~60-repo account" (done) while keeping `prs` and the `repo_assessments` → `tracker.html` wiring as still-open items.

- [ ] **Step 2: Update `ROADMAP.md`**

Move the "Wire Discovery in + decide filter policy + widen..." item from "Next" to "Done", rewritten in the past tense with the actual outcome (no filtering, `--dry-run`/`--limit` added, `REPOS` deleted, live-verified counts from Task 5). If `fetch.sh`'s retirement (currently gated on "Discovery's widening... restores at least the repo coverage `fetch.sh` currently provides") is now unblocked, consider moving that item from "Later" to "Next" — but confirm with the user before doing so, since it's a scope decision, not a mechanical doc sync.

- [ ] **Step 3: Update `CLAUDE.md`'s "Future direction" section**

Replace the sentence "Discovery (`pipeline/discover.js`) is implemented and live-verified... but it is not wired into `run.js`'s `main()`..." with a statement that it now is, and that `pipeline/config.js` no longer has a hardcoded `REPOS` scope — the caveat about `pnpm pipeline` collapsing the dashboard to 2 repos no longer applies.

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md ROADMAP.md CLAUDE.md
git commit -m "docs: sync pipeline status now that Discovery is wired into run.js"
```

---

## Deferred From the Spec

- **P1 #6** (run summary distinguishing discovery-time vs. extraction-time failures) is not implemented by this plan. Today's `main()` already aborts entirely on a discovery error (Task 4's `discoverError` branch) rather than mixing it into the per-repo fetch-failure count, so the ambiguity P1 was meant to resolve mostly doesn't arise in practice — worth revisiting only if a future run produces a genuinely confusing mixed-failure summary.
- **P2 #7** (filtering/curation seam) is intentionally not built — the spec decided "no filtering" for v1, and P2 items are architectural notes for later, not tasks for this plan.
