# Ignore 3-Way Control (Auto/Yes/No) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's boolean "Ignore" checkbox with a 3-way Auto/Yes/No control on each repo card, so users can put a repo back under automatic ignore-rule control — something the current checkbox can never do once touched.

**Architecture:** `repos.ignore_source` ('auto'|'manual') and `repos.is_ignored` already model this; only the UI and the write path need to change. "Yes"/"No" map to `ignore_source: 'manual'` with `is_ignored` true/false (as today). "Auto" sets `ignore_source: 'auto'` and leaves `is_ignored` untouched — it's recomputed for real on the next pipeline run by the existing, unmodified `applyIgnoreDefaultForRepo` (`app/src/pipeline/ignore-rules.ts`), which already skips any repo with `ignore_source === 'manual'`.

**Tech Stack:** SolidStart (`action`/`query`), Drizzle ORM, Postgres (PGlite in tests), Vitest.

## Global Constraints

- No schema migration: `ignore_source` already supports `'auto'`/`'manual'` (`app/src/db/schema.ts:47`); the Yes/No distinction is carried entirely by the existing `is_ignored` boolean, not a new column value.
- Selecting "Auto" must NOT recompute `is_ignored` synchronously — no live Octokit/README fetch inside the write path. It only flips `ignore_source` back to `'auto'`; recomputation happens on the next pipeline run via the existing `applyIgnoreDefaultForRepo`, which this plan does not modify.
- `assessment_source` has an identical shape/gate but is explicitly out of scope — do not touch `app/src/pipeline/enrich.ts` or add any UI for it.
- Run `pnpm typecheck && pnpm lint && pnpm test` from `app/` after every task (CLAUDE.md's baseline gate). The repo has not been flattened yet (that's a separate, later plan) — all paths below are relative to `app/`.
- This is a UI-touching change with no `.tsx` test infrastructure in this repo today (confirmed: zero `.test.tsx` files exist, `vitest.config.ts` only includes `src/**/*.test.ts`). Task 3 has no automated test step for that reason — do not invent one. Instead, after Task 3, attempt `pnpm dev` and exercise the control in a browser. If you cannot (e.g. no 1Password/DB access in this environment), report `DONE_WITH_CONCERNS` naming that gap explicitly rather than reporting plain `DONE`.

---

### Task 1: 3-way read/write logic in `dashboard-queries.ts`

**Files:**
- Modify: `app/src/lib/dashboard-queries.ts`
- Test: `app/src/lib/dashboard-queries.test.ts`

**Interfaces:**
- Produces: `export type IgnoreControlValue = "auto" | "yes" | "no"`; `RepoCardView.ignoreControl: IgnoreControlValue`; `export async function setRepoIgnoreControl(db: DrizzleDb, repoId: number, value: IgnoreControlValue): Promise<void>` (replaces `setRepoIgnored`, which this task removes).

- [ ] **Step 1: Write the failing tests**

In `app/src/lib/dashboard-queries.test.ts`, replace the existing `describe("setRepoIgnored", ...)` block (lines 142–154) with:

```ts
describe("setRepoIgnoreControl", () => {
  it("'yes' sets is_ignored true and marks ignore_source manual", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { ignoreSource: "auto" });

    await setRepoIgnoreControl(db, 1, "yes");

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(true);
    expect(row.ignoreSource).toBe("manual");
  });

  it("'no' sets is_ignored false and marks ignore_source manual", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { ignoreSource: "auto", isIgnored: true });

    await setRepoIgnoreControl(db, 1, "no");

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(false);
    expect(row.ignoreSource).toBe("manual");
  });

  it("'auto' restores ignore_source without recomputing is_ignored", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { ignoreSource: "manual", isIgnored: true });

    await setRepoIgnoreControl(db, 1, "auto");

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.ignoreSource).toBe("auto");
    expect(row.isIgnored).toBe(true); // unchanged until the next pipeline run
  });
});
```

Also add this new test inside the existing `describe("getDashboardView", ...)` block:

