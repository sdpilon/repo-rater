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

- **`prs` data type** — the pipeline currently extracts readme/issues/
  commits/meta but not pull requests, unlike `fetch.sh` which does.

## Next

- **Wire Discovery in + decide filter policy + widen from 2 repos to the
  full ~60-repo account** — moved up from "Later": now that `pipeline/` is
  treated as the real project (see Done below), this is what actually
  restores full dashboard coverage, since `pnpm pipeline` currently
  publishes only `pipeline/config.js`'s hardcoded 2 repos. `pipeline/discover.js`
  exists and works standalone (see Done below), but nothing calls it from
  `run.js`'s `main()` yet, and there's no decision on which discovered repos
  should actually be tracked (everything gh returns? auto-exclude
  forks/archived? an explicit allow/deny list?). This item is: decide the
  filter policy, wire `discoverRepos()` in to replace `pipeline/config.js`'s
  hardcoded `REPOS`, and drop the 2-repo scope.

## Later

- **Wire `repo_assessments` into `tracker.html`** — replace the
  hand-authored `ASSESS` block with `pipeline/enrich.js`'s generated
  assessments. Requires extending `inject.js`'s splice markers to a second
  marker pair.
- **Retire `fetch.sh`** — now that `pipeline/` is the real project and
  `publish.js` writing to `repos.json`/`tracker.html` is accepted behavior,
  `fetch.sh` is legacy rather than a production path to protect. Retire it
  once Discovery's widening (above) restores at least the repo coverage
  `fetch.sh` currently provides.

## Done

- **Decided: `pipeline/publish.js` overwriting `repos.json`/`tracker.html`
  is accepted behavior, not a bug.** `pipeline/` is now treated as the real
  project; the earlier framing (see `docs/postmortems/`) of the overwrite as
  a footgun to fix before it's safe to run assumed `fetch.sh`'s output was
  the thing worth protecting. That's no longer the premise. The one
  remaining caveat: until Discovery is wired in and widened (see "Next"),
  running `pnpm pipeline` for real collapses dashboard coverage down to
  `pipeline/config.js`'s 2 hardcoded repos — an accepted, temporary
  tradeoff rather than something to guard against.

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
