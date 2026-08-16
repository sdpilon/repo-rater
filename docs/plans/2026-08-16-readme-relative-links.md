# README Relative Link/Image Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve relative links and images in rendered READMEs against GitHub (blob/raw URLs) instead of the dashboard's own origin.

**Architecture:** `renderReadme()` (`src/lib/render-markdown.ts`) gains a second `fullName: string` parameter. Internally it builds a per-call `Marked` instance configured with a `walkTokens` hook that rewrites any relative `link`/`image` token's `href` in place — before the default renderer ever runs — to an absolute `https://github.com/<fullName>/blob/HEAD/...` (links) or `https://raw.githubusercontent.com/<fullName>/HEAD/...` (images) URL. The wired-in caller (`RepoCard.tsx`) already has `fullName` on `props.repo`.

**Tech Stack:** SolidStart, `marked` (already a dependency, v18 — its `Marked` class + `walkTokens` extension hook, not a `Renderer` subclass, since `RendererObject` methods in v18 fully replace rather than wrap the default and would require re-implementing HTML escaping by hand), Vitest.

**Spec:** bd issue `tracker-8gt` — "README markdown: resolve relative links/images against GitHub, not dashboard origin"

## Global Constraints

- Must stay SSR-safe — no client-only API (unchanged from the existing `renderReadme` contract)
- Output must remain sanitized via `DOMPurify.sanitize()` before injection (unchanged)
- Absolute URLs (`https://…`), protocol-relative URLs (`//…`), in-page anchors (`#…`), and non-http schemes (`mailto:…`) must NOT be rewritten
- Baseline gate: `pnpm typecheck && pnpm lint && pnpm test` must pass

---

## Context

`renderReadme()` currently calls `marked.parse(markdown, { gfm: true, async: false })` with no base URL, so relative hrefs/srcs in README markdown (e.g. a link to `/docs/guide.md` or an image at `docs/img.png`) resolve against the dashboard's own origin at render time and show up broken on real repo cards. This was found and filed as a follow-up (`tracker-8gt`) during code review of the just-merged README-markdown-rendering feature (`tracker-ovc`).

Confirmed empirically (scratch script, not committed) that `marked`'s `walkTokens` extension hook — which runs once per token before the parser renders it — is the simplest correct fix: mutating `token.href` in place for `type === "link"` / `type === "image"` tokens, then letting the *default* renderer run unmodified, produces correct output for every case (relative with/without leading slash, absolute, anchor, `mailto:`). This avoids re-implementing `marked`'s default `link`/`image` renderer methods (which v18's `RendererObject` pattern would otherwise require, since a custom `link`/`image` method there fully replaces the default rather than wrapping it).

Acceptance criteria (from the bd issue):
- Relative link hrefs resolve against `https://github.com/<fullName>/blob/HEAD/`
- Relative image srcs resolve against `https://raw.githubusercontent.com/<fullName>/HEAD/`
- `fullName` is threaded from `RepoCard.tsx`'s existing `RepoCardView` data into `renderReadme`'s call site

Scope check: single, self-contained subsystem (one utility module + one call-site wire-up) — no need to split into separate plans.

## Approach

Two tasks:
1. Give `renderReadme` a second `fullName` parameter and a `walkTokens`-based rewrite for relative link/image URLs, entirely inside `src/lib/render-markdown.ts` — fully unit-testable in isolation.
2. Update `RepoCard.tsx`'s one call site to pass `props.repo.fullName` through.

Reused conventions already in this codebase:
- Vitest test style already established in `src/lib/render-markdown.test.ts`
- `@vitest-environment jsdom` pragma + `@solidjs/testing-library` pattern in `src/components/RepoCard.test.tsx`

No new dependencies — `marked`'s `Marked` class (as opposed to the shared default `marked` singleton import) is already exported by the installed `marked` package.

## Critical files

- `src/lib/render-markdown.ts` — `renderReadme()`, signature and implementation change
- `src/lib/render-markdown.test.ts` — add relative-URL-resolution tests
- `src/components/RepoCard.tsx:168` — the one call site (`renderReadme(readmeText())` → `renderReadme(readmeText(), props.repo.fullName)`)
- `src/components/RepoCard.test.tsx` — add a regression test covering the wired-in call site

---

## Task 1: Resolve relative links/images in `renderReadme`

**Files:**
- Modify: `src/lib/render-markdown.ts`
- Modify: `src/lib/render-markdown.test.ts`

**Interfaces (what Task 2 consumes):**
```ts
export function renderReadme(markdown: string, fullName: string): string;
```
Pure, synchronous. `fullName` is the GitHub `"owner/repo"` string. Output: sanitized HTML string, safe to pass directly to Solid's `innerHTML` prop.

- [ ] **Step 1: TDD — update the empty-input test call site**

  The existing test `"returns an empty string for empty input"` in `src/lib/render-markdown.test.ts` calls `renderReadme("")` with the old one-argument signature. Update it now so the whole file stays internally consistent as new tests are added:
  ```ts
  it("returns an empty string for empty input", () => {
    expect(renderReadme("", "octocat/hello-world")).toBe("");
  });
  ```
  Update every other existing call in the file the same way — each currently reads `renderReadme("...")` and becomes `renderReadme("...", "octocat/hello-world")`. There are 9 other call sites in the file (one per existing `it(...)` block).

  Run — confirm the file still fails to compile/run cleanly only insofar as the new assertions below don't exist yet (this step alone should still pass once every call is updated, since a second unused-by-behavior argument doesn't change output yet):
  ```bash
  pnpm test src/lib/render-markdown.test.ts
  ```
  Expected: all existing tests still PASS (this step is a mechanical signature update, not new behavior).