```ts
it("derives ignoreControl from ignore_source and is_ignored", async () => {
  const { db, close } = await createTestDb();
  cleanup = close;
  await insertRepo(db, { ignoreSource: "auto", isIgnored: false });

  const autoView = await getDashboardView(db);
  expect(autoView.repos[0].ignoreControl).toBe("auto");

  await db.update(repos).set({ ignoreSource: "manual", isIgnored: true }).where(eq(repos.repoId, 1));
  const yesView = await getDashboardView(db);
  expect(yesView.repos[0].ignoreControl).toBe("yes");

  await db.update(repos).set({ ignoreSource: "manual", isIgnored: false }).where(eq(repos.repoId, 1));
  const noView = await getDashboardView(db);
  expect(noView.repos[0].ignoreControl).toBe("no");
});
```

Update the top import line from `import { getDashboardView, setRepoIgnored } from "./dashboard-queries";` to `import { getDashboardView, setRepoIgnoreControl } from "./dashboard-queries";`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- dashboard-queries.test.ts`
Expected: FAIL — `setRepoIgnoreControl` is not exported yet, and `ignoreControl` is not on `RepoCardView`.

- [ ] **Step 3: Implement**

In `app/src/lib/dashboard-queries.ts`:

Add near the top (after the existing interfaces, before `RepoCardView`):

```ts
export type IgnoreControlValue = "auto" | "yes" | "no";
```

Add a field to `RepoCardView` (after `ignoreReasons: string[];`):

```ts
  ignoreControl: IgnoreControlValue;
```

In `getDashboardView`'s `repoRows.map` callback, add to the returned object (alongside the existing `ignoreReasons` line):

```ts
      ignoreControl: repo.ignoreSource === "auto" ? "auto" : repo.isIgnored ? "yes" : "no",
```

Replace `setRepoIgnored` entirely with:

```ts
export async function setRepoIgnoreControl(db: DrizzleDb, repoId: number, value: IgnoreControlValue): Promise<void> {
  if (value === "auto") {
    await db.update(repos).set({ ignoreSource: "auto" }).where(eq(repos.repoId, repoId));
    return;
  }
  await db
    .update(repos)
    .set({ isIgnored: value === "yes", ignoreSource: "manual" })
    .where(eq(repos.repoId, repoId));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- dashboard-queries.test.ts`
Expected: PASS (all tests in the file, including the pre-existing `getDashboardView` ones — don't just check the new ones).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. (This will surface `dashboard.ts`'s now-broken `setRepoIgnored` import — that's expected, fixed in Task 2.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard-queries.ts src/lib/dashboard-queries.test.ts
git commit -m "feat: add 3-way ignore control read/write to dashboard-queries"
```

---

### Task 2: Update `toggleIgnore` action to accept the 3-way value

**Files:**
- Modify: `app/src/lib/dashboard.ts`

**Interfaces:**
- Consumes: `IgnoreControlValue`, `setRepoIgnoreControl` from Task 1 (`~/lib/dashboard-queries`).
- Produces: `toggleIgnore` action now has signature `(repoId: number, value: IgnoreControlValue) => Promise<...>` (was `(repoId: number, ignored: boolean)`).

No test file exists for `dashboard.ts` by design — its own file lives thin/untested on purpose, with logic kept in `dashboard-queries.ts` specifically so it's unit-testable outside SolidStart's `"use server"` wrapping (see the doc comment at the top of `dashboard-queries.ts`). Task 1's tests already cover the logic this action delegates to. Do not add a test file here.

- [ ] **Step 1: Implement**

In `app/src/lib/dashboard.ts`, change:

```ts
import { getDashboardView, setRepoIgnored } from "./dashboard-queries";
```

to:

```ts
import { getDashboardView, setRepoIgnoreControl, type IgnoreControlValue } from "./dashboard-queries";
```

and change:

```ts
export const toggleIgnore = action(async (repoId: number, ignored: boolean) => {
  "use server";
  assertAuthenticated();
  await setRepoIgnored(db, repoId, ignored);
  return json(null, { revalidate: getDashboardData.key });
}, "toggleIgnore");
```

to:

```ts
export const toggleIgnore = action(async (repoId: number, value: IgnoreControlValue) => {
  "use server";
  assertAuthenticated();
  await setRepoIgnoreControl(db, repoId, value);
  return json(null, { revalidate: getDashboardData.key });
}, "toggleIgnore");
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors from `dashboard.ts` now. (`RepoCard.tsx` will still fail — expected, fixed in Task 3.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/dashboard.ts
git commit -m "feat: change toggleIgnore action to accept 3-way ignore control value"
```

---

### Task 3: Replace the checkbox with a 3-way segmented control in `RepoCard.tsx`

**Files:**
- Modify: `app/src/components/RepoCard.tsx`
- Modify: `app/src/app.css`

**Interfaces:**
- Consumes: `toggleIgnore` (now `(repoId, IgnoreControlValue)`) from Task 2; `RepoCardView.ignoreControl: IgnoreControlValue` from Task 1.

- [ ] **Step 1: Replace the checkbox markup and handler**

In `app/src/components/RepoCard.tsx`, change the import line:

```tsx
import type { RepoCardView } from "~/lib/dashboard-queries";
```

to:

```tsx
import type { IgnoreControlValue, RepoCardView } from "~/lib/dashboard-queries";
```

Replace the `handleChange` function (lines 24–32) with:

```tsx
  async function handleIgnoreChange(value: IgnoreControlValue) {
    try {
      await toggle(props.repo.repoId, value);
    } catch (err) {
      alert(`Couldn't update ignore state: ${(err as Error).message}`);
    }
  }
