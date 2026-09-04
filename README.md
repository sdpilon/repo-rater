# Repo Rater

> Self-hosted dashboard that scores your GitHub repos' actual progress against their stated goals using an LLM.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](./package.json)

> [!WARNING]
> **Early stage.** This is a young, mostly single-user project — expect rough edges and breaking changes. Bug reports and feature ideas are welcome; see [CONTRIBUTING.md](./CONTRIBUTING.md).

Most GitHub dashboards measure activity, not whether a project is actually converging on its stated goals. This reads each repo's own README, commits, and issues for an honest, evidence-based verdict — run entirely against your own database and credentials, not a hosted service.

![Repo Rater dashboard showing repo cards with good/warn/crit AI assessments](.github/assets/dashboard.png)

## Table of contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Quick start](#quick-start)
  - [Pre-built Docker image](#pre-built-docker-image)
  - [Build from source](#build-from-source)
  - [Populate the dashboard](#populate-the-dashboard)
- [Usage](#usage)
  - [Keeping data fresh](#keeping-data-fresh)
- [Development](#development)
  - [Tech stack](#tech-stack)
- [AI disclosure](#ai-disclosure)
- [License](#license)

## Features

- **Automatic repo discovery** — finds every repo in the account; no hardcoded list.
- **AI-written progress assessment per repo** — a 0–100 completion estimate, good/warn/crit status, and an evidenced writeup citing commits, issues, and PRs against the README's stated goals.
- **Re-assessment only when something changed** — inputs are hashed, so the LLM only reruns when the README, commits, issues, or PRs meaningfully change.
- **Per-repo Assess control** — force a repo in or out, or leave it on "Auto" for smart defaults (forks, archived, README-less, and inactive repos excluded).
- **Rendered READMEs** — GitHub-flavored markdown, sanitized, with relative links/images resolved back to GitHub.
- **Everything lives in Postgres, rendered on every request** — no static rebuild step, no stale cache to invalidate.
- **In-browser Settings panel** — add or update credentials without restarting; each is validated against the real service before saving.
- **Optional password gate** — shared-secret login for instances exposed beyond your network.
- **Dark mode** — following your system preference.

## Prerequisites

- **Node.js 22+** — the version pinned in `package.json`'s `engines` field.
- **pnpm** — the only package manager this is tested and locked against; `npm`/`yarn` will resolve independently of the lockfile, so not recommended.
- **A Postgres database** — any Postgres works; nothing provider-specific beyond standard SQL.
- **A GitHub personal access token and an Anthropic API key** — needed for the pipeline to populate data (the app itself only needs `DATABASE_URL` to run); add both anytime via Settings. Details in [Configuration](#configuration), next.

**Platform:** pure Node.js/TypeScript, no native or OS-specific dependencies — runs anywhere Node 22 runs. A pre-built Docker image is available (see [Quick start](#quick-start)), or run the Node process directly (`pnpm dev`/`pnpm build && pnpm start`, a systemd unit, etc.).

## Configuration

Four settings control the app, each settable as an environment variable or through the in-browser Settings panel:

| Variable            | Required                | Purpose                                                                     |
| ------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`      | To unlock the dashboard | Postgres connection string.                                                 |
| `PIPELINE_GH_TOKEN` | To populate data        | GitHub PAT with read access to your repos.                                  |
| `ANTHROPIC_API_KEY` | To populate data        | Used to generate each repo's progress assessment.                           |
| `APP_PASSWORD`      | No                      | Optional shared-secret login gate; skip it behind something like Tailscale. |

See [ARCHITECTURE.md](./ARCHITECTURE.md#credentials--auth) for how settings resolve between env vars and the Settings panel, how they're validated, and where the config file lives.

## Quick start

Three ways to run the app. None of them run the pipeline that populates real data — that's a separate step, [Populate the dashboard](#populate-the-dashboard) below, once the app is up with credentials in place.

### Docker (Recommended)

```bash
docker run -d --name repo-rater \
  -p 8372:8372 \
  -e DATABASE_URL="postgres://..." \
  -e PIPELINE_GH_TOKEN="..." \
  -e ANTHROPIC_API_KEY="..." \
  ghcr.io/sdpilon/repo-rater
```

### Build from source

```bash
git clone https://github.com/sdpilon/repo-rater.git
cd repo-rater
```

Then either build the Docker image yourself — a multi-stage `Dockerfile` produces a ~164MB image (`node:22-alpine` plus the built app, no source tree or build toolchain baked in):

```bash
docker build --tag repo-rater .
docker run -d --name repo-rater \
  -p 8372:8372 \
  -e DATABASE_URL="postgres://..." \
  -e PIPELINE_GH_TOKEN="..." \
  -e ANTHROPIC_API_KEY="..." \
  repo-rater
```

— or run the Node process directly:

```bash
pnpm install
pnpm dev
# or, for a production build:
pnpm build && pnpm start
```

Open `http://localhost:3000`. If `DATABASE_URL` isn't set, the app shows a credentials screen on first load — paste it in (with your GitHub token and Anthropic key). See [Configuration](#configuration) for details.

### Populate the dashboard

Run the pipeline to populate the dashboard with real data — this needs a local checkout regardless of which option above you used:

```bash
git clone https://github.com/sdpilon/repo-rater.git   # skip if you already have one
cd repo-rater && pnpm install                          # skip if already installed
pnpm run pipeline
```

## Usage

Each repo gets a card showing its assessment — completion percentage, status label, evidence-based reasoning, and flagged gaps — plus collapsible commits/issues/PRs and its rendered README. A totals bar summarizes all visible repos.

Every card has an **Assess: Auto / Yes / No** control, answering "should this repo be assessed?":

- **Auto** (default) — decided by smart defaults (forks, archived repos, repos with no README, and repos with no activity are excluded).
- **Yes** — force assessment, regardless of the automatic rules.
- **No** — force exclusion, regardless of the automatic rules.

A **Hide ignored repos** toggle filters excluded repos out of view; remembered locally between visits.

The **Settings** panel (bottom of the page) adds or updates credentials anytime — no restart needed.

### Keeping data fresh

The app doesn't refresh in the background — it just serves whatever's in Postgres. To pull in new commits/issues/PRs and re-run assessments, run the pipeline again:

```bash
pnpm run pipeline
```

Re-running is cheap: only repos whose README, commits, issues, or PRs changed get reassessed. Schedule it however you'd schedule any recurring job (cron, a systemd timer, etc.).

Two flags are available for pipeline runs:

- `--dry-run` — reports what the pipeline would do, without writing anything.
- `--limit N` — restricts the run to the first `N` discovered repos.

## Development

### Tech stack

- **[SolidJS](https://www.solidjs.com/) + [SolidStart](https://start.solidjs.com/)** — UI framework and meta-framework (routing, server actions/queries, SSR).
- **[Vite](https://vite.dev/)** (with [Nitro](https://nitro.build/)) — dev server and build tool.
- **[Drizzle ORM](https://orm.drizzle.team/)** — schema, queries, migrations against Postgres.
- **[Octokit](https://github.com/octokit/octokit.js)** — GitHub API client.
- **[Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript)** — per-repo LLM assessment.
- **[marked](https://marked.js.org/)** — README rendering, sanitized via **[DOMPurify](https://github.com/cure53/DOMPurify)** (client) and **[sanitize-html](https://github.com/apostrophecms/sanitize-html)** (server).
- **TypeScript**, **[Biome](https://biomejs.dev/)**, **[Vitest](https://vitest.dev/)** — typing, lint/format, tests.

Install dependencies:

```bash
pnpm install
```

Run the dev server (hot reload):

```bash
pnpm dev
```

Run the same checks CI does (type-check, lint, format check, tests) in one go:

```bash
pnpm check
```

`pnpm tidy` applies Biome's lint and format autofixes in place.

### Public demo

A live instance seeded with fake data runs at [repo-rater-demo.vercel.app](https://repo-rater-demo.vercel.app) — not connected to a real GitHub account, for a quick look before setting anything up. `DEMO_MODE=true` disables the Assess control so visitors can't mutate the shared database.

### Seeding fake data

`pnpm run seed:fake` populates the database with a small fake GitHub account instead of the real pipeline — a quick way to try the dashboard without wiring up real credentials. It refuses to run against a database that already has repos; pass `--force` to seed anyway. See [CONTRIBUTING.md](./CONTRIBUTING.md#working-with-fake-data) for using it with a throwaway Postgres and regenerating the demo screenshot.

## AI disclosure

Parts of this codebase, including this README, were written with AI coding assistance.

**Used for:** implementation, refactoring, debugging, tests, docs, architecture/design decisions, security and code review, CI/config files, commit messages, and research into unfamiliar APIs.

**Oversight:** everything lands through the same CI gate (typecheck, lint, tests) as any other change, is reviewed and edited before merging, and gets rewritten or discarded when it's wrong. No other contributors are involved, so there's no separate human peer review beyond that.

## License

[MIT](./LICENSE)
