# Architecture: from a hardcoded fetch script to a live Postgres dashboard

This document is the design/build history for `github-project-tracker`.
The current, live-running system is a SolidStart + Drizzle + Postgres
(Neon) + Octokit dashboard in `app/`, deployed to Vercel via GitHub
Actions, with a second GitHub Actions workflow running the discover/
extract/enrich pipeline on a schedule. See the "Status" section below for
how it was built, phase by phase — that's the accurate, current design.

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

**Fully retired as of Phase 4** (this branch, `worktree-phase4-deploy`):
`pipeline/`, `tracker.html`, `schema.sql`, `inject.js`, `repos.json`, and
the local `tracker.duckdb` file are all deleted — nothing above is
runnable anymore. This section is kept only as a condensed pointer, not a
current design: the full original write-up (five-stage architecture
diagram, full DDL rationale, out-of-scope reasoning) lives in git history
(see commit `660fc2b`, "docs: add scaled pipeline architecture design and
DuckDB schema draft") and in `docs/postmortems/`, which are dated
historical records and intentionally left unedited.

## Status

Starting 2026-07-29, the project underwent a ground-up rewrite to
**SolidStart + Drizzle + Postgres (Neon) + Octokit**, replacing DuckDB, the
`gh` CLI, and the static `tracker.html`/`inject.js` publish step. That
rewrite is now **fully complete and cut over** (Phase 4, this document's
last section below): the new stack runs live in production on Vercel, and
the old stack described in "Original design (retired)" above has been
deleted from the repo. Everything below traces how the new stack was
actually built, phase by phase, as a historical record — not a
forward-looking plan.

### New stack — Phase 1 (Discover → Extract+Load): complete and live-verified

All of the following lives in `app/` (a SolidStart project, its own
isolated pnpm workspace so installing it doesn't pull in the old stack's
DuckDB native-binding rebuild):

- **`app/src/db/schema.ts`** — Drizzle Postgres schema translating the old
  `schema.sql`'s 9 tables, plus two new columns: `repos.assessment_source`
  (mirrors `ignore_source`, will gate manual-override assessments in
  Phase 2) and `repo_assessments.input_snapshot jsonb` (debuggability now
  that there's no bronze layer to inspect after the fact). Migration
  generated via `drizzle-kit generate`, applied to a real Neon database
  via `drizzle-kit migrate`, and verified against real
  `information_schema` introspection — all 9 tables/columns present
  exactly as designed.
- **`app/src/pipeline/github/client.ts`** — Octokit-based GitHub client
  replacing `gh`-CLI shell-outs. Function-for-function port of
  `pipeline/github.js`: same repo-meta/readme/commits/issues/PR fetch
  shapes, Octokit's built-in pagination replacing the old hand-rolled
  loops, and the PR since-filter logic preserved (still needed — GitHub's
  `/pulls` has no server-side `since=` regardless of client, that was
  never a `gh`-CLI artifact).
- **`app/src/pipeline/discover.ts` + `runs.ts`** — port of
  `discover.js`/`run-tracking.js`. `upsertRepo` is now a single atomic
  Postgres `INSERT ... ON CONFLICT DO UPDATE`, replacing the old
  two-round-trip SELECT-then-`INSERT OR REPLACE` that DuckDB needed to
  preserve `first_seen_at`/`is_ignored` — Postgres just leaves omitted
  columns alone on conflict, so no pre-SELECT is needed.
- **`app/src/pipeline/extract-load.ts`** — the one genuinely new module,
  not a port: merges the old `extract.js` (fetch → bronze flat files) and
  `load.js` (bronze → DuckDB) into a single per-repo, per-data-type
  fetch-and-upsert step straight into Postgres, **with no bronze
  flat-file layer** (its only value — replay without re-hitting GitHub —
  doesn't survive on ephemeral compute and isn't worth a second storage
  subsystem at this project's scale). Each of commits/issues/prs gets its
  own try/catch: a failure records a `fetch_failures` row and skips that
  data type's watermark advance without blocking the others; a second,
  outer per-repo isolation layer means one repo's total failure doesn't
  block the rest of the batch either.
- **`app/src/pipeline/run.ts`** — Phase 1 orchestrator, Discover →
  Extract+Load only. Enrichment is Phase 2; Publish is removed from the
  architecture entirely — the eventual SolidStart SSR route will query
  Postgres directly at request time, no static-file regeneration step.

Live-verified against the real GitHub account (66 repos) and a real Neon
Postgres database, 2026-07-30 (`pnpm exec tsx src/pipeline/run.ts` below is
the exact command run at the time; as of Phase 4, `app/package.json` also
has a `pipeline` script — `pnpm run pipeline` — wrapping the identical
`tsx src/pipeline/run.ts` invocation, which is what `pipeline.yml` calls in
CI):

```
$ pnpm exec tsx src/pipeline/run.ts --dry-run
run run_...: 66 repos discovered

$ pnpm exec tsx src/pipeline/run.ts            # first full run
run run_...: 65 repos ok, 1 repos with fetch errors

$ pnpm exec tsx src/pipeline/run.ts            # same command, run again immediately
run run_...: 65 repos ok, 1 repos with fetch errors   # identical result
```

The one failure, both times, is a real expected 404 (`sdpilon/home-server`
has pull requests disabled) — correctly isolated into `fetch_failures`
rather than aborting the run. Idempotency confirmed directly against
Postgres: row counts identical across both runs (1863 commits, 17 issues,
6 pull requests, 197 `fetch_watermarks` rows — 66 repos × 3 data types
minus the 1 failure), zero duplicate `(repo_id, sha)` commit rows, and
`fetch_watermarks.last_success_run_id`/`last_fetched_at` correctly
advanced to the second run's id/timestamp.

Along the way this also surfaced a real-world credential-scoping gotcha
worth recording: a fine-grained GitHub PAT with only "Contents: Read"
access fetches commits fine but fails Issues/PRs with `Resource not
accessible by personal access token` — fine-grained PATs scope each REST
resource independently, so "Issues: Read-only" and "Pull requests:
Read-only" repository permissions have to be granted explicitly too.

### New stack — Phase 2 (ignore-rules port + Anthropic-backed enrichment): complete and live-verified

All new code lives in `app/src/pipeline/`:

- **`app/src/pipeline/anthropic/client.ts`** — port of `pipeline/enrich.js`'s
  Anthropic-calling half: `createAnthropicClient` (fails fast on missing
  `ANTHROPIC_API_KEY`, mirroring `createOctokit`), `ASSESSMENT_SCHEMA`,
  `SYSTEM_PROMPT`, `buildUserContent`, and `generateAssessment`. The API
  call shape (`model: "claude-opus-4-8"`, `thinking: {type: "adaptive"}`,
  `output_config: {format: {type: "json_schema", ...}}`) is ported verbatim
  from the old stack, not "corrected" to older documented API shapes — it's
  confirmed working against the real API below.
- **`app/src/pipeline/ignore-rules.ts`** — port of `pipeline/ignore-rules.js`.
  `computeSuggestedIgnore` is unchanged (fork / archived / no-README /
  zero-activity). `applyIgnoreDefaultForRepo` is the single-repo equivalent
  of the old `applySuggestedIgnoreDefaults` loop body; the "auto never
  overwrites manual" `ignore_source` invariant is preserved.
- **`app/src/pipeline/enrich.ts`** — port of `pipeline/enrich.js`'s
  content-hash-gate half (`computeInputHash`, `readEnrichInputs`,
  `enrichRepo`, `countUnassessedRepos`), plus a new `enrichAll` orchestrator.
  Two deliberate departures from a literal port: `readEnrichInputs`'s
  commit/issue/PR queries now have an explicit `ORDER BY` (the old DuckDB
  queries had none, making the hash technically non-deterministic — free to
  fix since no existing hash values need to stay stable), and `enrichAll`
  merges what the old stack did as two separate full passes
  (`applySuggestedIgnoreDefaults` over every repo, then a second loop for
  enrichment) into one per-repo pass — there's no bronze-file README cache
  here (see `extract-load.ts`'s module comment), so a second pass would
  fetch each repo's README from GitHub twice. `enrichAll` also respects the
  new `repos.assessment_source` column (added in Phase 1 for exactly this):
  a repo marked `'manual'` is never re-enriched, mirroring `ignore_source`.
- **`app/src/pipeline/run.ts`** — extended from the Phase 1 orchestrator:
  `main()` now also requires `ANTHROPIC_API_KEY` and constructs the
  Anthropic client; `runPipeline` calls `enrichAll` after extract-load and
  threads real `llmCallsMade`/`llmCallsSkipped` into `recordRunFinish`
  (previously hardcoded to `0, 0`); the dry-run branch reports "N have no
  prior assessment" again via `countUnassessedRepos`.

No schema migration was needed — `repos.assessment_source` and
`repo_assessments.input_snapshot` were already added in Phase 1 anticipating
this phase.

Live-verified against the real GitHub account, real Neon Postgres, and the
real Anthropic API, 2026-07-30:

```
$ pnpm exec tsx src/pipeline/run.ts --dry-run
run run_...: 66 repos discovered, 66 have no prior assessment

$ pnpm exec tsx src/pipeline/run.ts --limit 3
run run_...: 3 repos ok, 0 repos with fetch errors, 0 enrichment calls made, 3 skipped
# all 3 correctly auto-ignored: no-README/no-activity student-assignment repos

$ pnpm exec tsx src/pipeline/run.ts --limit 12
run run_...: 12 repos ok, 0 repos with fetch errors, 0 enrichment calls made, 12 skipped
# several of these have real commit/issue activity but no README (confirmed
# directly against Postgres row counts) — correctly auto-ignored on that
# basis alone, matching the old stack's historical finding that "no README"
# was the dominant auto-ignore reason across this account
```

To exercise the actual LLM-call path (the first 15 discovered repos happen
to be READMEless student-assignment repos), `enrichAll` was called directly
against `sdpilon/github-project-tracker` (a real repo with a real README and
real commit history already loaded from Phase 1's earlier full run):

- First call: 1 real Anthropic call made, produced a coherent,
  evidence-based assessment citing specific real commit messages and README
  claims (`pct: 80, band: "good"`), inserted into `repo_assessments` with
  `input_snapshot` populated.
- Second call, same inputs: 0 calls made, 1 skipped — content-hash gate
  held, still exactly 1 assessment row.
- Third call, with `repos.assessment_source` manually set to `'manual'`: 0
  calls made, 1 skipped, still exactly 1 assessment row — confirming the new
  manual-override gate works, then reverted back to `'auto'`.

### New stack — Phase 3 (SolidStart frontend): complete

Replaces `tracker.html`'s hand-rolled `innerHTML` templating with real
SolidStart components rendering live Postgres data server-side, per
`docs/superpowers/specs/2026-07-30-phase3-solidstart-frontend-design.md`
and `docs/superpowers/plans/2026-07-30-phase3-solidstart-frontend.md`:

- **`app/src/lib/server-db.ts` + `app/src/lib/dashboard.ts` /
  `dashboard-queries.ts`** — a server-only Postgres singleton and the
  data-shaping layer that reads each repo's latest metadata, activity
  counts, and latest `repo_assessments` row, plus the ignore-toggle write
  path (`toggleIgnore`), ported from `pipeline/server.js`'s
  `POST /api/repos/:repoId/ignore` endpoint but now a SolidStart server
  function instead of a hand-rolled `node:http` route. `ignore_reasons` is
  persisted alongside `is_ignored` (previously computed and rendered
  on-the-fly by `publish.js`) so the UI can show *why* a repo was
  auto-ignored without recomputing it at render time.
- **`app/src/components/{Totals,CollapsibleSection,RepoCard}.tsx`** — port
  of `tracker.html`'s visual structure (repo cards, Commits/PRs/Issues/
  README `<details>` toggles, the Ignore checkbox, totals header) into
  real Solid components instead of one large template-string blob.
- **`app/src/routes/index.tsx`** — the dashboard route itself, wired to
  `getDashboardData` (a SolidStart server query) so the page renders from
  live Postgres on every request — no static-file regeneration step, no
  `inject.js` splice, no risk of README `$`/`$$` sequences corrupting a
  string-splice (that whole gotcha class no longer exists).

### New stack — Phase 4 (Vercel + GitHub Actions deploy, then cutover): complete

- **`app/nitro.config.ts` / Vercel Build Output API target** — the
  SolidStart/Nitro build outputs Vercel's Build Output API format directly,
  so deploys don't need Vercel's own framework auto-detection.
- **`.github/workflows/deploy.yml`** — on every push to `main` touching
  `app/**`: install, typecheck, lint, test, then
  `vercel deploy --prod` using `VERCEL_TOKEN`/`VERCEL_ORG_ID`/
  `VERCEL_PROJECT_ID` repo secrets. Live-verified: deploy succeeded end to
  end after fixing two Vercel project misconfigurations discovered live
  (Root Directory pointed at a build-artifact path, then needed to be
  empty rather than `app` since the workflow already `cd`s into `app/`
  before invoking the Vercel CLI) — production is
  https://github-project-tracker-chi.vercel.app.
- **`.github/workflows/pipeline.yml`** — replaces manually running
  `node pipeline/run.js` locally: runs `pnpm run pipeline`
  (`tsx src/pipeline/run.ts`) on a daily cron plus `workflow_dispatch`,
  against real `DATABASE_URL`/`GITHUB_TOKEN`/`ANTHROPIC_API_KEY` secrets.
  **Naming gotcha, verified as a hard GitHub Actions platform constraint,
  not a style choice:** Actions disallows a repo secret literally named
  `GITHUB_TOKEN` (reserved for the automatic per-run token), but the
  pipeline's Octokit client needs a broad, account-wide PAT (it discovers
  every repo in the account), not the automatic token's repo-scoped one.
  The PAT is stored as `PIPELINE_GH_TOKEN` and mapped into the
  `GITHUB_TOKEN` env var the app code expects via the workflow's `env:`
  block. Also confirmed: a fine-grained PAT needs Contents/Issues/Pull
  requests read access granted explicitly and independently — see the
  Phase 1 gotcha above, which held again here.
- **App-level shared-secret auth (`app/src/middleware.ts` +
  `app/src/lib/auth.ts` + `app/src/lib/auth-guard.ts` +
  `app/src/routes/login.tsx`)** — added after discovering, live, that
  Vercel's native Deployment Protection does **not** cover production
  deployments on the free Hobby plan (only ephemeral preview URLs; a
  rejected API PATCH confirmed "Vercel Authentication is not available on
  your plan for production deployments"). Since this dashboard surfaces AI
  assessments of private repos, the production URL was briefly served with
  zero auth — a real exposure, not theoretical. Fixed with an in-app
  shared-secret cookie gate (`APP_PASSWORD`, a single environment
  variable, compared server-side against a `site_auth` cookie) instead of
  upgrading to a paid Vercel plan. Also closed a gap the initial
  implementation missed: SolidStart's `action()`/`query()` functions all
  POST through a shared `/_server` RPC endpoint regardless of which page
  called them, so page-level middleware alone doesn't stop a direct
  unauthenticated POST to `/_server` from reaching `getDashboardData`/
  `toggleIgnore` — closed via `assertAuthenticated()` inside those
  functions themselves (defense in depth at the RPC layer, not just the
  page layer).
- **Live verification (2026-08-02):** unauthenticated `/` correctly
  302-redirects to `/login`; the real `APP_PASSWORD` cookie yields real
  content; the production dashboard renders the full account (66 repos, 54
  private) matching local dev exactly; `pipeline.yml` triggered manually
  via `workflow_dispatch` completed in 4m52s ("65 repos ok, 1 repo with
  fetch errors, 21 enrichment calls made, 45 skipped") with the live
  dashboard's repo/private counts matching that run's output exactly,
  confirming the schedule-refreshes-Postgres/dashboard-reads-live-at-
  request-time model works without a redeploy.
- **Cutover (this task):** `pipeline/`, `tracker.html`, `schema.sql`,
  `inject.js`, `repos.json`, `scripts/doctor.sh`, and the local
  `tracker.duckdb` file are deleted; root `package.json`/
  `pnpm-workspace.yaml`/`biome.json` no longer reference them; `CLAUDE.md`/
  `AGENTS.md`/`README.md`/`ROADMAP.md` rewritten to describe the current
  stack only.

### Old stack (DuckDB) — status as of the rewrite starting

**Stage 0 (a thin vertical slice) is implemented in `pipeline/`**, run
end-to-end for a hardcoded 2-repo scope: Extract → Load → Enrich → Publish,
with DuckDB-backed watermarking, idempotent upserts, content-hash-gated
enrichment, and dead-letter failure isolation all proven out. See
`docs/superpowers/plans/2026-07-22-stage-0-vertical-slice.md` for what was
built and why (thinnest end-to-end slice first, Discovery deliberately
last since it's the easiest stage in isolation).

**Discovery is implemented as a standalone module** (and, as of this
section's next paragraph, also wired into `run.js`'s `main()`).
`pipeline/discover.js` calls `gh api user/repos` (paginated, `affiliation=owner`),
upserts every returned repo into `repos`, appends one row per repo to
`repo_discoveries`, and writes a `runs` row with real counts (via
`run.js`'s `recordRunStart`/`recordRunFinish`, not the hardcoded config
length). A bad repo or a mid-pagination API failure is isolated per-repo
(recorded as a result, not a thrown exception that drops the whole batch) —
same failure-isolation shape as `extract.js`.

It's runnable on its own (`pnpm pipeline:discover`). Live-verified against
the real account, run twice back to back:

```
$ node pipeline/discover.js
discover run_2026-07-24T11-19-53-533Z: 65 repos discovered (3 forks, 2 archived), 65 recorded ok, 0 failed
$ node pipeline/discover.js
discover run_2026-07-24T11-19-54-449Z: 65 repos discovered (3 forks, 2 archived), 65 recorded ok, 0 failed
```

and confirmed in `tracker.duckdb` directly — `repo_discoveries` has 65 rows
per run_id (append-only, not overwritten) and `runs` has a matching row per
run_id (`status: 'success', repos_discovered: 65, repos_fetched_ok: 65,
repos_failed: 0`), rather than a dangling `run_id` with no `runs` entry.

Both CLI entry points remain intentional — `pnpm pipeline:discover` (this
module's own fork/archived-count + full-listing output) and `pnpm pipeline`
/`--dry-run` (discovery folded into the pipeline's own "N unassessed"
preview) serve genuinely different purposes and both stay. What's shared
between them is only the open→ensureSchema→runId→discoverRepos scaffolding,
now factored into `discover.js`'s exported `runDiscoveryScaffold({dbPath,
ghApiJson})`, which both this module's own `main()` and `run.js`'s `main()`
call before layering their own distinct summary-printing (and, for `run.js`,
recordRunStart/recordRunFinish placement and the rest of the pipeline) on
top — so the two `main()` functions no longer hand-roll the same four calls
in parallel.

**Discovery is now wired into `run.js`'s `main()`.** `pipeline/config.js`'s
`REPOS` constant is deleted (`grep -rn "REPOS" pipeline/` returns nothing);
`main()` calls `discoverRepos()` and extracts/loads/enriches/publishes the
full discovered set, with no filter policy applied (everything `gh`
returns — forks and archived repos included). Two new `run.js` flags
support this: `--dry-run` (reports scope and how many repos have no prior
assessment; runs a real discovery — writes `repos`/`repo_discoveries`/`runs`
— but no extraction, load, enrichment, publish, or `repos.json`/
`tracker.html` writes) and `--limit N` (restricts a real run to the
first N discovered repos; discovery itself is never restricted by `--limit`
— `repos`/`repo_discoveries` always reflect the full account).

Live-verified against the real account (2026-07-24):

```
$ node pipeline/run.js --dry-run
65 repos discovered, 63 with no prior assessment

$ node pipeline/run.js            # first full run
65 discovered, 28 fetched ok, 37 fetch errors (mostly repos with no
README, a 404 on GitHub's readme endpoint, handled as an expected
per-datatype failure; one "Git Repository is empty" 409, same handling),
60 enrichment calls made, 5 skipped (already had a prior assessment)

$ node pipeline/run.js            # same command, run again immediately
65 discovered, same 28 ok / 37 fetch errors, 0 enrichment calls made,
65 skipped — confirms the content-hash gate: nothing changed between the
two runs, so nothing was re-assessed
```

`runs.repos_discovered` was 65 on both full runs, confirming discovery
scope is independent of `--limit`. `repos.json` now has 65 entries (was 2);
`tracker.html`'s injected `DATA` block was verified to parse as valid JSON
with 65 entries.

**Done since this slice was written:** the `prs` data type, and wiring
`repo_assessments` into `tracker.html`. The wiring turned out not to need a
second `inject.js` splice marker — `pipeline/publish.js`'s `buildRepoRecord()`
includes each repo's latest `repo_assessments` row as an `assessment` field
inside the existing `DATA` payload, and `tracker.html`'s render code falls
back to it (`ASSESS[r.name] || r.assessment || {...}`) only when there's no
hand-authored `ASSESS` entry for that repo. `generateAssessment()` in
`pipeline/enrich.js` now makes a real Anthropic API call (`claude-opus-4-8`,
adaptive thinking, structured JSON output via
`output_config: { format: { type: "json_schema" } }` matching
`repo_assessments`'/`publish.js`'s existing shape —
`pct`/`band`/`label`/`text`/`gaps`) instead of the old hardcoded 50%/
"unknown" stub. The client is a plain parameter threaded into `enrichRepo()`
(constructed once in `run.js`'s `main()` via `new Anthropic()`, which picks
up `ANTHROPIC_API_KEY` from the environment implicitly) — no SDK-specific
injection framework, just duck-typing `messages.create`, so
`pipeline/enrich.test.js` exercises the real assessment logic offline
against a stub client instead of hitting the API. `run.js`'s enrich loop
wraps each repo's `readEnrichInputs` + `enrichRepo` call in its own
try/catch: one repo's assessment failure is logged and counted as skipped,
not thrown, so it doesn't abort the run for the rest of the account.
`readEnrichInputs` also now pulls issue state and PR title/state straight
from `issues`/`pull_requests` in DuckDB (not just bronze commit messages
and issue titles), and `computeInputHash` covers those same fields, so the
content-hash gate re-triggers when a PR or issue's state changes even if no
new commit or title text did. The hand-authored `ASSESS` entries still take
precedence wherever they exist — `generateAssessment()` going live doesn't
retire `/update-tracker`, it means an unmodified repo now gets a real
machine-generated assessment instead of the old placeholder.

**Publish writes directly to the production dataset — deliberately.**
`pipeline/publish.js` writes directly to `repos.json` and shells out to
`inject.js`, so `node pipeline/run.js` (or `pnpm pipeline`) overwrites the
checked-in `tracker.html` for real. This was previously logged here as a
bug, since `pipeline/config.js` only scoped 2 repos and an early run
truncated the other 7 repos' data (recovered via
`git checkout -- repos.json tracker.html`, since nothing had been
committed). It's now treated as accepted behavior instead: `pipeline/` is
the real project (see `ROADMAP.md`'s "Done" section). Now that Discovery is
wired in and the 2-repo scope is gone, `pnpm pipeline` publishes the full
discovered account instead of collapsing coverage down to it.

**`fetch.sh` has been retired.** `pipeline/run.js` is now the only pipeline
that produces `repos.json` / `tracker.html` — proven end-to-end (Extract →
Load → Enrich → Publish) by the live-verified runs above. The one gap that
would have made retirement a regression — `pipeline/publish.js` hardcoding
`readme: ""` while `fetch.sh` fetched real README text — is fixed:
`buildRepoRecord()` now reads the real README text out of that run's bronze
copy (`readBronzeJson(bronzeDir, runId, repoId, "readme")`, exported from
`extract.js` alongside its `writeBronze()` counterpart), threaded through
from `run.js`'s already-in-scope `runId`/`BRONZE_DIR`. `package.json`'s
`build` script now runs `node pipeline/run.js` directly; there's no
remaining `fetch.sh` path to fall back to.

**`tracker.html` has its first live write path.** Each repo card has an
"Ignore" checkbox that `fetch()`-POSTs to a new `pipeline/server.js` — a
plain `node:http` static file server plus one JSON endpoint
(`POST /api/repos/:repoId/ignore`), replacing `serve .` as `pnpm dev`. The
endpoint writes straight to a new `repos.is_ignored` column in
`tracker.duckdb`; `pipeline/run.js`'s enrichment loop reads it back via
`getIgnoredRepoIds()` (`pipeline/db.js`) and skips `enrichRepo()` for
ignored repos, so the next pipeline run stops re-assessing them (the repo
still appears on the dashboard with its normal activity — just no
assessment). `pipeline/load.js`'s `upsertRepo()` preserves `is_ignored`
across `INSERT OR REPLACE` the same way it already preserved
`first_seen_at`. Since `schema.sql` changes don't retrofit an existing
DuckDB file (see `CLAUDE.md`'s Gotcha section), this required a one-time
manual `ALTER TABLE repos ADD COLUMN is_ignored BOOLEAN DEFAULT false`
against the live `tracker.duckdb`, run once before any of the above code
landed. This is the project's first server-side write path — previously
everything was one-directional (pipeline → DuckDB → `repos.json` → static
`tracker.html`).

## Closing note

Everything in this "Old stack (DuckDB)" subsection describes code that no
longer exists in this repo as of Phase 4's cutover (see "Original design
(retired)" at the top of this document and the Phase 4 write-up above) —
kept here only as the historical record of how Stage 0 was actually built,
not as documentation of anything currently runnable. The rewrite that
started 2026-07-29 is done: `app/` is the whole project now, deployed live
on Vercel with a scheduled GitHub Actions pipeline keeping its Postgres
data fresh. `CLAUDE.md` has the current-stack orientation for day-to-day
work; `ROADMAP.md` has whatever's next.