```

(No manual revert needed here, unlike the old checkbox handler: the radio inputs' `checked` state below is derived reactively from `props.repo.ignoreControl`, which SolidStart's action-triggered revalidation leaves unchanged on a failed write — nothing to roll back by hand.)

Replace the `<label class="ignore-toggle">...</label>` block (lines 52–60) with:

```tsx
          <div class="ignore-control" role="radiogroup" aria-label="Ignore status">
            <For each={["auto", "yes", "no"] as const}>
              {(value) => (
                <label classList={{ active: props.repo.ignoreControl === value }}>
                  <input
                    type="radio"
                    name={`ignore-${props.repo.repoId}`}
                    checked={props.repo.ignoreControl === value}
                    disabled={submission.pending}
                    onChange={() => handleIgnoreChange(value)}
                  />
                  {value === "auto" ? "Auto" : value === "yes" ? "Yes" : "No"}
                </label>
              )}
            </For>
          </div>
```

`For` is already imported from `solid-js` at the top of this file — no new import needed for it.

- [ ] **Step 2: Update CSS**

In `app/src/app.css`, replace these two rules:

```css
.ignore-toggle {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 0.72rem; color: var(--ink-2); cursor: pointer; user-select: none;
}
.ignore-toggle input { accent-color: var(--accent); cursor: pointer; }
```

with:

```css
.ignore-control {
  display: inline-flex; border: 1px solid var(--line); border-radius: 6px;
  overflow: hidden; font-size: 0.72rem;
}
.ignore-control label {
  position: relative; padding: 2px 8px; cursor: pointer;
  color: var(--ink-2); user-select: none;
}
.ignore-control label.active { background: var(--accent); color: var(--surface); }
.ignore-control input {
  position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer;
}
```

Leave `.ignore-reason` and `.repo.is-ignored` untouched — both still apply (the latter is set from `props.repo.isIgnored` at `RepoCard.tsx:38`, unchanged by this task).

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: PASS (no `.tsx` tests exist to run for this file — this just confirms Tasks 1–2's tests still pass and nothing else broke).

- [ ] **Step 5: Manual browser verification**

Run `pnpm dev`, open the dashboard, and confirm: each repo card shows an Auto/Yes/No control reflecting its current state; clicking "Yes" force-ignores and dims the card; clicking "No" force-includes; clicking "Auto" returns it to auto mode (dimming state stays as-is until the next pipeline run, per the Global Constraints above — this is expected, not a bug). If `pnpm dev` cannot be run in this environment (e.g. missing 1Password session), state that explicitly in the task report as a concern rather than skipping this step silently.

- [ ] **Step 6: Commit**

```bash
git add src/components/RepoCard.tsx src/app.css
git commit -m "feat: replace ignore checkbox with 3-way Auto/Yes/No segmented control"
```
