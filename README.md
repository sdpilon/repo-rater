# github-project-tracker

A single-file dashboard (`tracker.html`) summarizing recent activity across your full GitHub account — discovered automatically, not a hardcoded list — plus an AI-written "stated goals vs. reality" assessment for each repo.

Mostly static (data is baked in at build time), except for one live control: each repo card has an **Ignore** checkbox that persists to a local DuckDB store via `pipeline/server.js`, so future pipeline runs skip generating an assessment for that repo. Ignore defaults are computed automatically (forks, archived repos, no-README repos, and no-activity repos default to ignored) but any manual toggle always wins on future runs.

## Requirements

- Node.js
- [`gh`](https://cli.github.com/) CLI, authenticated (`gh auth login`)
- An `ANTHROPIC_API_KEY` for the AI assessment step

## Usage

Build/refresh the dashboard:

```
pnpm pipeline        # or: node pipeline/run.js
```

This discovers every repo in your account via `gh api /user/repos`, then for each one: pulls README/issues/PRs/commits/metadata, upserts into DuckDB, runs a content-hash-gated AI assessment (skipping repos marked ignored), and writes `repos.json` + splices it into `tracker.html`.

Useful flags:
- `--dry-run` — preview scope, no writes
- `--limit N` — restrict a real run to the first N discovered repos

Serve the dashboard (needed for the Ignore toggle to persist; opening `tracker.html` directly as a `file://` URL works for viewing only):

```
pnpm dev             # serves http://localhost:3000/tracker
```

**Note:** DuckDB is single-writer per file — don't run `pnpm pipeline` and `pnpm dev` at the same time.

## Project layout

- `pipeline/` — Extract → Load → Enrich → Publish pipeline that produces `repos.json`/`tracker.html`
- `tracker.html` — the dashboard itself (checked in, overwritten by each pipeline run)
- `ARCHITECTURE.md` / `ROADMAP.md` — design and sequencing notes for the ongoing pipeline redesign
- `CLAUDE.md` — detailed contributor/agent notes (gotchas, schema-migration caveats, etc.)

This is a personal tool built partly as a learning exercise for a from-scratch DuckDB/medallion-style pipeline design — expect the pipeline architecture to be more involved than the dashboard's actual needs strictly require.
