# github-project-tracker

A dashboard summarizing recent activity across your full GitHub account — discovered automatically, not a hardcoded list — plus an AI-written "stated goals vs. reality" assessment for each repo.

This is a live, deployed personal tool: production is https://github-project-tracker-chi.vercel.app, gated behind an app-level password. There's no local build step that produces a static file to view — the dashboard (`app/`, a SolidStart app) renders live from Postgres on every request, and its data is kept fresh by a scheduled GitHub Actions pipeline, not a manually-run local script.

## How it works

- **`app/`** — the SolidStart + Drizzle + Postgres (Neon) + Octokit dashboard. Deployed to Vercel via `.github/workflows/deploy.yml` on every push to `main` that touches `app/**` (install → typecheck → lint → test → `vercel deploy --prod`).
- **`app/src/pipeline/`** — discovers every repo in the account via Octokit, fetches readme/issues/PRs/commits/metadata for each, upserts into Postgres, and runs a content-hash-gated AI assessment (only re-calling the LLM when a repo's inputs actually changed). Runs via `.github/workflows/pipeline.yml` on a daily schedule (plus manual `workflow_dispatch`).
- Each repo card has an **Ignore** checkbox, persisted straight to Postgres, so future pipeline runs skip generating an assessment for that repo. Ignore defaults are computed automatically (forks, archived repos, no-README repos, and no-activity repos default to ignored) but any manual toggle always wins on future runs.

## Running locally

```bash
cd app
pnpm install
pnpm dev
```

`app/package.json`'s `dev`/`start` scripts wrap the underlying command in `op run --environment <id> -- ...`, pulling secrets (`DATABASE_URL`, `APP_PASSWORD`, etc.) from a 1Password Environment. `app/` is its own isolated pnpm workspace, independent of this repo root.

Other useful commands, run from inside `app/`:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm run pipeline   # tsx src/pipeline/run.ts — the same script the scheduled GitHub Actions workflow runs
```

Pipeline flags: `--dry-run` (preview scope, no writes) and `--limit N` (restrict a real run to the first N discovered repos).

## Project layout

- `app/` — the whole live project: SolidStart dashboard, Drizzle/Postgres schema, and the discover/extract/enrich pipeline (`app/src/pipeline/`)
- `.github/workflows/deploy.yml` — CI + Vercel deploy on push to `main`
- `.github/workflows/pipeline.yml` — scheduled pipeline run
- `ARCHITECTURE.md` — design and full build history, including the retired original DuckDB-based design this project replaced
- `ROADMAP.md` — sequencing notes for what's next
- `CLAUDE.md` — detailed contributor/agent notes (gotchas, auth model, etc.)

This is a personal tool built partly as a learning exercise in incremental data-pipeline and full-stack app design — expect more architectural rigor than the dashboard's actual needs strictly require.
