# Phase 3: SolidStart Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the real dashboard in `app/` — replacing the SolidStart scaffold with a live-from-Postgres rebuild of `tracker.html`'s repo cards, totals, assessments, and ignore toggle.

**Architecture:** SolidStart SSR data loading (`query()`/`createAsync()`) and a server action (`action()`) read/write Postgres directly via Drizzle — no API route layer, no build-time snapshot. Data-shaping logic is split into a plain, `db`-parameterized module (unit-testable with PGlite, matching `app/src/pipeline/`'s existing pattern) from a thin `"use server"` wrapper module that SolidStart's router calls.

**Tech Stack:** SolidStart 2.x, `@solidjs/router` 1.x (`query`/`action`/`createAsync`/`useAction`/`useSubmission`), Drizzle ORM (`drizzle-orm/node-postgres` for the real Neon DB, `drizzle-orm/pglite` for tests), `drizzle-kit` for migrations, Vitest.

**Reference:** `docs/superpowers/specs/2026-07-30-phase3-solidstart-frontend-design.md` — read this first for the approved decisions and their rationale.

## Global Constraints

- Data is read live from Postgres on every request — no `repos.json`-style snapshot file.
- The ignore-toggle write path is in scope; a UI trigger for pipeline runs is not.
- Parity-first: match `tracker.html`'s information architecture (totals, repo cards, meter/status chip, collapsible commits/PRs/issues/README) as real components. No visual redesign in this phase.
- No auth/access control in this phase (deferred to Phase 4).
- README display reads from the latest `repo_assessments.input_snapshot.readmeText`; no live GitHub fetch, no new README column.
- The ignore-reason label (`ignore_reasons`) is persisted on `repos` by the pipeline at ignore-decision time (Task 1), not recomputed at display time.
- This phase does not retire `pipeline/`/`tracker.html`/`schema.sql`/`tracker.duckdb` (Phase 4 cutover) and does not touch those files.
- All commands below run from `app/` unless stated otherwise. Use `pnpm` (this workspace uses `pnpm-workspace.yaml`, not bun).

---

### Task 1: Persist `ignore_reasons` on `repos`

**Files:**
- Modify: `app/src/db/schema.ts:47` (add column after `ignoreSource`)
- Modify: `app/src/pipeline/ignore-rules.ts:47-73` (`applyIgnoreDefaultForRepo`)
- Modify: `app/src/pipeline/ignore-rules.test.ts` (assert the new column)
- Rewrite: `app/src/pipeline/test-helpers/pglite-db.ts` (apply all migrations, not just the first)
- Create: `app/drizzle/NNNN_<generated-name>.sql` (via `drizzle-kit generate`, exact name unpredictable)

**Interfaces:**
- Produces: `repos.ignoreReasons: string[] | null` (Drizzle column `ignoreReasons`, DB column `ignore_reasons text[]`); `applyIgnoreDefaultForRepo(db, repoId, input): Promise<{ ignored: boolean; reasons: string[] }>` (widened from `{ ignored: boolean }` — existing caller in `enrich.ts` only destructures `.ignored`, unaffected).

- [ ] **Step 1: Add the column to the schema**

Edit `app/src/db/schema.ts`, right after the existing `ignoreSource` line:

```ts
  ignoreSource: varchar("ignore_source").notNull().default("auto"),
  // Persisted reasons behind an 'auto' ignore decision (e.g. ["no README",
  // "no activity"]), written by `applyIgnoreDefaultForRepo`
  // (pipeline/ignore-rules.ts) at the same time it computes is_ignored.
  // Added for the Phase 3 dashboard's ignore-reason label — the old
  // dashboard recomputed this at display time from a freshly-fetched
  // README, but the new schema never persists README for a currently-
  // ignored repo (enrichment, and its input_snapshot, is skipped entirely
  // for ignored repos), so display-time recomputation isn't possible here.
  ignoreReasons: text("ignore_reasons").array(),
  assessmentSource: varchar("assessment_source").notNull().default("auto"),
```

(`text` is already imported at the top of `schema.ts`.)

- [ ] **Step 2: Update the failing test for `applyIgnoreDefaultForRepo`**

In `app/src/pipeline/ignore-rules.test.ts`, update the two `applyIgnoreDefaultForRepo` tests that currently only check `isIgnored`:

```ts
  it("sets is_ignored true, ignore_source 'auto', and ignore_reasons for a repo with no activity", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db);

    const result = await applyIgnoreDefaultForRepo(db, 1, {
      readme: "",
      commitCount: 0,
      issueCount: 0,
      prCount: 0,
    });
    expect(result.ignored).toBe(true);
    expect(result.reasons).toEqual(["no README", "no activity"]);

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(true);
    expect(row.ignoreSource).toBe("auto");
    expect(row.ignoreReasons).toEqual(["no README", "no activity"]);
  });

  it("sets is_ignored false and clears ignore_reasons for an active repo", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { isIgnored: true, ignoreReasons: ["no activity"] });

    const result = await applyIgnoreDefaultForRepo(db, 1, {
      readme: "# hi",
      commitCount: 3,
      issueCount: 0,
      prCount: 0,
    });
    expect(result.ignored).toBe(false);
    expect(result.reasons).toEqual([]);

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(false);
    expect(row.ignoreReasons).toEqual([]);
  });
```

Also add `reasons: []` to the expectation in the existing "never recomputes or overwrites a manually-set ignore_source" test:

```ts
    const result = await applyIgnoreDefaultForRepo(db, 1, {
      readme: "",
      commitCount: 0,
      issueCount: 0,
      prCount: 0,
    });
    expect(result.ignored).toBe(false);
    expect(result.reasons).toEqual([]);
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd app && pnpm vitest run src/pipeline/ignore-rules.test.ts`
Expected: FAIL — `result.reasons` is `undefined`, `row.ignoreReasons` column doesn't exist yet (schema/DB not updated), TypeScript error on the new schema field until Step 1/5 land together. (If Step 1 already applied cleanly, the column-doesn't-exist failure won't appear until you also rewrite `pglite-db.ts` in Step 6 — that's fine, keep going; the point of this run is to confirm the *behavioral* assertions fail before `ignore-rules.ts` is updated.)

