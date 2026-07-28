# Architecture: incremental multi-repo tracker pipeline

This is the design for evolving the tracker from a hardcoded 9-repo,
full-refetch-every-time script into a pipeline that can run against a full
GitHub account (~60 repos) incrementally. A first vertical slice (Stage 0)
is implemented in `pipeline/` — see the "Status" section below for exactly
what that covers. **`pipeline/run.js`'s `main()` now runs Discovery against
the real account and writes to the same `repos.json` / `tracker.html`**
(its Publish stage calls the same `inject.js`) — see "Status" below for the
live-verified counts. `fetch.sh` has been retired: `pipeline/` is now the
only path that produces `repos.json` / `tracker.html`.

## Why

The original pipeline (`fetch.sh`, now retired) had a few properties that
don't scale past a small, manually-curated repo list:

- The repo list is hardcoded in `fetch.sh` and has to be edited by hand as
  projects come and go.
- Every run refetches everything from a single global `$SINCE` cutoff —
  there's no per-repo memory of what's already been fetched.
- API failures silently fall back to empty (`valid()` swaps bad JSON for
  `[]`/`{}`), so a broken repo just goes blank in the dashboard instead of
  surfacing as an error.
- The AI "stated goals vs. reality" assessment is hand-authored per repo
  (`ASSESS` block in `tracker.html`), not something the pipeline generates
  or refreshes on its own.
- There's no persistence beyond flat JSON files that get overwritten each
  run — no history, no run metadata, nothing to inspect after the fact.

This is a personal-use project (one GitHub account, no multi-tenancy), but
the goal is to build it the way a real data pipeline would be built, as a
learning exercise. The focus is specifically the **data/product axis**:
learning pipeline design patterns that hold up as repo count grows, not
ops/infra concerns and not AI-engineering concerns.

## Scale target

~60 repos (the user's actual GitHub account), up from the current 9.
At roughly 4 API calls per repo per run, that's ~240 requests — well under
GitHub's 5,000/hour REST rate limit. **Rate limiting is explicitly not the
bottleneck being designed around.** Patterns like GraphQL batching or
aggressive concurrency/backoff were considered and deliberately parked —
they solve a rate-limit problem that doesn't exist at this scale, and
adding them now would be complexity for the sake of feeling scalable
rather than complexity the problem actually demands.

## Architecture overview

Five pipeline stages, each isolated so a failure in one repo or stage
doesn't take down the rest of the run:

1. **Discovery** — replaces the hardcoded `repos=` list. Calls
   `gh api /user/repos --paginate` to enumerate the account's repos each
   run. Every repo seen is logged to `repo_discoveries` (append-only), and
   `repos` (the dimension table) is upserted so renames/archival/new repos
   are tracked over time instead of requiring a manual edit.

2. **Extract (bronze)** — pulls raw API responses (readme, issues, PRs,
   commits, meta) per repo, per run, and writes them to disk as immutable
   flat JSON files keyed by `(repo_id, run_id)`. This layer is intentionally
   *not* in DuckDB — it's the raw, replayable source of truth. If a
   downstream bug is found, silver/gold can be rebuilt from bronze without
   re-hitting the GitHub API.

   Extraction is **incremental**, driven by a per-repo, per-datatype
   watermark (`fetch_watermarks`) instead of a single global `$SINCE`. Each
   repo's `commits`/`issues`/`prs` fetch uses its own `last_fetched_at` as
   the `since=` cursor, and only advances the watermark on success.

   Failures are isolated per repo/datatype: instead of silently falling
   back to `[]`, a failure is written to `fetch_failures` (a dead-letter
   manifest) and that repo's existing data is left untouched rather than
   zeroed out. One broken repo no longer degrades the whole dashboard.

3. **Load (silver)** — normalizes bronze JSON into DuckDB tables
   (`commits`, `issues`, `pull_requests`), upserted idempotently by natural
   key (`repo_id` + `sha`/`number`). Replaying a run doesn't duplicate rows.

4. **Enrich (AI assessment)** — replaces the hand-authored `ASSESS` block
   with a generated one, but avoids re-running the LLM on every repo every
   run. Each repo's silver-layer inputs (readme + recent activity) are
   hashed into `input_hash`; enrichment only calls the LLM when that hash
   changes since the last assessment. This is the same pattern as a dbt
   incremental model, applied to an LLM call instead of a SQL transform.
   Results are appended to `repo_assessments` (never overwritten), so
   assessment history is preserved and "current" is just the latest row
   per repo.

5. **Publish (gold)** — the existing `inject.js` step, reading current
   state out of DuckDB (latest repo metadata, activity, and assessment per
   repo) instead of `repos.json`, and splicing it into `tracker.html` the
   same way it does today (see the slice-based splicing gotcha below —
   that constraint doesn't change).

Every run is recorded in `runs`: start/end time, repos discovered, repos
fetched OK vs. failed, and LLM calls made vs. skipped. The
`llm_calls_skipped` count is the concrete signal that the incremental
enrichment gate is actually working, not just hoped to be working.

## Storage design

DuckDB is the storage engine for silver/gold/metadata — chosen
specifically to practice the medallion + incremental-load pattern without
taking on a hosted database's operational burden, which isn't the point of
this exercise for a single-user tool. Bronze stays as flat files on disk,
outside DuckDB, so "replay from raw" stays trivial.

Full DDL: see [`schema.sql`](schema.sql). Key design choices:

- **`repo_id` (GitHub's numeric id) is the primary key everywhere**, not
  `full_name`. A rename or ownership transfer changes `full_name` but not
  `repo_id` — keying on the stable id keeps a repo's history from
  fracturing into two identities across a rename.
- **`fetch_watermarks` is keyed per `(repo_id, data_type)`**, not one
  watermark per repo, because GitHub's `since=` semantics differ slightly
  across the commits/issues/PRs endpoints.
- **`repo_assessments` is append-only.** There's no "current assessment"
  column to update in place — "current" is defined as the latest row per
  `repo_id` by `created_at`. Slightly more work to query, but it comes for
  free with a full history of how each repo's assessment has evolved.
- **`fetch_failures` is a dead-letter manifest, not a log line.** It's a
  queryable table specifically so "which repos are currently degraded" is
  a first-class question the pipeline can answer, rather than something
  buried in run output.

## Explicitly out of scope (for now)

- GraphQL batching of API calls — solves a rate-limit problem that doesn't
  exist at 60 repos.
- Concurrency/backoff tuning — same reasoning; premature for this scale.
- Multi-tenancy / multi-user support — this is a personal tool built to
  practice patterns, not a product with other users.
- Any change to the existing `inject.js` splicing mechanism itself (the
  slice-based string splicing that avoids `$`/`$$`-sequence corruption from
  README content) — the publish stage's *data source* changes, not that
  mechanism.

## Status

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
