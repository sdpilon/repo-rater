# Roadmap

This is a personal-use, single-repo learning project — one owner (you), no team,
no hard deadlines. Kept in Now/Next/Later form deliberately: it says what's
true and what's next without pretending to have dates or capacity numbers
that don't exist for a solo side project. See `ARCHITECTURE.md` for the full
design rationale behind each item; this file is just the sequencing.

Update this file (and re-sync `ARCHITECTURE.md`'s "Status" section /
`CLAUDE.md`'s "Future direction" section alongside it — see
`CLAUDE.md`'s "Keeping docs in sync") whenever priorities shift or an item
completes.

## Now

(nothing queued here right now — see "Next"/"Later" below)

## Next

- **UI-based per-repo assess/ignore selection** — let the user choose which
  repos get an AI assessment (vs. ignored) directly from `tracker.html`,
  instead of `update-tracker`'s `$ARGUMENTS` naming repos by hand each run.
  Tracked as a separate beads issue, filed when `fetch.sh` was retired
  (see "Done" below) — has real open design questions (where selections
  get persisted, whether it needs a small local server) not yet worked out.

## Later

(nothing queued here right now)

## Done

- **Retire `fetch.sh`** — `pipeline/` is the real project and
  `publish.js` writing to `repos.json`/`tracker.html` is accepted behavior,
  so `fetch.sh` was deleted outright. The one gap that would have made this
  a regression — `pipeline/publish.js` always publishing `readme: ""` while
  `fetch.sh` fetched real README text — is fixed: `buildRepoRecord()` now
  reads the real README text out of that run's bronze copy. `package.json`'s
  `build` script now runs `node pipeline/run.js` directly, and
  `.claude/skills/update-tracker/SKILL.md` was rewritten to run the pipeline
  and scope assessment work via `$ARGUMENTS` instead of hand-editing a
  `repos=` list that no longer exists.

- **`prs` data type** — the pipeline now extracts/loads/publishes pull
  requests (`fetchPrsSince` and the full extract/load/publish wiring),
  matching what `fetch.sh` already provided. Live-verified.

- **Wire `repo_assessments` into `tracker.html`.** `pipeline/publish.js`'s
  `buildRepoRecord()` includes each repo's latest `repo_assessments` row as
  an `assessment` field; `tracker.html` falls back to it
  (`ASSESS[r.name] || r.assessment || {...}`) only when there's no
  hand-authored `ASSESS` entry. No second `inject.js` splice marker was
  needed — the assessment rides along inside the existing `DATA` payload.
  Deliberately not a full replacement of the hand-authored block: until
  `generateAssessment()` is a real LLM call instead of a stub, the 9
  existing hand-written entries stay authoritative.

- **Wire Discovery into `run.js`'s `main()`, widen from 2 repos to the full
  account.** No filter policy applied — `main()` extracts/loads/enriches/
  publishes every repo Discovery returns (forks and archived included).
  `pipeline/config.js`'s hardcoded `REPOS` is deleted. Added `--dry-run`
  (reports scope + repos with no prior assessment; runs a real discovery —
  writes `repos`/`repo_discoveries`/`runs` — but no extraction, load,
  enrichment, publish, or `repos.json`/`tracker.html` writes) and
  `--limit N` (restricts a real run to the first N discovered repos;
  discovery itself is never restricted by `--limit`) flags to `run.js`.
  Live-verified against the real account: dry-run found 65 repos discovered,
  63 with no prior assessment; a `--limit 3` run confirmed `repos`/
  `repo_discoveries` always reflect the full 65-repo account regardless of
  `--limit`, while `repos.json`/`tracker.html` reflect only the limited
  subset; a full run (no flags) discovered 65, fetched 28 ok, hit 37 fetch
  errors (overwhelmingly repos with no README — a 404, handled as an
  expected per-datatype failure — plus one "Git Repository is empty" 409),
  made 60 enrichment calls, skipped 5 (already assessed); running the same
  full run again immediately after made 0 enrichment calls and skipped all
  65, confirming the content-hash gate holds when nothing has changed.
  `repos.json` now has 65 entries (was 2); `tracker.html`'s injected `DATA`
  block was verified to parse as valid JSON with all 65.

- **Decided: `pipeline/publish.js` overwriting `repos.json`/`tracker.html`
  is accepted behavior, not a bug.** `pipeline/` is now treated as the real
  project; the earlier framing (see `docs/postmortems/`) of the overwrite as
  a footgun to fix before it's safe to run assumed `fetch.sh`'s output was
  the thing worth protecting. That's no longer the premise. Discovery is now
  wired in (see the item above), so `pnpm pipeline` publishes the full
  discovered account rather than a hardcoded 2-repo subset.

- **Stage 0 vertical slice** (`pipeline/`) — Extract → Load → Enrich →
  Publish, proven end-to-end for a hardcoded 2-repo scope: DuckDB-backed
  watermarking, idempotent upserts, content-hash-gated enrichment (skips
  the LLM call when inputs haven't changed), dead-letter failure isolation.
- **Discovery module** (`pipeline/discover.js`) — enumerates the account via
  paginated `gh api user/repos`, upserts `repos`, appends one row per repo to
  `repo_discoveries` per run, and records a real `runs` row (not a
  hardcoded count). Per-repo failures are isolated (one bad repo doesn't
  abort the batch), matching `extract.js`'s pattern. Verified across two
  live runs against the real account: 65 repos, no filtering, `runs` and
  `repo_discoveries` both correctly populated (see `ARCHITECTURE.md`'s
  Status section for the actual output). Runnable standalone via
  `pnpm pipeline:discover`, and now also wired into `run.js`'s `main()`
  (see the "Wire Discovery..." item above).
- **Environment tooling** — `scripts/doctor.sh` (preflight checks: lockfile
  integrity, DuckDB binding, real `gh` auth reachability, test discovery)
  and standard `package.json` scripts (`dev`, `lint`, `format`, `build`,
  `pipeline`, `deps:outdated`, `deps:update`, `env-check`).

## Explicitly not planned

Carried over from `ARCHITECTURE.md`'s "Explicitly out of scope" — GraphQL
batching, concurrency/backoff tuning, multi-tenancy. None of these solve a
problem that exists at ~60 repos / one user; they'd be complexity for the
sake of looking scalable, which isn't the point of this exercise.