- [ ] **Step 4: Update `applyIgnoreDefaultForRepo`**

Replace the function body in `app/src/pipeline/ignore-rules.ts`:

```ts
export async function applyIgnoreDefaultForRepo(
  db: DrizzleDb,
  repoId: number,
  input: Omit<SuggestedIgnoreInput, "isFork" | "isArchived">,
): Promise<{ ignored: boolean; reasons: string[] }> {
  const [repoRow] = await db
    .select({ isFork: repos.isFork, isArchived: repos.isArchived, ignoreSource: repos.ignoreSource, isIgnored: repos.isIgnored })
    .from(repos)
    .where(eq(repos.repoId, repoId));

  if (!repoRow || repoRow.ignoreSource === "manual") {
    return { ignored: repoRow?.isIgnored ?? false, reasons: [] };
  }

  const { ignored, reasons } = computeSuggestedIgnore({
    isFork: repoRow.isFork ?? false,
    isArchived: repoRow.isArchived ?? false,
    ...input,
  });

  await db
    .update(repos)
    .set({ isIgnored: ignored, ignoreSource: "auto", ignoreReasons: reasons })
    .where(and(eq(repos.repoId, repoId), ne(repos.ignoreSource, "manual")));

  return { ignored, reasons };
}
```

- [ ] **Step 5: Generate the migration**

Run: `cd app && pnpm exec drizzle-kit generate`
Expected: a new file appears under `app/drizzle/`, e.g. `0001_<adjective>_<noun>.sql`, containing `ALTER TABLE "repos" ADD COLUMN "ignore_reasons" text[];`. Confirm with `ls app/drizzle/*.sql` — don't hardcode the generated name anywhere.

- [ ] **Step 6: Generalize the PGlite test helper to apply every migration**

Replace the full contents of `app/src/pipeline/test-helpers/pglite-db.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DrizzleDb } from "../db-types";

/**
 * Real (WASM, in-process, no server/network) Postgres for pipeline tests,
 * via PGlite + Drizzle's `drizzle-orm/pglite` driver — Drizzle's own
 * documented approach for testing against real Postgres semantics without a
 * live server. Used in place of the old suite's DuckDB `:memory:` database
 * so upsert/ON CONFLICT behavior is exercised for real, not just asserted
 * against a mocked query builder.
 *
 * Schema is applied by running every migration file under `drizzle/` in
 * filename order (the `NNNN_` prefix is zero-padded, so lexical sort ==
 * numeric sort) against a fresh PGlite instance — not just the first one,
 * so tests stay in sync as new migrations (e.g. `ignore_reasons`) are
 * added, mirroring the old tests' `ensureSchema(db)` call.
 */

const drizzleDir = fileURLToPath(new URL("../../../drizzle", import.meta.url));

export async function createTestDb(): Promise<{ db: DrizzleDb; close: () => Promise<void> }> {
  const client = new PGlite();
  const migrationFiles = readdirSync(drizzleDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    const migrationSql = readFileSync(`${drizzleDir}/${file}`, "utf8");
    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) {
        await client.exec(trimmed);
      }
    }
  }
  const db = drizzle(client);
  return { db, close: () => client.close() };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd app && pnpm vitest run src/pipeline/ignore-rules.test.ts src/pipeline/enrich.test.ts src/db/schema.test.ts`
Expected: PASS (the `enrich.test.ts`/`schema.test.ts` run is a regression check — `enrich.ts` calls `applyIgnoreDefaultForRepo` and only reads `.ignored`, so it should be unaffected by the widened return type).

