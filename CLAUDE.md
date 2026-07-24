# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, single-file dashboard (`tracker.html`) summarizing recent activity across a hardcoded list of GitHub repos, plus an AI-written "stated goals vs. reality" assessment for each repo.

## Pipeline

1. `./fetch.sh` — pulls readme/issues/prs/commits/meta for each repo in the `repos=` list via `gh api`, writes `parts_NN.json` per repo, then combines them into `repos.json`. Requires `gh` authenticated.
2. `node inject.js` — splices `repos.json` into `tracker.html`'s `const DATA = ...` block.
3. Open `tracker.html` in a browser to view.

The repo list in `fetch.sh` (the `repos=` variable) changes often as projects come and go — check whether it's still current before running a refresh.

## The ASSESS block

`tracker.html` also contains a hand-authored `const ASSESS = {...}` object, one entry per repo (`pct`, `band`, `label`, `text`, `gaps`). This is a qualitative assessment — written by reading each repo's README against its actual commits/PRs/issues — not derived data. It is maintained via the `/update-tracker` skill, not written by hand.

## Gotcha

`inject.js` splices `repos.json` into `tracker.html` using slice-based string splicing, not `String.replace()` — README content can contain `$'`/`$$` sequences that `replace()` would interpret as substitution patterns and corrupt.

## Future direction

The pipeline above is the current, working baseline for a small hardcoded repo list. `ARCHITECTURE.md` and `schema.sql` describe a redesign to scale this to a full GitHub account (~60 repos): repo discovery instead of a hardcoded list, a bronze/silver/gold DuckDB-backed storage layer, incremental per-repo watermarked extraction, content-hash-gated AI re-assessment, and per-repo failure isolation. `ROADMAP.md` tracks sequencing (what's next vs. later) for that redesign.

A first vertical slice of that redesign (Stage 0) is implemented in `pipeline/` — Extract → Load → Enrich → Publish. Discovery (`pipeline/discover.js`) is now wired into `run.js`'s `main()`: a real run enumerates the full GitHub account via `gh api /user/repos` and extracts/loads/enriches/publishes every repo it finds, with no filter policy applied (forks and archived repos included). `pipeline/config.js` no longer has a hardcoded `REPOS` scope. Live-verified against the real account: 65 repos discovered, 28 fetched ok (37 fetch errors, overwhelmingly repos with no README), 60 enrichment calls made on the first run and 0 on an immediate second run (content-hash gate confirmed working). `run.js` also has `--dry-run` (report scope, zero side effects) and `--limit N` (restrict a real run to the first N discovered repos) flags.

**`pipeline/` is now the real project, not an isolated experiment.** `pipeline/publish.js` writes straight to the same `repos.json` and shells out to the same `inject.js` that `fetch.sh` uses, overwriting the checked-in `tracker.html` too — and that's intentional now, not a bug to guard against (see `ROADMAP.md`'s "Done" section for when/why this was decided). Running `node pipeline/run.js` (or `pnpm pipeline`) for real now publishes the full discovered account — the earlier caveat about it collapsing the dashboard down to a hardcoded 2-repo scope no longer applies. Consult `ARCHITECTURE.md`'s "Status" section and `docs/superpowers/plans/` before assuming how much of the redesign exists.

## Keeping docs in sync

Before finishing any `pipeline/`-related branch, check whether `ARCHITECTURE.md`'s "Status" section and this file's "Future direction" section above still accurately describe what's implemented vs. not. Update them in the same branch if they don't — see `docs/postmortems/2026-07-22-stage-0-vertical-slice.md` for why this is called out explicitly rather than left to be remembered.

## Verifying pipeline changes

Run `./scripts/doctor.sh` before trusting a fresh checkout or a fresh `pnpm install` — it catches the environment issues (corrupted lockfile, unbuilt DuckDB binding, sandboxed network masquerading as an auth failure, a `test` script that silently discovers 0 files) that cost real time on Stage 0. See the same postmortem for details.

Any task that wires previously-independent, already-tested `pipeline/` modules together into an orchestrator (extract→load→enrich→publish, or any future stage) needs a live end-to-end verification step against real external data, not just unit tests of the pieces — Stage 0's most severe bug (the content-hash gate never actually skipping) passed all 28 unit tests and was only caught by running the orchestrator twice against real GitHub repos.
