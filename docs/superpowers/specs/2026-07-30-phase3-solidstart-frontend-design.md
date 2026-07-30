# Phase 3: SolidStart frontend — design

Status: approved
Date: 2026-07-30

## Context

The rewrite (see `ARCHITECTURE.md`, `~/.claude/PROJECTS.md`) is replacing the
old DuckDB/`gh`-CLI/static-`tracker.html` stack with SolidStart + Drizzle +
Postgres (Neon) + Octokit. Phase 1 (Discover → Extract+Load) and Phase 2
(ignore-rules port + Anthropic-backed enrichment) are done and merged to
`main`; both are live-verified against the real ~65-repo account. `app/`
currently has the default SolidStart scaffold only (`Counter`, `about`,
`index` routes) — no real dashboard UI yet.

This spec covers Phase 3: building the actual dashboard in `app/`, reading
live from the Postgres tables Phase 1/2 populate, replacing
`tracker.html`'s hand-rolled `innerHTML` string templating with real Solid
components. It does **not** cover Phase 4 (Vercel + GitHub Actions deploy,
auth, and the old-stack cutover/retirement) — those are explicitly out of
scope here, per the decisions below.

## Decisions

- **Data freshness**: live from Postgres on every request (via SSR data
  loading), not a build-time snapshot file. This matches the direction
  `app/src/pipeline/run.ts`'s own doc comment already states: "the eventual
  SolidStart SSR route will query Postgres directly once the frontend phase
  lands."
- **Ignore toggle**: in scope. Full parity with the old dashboard's only
  interactive feature, ported from `pipeline/server.js`'s
  `POST /api/repos/:id/ignore` to a SolidStart server action against
  Postgres.
- **Visual/feature scope**: parity-first. Rebuild the same information
  architecture as tracker.html as real components; redesign is explicitly a
  later, separate pass, not bundled into this phase.
- **Access control**: deferred to Phase 4. This phase is local-dev only; no
  auth gate.
- **Pipeline triggering**: stays CLI-only (`pnpm pipeline` / `run.ts`). No UI
  trigger button in this phase.
- **README display**: the new Postgres schema deliberately has no `readme`
  column anywhere (see `extract-load.ts`'s module comment) — README text
  only exists inside `repo_assessments.input_snapshot.readmeText`, and only
  for repos that have actually been assessed. The dashboard's raw-README
  collapsible section reads from there; repos with no assessment row yet
  show "not yet assessed" instead of a README block. No new fetch, no
  schema change.

## Architecture & data flow

`@solidjs/router` (already a dependency, v1.x) provides `query()` /
`createAsync()` for SSR data loading and `action()` for mutations — no
separate API route layer is needed.

- **`src/lib/dashboard.ts`** (server-only, via SolidStart's `"use server"`
  boundary so `pg`/Drizzle never reach the client bundle): exports
  `getDashboardData()`, which queries Postgres directly:
  - `repos` joined to each repo's latest `repo_assessments` row (`DISTINCT
    ON (repo_id) ... ORDER BY repo_id, created_at DESC`).
  - Each repo's `commits` / `issues` / `pull_requests` rows.
  - Ignore-reason text, computed by calling the already-ported
    `computeSuggestedIgnore()` (`app/src/pipeline/ignore-rules.ts`) when
    `is_ignored && ignore_source === 'auto'` — same rule `publish.js` used.
  - At ~65 repos, N+1-per-repo queries are an acceptable, deliberate choice
    — matches this project's stated "no complexity for scale that doesn't
    exist" philosophy (`ROADMAP.md`'s "Explicitly not planned" section).
- **`src/routes/index.tsx`**: `const data = createAsync(() =>
  getDashboardData())`; renders `<Totals>` + a list of `<RepoCard>`.
- **Ignore toggle**: a co-located `action()` in `src/lib/dashboard.ts`,
  `toggleIgnore(repoId, ignored)`, running `UPDATE repos SET is_ignored =
  $1, ignore_source = 'manual' WHERE repo_id = $2`. The page revalidates the
  same query key on completion so the toggle reflects immediately.

## Components & UI parity

Breaking `tracker.html`'s single string-templating blob into components,
same visual output:

- **`components/Totals.tsx`** — stat tiles row (total repos, private count,
  merged PRs, etc.), same aggregates as today.
- **`components/RepoCard.tsx`** — one repo's card: name/link, public/private
  badge, language, the ignore checkbox (wired to the `toggleIgnore` action),
  the auto-ignore-reason label, the meter/status-chip row, and the
  assessment text + gaps list.
- **`components/CollapsibleSection.tsx`** — reusable `<details>` wrapper
  (title/count/children), replacing the four near-identical blocks
  (commits, PRs, issues, README) with one component used four times.
- **Styling**: port `tracker.html`'s existing CSS (the `:root` custom
  properties, light/dark theme via `prefers-color-scheme` + `data-theme`
  override, `.repo`/`.tile`/`.meter`/etc. classes) into `app.css` largely
  as-is — same look, attached to real markup instead of injected via
  `innerHTML`.

## Testing, verification & error handling

- **Unit tests**: `getDashboardData()` and `toggleIgnore()` tested against
  an in-memory pglite Postgres, following the existing pattern in
  `test-helpers/pglite-db.ts` (already used by `ignore-rules.test.ts`,
  `enrich.test.ts`, etc.) — seed repos/commits/issues/prs/assessments,
  assert the shaped output and the update.
- **No new component-test framework.** This project has no
  `@solidjs/testing-library` today; adding one is more infrastructure than a
  single-user dashboard needs. Parity is verified visually instead, matching
  the existing `run-github-project-tracker`/`verify` skill pattern of
  screenshotting the real page.
- **Live verification**: run the SolidStart dev server against the real
  Neon Postgres, visually diff against `tracker.html` for a handful of
  repos (mix of assessed/ignored/no-assessment-yet), and confirm the ignore
  checkbox persists across a page reload (not just client state) — same
  rigor as Phase 1/2's live-verification steps.
- **Edge cases**: a repo with zero `repo_assessments` rows (race between
  discover and first enrich, or a manually-ignored repo never enriched) is
  handled via `LEFT JOIN` + null-safe fallback rendering ("not yet
  assessed"), not a thrown error. Postgres unreachable → SolidStart's
  default error boundary, no bespoke handling (single-user local tool).

## Explicitly out of scope

- Retiring `pipeline/`/`tracker.html`/`schema.sql`/`tracker.duckdb` — Phase
  4 cutover.
- Auth/access control — Phase 4 deploy step.
- A UI trigger for pipeline runs — stays CLI-only.
- Visual redesign — parity-first; a redesign pass, if wanted, is separate
  future work.
