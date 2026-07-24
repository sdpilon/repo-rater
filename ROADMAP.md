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

- **Fix `pipeline/publish.js` production-overwrite bug** — it writes
  straight to the same `repos.json`/`tracker.html` that `fetch.sh` produces,
  scoped to only its 2 hardcoded repos, so running it clobbers the other 7
  repos' data. This is the only thing making `pipeline/` actively unsafe to
  run today; low effort, high value (removes a footgun that's already bitten
  us once this session). Fix options: write to a separate file when scoped
  to fewer than the full repo set, or gate `inject.js` calls behind a flag
  until Discovery + widening land. See `ARCHITECTURE.md`'s "Status" section.

## Next

- **`prs` data type** — the pipeline currently extracts readme/issues/
  commits/meta but not pull requests, unlike `fetch.sh` which does.

## Later

- **Wire `repo_assessments` into `tracker.html`** — replace the
  hand-authored `ASSESS` block with `pipeline/enrich.js`'s generated
  assessments. Requires extending `inject.js`'s splice markers to a second
  marker pair.
- **Wire Discovery in + decide filter policy + widen from 2 repos to the
  full ~60-repo account** — `pipeline/discover.js` exists and works
  standalone (see Done below), but nothing calls it from `run.js`'s
  `main()` yet, and there's no decision on which discovered repos should
  actually be tracked (everything gh returns? auto-exclude forks/archived?
  an explicit allow/deny list?). This item is: decide the filter policy,
  wire `discoverRepos()` in to replace `pipeline/config.js`'s hardcoded
  `REPOS`, and drop the 2-repo scope.
- **Cut over `pipeline/` to be the actual production path**, retiring
  `fetch.sh`/`inject.js` — contingent on all of the above, especially the
  publish-isolation fix and Discovery's wiring.

## Done

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
  `pnpm pipeline:discover`; deliberately not wired into `run.js`'s `main()`
  — see the Later item above for why.
- **Environment tooling** — `scripts/doctor.sh` (preflight checks: lockfile
  integrity, DuckDB binding, real `gh` auth reachability, test discovery)
  and standard `package.json` scripts (`dev`, `lint`, `format`, `build`,
  `pipeline`, `deps:outdated`, `deps:update`, `env-check`).

## Explicitly not planned

Carried over from `ARCHITECTURE.md`'s "Explicitly out of scope" — GraphQL
batching, concurrency/backoff tuning, multi-tenancy. None of these solve a
problem that exists at ~60 repos / one user; they'd be complexity for the
sake of looking scalable, which isn't the point of this exercise.
