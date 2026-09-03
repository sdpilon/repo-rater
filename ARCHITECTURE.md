# Architecture

This document describes the internal design of `repo-rater`: how
data flows through the system and why it's shaped the way it is. For how to
install, configure, and run the app, see `README.md`.

## Overview

The system has two independent parts that share one Postgres database:

- **The app** — a SolidStart server that renders the dashboard from Postgres
  on every request. It has no build-time data dependency and does no writing
  of its own beyond the Assess control and credential settings.
- **The pipeline** (`src/pipeline/`) — a CLI script that discovers every repo
  in a GitHub account, fetches its activity, and writes an AI-generated
  progress assessment into Postgres. It's the only thing that populates or
  refreshes the data the app displays.

They never call each other directly and don't need to run on the same
machine or schedule — the pipeline just needs write access to the same
database the app reads from.

## Data model

Everything lives in Postgres, defined in `src/db/schema.ts` (Drizzle ORM).
A few shapes are worth calling out because they encode real behavior, not
just storage:

- **`repos`** is the one row per tracked repo. `is_ignored` isn't a plain
  boolean the pipeline sets once — it's recomputed on every run from
  `ignore_reasons` (see "Ignore rules" below) unless `ignore_source` is
  `'manual'`, in which case it's frozen at whatever the Assess control last
  set. `assessment_source` follows the same `'auto'` / `'manual'` pattern
  for whether a repo gets re-assessed automatically.
- **`commits`, `issues`, `pull_requests`** are keyed by `(repo_id, sha)` /
  `(repo_id, number)` and upserted every run. Each row also carries the
  run ID that first ingested it (or last updated it), useful for tracing a
  row back to when it entered the database.
- **`fetch_watermarks`** stores one `last_fetched_at` per `(repo_id,
  data_type)`, advanced to the run's start time — not the newest event time
  in the fetched data — after a successful fetch. That's what makes each
  pipeline run incremental: it only asks GitHub for activity since the last
  successful fetch of that data type for that repo, rather than the whole
  history every time. `fetch_failures` logs failures the same way, so a
  data type that failed doesn't silently advance its watermark and skip
  data on the next run.
- **`repo_assessments`** is append-only — a new assessment is always
  inserted, never updated in place. "The current assessment" for a repo is
  just its latest row by `created_at`. Each row also stores `input_hash`
  (see "Pipeline stages" below) and `input_snapshot`, a raw copy of
  whatever was sent to the LLM, kept for debugging since there's no other
  layer where that input is retained.
- **`runs`** is one row per pipeline invocation: start/finish time, status,
  and counts (repos discovered/fetched/failed, LLM calls made/skipped) —
  useful for spotting a run that silently degraded (e.g. `reposFailed > 0`)
  without re-reading logs.

## Pipeline stages

`src/pipeline/run.ts` runs three stages in sequence for every invocation:
**discover → extract+load → enrich**. Each stage isolates failures at the
narrowest level that makes sense, so one repo (or one data type within a
repo) having a bad run never aborts the rest:

1. **Discover** (`discover.ts`) — lists every repo in the account via
   Octokit and upserts its metadata into `repos`. Fields like
   `first_seen_at`, `is_ignored`, and `ignore_source` are deliberately left
   out of the upsert's `SET` clause so an existing repo's state survives
   being re-discovered; only genuinely new repos get default values.
2. **Extract + load** (`extract-load.ts`) — for each discovered repo, fetches
   commits/issues/PRs since that data type's last watermark and upserts
   them. Each of the three data types has its own try/catch: a failure
   fetching issues, say, is recorded in `fetch_failures` and that data
   type's watermark isn't advanced, but commits and PRs for the same repo
   still proceed normally.
3. **Enrich** (`enrich.ts`) — for each repo not ignored and not on a manual
   assessment override, hashes its current README + commit messages + issue/
   PR titles and states into `input_hash`, and only calls the Anthropic API
   if that hash differs from the repo's latest stored assessment. This is
   what keeps a re-run cheap: a repo with no new activity produces the same
   hash and is skipped entirely, no LLM call and no new database row.

There's no separate "publish" stage — the app reads `repos` and
`repo_assessments` directly at request time, so there's nothing to
regenerate or invalidate after enrichment finishes.

## Ignore rules

Whether a repo gets assessed is governed by `ignore_source`, not just
`is_ignored` directly:

- **`'auto'`** (the default) — `is_ignored` is recomputed every pipeline run
  by `computeSuggestedIgnore()` (`ignore-rules.ts`): a fork, an archived
  repo, a repo with no README, or a repo with zero commits/issues/PRs is
  ignored; anything else isn't. The specific reasons are persisted to
  `ignore_reasons` so the dashboard can show why.
- **`'manual'`** — set the moment someone uses the dashboard's Assess
  Yes/No control. Once manual, the automatic recomputation above is
  skipped entirely for that repo (both the `is_ignored` recompute and, for
  a separate `assessment_source === 'manual'` override, the enrichment
  step itself) until it's switched back to Auto.

This recomputation happens inside `enrichAll` (`enrich.ts`), not as a
separate pass — a repo's README has to be fetched for the ignore check
either way, so folding it into the same per-repo loop that does enrichment
avoids fetching it twice.

## Credentials & auth

**Credential resolution** (`config.ts`) is one function,
`resolveConfig(key)`, used identically by the app and the pipeline: an
environment variable wins if set; otherwise it falls back to a local JSON
file (`./data/config.json` by default). The dashboard's Settings panel
writes to that same file, so a credential can come from either source
interchangeably — e.g. `DATABASE_URL` from the environment and the GitHub
token typed into the UI. Before a credential typed into the UI is
persisted, it's checked against the real service it's for (`SELECT 1` for
the database, `users.getAuthenticated` for the GitHub token, `models.list`
for the Anthropic key) so an invalid value is rejected immediately instead
of silently written and failing later. For `DATABASE_URL` specifically,
that same connection also applies any pending Drizzle migrations
(`settings-queries.ts`) right after the `SELECT 1` succeeds — idempotent,
so a self-hoster pasting in a brand-new Postgres gets its schema applied
at save time rather than hitting a missing-table error on first render.
The same idempotent migration also runs from `server-db.ts`'s `getDb()`,
the app's lazy request-time DB client — so a `DATABASE_URL` set purely via
environment variable (the Docker/container path, which never touches the
Settings UI) gets its schema applied on first request too. A
credential resolving from an
environment variable shows as read-only in the UI, since saving through
the form there would write the file but the app would keep using the
unchanged environment variable regardless.

**Auth** is a single shared-secret cookie (`APP_PASSWORD`), appropriate
for a single-user personal tool — no hashing, no session store, no
accounts. It's unset by default (no login gate at all, e.g. behind
Tailscale). It's enforced twice, deliberately: `middleware.ts` redirects
any unauthenticated request to `/login`, but SolidStart's `action()`/
`query()` calls all POST through one shared `/_server` RPC endpoint
regardless of which page invoked them — so `getDashboardData` and
`toggleAssess` (`dashboard.ts`) also call `assertAuthenticated()` directly,
as a second gate at the RPC layer that doesn't depend on which route the
request claims to be for.

**`DEMO_MODE`** is a third behavior-gating env var alongside
`DATABASE_URL`/`APP_PASSWORD` (`demo-mode.ts`) — when set to `"true"`,
`toggleAssess` is rejected server-side and the UI disables the Assess
control, so the public demo site's shared database can't be mutated by
visitors.
