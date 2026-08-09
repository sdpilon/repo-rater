# Architecture: from a hardcoded fetch script to a live Postgres dashboard

This document is a short pointer to the design/build history for
`github-project-tracker`. The current, live-running system is a SolidStart
+ Drizzle + Postgres (Neon) + Octokit dashboard, deployed to Vercel via
GitHub Actions, with a second GitHub Actions workflow running the discover/
extract/enrich pipeline on a schedule — see `CLAUDE.md`/`README.md` for how
that current stack actually works day to day.

Detailed build history (what was built, in what order, with what
verification) lives in `bd` — each phase below is a closed epic with full
design notes and live-verification transcripts in `bd show <id>` — rather
than duplicated here, so this file doesn't drift the way a hand-maintained
narrative can (a stale spec doc calling done work "Draft" is what prompted
this file's own trim, 2026-08-09).

## Original design (retired)

Before the rewrite, this project was a from-scratch, DuckDB-backed,
medallion-style (bronze/silver/gold) pipeline (`pipeline/`), built
partly as a learning exercise in incremental data-pipeline design: repo
discovery via the `gh` CLI instead of a hardcoded list, per-repo watermarked
incremental extraction to flat-file "bronze" JSON, idempotent upserts into
DuckDB "silver" tables, content-hash-gated LLM re-assessment (only call the
LLM when a repo's inputs actually changed), and a "gold" publish step that
spliced the result into a static `tracker.html`. Discovery/extraction/
loading/enrichment/publishing were five separately-isolated stages so one
repo's failure never took down the whole run. GraphQL batching,
concurrency/backoff tuning, and multi-tenancy were all explicitly
considered and parked as unnecessary complexity at this project's ~60-repo,
single-user scale.

**Fully retired as of Phase 4:** `pipeline/`, `tracker.html`, `schema.sql`,
`inject.js`, `repos.json`, and the local `tracker.duckdb` file are all
deleted — nothing above is runnable anymore. This section is kept only as a
condensed pointer, not a current design: the full original write-up (five-
stage architecture diagram, full DDL rationale, out-of-scope reasoning)
lives in git history (see commit `660fc2b`, "docs: add scaled pipeline
architecture design and DuckDB schema draft") and in `docs/postmortems/`,
which are dated historical records and intentionally left unedited.

## Status

Starting 2026-07-29, the project underwent a ground-up rewrite to
**SolidStart + Drizzle + Postgres (Neon) + Octokit**, replacing DuckDB, the
`gh` CLI, and the static `tracker.html`/`inject.js` publish step. That
rewrite is now **fully complete and cut over**: the new stack runs live in
production on Vercel, and the old stack has been deleted from the repo.

### New stack — Phase 1 (Discover → Extract+Load): complete and live-verified

Ported discover/extract/load from the old DuckDB pipeline to Postgres
(Neon) via Drizzle + Octokit, with per-repo/per-data-type failure isolation
and no bronze flat-file layer (`extract-load.ts` merges extract+load into
one atomic per-repo step). Live-verified 2026-07-30 against the real
account (66 repos): two consecutive full runs produced identical row
counts, confirming idempotency. Full module-by-module design detail and
verification transcripts: `bd show tracker-8rb`.

### New stack — Phase 2 (ignore-rules port + Anthropic-backed enrichment): complete and live-verified

Ported `ignore-rules.js` and `enrich.js`'s Anthropic-calling half, with the
content-hash gate and manual-override (`assessment_source`) invariant
preserved. Live-verified against the real GitHub account, Neon, and the
Anthropic API: the content-hash gate correctly skipped re-assessment on an
unchanged repo, and the manual-override gate correctly blocked
re-enrichment. Full design detail and verification transcripts:
`bd show tracker-20b`.

### New stack — Phase 3 (SolidStart frontend): complete

Replaced `tracker.html`'s hand-rolled `innerHTML` templating with real
SolidStart components reading live Postgres data server-side — no
static-file regeneration, no `inject.js` splice. Implemented as 9 tasks,
per `docs/superpowers/specs/2026-07-30-phase3-solidstart-frontend-design.md`
and `docs/superpowers/plans/2026-07-30-phase3-solidstart-frontend.md`. Full
child task breakdown: `bd show tracker-ur4`.

### New stack — Phase 4 (Vercel + GitHub Actions deploy, then cutover): complete

Deployed to Vercel via GitHub Actions (`deploy.yml`, `pipeline.yml`), added
app-level shared-secret auth after discovering live that Vercel's
Deployment Protection doesn't cover production on the Hobby plan, then
retired the old DuckDB stack entirely. Live-verified 2026-08-02 (production
matching local dev exactly; a scheduled pipeline run confirmed refreshing
Postgres without a redeploy). Full design detail, the Vercel
team-scoped-token gotcha, and verification transcripts: `bd show tracker-chm`.

### Old stack (DuckDB) — status as of the rewrite starting

The Stage 0 vertical slice (Extract→Load→Enrich→Publish for a hardcoded
2-repo scope, merged 2026-07-22) and Discovery's later wiring into the full
account (2026-07-24) are documented in
`docs/postmortems/2026-07-22-stage-0-vertical-slice.md` and the closed bd
issues from that window (`tracker-9kj`, `tracker-nth`, `tracker-s10`) —
not reproduced here.

## Closing note

Everything above Phase 1 describes code that no longer exists in this repo
as of Phase 4's cutover — kept only as a pointer to where the historical
record actually lives (`bd`, `docs/postmortems/`, git history), not as
documentation of anything currently runnable. `CLAUDE.md` has the
current-stack orientation for day-to-day work; `ROADMAP.md` has whatever's
next.
