# Architecture: incremental multi-repo tracker pipeline

This is the design for evolving the tracker from a hardcoded 9-repo,
full-refetch-every-time script into a pipeline that can run against a full
GitHub account (~60 repos) incrementally. A first vertical slice (Stage 0)
is implemented in `pipeline/` — see the "Status" section below for exactly
what that covers. `fetch.sh` / `inject.js` is the pipeline you should run
to safely refresh the checked-in dashboard. **`pipeline/run.js` already
writes to the same `repos.json` / `tracker.html`** (its Publish stage calls
the same `inject.js`), but only for its hardcoded 2-repo scope — running it
against the real repo overwrites the full dataset down to just those 2
repos. This isn't a deliberate cutover gate, it's an unfixed bug; see
"Status" below.

## Why

The current pipeline (`fetch.sh`) has a few properties that don't scale
past a small, manually-curated repo list:

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

**Not yet implemented:** Discovery (the repo list is still a hardcoded array
in `pipeline/config.js`, same as `fetch.sh`'s today), the `prs` data type,
wiring `repo_assessments` into `tracker.html` (would require extending
`inject.js`'s splice markers to a second marker pair), and widening from 2
repos to the full ~60-repo account.

**Known bug — Publish is not actually isolated from production.**
`pipeline/publish.js` writes directly to `repos.json` and shells out to the
same `inject.js` used by `fetch.sh`, so `node pipeline/run.js` (or
`pnpm pipeline`) overwrites the checked-in `tracker.html` for real. Because
`pipeline/config.js` only scopes 2 repos, this silently truncates the other
7 repos' data rather than merging with or safely coexisting alongside it.
Confirmed by actually running it against the real repo and observing
`repos.json`/`tracker.html` collapse to the 2-repo scope (recovered via
`git checkout -- repos.json tracker.html`, since nothing had been
committed). Until this is fixed — most simply, by having `publish()` write
to a separate file when scoped to fewer than the full repo set, or by not
calling `inject.js` until Discovery + widening land — treat `pnpm pipeline`
/ `node pipeline/run.js` as unsafe to run without reverting `repos.json`
and `tracker.html` afterward.

**`fetch.sh` → `node inject.js` → `tracker.html` is still the pipeline you
should use to actually refresh the dashboard.** Stage 0's `pipeline/` is
proven out end-to-end (Extract → Load → Enrich all work, confirmed by a
live run producing real rows in `tracker.duckdb`), but its Publish stage
reaching into the same production files it's supposed to be isolated from
means it isn't a safe parallel path yet, let alone a replacement.