- [ ] **Step 8: Apply the migration to the real Neon database**

With `DATABASE_URL` available in the environment (the same way it's sourced for `pnpm exec tsx src/pipeline/run.ts` today — see `~/.claude/CLAUDE.md`'s 1Password Environments notes if this isn't already set up in your shell):

Run: `cd app && pnpm exec drizzle-kit migrate`
Expected: reports one migration applied. This must happen now, not deferred — `ignore-rules.ts` now writes to `ignore_reasons` unconditionally whenever it runs, so the next real pipeline run would fail against an unmigrated database.

- [ ] **Step 9: Commit**

```bash
git add app/src/db/schema.ts app/src/pipeline/ignore-rules.ts app/src/pipeline/ignore-rules.test.ts app/src/pipeline/test-helpers/pglite-db.ts app/drizzle/
git commit -m "feat(app): persist ignore_reasons on repos"
```

---

### Task 2: Server-only DB singleton

**Files:**
- Create: `app/src/lib/server-db.ts`

**Interfaces:**
- Consumes: `createDb(databaseUrl: string)` from `app/src/db/client.ts` (existing).
- Produces: `db` — a module-level `NodePgDatabase` singleton, imported by Task 4's `dashboard.ts`.

This is a thin, un-unit-tested singleton (a live Postgres connection isn't something to fake in a unit test); it's exercised for real in Task 9's live verification.

- [ ] **Step 1: Write the singleton**

```ts
import { createDb } from "~/db/client";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} environment variable is required to run the dashboard — set it before running \`pnpm dev\`.`,
    );
  }
  return value;
}

export const db = createDb(requireEnv("DATABASE_URL"));
```

- [ ] **Step 2: Typecheck**

Run: `cd app && pnpm typecheck`
Expected: no new errors (this file isn't imported by anything yet, so it won't execute — the `requireEnv` throw only matters once Task 4 wires it in and the dev server actually starts).

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/server-db.ts
git commit -m "feat(app): add server-only DB singleton for the dashboard"
```

---

### Task 3: Dashboard data-shaping + ignore-write (testable core)

**Files:**
- Create: `app/src/lib/dashboard-queries.ts`
- Create: `app/src/lib/dashboard-queries.test.ts`

**Interfaces:**
- Consumes: `repos`, `commits`, `issues`, `pullRequests`, `repoAssessments` from `app/src/db/schema.ts`; `DrizzleDb` from `app/src/pipeline/db-types.ts`; `createTestDb` from `app/src/pipeline/test-helpers/pglite-db.ts` (test only).
- Produces: `getDashboardView(db: DrizzleDb): Promise<DashboardView>`, `setRepoIgnored(db: DrizzleDb, repoId: number, ignored: boolean): Promise<void>`, and the types `DashboardView`, `DashboardTotals`, `RepoCardView`, `RepoAssessmentView`, `RepoCommitView`, `RepoIssueView`, `RepoPullRequestView` — all consumed by Task 4 (`dashboard.ts`) and Tasks 5-7 (components).

Kept free of SolidStart's `query()`/`action()`/`"use server"` wrapping specifically so it's unit-testable with PGlite the same way `app/src/pipeline/ignore-rules.ts` already is — the wrapped, server-only entry points that the UI actually calls are Task 4.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/dashboard-queries.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { commits, issues, pullRequests, repoAssessments, repos } from "../db/schema";
import type { DrizzleDb } from "../pipeline/db-types";
import { createTestDb } from "../pipeline/test-helpers/pglite-db";
import { getDashboardView, setRepoIgnored } from "./dashboard-queries";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

async function insertRepo(
  db: DrizzleDb,
  overrides: Partial<typeof repos.$inferInsert> = {},
): Promise<void> {
  await db.insert(repos).values({
    repoId: 1,
    fullName: "sdpilon/example",
    isFork: false,
    isArchived: false,
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });
}

