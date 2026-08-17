# github-project-tracker

A dashboard summarizing recent activity across your full GitHub account — discovered automatically, not a hardcoded list — plus an AI-written "stated goals vs. reality" assessment for each repo.

The dashboard renders live from Postgres on every request (no static-file build step); its data is kept fresh by a scheduled pipeline, not a manually-run local script. The maintainer's own instance runs at https://github-project-tracker-chi.vercel.app, gated behind an app-level password — but the app itself is a bring-your-own-credentials, single-tenant tool: point it at your own Postgres database, GitHub personal access token, and Anthropic API key, and it tracks your account instead.

## How it works

- **The dashboard** — a SolidStart + Drizzle + Postgres + Octokit app.
- **`src/pipeline/`** — discovers every repo in the account via Octokit, fetches readme/issues/PRs/commits/metadata for each, upserts into Postgres, and runs a content-hash-gated AI assessment (only re-calling the LLM when a repo's inputs actually changed).
- Each repo card has an **Auto/Yes/No ignore control**, persisted straight to Postgres, so future pipeline runs skip generating an assessment for ignored repos. Ignore defaults are computed automatically (forks, archived repos, no-README repos, and no-activity repos default to ignored) — "Auto" hands a repo back to that automatic recomputation, "Yes"/"No" force it either way.
- **Credentials are optional and independently settable**, not one blocking setup wizard: a fresh instance with no database configured shows a credentials-only screen; once a database is connected, the dashboard renders (empty, until GitHub/Anthropic credentials let the pipeline populate it) plus a Settings panel for adding or updating the GitHub token and Anthropic key at any time. Every credential is validated against the real service (a live DB query, an authenticated GitHub API call, a minimal Anthropic API call) before being saved — a bad value is rejected immediately, nothing invalid gets persisted.
- **Config resolution is env-var-first, config-file-fallback.** For each of `DATABASE_URL`, `PIPELINE_GH_TOKEN`, `ANTHROPIC_API_KEY`, and `APP_PASSWORD`: an environment variable wins if set; otherwise the app falls back to a local JSON file (`./data/config.json` by default, `CONFIG_FILE_PATH`-overridable, `0600`-permissioned, gitignored) written by the Settings UI. Set env vars for a Docker Compose / systemd style deployment, or leave them unset and configure everything through the browser — both work, and they compose (e.g. env-var DB connection + UI-entered API keys). A credential that resolves from an env var is shown as read-only in the UI, since a value saved there would be silently shadowed.
- **`APP_PASSWORD` is genuinely optional** and isn't a Settings-panel field (set it via environment variable only). Unset, the instance has no login gate at all — appropriate for a deployment already restricted by something like Tailscale, not for anything open to the public internet.

## Self-hosting: environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | To unlock the dashboard | Postgres connection string. Nothing renders but the credentials screen until this is set. |
| `PIPELINE_GH_TOKEN` | To run the pipeline | A GitHub personal access token with read access to the repos you want tracked (classic PAT with `repo` scope, or a fine-grained token with equivalent read permissions on the target account's repositories). |
| `ANTHROPIC_API_KEY` | To run the pipeline | Used for the per-repo "stated goals vs. reality" assessment. |
| `APP_PASSWORD` | No | Shared-secret login gate. Unset = no auth at all. |
| `CONFIG_FILE_PATH` | No | Overrides where the credential fallback file is written/read. Defaults to `./data/config.json`. |

Any of the four can instead be left unset and entered through the Settings UI once the app is running — see "How it works" above.

## Running locally

```bash
pnpm install
pnpm exec vite dev
```

> `package.json`'s `dev`/`start` scripts (`pnpm dev`/`pnpm start`) currently wrap the underlying command in `op run --environment <id> -- ...`, pulling the maintainer's own secrets from a personal 1Password Environment — that's specific to how the maintainer runs their own instance and won't work for anyone else (tracked as a known gap, `tracker-jm8.2.1`). Run the underlying command directly instead, as above, or `node .output/server/index.mjs` after `pnpm build` for a production-style run.

Credentials aren't read from a `.env` file (this project has no `dotenv` dependency) — export them as real environment variables before starting the process (`export DATABASE_URL=... && pnpm exec vite dev`, a Docker Compose `env_file`, a systemd unit's `EnvironmentFile`, etc.), or leave them unset and add them through the credentials screen the dashboard shows once it's running.

Other useful commands:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm run pipeline   # tsx src/pipeline/run.ts — discover, extract/load, enrich
```

Pipeline flags: `--dry-run` (preview scope, no writes) and `--limit N` (restrict a real run to the first N discovered repos). The pipeline reads credentials through the same env-var/config-file resolution as the web app, so values saved via the Settings UI on a given host are picked up by pipeline runs on that same host too.

## Project layout

- `src/` — the whole live project: SolidStart dashboard, Drizzle/Postgres schema, credential resolver (`src/lib/config.ts`), and the discover/extract/enrich pipeline (`src/pipeline/`)
- `.github/workflows/deploy.yml` — CI + Vercel deploy on push to `main` (the maintainer's own hosted instance; not required for self-hosting)
- `.github/workflows/pipeline.yml` — scheduled pipeline run for that same hosted instance
- `ARCHITECTURE.md` — design and full build history
- `ROADMAP.md` — sequencing notes for what's next
- `CLAUDE.md` — detailed contributor/agent notes (gotchas, auth model, etc.)

This is a personal tool built partly as a learning exercise in incremental data-pipeline and full-stack app design — expect more architectural rigor than the dashboard's actual needs strictly require.
