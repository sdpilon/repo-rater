# Render READMEs as GitHub-flavored Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render each repo's README as sanitized GitHub-flavored Markdown instead of raw plain text.

**Architecture:** A pure `renderReadme()` utility (`marked` → `DOMPurify`) in `src/lib/render-markdown.ts`, wired into `RepoCard.tsx`'s existing `<Show>` block via Solid's `innerHTML` prop; CSS restyled for real markdown elements instead of preformatted text.

**Tech Stack:** SolidStart, `marked` (new dep), `isomorphic-dompurify` (new dep), Vitest + `@solidjs/testing-library`.

**Spec:** bd issue `tracker-ovc` — "Render the README files of each shown project as github flavoured markdown"

## Global Constraints

- Must work correctly during SSR — no client-only API for the initial render
- Output must be sanitized before injection (strip script tags/event handlers)
- The existing no-README fallback (`"Not yet assessed — no README captured."`) must keep working
- Baseline gate: `pnpm typecheck && pnpm lint && pnpm test` must pass

---

## Context

READMEs are currently shown as raw plain text in a `<pre class="readme">`
block in `RepoCard.tsx`. This makes them hard to read — no headers, lists,
tables, code formatting, or links. The fix is to parse README markdown with
`marked` (GFM mode) and inject the sanitized HTML (via
`isomorphic-dompurify`, since this SolidStart app renders server-side) into
the card.

Acceptance criteria (from the bd issue):
- Headers, lists, tables, fenced code blocks, links, task lists,
  strikethrough all render as formatted HTML
- `marked` added as a dependency, configured for GFM
- Output sanitized before injection (script tags / event handlers stripped)
- SSR-safe (no client-only API for the initial render)
- No-README fallback still works

Scope check: single, self-contained subsystem (one new utility module +
one component wired to it) — no need to split into separate plans.

## Approach

Two tasks:
1. A standalone, pure `renderReadme(markdown: string): string` utility in
   `src/lib/render-markdown.ts` — `marked.parse()` piped through
   `DOMPurify.sanitize()`. Fully unit-testable in isolation, no Solid/DOM
   dependency at this layer.
2. Wire it into `RepoCard.tsx`'s existing `<Show>` block via Solid's
   `innerHTML` prop, and restyle the container (now a `<div>`, not a
   `<pre>`) in `app.css` for actual markdown elements instead of
   preformatted text.

Reused conventions already in this codebase:
- `marked.parse(body)` call style — same as `~/Projects/_Claude/cleanpages/scripts/build.mjs`
- Vitest + `@vitest-environment jsdom` pragma + `@solidjs/testing-library`,
  matching `src/components/RepoCard.test.tsx`'s existing pattern
- CSS custom properties already defined in `src/app.css` `:root`
  (`--surface`, `--surface-2`, `--line`, `--ink`, `--ink-2`, `--ink-3`,
  `--accent-ink`, `--mono`, `--sans`) — new styles reuse these, no new
  tokens introduced

No existing markdown-rendering or sanitization utility exists elsewhere in
this codebase to reuse — `marked` and `isomorphic-dompurify` are new
dependencies.

## Critical files

- `src/lib/render-markdown.ts` (new) — the `renderReadme()` utility
- `src/lib/render-markdown.test.ts` (new) — unit tests
- `src/components/RepoCard.tsx` — README section, lines 159-169
- `src/components/RepoCard.test.tsx` — existing test file, add a new
  `describe` block
- `src/app.css` — replace `pre.readme` (lines 185-190) with `.readme` plus
  nested markdown-element styles
- `package.json` / `pnpm-lock.yaml` — new deps via `pnpm add`

---

## Task 1: `renderReadme` markdown-rendering utility

**Files:**
- Create: `src/lib/render-markdown.ts`
- Create: `src/lib/render-markdown.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml` (via `pnpm add`)

**Interfaces (what Task 2 consumes):**
```ts
export function renderReadme(markdown: string): string;
```
Pure, synchronous. Input: raw README markdown. Output: sanitized HTML
string, safe to pass directly to Solid's `innerHTML` prop. No browser-only
APIs — safe during SSR.