describe("getDashboardView", () => {
  it("returns a repo's latest assessment, including README from its input snapshot", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { isPrivate: true });
    await db.insert(repoAssessments).values([
      {
        repoId: 1,
        runId: "run-1",
        inputHash: "hash-1",
        pct: 40,
        band: "warn",
        label: "In progress",
        text: "old assessment",
        gaps: ["old gap"],
        inputSnapshot: { readmeText: "old readme" },
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        repoId: 1,
        runId: "run-2",
        inputHash: "hash-2",
        pct: 80,
        band: "good",
        label: "Shipped",
        text: "new assessment",
        gaps: [],
        inputSnapshot: { readmeText: "new readme" },
        createdAt: new Date("2026-02-01T00:00:00Z"),
      },
    ]);

    const view = await getDashboardView(db);
    expect(view.repos).toHaveLength(1);
    expect(view.repos[0].assessment).toEqual({
      pct: 80,
      band: "good",
      label: "Shipped",
      text: "new assessment",
      gaps: [],
      readmeText: "new readme",
    });
    expect(view.totals.privateCount).toBe(1);
  });

  it("falls back to 'Not yet assessed' with no README for a repo with no assessment row", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db);

    const view = await getDashboardView(db);
    expect(view.repos[0].assessment).toEqual({
      pct: null,
      band: "none",
      label: "Not yet assessed",
      text: "",
      gaps: [],
      readmeText: null,
    });
  });

  it("only surfaces ignore_reasons for auto-ignored repos, not manually-ignored ones", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, {
      isIgnored: true,
      ignoreSource: "auto",
      ignoreReasons: ["no README", "no activity"],
    });

    const view = await getDashboardView(db);
    expect(view.repos[0].ignoreReasons).toEqual(["no README", "no activity"]);

    await db.update(repos).set({ ignoreSource: "manual" }).where(eq(repos.repoId, 1));
    const manualView = await getDashboardView(db);
    expect(manualView.repos[0].ignoreReasons).toEqual([]);
  });

  it("aggregates totals across multiple repos' commits/issues/prs", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { repoId: 1, fullName: "sdpilon/one" });
    await insertRepo(db, { repoId: 2, fullName: "sdpilon/two" });
    await db.insert(commits).values([
      { repoId: 1, sha: "a", firstIngestedRunId: "run-1" },
      { repoId: 2, sha: "b", firstIngestedRunId: "run-1" },
    ]);
    await db.insert(pullRequests).values([
      { repoId: 1, number: 1, state: "open", lastUpdatedRunId: "run-1" },
      {
        repoId: 2,
        number: 1,
        state: "closed",
        mergedAt: new Date("2026-01-05T00:00:00Z"),
        lastUpdatedRunId: "run-1",
      },
    ]);
    await db.insert(issues).values([{ repoId: 1, number: 1, state: "open", lastUpdatedRunId: "run-1" }]);

    const view = await getDashboardView(db);
    expect(view.totals).toEqual({
      repoCount: 2,
      privateCount: 0,
      commitCount: 2,
      prCount: 2,
      mergedPrCount: 1,
      issueCount: 1,
    });
  });
});

