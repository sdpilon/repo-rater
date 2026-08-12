# Reframe Ignore-Control Semantics as Assess-Based Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the per-repo Auto/Yes/No control's underlying semantics from "is this ignored?" to "should this be assessed?", so selecting "Yes" assesses the repo (matching what a user reading "Yes" expects) instead of ignoring it.

**Architecture:** Pure rename-and-flip at the view/query layer. The `is_ignored`/`ignore_source`/`ignore_reasons` Postgres columns are untouched — only the exposed TypeScript type (`IgnoreControlValue` → `AssessControlValue`), the `RepoCardView` field that carries it (`ignoreControl` → `assessControl`), the query-layer setter (`setRepoIgnoreControl` → `setRepoAssessControl`), and the SolidStart action (`toggleIgnore` → `toggleAssess`) change name and, where they map "yes"/"no" onto `isIgnored`, invert that mapping.

**Tech Stack:** SolidStart, Drizzle ORM, Vitest, TypeScript, Biome (lint).

## Global Constraints

- Bug: tracker-st7. Related: tracker-1di (UI label/placement fix, depends on this landing first — already wired as a `bd` dependency, don't touch RepoCard.tsx's DOM layout, CSS classes, or visible label text/aria-label in this plan).
- The `is_ignored` DB column and `ignoreSource`/`ignoreReasons` fields on `RepoCardView`/`repos` schema stay exactly as named — this plan only renames the derived control type/field/functions, not storage.
- Run `pnpm typecheck && pnpm lint && pnpm test` (from `CLAUDE.md`) after the final task, before considering this done.
- Conventional Commits for every commit message (`type(scope): summary`, single line).

---

## File Structure

- `src/lib/dashboard-view.ts` — renames the `IgnoreControlValue` type to `AssessControlValue` and the `RepoCardView.ignoreControl` field to `assessControl`. Client-safe, no drizzle imports — keep it that way.
- `src/lib/dashboard-queries.ts` — renames/flips the `assessControl` derivation in `getDashboardView` and renames+flips `setRepoIgnoreControl` to `setRepoAssessControl`.
- `src/lib/dashboard.ts` — renames the `toggleIgnore` action to `toggleAssess` and updates its imports.
- `src/components/RepoCard.tsx` — updates imports and the two property-access sites (`props.repo.ignoreControl` → `props.repo.assessControl`) and the local handler name; no visible DOM/label/CSS changes.
- `src/middleware.ts` — doc-comment reference to `toggleIgnore` updated to `toggleAssess` (accuracy only, no behavior change).
- `CLAUDE.md` — two prose references to `toggleIgnore` updated to `toggleAssess` (accuracy only).
- `src/lib/dashboard-view.test.ts`, `src/lib/dashboard-queries.test.ts` — updated for the rename and the flipped yes/no mapping.

---

### Task 1: Flip semantics in the view/query layer

**Files:**
- Modify: `src/lib/dashboard-view.ts:11` (type), `src/lib/dashboard-view.ts:52` (field)
- Modify: `src/lib/dashboard-queries.ts:86` (derivation), `src/lib/dashboard-queries.ts:112-124` (`setRepoIgnoreControl` → `setRepoAssessControl`)
- Test: `src/lib/dashboard-view.test.ts`
- Test: `src/lib/dashboard-queries.test.ts`