- [ ] **Step 1: Install dependencies**
  ```bash
  pnpm add marked isomorphic-dompurify
  ```
  Verify `marked` and `isomorphic-dompurify` now appear under
  `"dependencies"` in `package.json`, and `pnpm-lock.yaml` is updated. No
  `@types/*` packages needed — both ship their own types.
  ```bash
  git add package.json pnpm-lock.yaml
  git commit -m "chore: add marked and isomorphic-dompurify dependencies"
  ```

- [ ] **Step 2: TDD — basic markdown-to-HTML parsing**

  Create `src/lib/render-markdown.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { renderReadme } from "./render-markdown";

  describe("renderReadme", () => {
    it("renders a level-1 header as an <h1> tag", () => {
      expect(renderReadme("# Hello")).toContain("<h1>Hello</h1>");
    });
  });
  ```
  Run — confirm it fails (`./render-markdown` doesn't exist yet):
  ```bash
  pnpm test src/lib/render-markdown.test.ts
  ```

  Create `src/lib/render-markdown.ts`:
  ```ts
  import { marked } from "marked";

  export function renderReadme(markdown: string): string {
    return marked.parse(markdown, { gfm: true }) as string;
  }
  ```
  Run — confirm it passes:
  ```bash
  pnpm test src/lib/render-markdown.test.ts
  ```
  Also run `pnpm typecheck` here — if it complains that `marked.parse(...)`
  returns `string | Promise<string>` instead of narrowing to `string`, the
  `as string` cast above already resolves it.
  ```bash
  git add src/lib/render-markdown.ts src/lib/render-markdown.test.ts
  git commit -m "feat: add renderReadme markdown-to-HTML utility"
  ```

- [ ] **Step 3: Lock in the rest of the GFM feature surface as regression tests**

  `marked`'s GFM mode already covers tables, strikethrough, task lists,
  lists, links, and fenced code with no further implementation change —
  these assertions pass immediately against the Step 2 code. This step
  exists to pin the acceptance-criteria feature list down as tests, not to
  drive new implementation.

  Append to `src/lib/render-markdown.test.ts` (inside the existing
  `describe` block):
  ```ts
  it("renders unordered lists as <ul><li> markup", () => {
    const html = renderReadme("- one\n- two");
    expect(html).toContain("<ul>");
    expect(html.match(/<li>/g)?.length).toBe(2);
  });

  it("renders fenced code blocks with a <pre><code> wrapper", () => {
    const html = renderReadme("```js\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
  });

  it("renders links with an href attribute", () => {
    const html = renderReadme("[docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain(">docs<");
  });

  it("renders GFM pipe tables as <table> markup", () => {
    const html = renderReadme("| A | B |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders GFM strikethrough as <del>", () => {
    expect(renderReadme("~~gone~~")).toContain("<del>gone</del>");
  });

  it("renders GFM task lists as disabled checkboxes", () => {
    const html = renderReadme("- [ ] todo\n- [x] done");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
  });
  ```
  Run — confirm all pass with no implementation change:
  ```bash
  pnpm test src/lib/render-markdown.test.ts
  ```
  ```bash
  git add src/lib/render-markdown.test.ts
  git commit -m "test: cover full GFM feature surface for renderReadme"
  ```

- [ ] **Step 4: TDD — sanitize malicious HTML**

  The one behavior not yet covered: `marked.parse` alone passes raw
  `<script>` blocks and `on*` handler attributes straight through
  untouched.

  Append to `src/lib/render-markdown.test.ts`:
  ```ts
  it("strips <script> tags from malicious markdown input", () => {
    const html = renderReadme("# Title\n\n<script>alert('xss')</script>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(");
  });

  it("strips inline event-handler attributes like onerror", () => {
    const html = renderReadme('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
  });
  ```
  Run — confirm these two fail (script tag / `onerror` currently survive
  verbatim):
  ```bash
  pnpm test src/lib/render-markdown.test.ts
  ```

  Update `src/lib/render-markdown.ts`:
  ```ts
  import { marked } from "marked";
  import DOMPurify from "isomorphic-dompurify";

  export function renderReadme(markdown: string): string {
    const html = marked.parse(markdown, { gfm: true }) as string;
    return DOMPurify.sanitize(html);
  }
  ```
  Run — confirm all tests in the file now pass, including the Step 3
  task-list checkbox test. If that specific assertion regresses here, it
  means DOMPurify's default allowlist is stripping the checkbox `<input>` —
  fix by passing an explicit config:
  `DOMPurify.sanitize(html, { ADD_TAGS: ["input"], ADD_ATTR: ["type", "checked", "disabled"] })`.
  ```bash
  pnpm test src/lib/render-markdown.test.ts
  ```
  ```bash
  git add src/lib/render-markdown.ts src/lib/render-markdown.test.ts
  git commit -m "feat: sanitize renderReadme output with DOMPurify"
  ```

---

## Task 2: Wire `renderReadme` into `RepoCard.tsx`

**Files:**
- Modify: `src/components/RepoCard.tsx`
- Modify: `src/app.css`
- Modify (test): `src/components/RepoCard.test.tsx`

**Interfaces consumed:**
```ts
import { renderReadme } from "~/lib/render-markdown";
// renderReadme(markdown: string): string
```

- [ ] **Step 1: TDD — component renders sanitized markdown**

  Append to `src/components/RepoCard.test.tsx` (new `describe` block,
  after the existing `"RepoCard assess-control placement"` block):
  ```tsx
  describe("RepoCard README rendering", () => {
    it("renders README markdown as formatted HTML", () => {
      const { container } = renderCard(
        makeRepo({
          assessment: {
            pct: 50,
            band: "ok",
            label: "In progress",
            text: "",
            gaps: [],
            readmeText: "# Title\n\n- one\n- two",
          },
        }),
      );
      const readme = container.querySelector(".readme");
      expect(readme).toBeTruthy();
      expect(readme?.innerHTML).toContain("<h1>Title</h1>");
      expect(readme?.querySelectorAll("li").length).toBe(2);
    });

    it("still shows the no-README fallback when readmeText is null", () => {
      const { container } = renderCard(
        makeRepo({
          assessment: { pct: 50, band: "ok", label: "In progress", text: "", gaps: [], readmeText: null },
        }),
      );
      expect(container.querySelector(".readme")).toBeNull();
      expect(screen.getByText("Not yet assessed — no README captured.")).toBeTruthy();
    });

    it("does not render a raw <script> element from malicious README content", () => {
      const { container } = renderCard(
        makeRepo({
          assessment: {
            pct: 50,
            band: "ok",
            label: "In progress",
            text: "",
            gaps: [],
            readmeText: "<script>window.__pwned = true;</script>\n\nSafe text.",
          },
        }),
      );
      expect(container.querySelector(".readme script")).toBeNull();
      expect(container.querySelector(".readme")?.textContent).toContain("Safe text.");
    });
  });
  ```
  Run — confirm the first test fails (today's `<pre class="readme">`
  renders markdown as escaped plain text, so `innerHTML` contains the
  literal string `# Title`, not `<h1>Title</h1>`):
  ```bash
  pnpm test src/components/RepoCard.test.tsx
  ```

  Edit `src/components/RepoCard.tsx`. Add this import after the existing
  `~/lib/dashboard-queries` import (line 5):
  ```tsx
  import { renderReadme } from "~/lib/render-markdown";
  ```
  Replace lines 163-168 (the `<Show>` block inside the README
  `CollapsibleSection`):
  ```tsx
          <Show
            when={props.repo.assessment.readmeText}
            fallback={<div class="empty">Not yet assessed — no README captured.</div>}
          >
            <pre class="readme">{props.repo.assessment.readmeText}</pre>
          </Show>
  ```
  with:
  ```tsx
          <Show
            when={props.repo.assessment.readmeText}
            fallback={<div class="empty">Not yet assessed — no README captured.</div>}
          >
            {(readmeText) => <div class="readme" innerHTML={renderReadme(readmeText())} />}
          </Show>
  ```
  (Solid's `Show` function-as-children form gives a
  `readmeText: Accessor<string>` already narrowed to non-null, so
  `renderReadme(readmeText())` type-checks with no cast needed.)

  Run — confirm all three new tests pass, plus the full existing file
  suite:
  ```bash
  pnpm test src/components/RepoCard.test.tsx
  ```
  Also confirm lint doesn't flag the `innerHTML` prop (Biome's
  `noDangerouslySetInnerHtml` rule keys on React's prop name, not Solid's
  `innerHTML` — but verify against the actual installed Biome version):
  ```bash
  pnpm lint
  ```
  ```bash
  git add src/components/RepoCard.tsx src/components/RepoCard.test.tsx
  git commit -m "feat: render README as sanitized GitHub-flavored Markdown"
  ```

- [ ] **Step 2: Restyle the README container for rendered HTML**

  In `src/app.css`, replace the existing `pre.readme { ... }` block
  (currently lines 185-190):
  ```css
  pre.readme {
    font-family: var(--mono); font-size: 0.74rem; line-height: 1.55;
    background: var(--surface); border: 1px solid var(--line); border-radius: 6px;
    padding: 12px 14px; margin: 0; white-space: pre-wrap; word-break: break-word;
    max-height: 340px; overflow-y: auto; color: var(--ink-2);
  }
  ```
  with:
  ```css
  .readme {
    font-family: var(--sans); font-size: 0.82rem; line-height: 1.6;
    background: var(--surface); border: 1px solid var(--line); border-radius: 6px;
    padding: 12px 14px; margin: 0; word-break: break-word;
    max-height: 340px; overflow-y: auto; color: var(--ink-2);
  }
  .readme h1, .readme h2, .readme h3, .readme h4, .readme h5, .readme h6 {
    color: var(--ink); font-weight: 600; line-height: 1.3; margin: 0.9em 0 0.4em;
  }
  .readme h1:first-child, .readme h2:first-child, .readme h3:first-child { margin-top: 0; }
  .readme h1 { font-size: 1.3rem; }
  .readme h2 { font-size: 1.15rem; }
  .readme h3 { font-size: 1.02rem; }
  .readme p { margin: 0.5em 0; }
  .readme ul, .readme ol { margin: 0.5em 0; padding-left: 1.5em; }
  .readme li { margin: 0.2em 0; }
  .readme li input[type="checkbox"] { margin-right: 0.4em; }
  .readme code {
    font-family: var(--mono); font-size: 0.85em; background: var(--surface-2);
    border-radius: 3px; padding: 0.1em 0.35em;
  }
  .readme pre {
    font-family: var(--mono); font-size: 0.78rem; background: var(--surface-2);
    border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px;
    overflow-x: auto; margin: 0.6em 0;
  }
  .readme pre code { background: none; padding: 0; }
  .readme table { border-collapse: collapse; margin: 0.6em 0; font-size: 0.82rem; }
  .readme th, .readme td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
  .readme th { background: var(--surface-2); font-weight: 600; }
  .readme a { color: var(--accent-ink); }
  .readme blockquote {
    margin: 0.6em 0; padding: 0.2em 0.9em; border-left: 3px solid var(--line); color: var(--ink-3);
  }
  .readme del { color: var(--ink-3); }
  .readme hr { border: none; border-top: 1px solid var(--line); margin: 1em 0; }
  .readme img { max-width: 100%; }
  ```
  ```bash
  pnpm lint
  ```
  ```bash
  git add src/app.css
  git commit -m "style: add markdown rendering styles for README section"
  ```

- [ ] **Step 3: Full gate verification**
  ```bash
  pnpm typecheck && pnpm lint && pnpm test
  ```
  All three must pass. No commit for this step — verification checkpoint
  only.

---

## Verification (end-to-end)

1. `pnpm typecheck && pnpm lint && pnpm test` — the repo's baseline gate,
   must be green.
2. Run `pnpm dev`, open the dashboard, and visually confirm on a real repo
   card with a substantial README: headers, lists, a table, a fenced code
   block, a link, and (if the README has one) a task list all render as
   formatted HTML, not raw markdown syntax. Confirm a repo with no README
   still shows the "Not yet assessed — no README captured." fallback.
3. Spot-check dark mode (the app's CSS has a
   `@media (prefers-color-scheme: dark)` block) — new `.readme` styles
   reuse existing CSS custom properties so they should adapt automatically,
   but confirm visually.
