# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A dashboard summarizing recent activity across the user's full GitHub account (discovered automatically, not a hardcoded list), plus an AI-written "stated goals vs. reality" assessment for each repo. It's `app/` — a SolidStart + Drizzle + Postgres (Neon) + Octokit app that renders live from Postgres on every request (no static-file build step, no baked-in data block). Each repo card has an "Ignore" checkbox that persists straight to Postgres via a SolidStart server action, so future pipeline runs skip generating an assessment for that repo. `is_ignored`'s default isn't just `false` — the pipeline computes a smart default (forks, archived repos, no-README, no-activity all default to ignored) and recomputes it every run for any repo the user hasn't manually toggled; see `app/src/pipeline/ignore-rules.ts` and the `ignore_source` column.

The whole account, dashboard included, is a **live, deployed personal tool** — production is https://github-project-tracker-chi.vercel.app, gated behind an app-level password (see "Auth" below), not something you build/run locally to view.

## The two moving parts

**1. The app (`app/`)** — the SolidStart dashboard, deployed to Vercel via `.github/workflows/deploy.yml`: on every push to `main` touching `app/**`, it installs, typechecks, lints, tests, then runs `vercel deploy --prod`. Locally: `cd app && pnpm dev` — `app/package.json`'s `dev`/`start` scripts already wrap the underlying command in `op run --environment <id> -- ...`, pulling secrets (`DATABASE_URL`, `APP_PASSWORD`, etc.) from a 1Password Environment rather than a local `.env` file. `app/` is its own isolated pnpm workspace (`app/pnpm-workspace.yaml`), independent of the repo root — installing at root never pulls in `app/`'s dependencies or vice versa.

**2. The pipeline (`app/src/pipeline/`)** — discovers every repo in the account via Octokit (`listForAuthenticatedUser`), then for each one: fetches readme/issues/prs/commits/meta, upserts into Postgres, and runs a content-hash-gated AI assessment (skipping repos marked ignored or with a manually-overridden assessment). Runs via `.github/workflows/pipeline.yml` on a daily cron plus `workflow_dispatch` — not something you run manually against production data day-to-day, though `pnpm run pipeline` (`tsx src/pipeline/run.ts`, run from inside `app/`) works locally against a `DATABASE_URL` you control. Flags: `--dry-run` (report scope, no writes) and `--limit N` (restrict to the first N discovered repos).

## Auth

Vercel's Deployment Protection (SSO/password gate) does **not** cover production deployments on the free Hobby plan — only ephemeral preview URLs. That gap is filled in-app instead: `app/src/middleware.ts` redirects any unauthenticated request to `/login`, and `app/src/lib/auth.ts`/`auth-guard.ts` implement a plain shared-secret cookie check against the `APP_PASSWORD` env var (no hashing, no session store — a single-user personal tool doesn't need more). SolidStart's `action()`/`query()` functions all POST through a shared `/_server` RPC endpoint regardless of which page called them, so page-level middleware alone isn't sufficient — `assertAuthenticated()` is also called directly inside `getDashboardData`/`toggleIgnore` (`app/src/lib/dashboard.ts`) as defense in depth at the RPC layer.

## Content-hash-gated re-assessment

The AI assessment (`app/src/pipeline/enrich.ts`) is fully automated — there is no hand-authored override path (the old `tracker.html` had an `ASSESS` block for that; it's gone, along with `tracker.html` itself). To avoid re-calling the LLM on every repo every run, each repo's inputs (readme + commit messages + issue/PR titles and state) are hashed into `input_hash`; enrichment only calls the LLM when that hash changes since the last assessment. Results are appended to `repo_assessments` (never overwritten) — "current" is just the latest row per repo by `created_at`. `repos.assessment_source` (`'auto'` | `'manual'`) mirrors `ignore_source`: a repo marked `'manual'` is never re-enriched automatically.

## Gotchas

- **GitHub Actions secret naming.** Actions disallows a repo secret literally named `GITHUB_TOKEN` (reserved for the automatic per-run token), but the pipeline's Octokit client needs a broad, account-wide PAT — not the automatic token's repo-scoped one. The PAT is stored as the `PIPELINE_GH_TOKEN` secret and mapped into the `GITHUB_TOKEN` env var the app code expects via `pipeline.yml`'s `env:` block.
- **Fine-grained PAT scoping.** A fine-grained GitHub PAT with only "Contents: Read" fetches commits fine but fails Issues/PRs with `Resource not accessible by personal access token` — fine-grained PATs scope each REST resource independently, so "Issues: Read-only" and "Pull requests: Read-only" repository permissions have to be granted explicitly too.
- **Vercel Root Directory + working-directory `cd`.** `deploy.yml` already `cd`s into `app/` before invoking the Vercel CLI, so the Vercel project's "Root Directory" setting needs to be **empty**, not `app` — setting it to `app` on top of the workflow's own `cd` double-nests into `app/app` and fails.

## Verifying changes

`cd app && pnpm typecheck && pnpm lint && pnpm test` is the baseline gate — run it after any change touching `app/`. Any task that wires previously-independent, already-tested pipeline modules together into an orchestrator (discover→extract-load→enrich, or any future stage) needs a live end-to-end verification step against real external data, not just unit tests of the pieces — the predecessor DuckDB pipeline's most severe bug (a content-hash gate that never actually skipped) passed all its unit tests and was only caught by running the orchestrator twice against real GitHub repos. See `ARCHITECTURE.md`'s "Status" section for the full build history and what's been live-verified so far, and `ROADMAP.md` for what's next.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