**Interfaces:**
- Produces: `export type AssessControlValue = "auto" | "yes" | "no";` (same literal values as before — only the type name and its meaning change). `RepoCardView.assessControl: AssessControlValue`. `export async function setRepoAssessControl(db: DrizzleDb, repoId: number, value: AssessControlValue): Promise<void>`.
- New mapping (inverted from today): `assessControl` is `"auto"` when `ignoreSource === "auto"`; otherwise `"yes"` when `!isIgnored` (will be assessed), `"no"` when `isIgnored` (won't be assessed). `setRepoAssessControl(db, id, "yes")` sets `isIgnored: false`; `setRepoAssessControl(db, id, "no")` sets `isIgnored: true`; `setRepoAssessControl(db, id, "auto")` behaves exactly as `setRepoIgnoreControl` did for `"auto"` today (resets `ignoreSource` to `"auto"`, clears `ignoreReasons`, leaves `isIgnored` untouched).

- [ ] **Step 1: Update the failing fixture in `dashboard-view.test.ts`**

In `src/lib/dashboard-view.test.ts`, change line 14 from:

```typescript
    ignoreControl: "auto",
```

to:

```typescript
    assessControl: "auto",
```

- [ ] **Step 2: Run typecheck to confirm it now fails (proves the rename isn't done yet)**

Run: `pnpm typecheck`
Expected: FAIL — `Object literal may only specify known properties, and 'assessControl' does not exist in type 'RepoCardView'` (or similar) from `dashboard-view.test.ts`, plus a second error that `RepoCardView` is missing the required `ignoreControl` property.

- [ ] **Step 3: Rename the type and field in `dashboard-view.ts`**

In `src/lib/dashboard-view.ts`, change line 11 from:

```typescript
export type IgnoreControlValue = "auto" | "yes" | "no";
```

to:

```typescript
export type AssessControlValue = "auto" | "yes" | "no";
```

And change line 52 (inside the `RepoCardView` interface) from:

```typescript
  ignoreControl: IgnoreControlValue;
```

to:

```typescript
  assessControl: AssessControlValue;
```

- [ ] **Step 4: Run typecheck to confirm `dashboard-view.ts` and its test now compile**

Run: `pnpm typecheck`
Expected: The `dashboard-view.test.ts` error from Step 2 is gone. Remaining errors (if any) will be in `dashboard-queries.ts`/`dashboard-queries.test.ts`/`dashboard.ts`/`RepoCard.tsx` — expected at this point, fixed in later steps of this task and in Tasks 2–3.

- [ ] **Step 5: Write the failing tests for the flipped mapping in `dashboard-queries.test.ts`**

In `src/lib/dashboard-queries.test.ts`, replace the `it("derives ignoreControl from ignore_source and is_ignored", ...)` block (lines 141-160) with:

```typescript
  it("derives assessControl from ignore_source and is_ignored, inverted from is_ignored", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { ignoreSource: "auto", isIgnored: false });

    const autoView = await getDashboardView(db);
    expect(autoView.repos[0].assessControl).toBe("auto");

    await db.update(repos).set({ ignoreSource: "manual", isIgnored: true }).where(eq(repos.repoId, 1));
    const noView = await getDashboardView(db);
    expect(noView.repos[0].assessControl).toBe("no");

    await db.update(repos).set({ ignoreSource: "manual", isIgnored: false }).where(eq(repos.repoId, 1));
    const yesView = await getDashboardView(db);
    expect(yesView.repos[0].assessControl).toBe("yes");

    await db.update(repos).set({ ignoreSource: "auto", isIgnored: true }).where(eq(repos.repoId, 1));
    const autoIgnoredView = await getDashboardView(db);
    expect(autoIgnoredView.repos[0].assessControl).toBe("auto");
  });
```

Then replace the `describe("setRepoIgnoreControl", ...)` block (lines 163-199) with:

```typescript
describe("setRepoAssessControl", () => {
  it("'yes' sets is_ignored false (will be assessed) and marks ignore_source manual", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { ignoreSource: "auto", isIgnored: true });

    await setRepoAssessControl(db, 1, "yes");

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(false);
    expect(row.ignoreSource).toBe("manual");
  });

  it("'no' sets is_ignored true (won't be assessed) and marks ignore_source manual", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { ignoreSource: "auto", isIgnored: false });

    await setRepoAssessControl(db, 1, "no");

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(true);
    expect(row.ignoreSource).toBe("manual");
  });

  it("'auto' restores ignore_source without recomputing is_ignored", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { ignoreSource: "manual", isIgnored: true });

    await setRepoAssessControl(db, 1, "auto");

    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.ignoreSource).toBe("auto");
    expect(row.isIgnored).toBe(true); // unchanged until the next pipeline run
  });
});
```

Also update the import at the top of the file (line 6) from:

```typescript
import { getDashboardView, setRepoIgnoreControl } from "./dashboard-queries";
```

to:

```typescript
import { getDashboardView, setRepoAssessControl } from "./dashboard-queries";
```

- [ ] **Step 6: Run the test file to verify it fails**

Run: `pnpm test -- dashboard-queries`
Expected: FAIL — `setRepoAssessControl` is not exported / `assessControl` is `undefined` (the production code hasn't changed yet).

- [ ] **Step 7: Rename and flip the mapping in `dashboard-queries.ts`**

In `src/lib/dashboard-queries.ts`, change the import on lines 4-10 from:

```typescript
import {
  computeTotals,
  type DashboardView,
  type IgnoreControlValue,
  type RepoAssessmentView,
  type RepoCardView,
} from "./dashboard-view";
```

to:

```typescript
import {
  type AssessControlValue,
  computeTotals,
  type DashboardView,
  type RepoAssessmentView,
  type RepoCardView,
} from "./dashboard-view";
```

Change line 86 from:

```typescript
      ignoreControl: repo.ignoreSource === "auto" ? "auto" : repo.isIgnored ? "yes" : "no",
```

to:

```typescript
      assessControl: repo.ignoreSource === "auto" ? "auto" : repo.isIgnored ? "no" : "yes",
```

Change lines 112-124 from:

```typescript
export async function setRepoIgnoreControl(db: DrizzleDb, repoId: number, value: IgnoreControlValue): Promise<void> {
  if (value === "auto") {
    await db
      .update(repos)
      .set({ ignoreSource: "auto", ignoreReasons: null })
      .where(eq(repos.repoId, repoId));
    return;
  }
  await db
    .update(repos)
    .set({ isIgnored: value === "yes", ignoreSource: "manual" })
    .where(eq(repos.repoId, repoId));
}
```

to:

```typescript
export async function setRepoAssessControl(db: DrizzleDb, repoId: number, value: AssessControlValue): Promise<void> {
  if (value === "auto") {
    await db
      .update(repos)
      .set({ ignoreSource: "auto", ignoreReasons: null })
      .where(eq(repos.repoId, repoId));
    return;
  }
  await db
    .update(repos)
    .set({ isIgnored: value === "no", ignoreSource: "manual" })
    .where(eq(repos.repoId, repoId));
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test -- dashboard-view dashboard-queries`
Expected: PASS — all tests in both files green.

- [ ] **Step 9: Commit**

```bash
git add src/lib/dashboard-view.ts src/lib/dashboard-view.test.ts src/lib/dashboard-queries.ts src/lib/dashboard-queries.test.ts
git commit -m "refactor(dashboard): flip ignore-control semantics to assess-based"
```

---

### Task 2: Update consumers (`dashboard.ts` action, `RepoCard.tsx`)

**Files:**
- Modify: `src/lib/dashboard.ts`
- Modify: `src/components/RepoCard.tsx`

**Interfaces:**
- Consumes: `AssessControlValue` and `setRepoAssessControl` from `./dashboard-queries` (produced in Task 1).
- Produces: `export const toggleAssess = action(async (repoId: number, value: AssessControlValue) => {...}, "toggleAssess")` — same signature shape as the old `toggleIgnore`, just renamed, for `RepoCard.tsx` to call.

- [ ] **Step 1: Rename the action in `dashboard.ts`**

In `src/lib/dashboard.ts`, change line 3 from:

```typescript
import { getDashboardView, setRepoIgnoreControl, type IgnoreControlValue } from "./dashboard-queries";
```

to:

```typescript
import { getDashboardView, setRepoAssessControl, type AssessControlValue } from "./dashboard-queries";
```

Change lines 12-17 from:

```typescript
export const toggleIgnore = action(async (repoId: number, value: IgnoreControlValue) => {
  "use server";
  assertAuthenticated();
  await setRepoIgnoreControl(db, repoId, value);
  return json(null, { revalidate: getDashboardData.key });
}, "toggleIgnore");
```

to:

```typescript
export const toggleAssess = action(async (repoId: number, value: AssessControlValue) => {
  "use server";
  assertAuthenticated();
  await setRepoAssessControl(db, repoId, value);
  return json(null, { revalidate: getDashboardData.key });
}, "toggleAssess");
```

- [ ] **Step 2: Run typecheck to confirm `dashboard.ts` now compiles**

Run: `pnpm typecheck`
Expected: The errors referencing `dashboard.ts` are gone. Remaining errors (if any) are in `RepoCard.tsx`, fixed next.

- [ ] **Step 3: Update `RepoCard.tsx`'s imports and property access**

In `src/components/RepoCard.tsx`, change line 4-5 from:

```typescript
import { toggleIgnore } from "~/lib/dashboard";
import type { IgnoreControlValue, RepoCardView } from "~/lib/dashboard-queries";
```

to:

```typescript
import { toggleAssess } from "~/lib/dashboard";
import type { AssessControlValue, RepoCardView } from "~/lib/dashboard-queries";
```

Change lines 21-30 from:

```typescript
  const toggle = useAction(toggleIgnore);
  const submission = useSubmission(toggleIgnore, (input) => input[0] === props.repo.repoId);

  async function handleIgnoreChange(value: IgnoreControlValue) {
    try {
      await toggle(props.repo.repoId, value);
    } catch (err) {
      alert(`Couldn't update ignore state: ${(err as Error).message}`);
    }
  }
```

to:

```typescript
  const toggle = useAction(toggleAssess);
  const submission = useSubmission(toggleAssess, (input) => input[0] === props.repo.repoId);

  async function handleAssessChange(value: AssessControlValue) {
    try {
      await toggle(props.repo.repoId, value);
    } catch (err) {
      alert(`Couldn't update assess state: ${(err as Error).message}`);
    }
  }
```

Change lines 53 and 57-59 (inside the `<For each={["auto", "yes", "no"] as const}>` block) from:

```typescript
                <label classList={{ active: props.repo.ignoreControl === value }}>
                  <input
                    type="radio"
                    name={`ignore-${props.repo.repoId}`}
                    checked={props.repo.ignoreControl === value}
                    disabled={submission.pending}
                    onChange={() => handleIgnoreChange(value)}
                  />
```

to:

```typescript
                <label classList={{ active: props.repo.assessControl === value }}>
                  <input
                    type="radio"
                    name={`ignore-${props.repo.repoId}`}
                    checked={props.repo.assessControl === value}
                    disabled={submission.pending}
                    onChange={() => handleAssessChange(value)}
                  />
```

Leave the `name={`ignore-${...}`}` attribute, the surrounding `.ignore-control`/`.ignore-reason` CSS classes, the `role="radiogroup" aria-label="Ignore status"`, and the visible "Auto"/"Yes"/"No" label text exactly as they are — those are DOM/label/positioning concerns reserved for tracker-1di, not this task.

- [ ] **Step 4: Run typecheck and the full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS — no type errors, all existing tests green (`RepoCard.tsx` has no dedicated test file, so this step's coverage is the typecheck plus the Task 1 unit tests still passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dashboard.ts src/components/RepoCard.tsx
git commit -m "refactor(dashboard): rename toggleIgnore action to toggleAssess"
```

---

### Task 3: Fix stale doc references and final verification

**Files:**
- Modify: `src/middleware.ts:18`
- Modify: `CLAUDE.md` (lines 7 and 19)

**Interfaces:**
- None — doc/comment-only changes, no code interface changes.

- [ ] **Step 1: Update the doc comment in `src/middleware.ts`**

Change line 18 from:

```
 * `assertAuthenticated()` guard inside `getDashboardData`/`toggleIgnore`
```

to:

```
 * `assertAuthenticated()` guard inside `getDashboardData`/`toggleAssess`
```

- [ ] **Step 2: Update `CLAUDE.md`'s two references**

On line 19 of `CLAUDE.md`, change:

```
`assertAuthenticated()` is also called directly inside `getDashboardData`/`toggleIgnore` (`src/lib/dashboard.ts`) as defense in depth at the RPC layer.
```

to:

```
`assertAuthenticated()` is also called directly inside `getDashboardData`/`toggleAssess` (`src/lib/dashboard.ts`) as defense in depth at the RPC layer.
```

On line 7 of `CLAUDE.md`, change the clause:

```
Each repo card has an Auto/Yes/No ignore control that persists straight to Postgres via a SolidStart server action ("Auto" hands the repo back to automatic recomputation; "Yes"/"No" force it either way), so future pipeline runs skip generating an assessment for ignored repos.
```

to:

```
Each repo card has an Auto/Yes/No assess control that persists straight to Postgres via a SolidStart server action ("Auto" hands the repo back to automatic recomputation; "Yes" force-assesses the repo, "No" force-ignores it), so future pipeline runs skip generating an assessment for ignored repos.
```

- [ ] **Step 3: Run the full baseline gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS — zero type errors, zero lint errors, all tests green.

- [ ] **Step 4: Commit**

```bash
git add src/middleware.ts CLAUDE.md
git commit -m "docs: update toggleIgnore references to toggleAssess"
```

---

## Post-plan

After Task 3's commit, this issue's acceptance criteria are met:
- Control type/field naming reflects assess semantics (`AssessControlValue`, `assessControl`).
- Selecting Yes assesses the repo (`isIgnored: false`); selecting No ignores it (`isIgnored: true`).
- Auto behavior is unchanged (verified by the unchanged "auto" branch in `setRepoAssessControl` and the passing "auto" test cases).
- `dashboard-queries.test.ts` and `dashboard-view.test.ts` (the two existing test files touching this — there is no separate `dashboard.test.ts` in this repo) are updated and passing.
- `RepoCard.tsx` has no layout/label/position changes — only import and property-access renames.

Report back to close `tracker-st7` in `bd` (`bd close tracker-st7`) and note that `tracker-1di` (blocked on this) is now unblocked and ready.
