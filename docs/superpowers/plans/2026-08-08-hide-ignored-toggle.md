# Hide Ignored Repos Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "hide ignored repos" toggle to the dashboard header, near the Totals tiles, so ignored repos can be filtered out of the list entirely (not just dimmed) — with the Totals tiles recomputing to match whatever's actually visible.

**Architecture:** Pure client-side filter. `dashboard().repos`/`dashboard().totals` (from the server, unfiltered) stay the source of truth; a local `createSignal` filters the repo list for display and, when the filter is on, recomputes totals from the filtered set via a shared `computeTotals` function extracted from `getDashboardView` (so server and client totals math can never drift apart). No server/query change, no schema change.

**Tech Stack:** SolidStart (`createSignal`, `onMount`), `solid-js`, localStorage.

## Global Constraints

- No server-side change: `getDashboardView` keeps returning the full, unfiltered `DashboardTotals`/`RepoCardView[]` exactly as today — filtering happens entirely in `src/routes/index.tsx` after the data arrives.
- Default is **off** (show all repos) — matches current behavior until the user opts in. Do not default to `true`.
- localStorage reads must be guarded for SSR (`onMount`, which only runs client-side in SolidStart) — referencing `localStorage` directly in a signal initializer or during render breaks server rendering.
- When the filter is **off**, Totals must render exactly `dashboard().totals` unchanged (the existing all-repos counts, including the current "active repos" tile behavior) — do not always recompute. Recompute only applies when the filter is **on**.
- Run `pnpm typecheck && pnpm lint && pnpm test` from `app/` after every task (CLAUDE.md's baseline gate).
- Same caveat as the prior ignore-control plan: no `.tsx` test infrastructure exists in this repo. Task 2 (the actual toggle UI) is pure client interactivity — unlike the 3-way control, this one **cannot** be verified by inspecting server-rendered HTML alone (the filtered/unfiltered state only exists after client JS runs), so a real browser click-through is the only way to confirm it works. Flag this plainly in that task's report; do not claim `DONE` without at least attempting it.

---

### Task 1: Extract `computeTotals` and add its tests

**Files:**
- Modify: `app/src/lib/dashboard-queries.ts`
- Test: `app/src/lib/dashboard-queries.test.ts`

**Interfaces:**
- Produces: `export function computeTotals(repos: RepoCardView[]): DashboardTotals` — pure function, no DB access, usable both server-side (by `getDashboardView`) and client-side (by Task 2's filtered recompute).

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `app/src/lib/dashboard-queries.test.ts` (needs `computeTotals` and `RepoCardView` imported — add both to the existing import line from `./dashboard-queries`):

```ts
function fakeRepoCardView(overrides: Partial<RepoCardView> = {}): RepoCardView {
  return {
    repoId: 1,
    fullName: "sdpilon/example",
    htmlUrl: null,
    description: null,
    language: null,
    isPrivate: false,
    isIgnored: false,
    ignoreReasons: [],
    ignoreControl: "auto",
    assessment: { pct: null, band: "none", label: "Not yet assessed", text: "", gaps: [], readmeText: null },
    commits: [],
    issues: [],
    pullRequests: [],
    ...overrides,
  };
}

describe("computeTotals", () => {
  it("aggregates counts across repos", () => {
    const repos = [
      fakeRepoCardView({
        repoId: 1,
        isPrivate: true,
        commits: [{ sha: "a", authoredAt: null, message: null }],
      }),
      fakeRepoCardView({
        repoId: 2,
        pullRequests: [
          { number: 1, title: null, state: "open", createdAt: null, mergedAt: null },
          { number: 2, title: null, state: "closed", createdAt: null, mergedAt: new Date() },
        ],
        issues: [{ number: 1, title: null, state: "open", createdAt: null }],
      }),
    ];

    expect(computeTotals(repos)).toEqual({
      repoCount: 2,
      privateCount: 1,
      commitCount: 1,
      prCount: 2,
      mergedPrCount: 1,
      issueCount: 1,
    });
  });

  it("returns all zeros for an empty list", () => {
    expect(computeTotals([])).toEqual({
      repoCount: 0,
      privateCount: 0,
      commitCount: 0,
      prCount: 0,
      mergedPrCount: 0,
      issueCount: 0,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- dashboard-queries.test.ts`
Expected: FAIL — `computeTotals` is not exported yet.

- [ ] **Step 3: Implement**

In `app/src/lib/dashboard-queries.ts`, add this function (place it near `getDashboardView`, after the `latestByRepoId` helper):

```ts
export function computeTotals(repos: RepoCardView[]): DashboardTotals {
  return {
    repoCount: repos.length,
    privateCount: repos.filter((r) => r.isPrivate).length,
    commitCount: repos.reduce((sum, r) => sum + r.commits.length, 0),
    prCount: repos.reduce((sum, r) => sum + r.pullRequests.length, 0),
    mergedPrCount: repos.reduce((sum, r) => sum + r.pullRequests.filter((p) => p.mergedAt).length, 0),
    issueCount: repos.reduce((sum, r) => sum + r.issues.length, 0),
  };
}
```

Then replace the inline totals object inside `getDashboardView` — this:

```ts
  const totals: DashboardTotals = {
    repoCount: repoViews.length,
    privateCount: repoViews.filter((r) => r.isPrivate).length,
    commitCount: repoViews.reduce((sum, r) => sum + r.commits.length, 0),
    prCount: repoViews.reduce((sum, r) => sum + r.pullRequests.length, 0),
    mergedPrCount: repoViews.reduce((sum, r) => sum + r.pullRequests.filter((p) => p.mergedAt).length, 0),
    issueCount: repoViews.reduce((sum, r) => sum + r.issues.length, 0),
  };

  return { totals, repos: repoViews };
```

with:

```ts
  return { totals: computeTotals(repoViews), repos: repoViews };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- dashboard-queries.test.ts`
Expected: PASS — all tests in the file, including the pre-existing `getDashboardView` totals-aggregation test (it should still pass unchanged, since `computeTotals` is byte-for-byte the same math as what it replaced).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard-queries.ts src/lib/dashboard-queries.test.ts
git commit -m "refactor: extract computeTotals from getDashboardView"
```

---

### Task 2: The toggle — client-side filter, recomputed totals, localStorage persistence

**Files:**
- Modify: `app/src/routes/index.tsx`
- Modify: `app/src/app.css`

**Interfaces:**
- Consumes: `computeTotals` from Task 1 (`~/lib/dashboard-queries`).

No automated test for this task — no `.tsx` test infrastructure exists in this repo (confirmed: zero `.test.tsx` files, `vitest.config.ts` only includes `src/**/*.test.ts`). Verification is `pnpm typecheck && pnpm lint`, then a real browser check (see Global Constraints — this one can't be verified from server-rendered HTML alone, since the filtering only happens after client JS runs).

- [ ] **Step 1: Implement the signal, persistence, and filtering**

In `app/src/routes/index.tsx`, change the import line:

```tsx
import { For, Show } from "solid-js";
```

to:

```tsx
import { For, Show, createEffect, createSignal, onMount } from "solid-js";
```

Add this import:

```tsx
import { computeTotals } from "~/lib/dashboard-queries";
```

Inside the `Home` component, after `const data = createAsync(() => getDashboardData());`, add:

```tsx
  const [hideIgnored, setHideIgnored] = createSignal(false);

  onMount(() => {
    if (localStorage.getItem("hideIgnoredRepos") === "true") {
      setHideIgnored(true);
    }
  });

  createEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("hideIgnoredRepos", String(hideIgnored()));
    }
  });