describe("setRepoIgnored", () => {
  it("sets is_ignored and marks ignore_source manual", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { ignoreSource: "auto" });

    await setRepoIgnored(db, 1, true);

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(true);
    expect(row.ignoreSource).toBe("manual");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && pnpm vitest run src/lib/dashboard-queries.test.ts`
Expected: FAIL with "Cannot find module './dashboard-queries'" (module doesn't exist yet).

- [ ] **Step 3: Write `dashboard-queries.ts`**

```ts
import { desc, eq } from "drizzle-orm";
import { commits, issues, pullRequests, repoAssessments, repos } from "../db/schema";
import type { DrizzleDb } from "../pipeline/db-types";

/**
 * Read-and-shape logic for the dashboard, plus the ignore-toggle write.
 * Kept free of SolidStart's "use server"/query()/action() wrapping (see
 * ~/lib/dashboard.ts) so it can be unit-tested against a real (PGlite)
 * Postgres the same way pipeline/ code already is, rather than only being
 * exercisable through a live SSR request.
 */

export interface RepoAssessmentView {
  pct: number | null;
  band: string;
  label: string;
  text: string;
  gaps: string[];
  readmeText: string | null;
}

export interface RepoCommitView {
  sha: string;
  authoredAt: Date | null;
  message: string | null;
}

export interface RepoIssueView {
  number: number;
  title: string | null;
  state: string | null;
  createdAt: Date | null;
}

export interface RepoPullRequestView {
  number: number;
  title: string | null;
  state: string | null;
  createdAt: Date | null;
  mergedAt: Date | null;
}

export interface RepoCardView {
  repoId: number;
  fullName: string;
  htmlUrl: string | null;
  description: string | null;
  language: string | null;
  isPrivate: boolean;
  isIgnored: boolean;
  ignoreReasons: string[];
  assessment: RepoAssessmentView;
  commits: RepoCommitView[];
  issues: RepoIssueView[];
  pullRequests: RepoPullRequestView[];
}

export interface DashboardTotals {
  repoCount: number;
  privateCount: number;
  commitCount: number;
  prCount: number;
  mergedPrCount: number;
  issueCount: number;
}

export interface DashboardView {
  totals: DashboardTotals;
  repos: RepoCardView[];
}

function groupByRepoId<T extends { repoId: number }>(rows: T[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const bucket = map.get(row.repoId);
    if (bucket) bucket.push(row);
    else map.set(row.repoId, [row]);
  }
  return map;
}

/** `rows` must already be ordered by (repoId, createdAt DESC) — the first row seen per repoId is kept as "latest". */
function latestByRepoId<T extends { repoId: number }>(rows: T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const row of rows) {
    if (!map.has(row.repoId)) map.set(row.repoId, row);
  }
  return map;
}

export async function getDashboardView(db: DrizzleDb): Promise<DashboardView> {
  const [repoRows, assessmentRows, commitRows, issueRows, prRows] = await Promise.all([
    db.select().from(repos).orderBy(repos.fullName),
    db
      .select()
      .from(repoAssessments)
      .orderBy(repoAssessments.repoId, desc(repoAssessments.createdAt)),
    db.select().from(commits).orderBy(desc(commits.authoredAt)),
    db.select().from(issues).orderBy(desc(issues.createdAt)),
    db.select().from(pullRequests).orderBy(desc(pullRequests.createdAt)),
  ]);

  const latestAssessmentByRepoId = latestByRepoId(assessmentRows);
  const commitsByRepoId = groupByRepoId(commitRows);
  const issuesByRepoId = groupByRepoId(issueRows);
  const prsByRepoId = groupByRepoId(prRows);

  const repoViews: RepoCardView[] = repoRows.map((repo) => {
    const assessmentRow = latestAssessmentByRepoId.get(repo.repoId);
    const inputSnapshot = assessmentRow?.inputSnapshot as { readmeText?: string } | null | undefined;
    const assessment: RepoAssessmentView = assessmentRow
      ? {
          pct: assessmentRow.pct,
          band: assessmentRow.band ?? "none",
          label: assessmentRow.label ?? "Not yet assessed",
          text: assessmentRow.text ?? "",
          gaps: assessmentRow.gaps ?? [],
          readmeText: inputSnapshot?.readmeText ?? null,
        }
      : { pct: null, band: "none", label: "Not yet assessed", text: "", gaps: [], readmeText: null };

    return {
      repoId: repo.repoId,
      fullName: repo.fullName,
      htmlUrl: repo.htmlUrl,
      description: repo.description,
      language: repo.language,
      isPrivate: repo.isPrivate ?? false,
      isIgnored: repo.isIgnored,
      ignoreReasons: repo.isIgnored && repo.ignoreSource === "auto" ? (repo.ignoreReasons ?? []) : [],
      assessment,
      commits: (commitsByRepoId.get(repo.repoId) ?? []).map((c) => ({
        sha: c.sha,
        authoredAt: c.authoredAt,
        message: c.message,
      })),
      issues: (issuesByRepoId.get(repo.repoId) ?? []).map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        createdAt: i.createdAt,
      })),
      pullRequests: (prsByRepoId.get(repo.repoId) ?? []).map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        createdAt: p.createdAt,
        mergedAt: p.mergedAt,
      })),
    };
  });

  const totals: DashboardTotals = {
    repoCount: repoViews.length,
    privateCount: repoViews.filter((r) => r.isPrivate).length,
    commitCount: repoViews.reduce((sum, r) => sum + r.commits.length, 0),
    prCount: repoViews.reduce((sum, r) => sum + r.pullRequests.length, 0),
    mergedPrCount: repoViews.reduce((sum, r) => sum + r.pullRequests.filter((p) => p.mergedAt).length, 0),
    issueCount: repoViews.reduce((sum, r) => sum + r.issues.length, 0),
  };

  return { totals, repos: repoViews };
}

