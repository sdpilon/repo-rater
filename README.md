# Repo Rater

> Self-hosted dashboard that scores your GitHub repos' actual progress against their stated goals using an LLM.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](./package.json)

Most GitHub dashboards measure activity, not whether a project is actually converging on what it says it's for. This is for anyone with more repos than time to check on them individually: instead of opening each one to see if it's stalled, abandoned, or done, you get an honest, evidence-based read pulled from its own README, commits, and issues. It runs entirely against your own database and your own credentials, not a hosted service with visibility into your account.

![Repo Rater dashboard showing repo cards with good/warn/crit AI assessments](.github/assets/dashboard.png)

## Table of contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Quick start](#quick-start)
- [Usage](#usage)
  - [Keeping data fresh](#keeping-data-fresh)
- [Development](#development)
  - [Tech stack](#tech-stack)
- [AI disclosure](#ai-disclosure)
- [License](#license)

## Features

- **Automatic repo discovery** — finds every repo in the connected GitHub account itself; no hardcoded list to maintain.
- **AI-written progress assessment per repo** — a 0–100 completion estimate, a good/warn/crit status, and a short evidence-based writeup that cites specific commits, issues, and PRs against the README's stated goals.
- **Re-assessment only when something actually changed** — each repo's inputs are hashed, so the LLM is only called again when the README, commits, issues, or PRs meaningfully change, not on every refresh.
- **Per-repo Assess control (Auto/Yes/No)** — force a repo assessed or excluded, or leave it on "Auto" and let smart defaults handle it (forks, archived repos, repos with no README, and repos with no activity are excluded by default).
- **Rendered READMEs** — GitHub-flavored markdown, sanitized, with relative links and images resolved back to GitHub so they actually work.
- **Everything lives in Postgres, rendered on every request** — no static rebuild step, no stale cache to invalidate.
- **In-browser Settings panel** — add or update your database connection, GitHub token, and Anthropic key from the UI itself; each is validated against the real service before it's saved, so a bad value never gets persisted silently.
- **Optional password gate** — a shared-secret login for instances exposed beyond your own network; leave it unset for something already behind something like Tailscale.
- **Dark mode**, following your system preference.

## Prerequisites

- **Node.js 24+** — the version pinned in `package.json`'s `engines` field.
- **pnpm** — the only package manager this is tested and locked against (`pnpm-lock.yaml`). `npm install`/`yarn install` will likely still run, but resolve dependencies independently of the tested lockfile — not recommended.
- **A Postgres database** — any Postgres works (a free [Neon](https://neon.tech) instance, a local install, a Docker container). Nothing Neon- or provider-specific is used beyond standard SQL.
- **A GitHub personal access token and an Anthropic API key** — needed for the pipeline to actually populate the dashboard with data. The app itself only requires `DATABASE_URL` to run — add these two anytime through the Settings panel. Full details in [Configuration](#configuration), next.

**Platform:** pure Node.js/TypeScript with no native or OS-specific dependencies — runs anywhere Node 24 runs. There's no packaged Docker image yet, so self-hosting today means running the Node process directly (via `pnpm dev`/`pnpm build && pnpm start`, a systemd unit, etc.) rather than a container.

## Configuration

Four settings control the app: `DATABASE_URL`, `PIPELINE_GH_TOKEN`, `ANTHROPIC_API_KEY`, and `APP_PASSWORD`. Each resolves the same way: an environment variable wins if it's set; otherwise the app falls back to a local JSON file (`./data/config.json` by default, override with `CONFIG_FILE_PATH`) written by the in-browser Settings panel. The two approaches compose freely — e.g. `DATABASE_URL` from an environment variable and the GitHub token entered through the UI. A value sourced from an environment variable shows as read-only in Settings, since anything saved there would be silently overridden by the env var anyway.

| Variable            | Required                | Purpose                                                                                                                                                                                                                 |
| ------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | To unlock the dashboard | Postgres connection string. Nothing renders but the credentials screen until this is set.                                                                                                                               |
| `PIPELINE_GH_TOKEN` | To populate data        | A GitHub personal access token with read access to the repos you want tracked — a classic PAT with the`repo` scope, or a fine-grained token with equivalent read permissions on your account's repositories.            |
| `ANTHROPIC_API_KEY` | To populate data        | Used to generate each repo's progress assessment.                                                                                                                                                                       |
| `APP_PASSWORD`      | No                      | Shared-secret login cookie for the whole app. Unset means no login gate at all — fine behind something like Tailscale, not for anything reachable from the open internet. Env-var only; not exposed in the Settings UI. |

Any of `DATABASE_URL`, `PIPELINE_GH_TOKEN`, or `ANTHROPIC_API_KEY` left unset can instead be entered through the Settings panel once the app is running. Each one is checked against the real service before being saved — a live `SELECT 1` for the database, an authenticated `users.getAuthenticated` call for the GitHub token, a `models.list` call for the Anthropic key — so a bad value is rejected immediately rather than silently persisted.

The config file itself is written `0600` (owner read/write only) in a `0700` directory, and is gitignored by default — don't check it into version control if you relocate it.

## Quick start

```bash
git clone https://github.com/sdpilon/repo-rater.git
cd repo-rater
pnpm install
```

Start the app — `pnpm dev` for a dev server with hot reload, or `pnpm build && pnpm start` to run the production build:

```bash
pnpm dev
# or
pnpm build && pnpm start
```

Open `http://localhost:3000`. If `DATABASE_URL` isn't set as an environment variable, the app shows a credentials screen on first load — paste it in there (along with your GitHub token and Anthropic key) and the database schema is applied automatically as part of saving, no separate migration step needed. See [Configuration](#configuration) for what each credential needs and every way to set it.

If you're setting `DATABASE_URL` as an environment variable instead (skipping the credentials screen entirely), apply the schema yourself first, one-time per database:

```bash
DATABASE_URL="postgres://..." pnpm exec drizzle-kit migrate
```

Once credentials are in place, run the pipeline once to populate the dashboard with real data:

```bash
pnpm run pipeline
```

## Usage

Once the dashboard loads with data, each repo gets a card showing its assessment — a completion percentage, a status label, evidence-based reasoning, and any gaps the LLM flagged — along with collapsible sections for its recent commits, issues, and pull requests, and its rendered README. A totals bar summarizes the account across all visible repos.

Every card has an **Assess: Auto / Yes / No** control, answering "should this repo be assessed?":

- **Auto** (default) — decided automatically by smart defaults (forks, archived repos, repos with no README, and repos with no activity are excluded from assessment).
- **Yes** — force this repo to be assessed, regardless of the automatic rules.
- **No** — force this repo to be excluded from assessment, regardless of the automatic rules.

A **Hide ignored repos** toggle above the repo list filters excluded repos out of view entirely; it's remembered locally between visits.

The **Settings** panel (bottom of the page) is available at any time to add or update credentials — you don't need to restart the app after changing them.

### Keeping data fresh

The app doesn't refresh itself in the background — running it just serves whatever is currently in Postgres. To pull in new commits/issues/PRs and re-run assessments, run the pipeline again:

```bash
pnpm run pipeline
```

Re-running it is cheap: assessments are only regenerated for repos whose README, commits, issues, or PRs actually changed since the last run — everything else is skipped. Schedule it however you'd schedule any recurring job on your setup (cron, a systemd timer, etc.).

Two flags are available for pipeline runs:

- `--dry-run` — reports what the pipeline would do (repos discovered, how many have no prior assessment) without writing anything.
- `--limit N` — restricts the run to the first `N` discovered repos, useful for testing against a smaller slice of a large account.

## Development

### Tech stack

- **[SolidJS](https://www.solidjs.com/) + [SolidStart](https://start.solidjs.com/)** — UI framework and full-stack meta-framework (routing, server actions/queries, SSR).
- **[Vite](https://vite.dev/)** — dev server and build tool, with [Nitro](https://nitro.build/) as the server engine.
- **[Drizzle ORM](https://orm.drizzle.team/)** — schema, queries, and migrations against Postgres.
- **[Octokit](https://github.com/octokit/octokit.js)** — GitHub API client (discovery, README/commit/issue/PR fetching).
- **[Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript)** — LLM calls for the per-repo assessment.
- **[marked](https://marked.js.org/) + [DOMPurify](https://github.com/cure53/DOMPurify)** — README markdown rendering and sanitization.
- **TypeScript**, **[Biome](https://biomejs.dev/)** (lint/format), **[Vitest](https://vitest.dev/)** (tests) — tooling.

Install dependencies:

```bash
pnpm install
```

Run the dev server (hot reload):

```bash
pnpm dev
```

Type-check, lint, and run the test suite:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm lint:fix` and `pnpm format` apply Biome's autofixes and formatting in place.

### Seeding fake data

`pnpm run seed:fake` populates a fresh database with a small fake GitHub account (a handful of repos spanning good/warn/crit assessments, one unassessed, one auto-ignored fork, one private repo) instead of the real pipeline. It's how the screenshot/demo data in this README and elsewhere is generated — useful any time that needs refreshing, or for trying out the dashboard without wiring up real credentials. It refuses to run against a database that already has repos, to avoid mixing fake data into a real one — pass `--force` to seed anyway.

A throwaway local Postgres works well for this — no real credentials needed at all:

```bash
docker run -d --name repo-rater-demo-db -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine

export DATABASE_URL="postgres://postgres:postgres@localhost:55432/postgres"
pnpm exec drizzle-kit migrate   # apply schema, one-time per database
pnpm run seed:fake

pnpm dev   # open http://localhost:3000 — no GitHub token or Anthropic key required
```

Drop the container when you're done: `docker rm -f repo-rater-demo-db`.

To regenerate `.github/assets/dashboard.png` from a UI change, with the dev server from above still running:

```bash
npx playwright install chromium   # one-time, downloads Playwright's managed browser
pnpm run screenshot
```

## AI disclosure

Parts of this codebase, including this README, were written with AI coding assistance.

**Used for:** implementation, refactoring, debugging, tests, docs, architecture/design decisions, security and code review, CI/config files, commit messages, and research into unfamiliar APIs.

**Oversight:** everything lands through the same CI gate (typecheck, lint, tests) as any other change, is reviewed and edited before merging, and gets rewritten or discarded when it's wrong. No other contributors are involved, so there's no separate human peer review beyond that.

## License

[MIT](./LICENSE)
