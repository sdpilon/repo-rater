# Flatten Repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `app/`'s contents up to the repo root so the project is a single, unnested pnpm workspace — `pnpm dev`/`pnpm test`/etc. run from the repo root instead of requiring `cd app` — with CI/deploy config, docs, and lockfiles all updated to match.

**Architecture:** This is one coherent mechanical transformation (file moves + config merges + doc updates), not several independent features — deliberately implemented and reviewed as a single task rather than split, since splitting a single atomic move into "independent" pieces would just create artificial merge conflicts between them. `app/`'s isolated-pnpm-workspace setup was a defensive measure against the old DuckDB stack's native-binding rebuild; that stack is fully deleted (confirmed: root `pipeline/` is an empty `.claude/`-only stub), so the isolation no longer serves a purpose.

**Tech Stack:** pnpm workspaces, Biome, GitHub Actions, Vercel.

## Global Constraints

- Verified before writing this plan (read the live files, not just the bd issue's description): the Vercel project (`prj_I97EjHUEac9J81hV1n3pvGDFSspG`, via `mcp__vercel__get_project`) currently has **no `rootDirectory` set** — i.e. it's already empty, matching CLAUDE.md's documented "must stay empty" requirement. Nothing needs to change on the Vercel side; this plan must not touch Vercel project settings, only the repo-side files that currently compensate for `deploy.yml`'s `cd`.
- `esbuild`'s postinstall script actually runs today via `app/pnpm-workspace.yaml`'s `allowBuilds: { esbuild: true }` (confirmed live in a `pnpm install` run, not just present as unused boilerplate) — this must carry forward into the merged root `pnpm-workspace.yaml`, not get dropped.
- Root-level docs (`ARCHITECTURE.md`, `ROADMAP.md`, `docs/`) and `AGENTS.md` are explicitly **out of scope** — confirmed `AGENTS.md` has zero `app/` references (grepped), and the bd issue explicitly scopes historical docs out. `CLAUDE.md` is the one exception: **it is in scope**, because unlike the historical docs it's operational instructions actively read every session, and flattening makes several of its `cd app`/`app/`-prefixed instructions actively wrong (not just stale) the moment this merges. Fix its path references and remove the one gotcha bullet that becomes obsolete; do not otherwise rewrite its content.
- Use `git mv` for every tracked file/directory move (not delete+recreate) so file history is preserved.
- After the move, run a fresh `pnpm install` at the new root (not `--frozen-lockfile`) to reconcile the lockfile against the merged `package.json` (name/scripts changed) — verify the diff doesn't show unexpected dependency changes, only what the merge intentionally changed.
- Run `pnpm typecheck && pnpm lint && pnpm test` from the repo root (no more `cd app`) — this is now the baseline gate's actual invocation, everywhere it's documented.

---

### Task 1: Flatten `app/` to repo root

**Files:** this task touches nearly every top-level path in the repo. Representative list (not exhaustive — see steps for the full move list): `package.json`, `biome.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `README.md`, `.gitignore` (merged); `src/`, `public/`, `drizzle/`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `drizzle.config.ts` (moved from `app/`); `.github/workflows/deploy.yml`, `.github/workflows/pipeline.yml`, `CLAUDE.md` (path references updated).

- [ ] **Step 1: Merge `package.json`**

Edit `app/package.json` in place (before moving it) to change just the `name` field and add two scripts from root's version. Current `app/package.json` starts:

```json
{
  "name": "app",
  "type": "module",
  "scripts": {
    "dev": "op run --environment awfmhhvd3m2pczed5p45annswa -- vite dev",
```

Change to:

```json
{
  "name": "github-project-tracker",
  "type": "module",
  "scripts": {
    "dev": "op run --environment awfmhhvd3m2pczed5p45annswa -- vite dev",
```

And in the same `scripts` block, after the existing `"pipeline": "tsx src/pipeline/run.ts"` line, add root's two unique scripts (root's `lint`/`lint:fix`/`format` are identical to app's — do not duplicate those):

```json
    "pipeline": "tsx src/pipeline/run.ts",
    "deps:outdated": "pnpm outdated",
    "deps:update": "pnpm update -i --latest"
```

Everything else in `app/package.json` (dependencies, devDependencies, engines) is unchanged — it already has the full real dependency list; root's `package.json` only ever had `@biomejs/biome` as a devDependency, which `app/package.json` already includes at the same version (`^2.5.5`).

- [ ] **Step 2: Merge `biome.json`**

Edit `app/biome.json` in place. Current:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.6/schema.json",
  "files": {
    "includes": ["**", "!**/node_modules", "!.output", "!.vinxi", "!dist"]
  },
```

Change the `includes` array to also exclude the two root-only directories that root's `biome.json` excluded (root's `!app` exclusion is dropped — there's no more `app/` to exclude):

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.6/schema.json",
  "files": {
    "includes": ["**", "!**/node_modules", "!.output", "!.vinxi", "!dist", "!.claude", "!.beads"]
  },
```

- [ ] **Step 3: Merge `pnpm-workspace.yaml`**

Edit `app/pnpm-workspace.yaml` in place. Current:

```yaml
# Isolates app/ as its own pnpm workspace root so `pnpm install` here
# doesn't walk up to the repo-root pnpm-workspace.yaml and pull in the
# old stack's dependencies (e.g. native duckdb rebuilds).
packages:
  - "."
allowBuilds:
  esbuild: true
```

Replace with (the comment now describes the post-flatten reality — this file's only remaining job is to mark this directory as the workspace root so `pnpm install` doesn't walk further up, and to keep allowing esbuild's postinstall):

```yaml
# Marks this directory as the pnpm workspace root, so `pnpm install` here
# doesn't walk up past this directory looking for a workspace file
# further up the filesystem. Single-package repo (no old nested app/
# workspace anymore — flattened, see docs/superpowers/plans/2026-08-08-flatten-repo.md).
allowBuilds:
  esbuild: true
```

- [ ] **Step 4: Merge `.gitignore`**

Edit `app/.gitignore` in place — prepend root's two entries that aren't already covered (root's `node_modules/` is equivalent to app's existing `/node_modules`; root's `.pnpm-store/` is new). Current `app/.gitignore` starts:

```
dist
.wrangler
.output
.vercel
.netlify
.vinxi
app.config.timestamp_*.js
```

Change to:

```
.pnpm-store/
dist
.wrangler
.output
.vercel
.netlify
.vinxi
app.config.timestamp_*.js
```

(Leave the rest of the file — env files, IDE files, temp, system files, `/node_modules` — unchanged. Root's `.claude/idea-seeds.md` entry is dropped: that file no longer exists per this project's `claudecode` tooling history, and root's `.gitignore` only had it as a stale entry.)

- [ ] **Step 5: Replace `app/README.md` with the merged root README**

`app/README.md` is unmodified SolidStart CLI boilerplate with no real content — discard it entirely rather than merging. Root's `README.md` is the real one; it needs one content fix while we're here (same "Ignore checkbox" staleness CLAUDE.md has, from the 3-way control that landed in an earlier plan) and its `cd app` instructions removed.

Overwrite `app/README.md`'s full contents with:

```markdown
# github-project-tracker

A dashboard summarizing recent activity across your full GitHub account — discovered automatically, not a hardcoded list — plus an AI-written "stated goals vs. reality" assessment for each repo.

This is a live, deployed personal tool: production is https://github-project-tracker-chi.vercel.app, gated behind an app-level password. There's no local build step that produces a static file to view — the dashboard renders live from Postgres on every request, and its data is kept fresh by a scheduled GitHub Actions pipeline, not a manually-run local script.

## How it works

- **The dashboard** — a SolidStart + Drizzle + Postgres (Neon) + Octokit app. Deployed to Vercel via `.github/workflows/deploy.yml` on every push to `main` (install → typecheck → lint → test → `vercel deploy --prod`).
- **`src/pipeline/`** — discovers every repo in the account via Octokit, fetches readme/issues/PRs/commits/metadata for each, upserts into Postgres, and runs a content-hash-gated AI assessment (only re-calling the LLM when a repo's inputs actually changed). Runs via `.github/workflows/pipeline.yml` on a daily schedule (plus manual `workflow_dispatch`).
- Each repo card has an **Auto/Yes/No ignore control**, persisted straight to Postgres, so future pipeline runs skip generating an assessment for ignored repos. Ignore defaults are computed automatically (forks, archived repos, no-README repos, and no-activity repos default to ignored) — "Auto" hands a repo back to that automatic recomputation, "Yes"/"No" force it either way.

## Running locally

```bash
pnpm install
pnpm dev
```

`package.json`'s `dev`/`start` scripts wrap the underlying command in `op run --environment <id> -- ...`, pulling secrets (`DATABASE_URL`, `APP_PASSWORD`, etc.) from a 1Password Environment.

Other useful commands:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm run pipeline   # tsx src/pipeline/run.ts — the same script the scheduled GitHub Actions workflow runs
```

Pipeline flags: `--dry-run` (preview scope, no writes) and `--limit N` (restrict a real run to the first N discovered repos).

## Project layout

- `src/` — the whole live project: SolidStart dashboard, Drizzle/Postgres schema, and the discover/extract/enrich pipeline (`src/pipeline/`)
- `.github/workflows/deploy.yml` — CI + Vercel deploy on push to `main`
- `.github/workflows/pipeline.yml` — scheduled pipeline run
- `ARCHITECTURE.md` — design and full build history, including the retired original DuckDB-based design this project replaced, and the later `app/`-subdirectory phase this repo has since been flattened out of
- `ROADMAP.md` — sequencing notes for what's next
- `CLAUDE.md` — detailed contributor/agent notes (gotchas, auth model, etc.)

This is a personal tool built partly as a learning exercise in incremental data-pipeline and full-stack app design — expect more architectural rigor than the dashboard's actual needs strictly require.
```

- [ ] **Step 6: Remove the root files being superseded, then move everything up**

```bash
git rm package.json biome.json pnpm-workspace.yaml pnpm-lock.yaml README.md .gitignore

git mv app/package.json package.json
git mv app/biome.json biome.json
git mv app/pnpm-workspace.yaml pnpm-workspace.yaml
git mv app/pnpm-lock.yaml pnpm-lock.yaml
git mv app/README.md README.md
git mv app/.gitignore .gitignore

git mv app/src src
git mv app/public public
git mv app/drizzle drizzle
git mv app/tsconfig.json tsconfig.json
git mv app/vite.config.ts vite.config.ts
git mv app/vitest.config.ts vitest.config.ts
git mv app/drizzle.config.ts drizzle.config.ts

# app/ should now contain only gitignored local artifacts (node_modules,
# .output, .vercel, .vinxi, if present) — remove the directory entirely.
rm -rf app
```

- [ ] **Step 7: Update `.github/workflows/deploy.yml`**

Remove the `paths` trigger filter (there's no more `app/**` prefix to filter on — nearly everything at the new root is real app code now) and the `working-directory`/`cache-dependency-path` `app/` prefixes. Current:

```yaml
on:
  push:
    branches:
      - main
    paths:
      - "app/**"

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: app
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 11

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: app/pnpm-lock.yaml
```

Change to:

```yaml
on:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 11

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml
```

(The rest of the file — install/typecheck/lint/test/deploy steps — is unchanged; those `run:` commands had no `app/` prefix of their own, they relied on `working-directory`, which is now gone since there's nothing to change directory into.)

- [ ] **Step 8: Update `.github/workflows/pipeline.yml`**

Same two changes as Step 7 (no `paths` filter existed here to remove — it's schedule-triggered). Current:

```yaml
jobs:
  pipeline:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: app
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 11

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: app/pnpm-lock.yaml
```

Change to:

```yaml
jobs:
  pipeline:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 11

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml
```

- [ ] **Step 9: Update `CLAUDE.md`**

Apply these exact search-and-replace edits (search text → replacement). Apply each one exactly once, at its unique location in the file:

1. Search:
```
A dashboard summarizing recent activity across the user's full GitHub account (discovered automatically, not a hardcoded list), plus an AI-written "stated goals vs. reality" assessment for each repo. It's `app/` — a SolidStart + Drizzle + Postgres (Neon) + Octokit app that renders live from Postgres on every request (no static-file build step, no baked-in data block). Each repo card has an "Ignore" checkbox that persists straight to Postgres via a SolidStart server action, so future pipeline runs skip generating an assessment for that repo. `is_ignored`'s default isn't just `false` — the pipeline computes a smart default (forks, archived repos, no-README, no-activity all default to ignored) and recomputes it every run for any repo the user hasn't manually toggled; see `app/src/pipeline/ignore-rules.ts` and the `ignore_source` column.
```
Replace with:
```
A dashboard summarizing recent activity across the user's full GitHub account (discovered automatically, not a hardcoded list), plus an AI-written "stated goals vs. reality" assessment for each repo. A SolidStart + Drizzle + Postgres (Neon) + Octokit app that renders live from Postgres on every request (no static-file build step, no baked-in data block). Each repo card has an Auto/Yes/No ignore control that persists straight to Postgres via a SolidStart server action ("Auto" hands the repo back to automatic recomputation; "Yes"/"No" force it either way), so future pipeline runs skip generating an assessment for ignored repos. `is_ignored`'s default isn't just `false` — the pipeline computes a smart default (forks, archived repos, no-README, no-activity all default to ignored) and recomputes it every run for any repo whose ignore control is still on "Auto"; see `src/pipeline/ignore-rules.ts` and the `ignore_source` column.
```

2. Search:
```
**1. The app (`app/`)** — the SolidStart dashboard, deployed to Vercel via `.github/workflows/deploy.yml`: on every push to `main` touching `app/**`, it installs, typechecks, lints, tests, then runs `vercel deploy --prod`. Locally: `cd app && pnpm dev` — `app/package.json`'s `dev`/`start` scripts already wrap the underlying command in `op run --environment <id> -- ...`, pulling secrets (`DATABASE_URL`, `APP_PASSWORD`, etc.) from a 1Password Environment rather than a local `.env` file. `app/` is its own isolated pnpm workspace (`app/pnpm-workspace.yaml`), independent of the repo root — installing at root never pulls in `app/`'s dependencies or vice versa.
```
Replace with:
```
**1. The app** — the SolidStart dashboard, deployed to Vercel via `.github/workflows/deploy.yml`: on every push to `main`, it installs, typechecks, lints, tests, then runs `vercel deploy --prod`. Locally: `pnpm dev` — `package.json`'s `dev`/`start` scripts already wrap the underlying command in `op run --environment <id> -- ...`, pulling secrets (`DATABASE_URL`, `APP_PASSWORD`, etc.) from a 1Password Environment rather than a local `.env` file.
```

3. Search:
```
**2. The pipeline (`app/src/pipeline/`)** — discovers every repo in the account via Octokit (`listForAuthenticatedUser`), then for each one: fetches readme/issues/prs/commits/meta, upserts into Postgres, and runs a content-hash-gated AI assessment (skipping repos marked ignored or with a manually-overridden assessment). Runs via `.github/workflows/pipeline.yml` on a daily cron plus `workflow_dispatch` — not something you run manually against production data day-to-day, though `pnpm run pipeline` (`tsx src/pipeline/run.ts`, run from inside `app/`) works locally against a `DATABASE_URL` you control. Flags: `--dry-run` (report scope, no writes) and `--limit N` (restrict to the first N discovered repos).
```
Replace with:
```
**2. The pipeline (`src/pipeline/`)** — discovers every repo in the account via Octokit (`listForAuthenticatedUser`), then for each one: fetches readme/issues/prs/commits/meta, upserts into Postgres, and runs a content-hash-gated AI assessment (skipping repos marked ignored or with a manually-overridden assessment). Runs via `.github/workflows/pipeline.yml` on a daily cron plus `workflow_dispatch` — not something you run manually against production data day-to-day, though `pnpm run pipeline` (`tsx src/pipeline/run.ts`) works locally against a `DATABASE_URL` you control. Flags: `--dry-run` (report scope, no writes) and `--limit N` (restrict to the first N discovered repos).
```

4. Search:
```
Vercel's Deployment Protection (SSO/password gate) does **not** cover production deployments on the free Hobby plan — only ephemeral preview URLs. That gap is filled in-app instead: `app/src/middleware.ts` redirects any unauthenticated request to `/login`, and `app/src/lib/auth.ts`/`auth-guard.ts` implement a plain shared-secret cookie check against the `APP_PASSWORD` env var (no hashing, no session store — a single-user personal tool doesn't need more). SolidStart's `action()`/`query()` functions all POST through a shared `/_server` RPC endpoint regardless of which page called them, so page-level middleware alone isn't sufficient — `assertAuthenticated()` is also called directly inside `getDashboardData`/`toggleIgnore` (`app/src/lib/dashboard.ts`) as defense in depth at the RPC layer.
```
Replace with:
```
Vercel's Deployment Protection (SSO/password gate) does **not** cover production deployments on the free Hobby plan — only ephemeral preview URLs. That gap is filled in-app instead: `src/middleware.ts` redirects any unauthenticated request to `/login`, and `src/lib/auth.ts`/`auth-guard.ts` implement a plain shared-secret cookie check against the `APP_PASSWORD` env var (no hashing, no session store — a single-user personal tool doesn't need more). SolidStart's `action()`/`query()` functions all POST through a shared `/_server` RPC endpoint regardless of which page called them, so page-level middleware alone isn't sufficient — `assertAuthenticated()` is also called directly inside `getDashboardData`/`toggleIgnore` (`src/lib/dashboard.ts`) as defense in depth at the RPC layer.
```

5. Search:
```
The AI assessment (`app/src/pipeline/enrich.ts`) is fully automated
```
Replace with:
```
The AI assessment (`src/pipeline/enrich.ts`) is fully automated
```

6. Search (remove this entire bullet — it's now obsolete, not just stale: there's no more `cd` for the Root Directory setting to interact with, and the setting was already confirmed empty via `mcp__vercel__get_project`):
```
- **Vercel Root Directory + working-directory `cd`.** `deploy.yml` already `cd`s into `app/` before invoking the Vercel CLI, so the Vercel project's "Root Directory" setting needs to be **empty**, not `app` — setting it to `app` on top of the workflow's own `cd` double-nests into `app/app` and fails.
```
Replace with: (nothing — delete the bullet and its leading `- ` entirely, including the newline, so the surrounding list just has one fewer entry)

7. Search:
```
`cd app && pnpm typecheck && pnpm lint && pnpm test` is the baseline gate — run it after any change touching `app/`.
```
Replace with:
```
`pnpm typecheck && pnpm lint && pnpm test` is the baseline gate — run it after any change.
```

- [ ] **Step 10: Reinstall and reconcile the lockfile**

```bash
pnpm install
git diff --stat pnpm-lock.yaml
```

Expected: `pnpm install` succeeds (no `--frozen-lockfile`, since `package.json` changed). Review the `pnpm-lock.yaml` diff — it should be small/mechanical (reflecting the `name` field change and nothing unexpected). If it shows dependency version changes you didn't intend, stop and investigate before proceeding; don't just accept an unexpected lockfile diff.

- [ ] **Step 11: Run the full verification gate**

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: all three pass, from the repo root, with no `cd` needed. Test count should match the pre-flatten baseline (112 tests) — a flatten is a pure file move, it must not change what the test suite covers.

- [ ] **Step 12: Sanity-check the dev/build commands still resolve correctly**

```bash
pnpm run pipeline -- --dry-run --limit 1
```

Expected: runs (may fail on missing `DATABASE_URL`/`GITHUB_TOKEN` if you don't have `op run` access in this environment — that's fine and expected in a sandboxed/headless environment; what matters here is that the command **resolves and starts** rather than erroring on a bad path like `tsx: command not found` or `Cannot find module './src/pipeline/run.ts'`, which would indicate the move broke something `pnpm typecheck`/`lint`/`test` didn't catch. If you have working `op run` access, also try `pnpm dev` and confirm it serves from the root without needing `cd app` — same manual-browser-check caveat as prior plans applies if you want to go further than confirming the process starts.

- [ ] **Step 13: Commit**

```bash
git add -A
git status
git commit -m "refactor: flatten app/ contents to repo root"
```

Review `git status`/`git add -A`'s staged output before committing — confirm it's exactly the moves/edits described above (git should show most files as renames, not delete+add pairs, if `git mv` was used correctly) and nothing unexpected (e.g. a stray `node_modules` entry) got staged.