```

Replace the `<Show when={data()}>` block's contents — this:

```tsx
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
```

with:

```tsx
      <Show when={data()}>
        {(dashboard) => {
          const visibleRepos = () =>
            hideIgnored() ? dashboard().repos.filter((r) => !r.isIgnored) : dashboard().repos;
          const visibleTotals = () => (hideIgnored() ? computeTotals(visibleRepos()) : dashboard().totals);

          return (
            <>
              <label class="hide-ignored-toggle">
                <input
                  type="checkbox"
                  checked={hideIgnored()}
                  onChange={(e) => setHideIgnored(e.currentTarget.checked)}
                />
                Hide ignored repos
              </label>
              <Totals totals={visibleTotals()} />
              <div id="repos">
                <For each={visibleRepos()}>{(repo) => <RepoCard repo={repo} />}</For>
              </div>
            </>
          );
        }}
      </Show>
```

- [ ] **Step 2: Add CSS for the toggle**

In `app/src/app.css`, add this rule right after the `.totals` block (after the `.tile .l { ... }` rule, before `.repo { ... }`):

```css
.hide-ignored-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 0.8rem; color: var(--ink-2); cursor: pointer; user-select: none;
  margin-top: 18px;
}
.hide-ignored-toggle input { accent-color: var(--accent); cursor: pointer; }
```

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: PASS (confirms Task 1's tests and everything else still pass — this task adds no new automated tests).

- [ ] **Step 5: Manual browser verification**

Run `pnpm dev` (from `app/`, in this worktree), open the dashboard, and confirm: the "Hide ignored repos" checkbox appears near the Totals tiles; toggling it on removes ignored repo cards from the list and the Totals tiles' numbers drop to match the visible set (in particular, "active repos" should now show only non-ignored repos, not the full count); toggling it off restores everything and Totals returns to the original full-account numbers; reloading the page after toggling it on keeps it on (localStorage persistence). This requires real client-side JS execution — checking the server-rendered HTML alone will always show the unfiltered default state, so it is not sufficient here. If you cannot complete this check, report `DONE_WITH_CONCERNS` and say so explicitly, naming what you tried.

- [ ] **Step 6: Commit**

```bash
git add src/routes/index.tsx src/app.css
git commit -m "feat: add hide-ignored-repos toggle with client-side filtering and persisted preference"
```
