# Spec: Wire Discovery into the pipeline

**Status:** Draft
**Owner:** solo project (spencer)
**Related:** `ARCHITECTURE.md` ("Status" section), `ROADMAP.md` ("Next" section), `pipeline/discover.js`, `pipeline/run.js`, `pipeline/config.js`

## Problem Statement

`pipeline/discover.js` works standalone and is live-verified against the real
account (65 repos, correctly upserted into `repos`/`repo_discoveries`), but
`pipeline/run.js`'s `main()` still sources its repo list from
`pipeline/config.js`'s hardcoded `REPOS` array — 2 repos. Every real run of
`pnpm pipeline` collapses the published dashboard down to those 2 repos,
discarding the other ~63. The pipeline can enumerate the whole account; it
just isn't allowed to act on what it finds yet.

## Goals

- `pnpm pipeline` publishes a dashboard covering the full account (~60+
  repos) discovered at run time, with no manually maintained repo list.
- Adding, renaming, or archiving a GitHub repo requires zero code changes to
  show up (or drop out of scope) on the next run.
- A run can be previewed at limited scope before committing to a full-cost
  run, so the first real full-account run isn't also the first time the
  operator sees what it does.
- `pipeline/config.js`'s `REPOS` constant and the two-repo scope it encodes
  are fully retired, not just unused.

## Non-Goals

- **Filtering by fork/archived/allow-deny list** — decided: no filtering.
  Every repo `discoverRepos()` returns is tracked. Revisit only if a
  specific repo turns out to be noise in practice.
- **The `prs` data type** — separate `ROADMAP.md` "Now" item, unrelated to
  wiring Discovery in.
- **Wiring `repo_assessments` into `tracker.html`** — separate `ROADMAP.md`
  "Later" item; requires extending `inject.js`'s splice markers.
- **Retiring `fetch.sh`** — sequenced after this ships and restores at least
  `fetch.sh`'s current repo coverage (`ROADMAP.md` "Later").
- **GraphQL batching / concurrency tuning / rate-limit handling** —
  explicitly out of scope per `ARCHITECTURE.md`; ~240 req/run stays well
  under GitHub's 5,000/hour limit even at 65 repos.
- **Cost controls beyond a preview flag** — no budget cap, no cost
  estimation UI. A `--limit`/dry-run flag to preview scope is P0 (see
  below); anything more sophisticated is future work if it turns out to be
  needed.

## User Stories

(Single-user tool — "user" below means the pipeline's operator, i.e. you.)

- As the operator, I want `pnpm pipeline` to discover the account's repos
  itself so that I never have to hand-edit a repo list again.
- As the operator, I want to preview which repos and how many LLM calls a
  full run would make *before* running it for real, so the first full
  ~60-repo run isn't a surprise (in scope or in LLM cost).
- As the operator, I want a repo that fails during discovery or extraction
  to not take down the rest of the run, so one bad repo doesn't zero out
  the whole dashboard.
- As the operator, I want each run's counts (discovered, fetched ok,
  failed, LLM calls made vs. skipped) recorded in `runs`, so I can see at a
  glance whether a run behaved as expected without digging through logs.

## Requirements

### Must-Have (P0)

1. **`run.js`'s `main()` calls `discoverRepos()` and uses its output as the
   repo list**, replacing `REPOS` from `pipeline/config.js`.
   - Acceptance: running `pnpm pipeline` with no flags processes every repo
     `discoverRepos()` returns for the authenticated account — no
     filtering, no manual list.
   - Technical note: `discoverRepos()` returns `{ repoId, fullName, ... }`
     objects; `extractAll()` currently takes `repos: REPOS` (an array of
     `fullName` strings from `pipeline/config.js`). This shape mismatch
     needs to be reconciled — confirm what `extractAll()` actually needs
     per repo and adapt the call site accordingly, don't assume a plain
     string array still works.

2. **A preview/limit mode exists before committing to a full run.**
   - Acceptance: an operator can invoke the pipeline in a mode that shows
     which repos would be processed and how many LLM enrichment calls
     would fire, without actually calling the GitHub write paths, DuckDB
     writes, `inject.js`, or the LLM.
   - Open question (below) on exact mechanism (`--dry-run` vs. `--limit N`
     vs. both).

3. **`pipeline/config.js`'s `REPOS` constant is deleted**, and every
   reference to it (`run.js`, tests, docs) is removed or updated.
   - Acceptance: `grep -r REPOS pipeline/` returns no hits outside of
     `discoverRepos()`'s own output naming; `pnpm test` and
     `scripts/doctor.sh` still pass.

4. **Per-repo failure isolation is preserved at the new scale.** One repo
   failing discovery or extraction must not abort the run for the other
   ~60.
   - Acceptance: this already holds for `discover.js` and `extract.js`
     individually (per `ARCHITECTURE.md`) — this requirement is that it
     still holds once they're chained together in `run.js` with a live
     ~60-repo input, not just proven in isolation.

5. **Live end-to-end verification against the real account**, per this
   project's own standing rule (`CLAUDE.md`: orchestration work needs a
   live E2E check, not just unit tests — Stage 0's worst bug shipped past
   28 passing unit tests). Run `pnpm pipeline` for real, twice, and confirm:
   - `runs.repos_discovered` matches the real account's repo count.
   - `repos` / `repo_discoveries` / `commits` / `issues` / `repo_assessments`
     all reflect the full scope, not 2 repos.
   - The second run's `llm_calls_skipped` is high (content-hash gate
     working) — the first run is expected to make ~60 LLM calls (see
     Non-Goals), the second should skip nearly all of them.
   - `tracker.html` renders the full repo set after publish.

### Nice-to-Have (P1)

6. **Run summary output distinguishes discovery-time failures from
   extraction-time failures** in the console log line `run.js` already
   prints, so a partial run's cause is legible without opening `runs` in
   DuckDB.

### Future Considerations (P2)

7. Filtering/curation policy (forks, archived, explicit allow/deny) —
   deliberately deferred (see Non-Goals). If it's ever needed, the natural
   seam is between `discoverRepos()`'s output and what gets passed to
   `extractAll()`, not inside `discover.js` itself, so discovery keeps
   recording the *full* account truthfully in `repo_discoveries` regardless
   of what gets tracked downstream.

## Open Questions

- **Preview mechanism shape (engineering, blocking):** `--dry-run` (show
  scope, make zero calls) vs. `--limit N` (run for real against the first N
  discovered repos) vs. both? Dry-run answers "what would this touch";
  limit answers "does this work end-to-end at small scale before I pay for
  60." They answer different questions — worth deciding whether P0 needs
  one or both before implementation starts.
- **Does `extractAll()` need to change signature, or just its caller
  (engineering, blocking):** requirement 1's shape mismatch — resolve by
  reading `extract.js`'s actual per-repo needs before writing the new
  `main()`, not by guessing.
- **What counts as "done enough" LLM cost for the first full run
  (non-blocking):** ~60 calls at first-run scale is accepted as one-time
  cost per this spec's scoping conversation — flagging here only in case
  actual model/pricing choice at implementation time changes that math
  enough to revisit.

## Timeline Considerations

None — solo project, no external deadline. Sequencing dependency: this is
the blocking item for `ROADMAP.md`'s "Later" items (`repo_assessments` →
`tracker.html`, retiring `fetch.sh`), so landing it unblocks both, but
nothing is waiting on a date.