export async function setRepoIgnored(db: DrizzleDb, repoId: number, ignored: boolean): Promise<void> {
  await db
    .update(repos)
    .set({ isIgnored: ignored, ignoreSource: "manual" })
    .where(eq(repos.repoId, repoId));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && pnpm vitest run src/lib/dashboard-queries.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `cd app && pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/dashboard-queries.ts app/src/lib/dashboard-queries.test.ts
git commit -m "feat(app): add dashboard data-shaping and ignore-write core"
```

---

### Task 4: SolidStart server-function wrappers

**Files:**
- Create: `app/src/lib/dashboard.ts`

**Interfaces:**
- Consumes: `getDashboardView`, `setRepoIgnored` from `app/src/lib/dashboard-queries.ts` (Task 3); `db` from `app/src/lib/server-db.ts` (Task 2); `query`, `action`, `json` from `@solidjs/router`.
- Produces: `getDashboardData` (a `CachedFunction` — call as `getDashboardData()`, has `.key: string`), `toggleIgnore` (an `Action<[repoId: number, ignored: boolean], null>`) — both consumed by Tasks 6-8 (components, route).

This file has no unit test — `query()`/`action()` need a live SolidStart router context to run meaningfully, and the logic they wrap is already covered by Task 3's tests. It's exercised for real in Task 9.

- [ ] **Step 1: Write the wrappers**

```ts
import { action, json, query } from "@solidjs/router";
import { getDashboardView, setRepoIgnored } from "./dashboard-queries";
import { db } from "./server-db";

export const getDashboardData = query(async () => {
  "use server";
  return getDashboardView(db);
}, "dashboard");

export const toggleIgnore = action(async (repoId: number, ignored: boolean) => {
  "use server";
  await setRepoIgnored(db, repoId, ignored);
  return json(null, { revalidate: getDashboardData.key });
}, "toggleIgnore");
```

- [ ] **Step 2: Typecheck**

Run: `cd app && pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/dashboard.ts
git commit -m "feat(app): add SolidStart server functions for the dashboard"
```

---

### Task 5: `Totals` component

**Files:**
- Create: `app/src/components/Totals.tsx`

**Interfaces:**
- Consumes: `DashboardTotals` from `app/src/lib/dashboard-queries.ts`.
- Produces: default-exported `Totals` component, consumed by Task 8 (`index.tsx`).

No component-test framework exists in this project (see spec's Testing section) — verified visually in Task 9.

- [ ] **Step 1: Write the component**

```tsx
import { For } from "solid-js";
import type { DashboardTotals } from "~/lib/dashboard-queries";

export default function Totals(props: { totals: DashboardTotals }) {
  const tiles = () =>
    [
      [props.totals.repoCount, "active repos"],
      [props.totals.privateCount, "private"],
      [props.totals.commitCount, "commits"],
      [`${props.totals.mergedPrCount}/${props.totals.prCount}`, "PRs merged/opened"],
      [props.totals.issueCount, "issues touched"],
    ] as const;

  return (
    <div class="totals">
      <For each={tiles()}>
        {([n, l]) => (
          <div class="tile">
            <div class="n">{n}</div>
            <div class="l">{l}</div>
          </div>
        )}
      </For>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `cd app && pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/Totals.tsx
git commit -m "feat(app): add Totals component"
```

---

### Task 6: `CollapsibleSection` component

**Files:**
- Create: `app/src/components/CollapsibleSection.tsx`

**Interfaces:**
- Produces: default-exported `CollapsibleSection` component (`{ title: string; count: string; children: JSX.Element }`), consumed by Task 7 (`RepoCard`).

- [ ] **Step 1: Write the component**

```tsx
import type { JSX } from "solid-js";

export default function CollapsibleSection(props: {
  title: string;
  count: string;
  children: JSX.Element;
}) {
  return (
    <details>
      <summary>
        {props.title} <span class="count">{props.count}</span>
      </summary>
      <div class="body">{props.children}</div>
    </details>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `cd app && pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/CollapsibleSection.tsx
git commit -m "feat(app): add CollapsibleSection component"
```

---

### Task 7: `RepoCard` component

**Files:**
- Create: `app/src/components/RepoCard.tsx`

**Interfaces:**
- Consumes: `RepoCardView` from `app/src/lib/dashboard-queries.ts`; `toggleIgnore` from `app/src/lib/dashboard.ts`; `CollapsibleSection` from Task 6; `useAction`/`useSubmission` from `@solidjs/router`.
- Produces: default-exported `RepoCard` component (`{ repo: RepoCardView }`), consumed by Task 8 (`index.tsx`).

- [ ] **Step 1: Write the component**

```tsx
import { useAction, useSubmission } from "@solidjs/router";
import { For, Show } from "solid-js";
import CollapsibleSection from "~/components/CollapsibleSection";
import { toggleIgnore } from "~/lib/dashboard";
import type { RepoCardView } from "~/lib/dashboard-queries";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function formatDate(value: Date | null): string {
  return value ? dateFormat.format(value) : "";
}

function meterColor(pct: number | null): string {
  if (pct == null) return "var(--ink-3)";
  if (pct >= 80) return "var(--good)";
  if (pct >= 40) return "var(--warn)";
  return "var(--crit)";
}

export default function RepoCard(props: { repo: RepoCardView }) {
  const toggle = useAction(toggleIgnore);
  const submission = useSubmission(toggleIgnore, (input) => input[0] === props.repo.repoId);

  async function handleChange(event: Event & { currentTarget: HTMLInputElement }) {
    const next = event.currentTarget.checked;
    try {
      await toggle(props.repo.repoId, next);
    } catch (err) {
      event.currentTarget.checked = !next;
      alert(`Couldn't update ignore state: ${(err as Error).message}`);
    }
  }

  const shortName = () => props.repo.fullName.split("/")[1];
  const assessment = () => props.repo.assessment;

  return (
    <article class="repo" classList={{ "is-ignored": props.repo.isIgnored }}>
      <div class="repo-head">
        <div class="toprow">
          <h2>
            <a href={`https://github.com/${props.repo.fullName}`} target="_blank" rel="noopener">
              {shortName()}
            </a>
          </h2>
          <span class="badge" classList={{ private: props.repo.isPrivate }}>
            {props.repo.isPrivate ? "private" : "public"}
          </span>
          <Show when={props.repo.language}>
            <span class="lang">{props.repo.language}</span>
          </Show>
          <label class="ignore-toggle">
            <input
              type="checkbox"
              checked={props.repo.isIgnored}
              disabled={submission.pending}
              onChange={handleChange}
            />
            Ignore
          </label>
          <Show when={props.repo.ignoreReasons.length > 0}>
            <span class="ignore-reason">auto: {props.repo.ignoreReasons.join(", ")}</span>
          </Show>
        </div>
        <Show when={props.repo.description}>
          <p class="desc">{props.repo.description}</p>
        </Show>
        <div class="meter-row">
          <span class={`status-chip s-${assessment().band}`}>{assessment().label}</span>
          <div
            class="meter"
            role="img"
            aria-label={`Estimated completion ${
              assessment().pct == null ? "not measurable" : `${assessment().pct} percent`
            }`}
          >
            <div
              style={{
                width: `${assessment().pct ?? 0}%`,
                background: meterColor(assessment().pct),
              }}
            />
          </div>
          <span class="meter-pct">{assessment().pct == null ? "n/a" : `${assessment().pct}%`}</span>
        </div>
      </div>
      <div class="assess">
        <div class="eyebrow">AI assessment — stated goals vs. reality</div>
        <p>{assessment().text}</p>
        <Show when={assessment().gaps.length > 0}>
          <ul>
            <For each={assessment().gaps}>{(gap) => <li>{gap}</li>}</For>
          </ul>
        </Show>
      </div>
      <div class="raw">
        <CollapsibleSection title="Commits" count={String(props.repo.commits.length)}>
          <Show when={props.repo.commits.length > 0} fallback={<div class="empty">No commits recorded.</div>}>
            <table class="log">
              <For each={props.repo.commits}>
                {(commit) => (
                  <tr>
                    <td class="date">{formatDate(commit.authoredAt)}</td>
                    <td class="sha">{commit.sha}</td>
                    <td class="msg">{commit.message}</td>
                  </tr>
                )}
              </For>
            </table>
          </Show>
        </CollapsibleSection>
        <CollapsibleSection title="Pull requests" count={String(props.repo.pullRequests.length)}>
          <Show
            when={props.repo.pullRequests.length > 0}
            fallback={<div class="empty">No PRs opened or merged.</div>}
          >
            <table class="log">
              <For each={props.repo.pullRequests}>
                {(pr) => (
                  <tr>
                    <td class="date">{formatDate(pr.createdAt)}</td>
                    <td class={`pr-state ${pr.mergedAt ? "merged" : pr.state}`}>
                      #{pr.number} {pr.mergedAt ? "merged" : pr.state}
                    </td>
                    <td class="msg">{pr.title}</td>
                  </tr>
                )}
              </For>
            </table>
          </Show>
        </CollapsibleSection>
        <CollapsibleSection title="Issues" count={String(props.repo.issues.length)}>
          <Show when={props.repo.issues.length > 0} fallback={<div class="empty">No issue activity.</div>}>
            <table class="log">
              <For each={props.repo.issues}>
                {(issue) => (
                  <tr>
                    <td class="date">{formatDate(issue.createdAt)}</td>
                    <td class={`pr-state ${issue.state}`}>
                      #{issue.number} {issue.state}
                    </td>
                    <td class="msg">{issue.title}</td>
                  </tr>
                )}
              </For>
            </table>
          </Show>
        </CollapsibleSection>
        <CollapsibleSection
          title="README"
          count={props.repo.assessment.readmeText ? `${props.repo.assessment.readmeText.length} chars` : "missing"}
        >
          <Show
            when={props.repo.assessment.readmeText}
            fallback={<div class="empty">Not yet assessed — no README captured.</div>}
          >
            <pre class="readme">{props.repo.assessment.readmeText}</pre>
          </Show>
        </CollapsibleSection>
      </div>
    </article>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `cd app && pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/RepoCard.tsx
git commit -m "feat(app): add RepoCard component"
```

---

### Task 8: Wire the real page, port styling, remove scaffold

**Files:**
- Modify (rewrite): `app/src/routes/index.tsx`
- Modify: `app/src/app.tsx` (remove scaffold nav/title)
- Modify (rewrite): `app/src/app.css` (port `tracker.html`'s styling)
- Delete: `app/src/components/Counter.tsx`, `app/src/components/Counter.css`

**Interfaces:**
- Consumes: `getDashboardData` from Task 4; `Totals` (Task 5), `RepoCard` (Task 7).

- [ ] **Step 1: Rewrite `index.tsx`**

```tsx
import { Title } from "@solidjs/meta";
import { createAsync } from "@solidjs/router";
import { For, Show } from "solid-js";
import RepoCard from "~/components/RepoCard";
import Totals from "~/components/Totals";
import { getDashboardData } from "~/lib/dashboard";

export default function Home() {
  const data = createAsync(() => getDashboardData());

  return (
    <div class="wrap">
      <Title>GitHub Project Tracker</Title>
      <header class="page">
        <h1>Project completion tracker</h1>
        <p class="sub">
          github.com/<code>sdpilon</code> · live from Postgres, refreshed by the enrichment pipeline
        </p>
        <div class="notice">
          Assessments are Claude's reading of each README's stated goals against actual commits, PRs, and
          issues — a judgment call about "stated scope shipped," not code coverage.
        </div>
      </header>

      <Show when={data()}>
        {(dashboard) => (
          <>
            <Totals totals={dashboard().totals} />
            <div id="repos">
              <For each={dashboard().repos}>{(repo) => <RepoCard repo={repo} />}</For>
            </div>
          </>
        )}
      </Show>

      <footer class="page">
        Percentages are judgment calls about "stated scope shipped," not code coverage. Ignored repos are
        excluded from AI assessment — toggle the checkbox on any repo to include or exclude it.
      </footer>
    </div>
  );
}
```

- [ ] **Step 2: Clean up `app.tsx`**

Replace the full contents of `app/src/app.tsx`:

```tsx
import { MetaProvider } from "@solidjs/meta";
import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import "./app.css";

export default function App() {
  return (
    <Router
      root={(props) => (
        <MetaProvider>
          <Suspense>{props.children}</Suspense>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
```

(Drops the demo `Index`/`About` nav links and placeholder `<Title>` — `index.tsx` now sets its own title, and the nav bar has no place in a parity-focused single-dashboard page.)

- [ ] **Step 3: Port the CSS**

Replace the full contents of `app/src/app.css` with `tracker.html`'s existing `<style>` block (repo root `tracker.html` lines 2-178) verbatim — the `:root` custom properties (light/dark theme via `prefers-color-scheme` and `data-theme` override), and every `.wrap`/`.totals`/`.tile`/`.repo`/`.badge`/`.ignore-toggle`/`.meter`/`.status-chip`/`.assess`/`.raw`/`table.log`/`.pr-state`/`.readme`/`.empty`/`footer.page` rule. Read that block directly from `tracker.html` (`sed -n '2,178p' tracker.html` from the repo root) rather than retyping it by hand, to avoid transcription drift from the original.

- [ ] **Step 4: Delete the unused Counter scaffold**

```bash
git rm app/src/components/Counter.tsx app/src/components/Counter.css
```

- [ ] **Step 5: Typecheck, lint, and unit-test**

Run: `cd app && pnpm typecheck && pnpm lint && pnpm test`
Expected: no errors, all existing tests still pass (nothing in this step changes `app/src/pipeline/` or `app/src/lib/*.test.ts` behavior).

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/index.tsx app/src/app.tsx app/src/app.css
git commit -m "feat(app): wire the real dashboard page and port tracker.html styling"
```

---

### Task 9: Live verification

Not a unit-testable task — this is the step the spec calls out explicitly (`getDashboardData`/`toggleIgnore` need a live router+DB context; parity is verified visually, matching this project's established `run-github-project-tracker`/`verify` skill pattern).

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server against the real Neon Postgres**

With `DATABASE_URL` available in the environment (same sourcing as Task 1 Step 8):

Run: `cd app && pnpm dev`
Expected: starts without throwing `server-db.ts`'s `requireEnv` error; visiting `http://localhost:3000/` (or whatever port Vite reports) renders the dashboard.

- [ ] **Step 2: Compare against `tracker.html` for a representative mix of repos**

Pick a handful of repos covering: an assessed, non-ignored repo (has an assessment, README shows real content); an auto-ignored repo (checkbox checked, "auto: ..." reason label visible, README section shows "Not yet assessed — no README captured"); a manually-ignored repo if one exists (checkbox checked, no reason label). Confirm totals tiles, meter/status-chip colors, and collapsible commits/PRs/issues sections match `tracker.html`'s rendering for the same repos (open `tracker.html` directly in a browser tab side by side, or via `pnpm --dir .. dev` per the repo-root `run-github-project-tracker` skill).

- [ ] **Step 3: Confirm the ignore toggle persists to Postgres, not just client state**

Toggle a repo's "Ignore" checkbox off then on in the browser. After each toggle, independently confirm the DB value changed — e.g. `psql "$DATABASE_URL" -c "select is_ignored, ignore_source from repos where full_name = '<repo>';"` — rather than trusting the checkbox's own rendered state. Reload the page and confirm the toggled state survived the reload (proves it round-tripped through Postgres, not just local component state).

- [ ] **Step 4: Confirm a repo with zero `repo_assessments` rows renders without error**

If the live account doesn't currently have one, this is implicitly covered by any freshly-discovered-but-not-yet-enriched repo; if all repos happen to have assessments, skip this check but note it in the handoff rather than silently passing over it.

- [ ] **Step 5: Report results**

No commit for this task (verification only) — report what was checked and any discrepancies found back to the user before considering Phase 3 done. If a discrepancy surfaces, fix it in the relevant earlier task's files and re-run this task's steps rather than patching around it here.