- [ ] **Step 2: TDD — relative link resolves against GitHub blob URL**

  Append to `src/lib/render-markdown.test.ts` (inside the existing `describe` block):
  ```ts
  it("resolves a relative link href against the repo's GitHub blob URL", () => {
    const html = renderReadme("[guide](docs/guide.md)", "octocat/hello-world");
    expect(html).toContain(
      'href="https://github.com/octocat/hello-world/blob/HEAD/docs/guide.md"',
    );
  });

  it("resolves a leading-slash relative link href the same way", () => {
    const html = renderReadme("[guide](/docs/guide.md)", "octocat/hello-world");
    expect(html).toContain(
      'href="https://github.com/octocat/hello-world/blob/HEAD/docs/guide.md"',
    );
  });

  it("resolves a relative image src against the repo's raw GitHub URL", () => {
    const html = renderReadme("![logo](docs/logo.png)", "octocat/hello-world");
    expect(html).toContain(
      'src="https://raw.githubusercontent.com/octocat/hello-world/HEAD/docs/logo.png"',
    );
  });

  it("leaves absolute link hrefs unchanged", () => {
    const html = renderReadme("[ext](https://example.com/x)", "octocat/hello-world");
    expect(html).toContain('href="https://example.com/x"');
  });

  it("leaves absolute image srcs unchanged", () => {
    const html = renderReadme("![ext](https://example.com/x.png)", "octocat/hello-world");
    expect(html).toContain('src="https://example.com/x.png"');
  });

  it("leaves in-page anchor links unchanged", () => {
    const html = renderReadme("[section](#install)", "octocat/hello-world");
    expect(html).toContain('href="#install"');
  });

  it("leaves mailto links unchanged", () => {
    const html = renderReadme("[email](mailto:a@example.com)", "octocat/hello-world");
    expect(html).toContain('href="mailto:a@example.com"');
  });

  it("resolves relative links against the given repo's own fullName", () => {
    const htmlA = renderReadme("[guide](docs/guide.md)", "octocat/hello-world");
    const htmlB = renderReadme("[guide](docs/guide.md)", "octocat/other-repo");
    expect(htmlA).toContain("octocat/hello-world/blob/HEAD/docs/guide.md");
    expect(htmlB).toContain("octocat/other-repo/blob/HEAD/docs/guide.md");
  });
  ```
  Run — confirm the new tests fail (today's `renderReadme` ignores the second argument entirely, so hrefs stay relative):
  ```bash
  pnpm test src/lib/render-markdown.test.ts
  ```

  Replace the full contents of `src/lib/render-markdown.ts`:
  ```ts
  import { Marked } from "marked";
  import type { Token } from "marked";
  import DOMPurify from "isomorphic-dompurify";

  const cache = new Map<string, string>();

  function isRelativeUrl(href: string): boolean {
    return !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href);
  }

  function resolveAgainst(href: string, base: string): string {
    return new URL(href.replace(/^\/+/, ""), base).toString();
  }

  function buildMarked(fullName: string): Marked {
    const blobBase = `https://github.com/${fullName}/blob/HEAD/`;
    const rawBase = `https://raw.githubusercontent.com/${fullName}/HEAD/`;
    const instance = new Marked({ gfm: true, async: false });
    instance.use({
      walkTokens(token: Token) {
        if (token.type === "link" && isRelativeUrl(token.href)) {
          token.href = resolveAgainst(token.href, blobBase);
        } else if (token.type === "image" && isRelativeUrl(token.href)) {
          token.href = resolveAgainst(token.href, rawBase);
        }
      },
    });
    return instance;
  }

  export function renderReadme(markdown: string, fullName: string): string {
    const key = `${fullName} ${markdown}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const html = buildMarked(fullName).parse(markdown, { async: false }) as string;
    const sanitized = DOMPurify.sanitize(html);
    cache.set(key, sanitized);
    return sanitized;
  }
  ```
  Note: the render-result cache key now includes `fullName`, not just `markdown` — two repos with identical README content (e.g. both using a shared template) must not share a cached render with the wrong repo's resolved URLs baked in. The "resolves relative links against the given repo's own fullName" test above pins this down.

  Run — confirm all tests in the file now pass:
  ```bash
  pnpm test src/lib/render-markdown.test.ts
  ```
  Also run the baseline gate here — `walkTokens`'s `Token` parameter is a broad union type, confirm it type-checks cleanly against the installed `marked` v18 types:
  ```bash
  pnpm typecheck
  ```
  ```bash
  git add src/lib/render-markdown.ts src/lib/render-markdown.test.ts
  git commit -m "feat: resolve relative README links/images against GitHub URLs"
  ```

---

## Task 2: Wire `fullName` into `RepoCard.tsx`'s call site

**Files:**
- Modify: `src/components/RepoCard.tsx`
- Modify: `src/components/RepoCard.test.tsx`

**Interfaces consumed:**
```ts
import { renderReadme } from "~/lib/render-markdown";
// renderReadme(markdown: string, fullName: string): string
```

- [ ] **Step 1: TDD — component resolves relative README links using the repo's fullName**

  Append to `src/components/RepoCard.test.tsx` (inside the existing `"RepoCard README rendering"` describe block):
  ```tsx
  it("resolves a relative README link against the repo's GitHub blob URL", () => {
    const { container } = renderCard(
      makeRepo({
        fullName: "octocat/hello-world",
        assessment: {
          pct: 50,
          band: "ok",
          label: "In progress",
          text: "",
          gaps: [],
          readmeText: "[guide](docs/guide.md)",
        },
      }),
    );
    const link = container.querySelector(".readme a");
    expect(link?.getAttribute("href")).toBe(
      "https://github.com/octocat/hello-world/blob/HEAD/docs/guide.md",
    );
  });
  ```
  Run — confirm it fails (today's call site drops `fullName`, so `renderReadme` currently only receives one argument and the link stays relative):
  ```bash
  pnpm test src/components/RepoCard.test.tsx
  ```

  In `src/components/RepoCard.tsx`, change line 168 from:
  ```tsx
          {(readmeText) => <div class="readme" innerHTML={renderReadme(readmeText())} />}
  ```
  to:
  ```tsx
          {(readmeText) => <div class="readme" innerHTML={renderReadme(readmeText(), props.repo.fullName)} />}
  ```

  Run — confirm the new test passes, plus the full existing file suite:
  ```bash
  pnpm test src/components/RepoCard.test.tsx
  ```
  ```bash
  git add src/components/RepoCard.tsx src/components/RepoCard.test.tsx
  git commit -m "feat: pass repo fullName into renderReadme for relative URL resolution"
  ```

- [ ] **Step 2: Full gate verification**
  ```bash
  pnpm typecheck && pnpm lint && pnpm test
  ```
  All three must pass. No commit for this step — verification checkpoint only.

---

## Verification (end-to-end)

1. `pnpm typecheck && pnpm lint && pnpm test` — the repo's baseline gate, must be green.
2. Run `pnpm dev`, open the dashboard, and find a real repo card whose README has a relative link or image (many READMEs link to files like `docs/` or embed a screenshot via a relative path). Confirm the rendered link/image now points at `github.com/<owner>/<repo>/blob/HEAD/...` or `raw.githubusercontent.com/<owner>/<repo>/HEAD/...` instead of the dashboard's own origin (hover the link/inspect the `<img src>`).
3. Confirm READMEs with only absolute links/images (or none at all) still render exactly as before — no regression in the already-merged `tracker-ovc` rendering.
