# Self-Host Config Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every credential (DB connection string, GitHub PAT, Anthropic API key, `APP_PASSWORD`) independently optional and settable either via env var or a local JSON config file written through the dashboard UI, so the app boots and runs progressively — "minimal server running" → "add credentials one at a time" → "everything works" — instead of hard-crashing on a missing `DATABASE_URL`.

**Architecture:** A single shared resolver (`src/lib/config.ts`, env var wins, falls back to a local JSON config file) replaces every direct `process.env.X` read across auth, the dashboard's DB client, and the pipeline CLI. The DB client becomes a lazy, memoized singleton instead of a module-load singleton, so the app can boot with no DB configured at all. New per-credential settings server actions validate against the real service (a live query / API call) before persisting. The dashboard route renders a credentials-only view when the DB isn't configured, and a settings panel alongside the normal dashboard once it is.

**Tech Stack:** SolidStart (`@solidjs/router` `query()`/`action()`), Drizzle (`drizzle-orm/node-postgres`), `pg`, `octokit`, `@anthropic-ai/sdk`, Vitest, `@solidjs/testing-library`.

**Spec:** `docs/specs/2026-08-16-self-host-config-phase1-design.md`

## Global Constraints

- Env var always wins over the config file (spec "Decisions": storage is a hybrid, env var checked first).
- Config file path defaults to `./data/config.json`, overridable via `CONFIG_FILE_PATH`, gitignored.
- No hot-reconnect: an edited, already-set `DATABASE_URL` requires a server restart to take effect. The DB client is a lazy singleton, created once on first successful resolution.
- `APP_PASSWORD` resolves through the same hybrid but is never a UI field — env var/config-file only.
- Every credential is validated against the real service before being persisted (spec "Decisions": save-time validation).
- GitHub auth is PAT-paste only this phase — no OAuth.
- This phase does not touch production (`github-project-tracker-chi.vercel.app`) — it's built and tested independently; production's existing all-env-vars-set behavior must remain unchanged (a regression check, not a new code path).

---

## Task 1: Config resolver

**Files:**
- Create: `src/lib/config.ts`
- Test: `src/lib/config.test.ts`

**Interfaces:**
- Produces:
  - `interface ConfigOptions { configFilePath?: string }`
  - `resolveConfig(key: string, options?: ConfigOptions): string | undefined`
  - `isConfigured(key: string, options?: ConfigOptions): boolean`
  - `setConfigValue(key: string, value: string, options?: ConfigOptions): void`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/config.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isConfigured, resolveConfig, setConfigValue } from "./config";

let tempDir: string;
let configFilePath: string;
const originalTestKey = process.env.TEST_CONFIG_KEY;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tracker-config-test-"));
  configFilePath = join(tempDir, "config.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (originalTestKey === undefined) delete process.env.TEST_CONFIG_KEY;
  else process.env.TEST_CONFIG_KEY = originalTestKey;
});

describe("resolveConfig", () => {
  it("returns undefined when neither env var nor file has the key", () => {
    delete process.env.TEST_CONFIG_KEY;
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath })).toBeUndefined();
  });

  it("returns the env var value when set, ignoring the file", () => {
    process.env.TEST_CONFIG_KEY = "from-env";
    setConfigValue("TEST_CONFIG_KEY", "from-file", { configFilePath });
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath })).toBe("from-env");
  });

  it("falls back to the config file when the env var is unset", () => {
    delete process.env.TEST_CONFIG_KEY;
    setConfigValue("TEST_CONFIG_KEY", "from-file", { configFilePath });
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath })).toBe("from-file");
  });

  it("returns undefined when the config file doesn't exist yet", () => {
    delete process.env.TEST_CONFIG_KEY;
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath: join(tempDir, "missing.json") })).toBeUndefined();
  });
});

describe("isConfigured", () => {
  it("is false when unresolved, true once set", () => {
    delete process.env.TEST_CONFIG_KEY;
    expect(isConfigured("TEST_CONFIG_KEY", { configFilePath })).toBe(false);
    setConfigValue("TEST_CONFIG_KEY", "value", { configFilePath });
    expect(isConfigured("TEST_CONFIG_KEY", { configFilePath })).toBe(true);
  });
});

describe("setConfigValue", () => {
  it("creates the parent directory and file if missing", () => {
    const nestedPath = join(tempDir, "nested", "dir", "config.json");
    setConfigValue("TEST_CONFIG_KEY", "value", { configFilePath: nestedPath });
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath: nestedPath })).toBe("value");
  });

  it("merges with existing keys instead of overwriting the file", () => {
    setConfigValue("FIRST_KEY", "first", { configFilePath });
    setConfigValue("SECOND_KEY", "second", { configFilePath });
    expect(resolveConfig("FIRST_KEY", { configFilePath })).toBe("first");
    expect(resolveConfig("SECOND_KEY", { configFilePath })).toBe("second");
  });

  it("overwrites an existing value for the same key", () => {
    setConfigValue("TEST_CONFIG_KEY", "old", { configFilePath });
    setConfigValue("TEST_CONFIG_KEY", "new", { configFilePath });
    expect(resolveConfig("TEST_CONFIG_KEY", { configFilePath })).toBe("new");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/config.test.ts`
Expected: FAIL — `Cannot find module './config'` (or similar), since `src/lib/config.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/config.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Shared config resolver used by both the web app and the pipeline CLI: env
 * var wins, falling back to a local JSON config file so a self-hoster can
 * either export env vars (Docker Compose env_file, k8s secrets) or set
 * credentials through the dashboard UI, which writes to this same file.
 */

export interface ConfigOptions {
  configFilePath?: string;
}

function resolveConfigFilePath(options?: ConfigOptions): string {
  return options?.configFilePath ?? process.env.CONFIG_FILE_PATH ?? "./data/config.json";
}

function readConfigFile(configFilePath: string): Record<string, string> {
  try {
    const raw = readFileSync(configFilePath, "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export function resolveConfig(key: string, options?: ConfigOptions): string | undefined {
  const envValue = process.env[key];
  if (envValue) return envValue;
  return readConfigFile(resolveConfigFilePath(options))[key];
}

export function isConfigured(key: string, options?: ConfigOptions): boolean {
  return resolveConfig(key, options) !== undefined;
}

export function setConfigValue(key: string, value: string, options?: ConfigOptions): void {
  const configFilePath = resolveConfigFilePath(options);
  const current = readConfigFile(configFilePath);
  current[key] = value;
  mkdirSync(dirname(configFilePath), { recursive: true });
  writeFileSync(configFilePath, JSON.stringify(current, null, 2));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/config.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts src/lib/config.test.ts
git commit -m "feat(config): add env/file-backed config resolver"
```

---

## Task 2: Lazy, memoized DB client

**Files:**
- Modify: `src/lib/server-db.ts`
- Test: `src/lib/server-db.test.ts`

**Interfaces:**
- Consumes: `resolveConfig`, `isConfigured` from `./config` (Task 1).
- Produces:
  - `isDbConfigured(): boolean`
  - `getDb(): NodePgDatabase<typeof schema> & { $client: Pool }` (same return type `createDb` already produces)

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/server-db.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route resolveConfig/isConfigured straight through process.env for this
// test file — same behavior the old direct process.env.DATABASE_URL read
// had, without coupling these tests to any real config file on disk.
vi.mock("./config", () => ({
  resolveConfig: (key: string) => process.env[key],
  isConfigured: (key: string) => process.env[key] !== undefined,
}));

const originalDatabaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("isDbConfigured", () => {
  it("is false when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const { isDbConfigured } = await import("./server-db");
    expect(isDbConfigured()).toBe(false);
  });

  it("is true when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { isDbConfigured } = await import("./server-db");
    expect(isDbConfigured()).toBe(true);
  });
});

describe("getDb", () => {
  it("throws a clear error when unconfigured", async () => {
    delete process.env.DATABASE_URL;
    const { getDb } = await import("./server-db");
    expect(() => getDb()).toThrow(/DATABASE_URL/);
  });

  it("memoizes the client across calls", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getDb } = await import("./server-db");
    expect(getDb()).toBe(getDb());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/server-db.test.ts`
Expected: FAIL — `isDbConfigured`/`getDb` are not exported yet (current file only exports `db`).

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/server-db.ts
import { createDb } from "~/db/client";
import { isConfigured, resolveConfig } from "./config";

let cachedDb: ReturnType<typeof createDb> | undefined;

/** Cheap presence check — never creates a client. */
export function isDbConfigured(): boolean {
  return isConfigured("DATABASE_URL");
}

/**
 * Lazy, memoized DB client. Resolves DATABASE_URL (env var, else the local
 * config file) on first call and caches the client after. Editing an
 * already-set DATABASE_URL via the settings UI requires a server restart to
 * take effect — no hot-reconnect, by design (see spec).
 */
export function getDb(): ReturnType<typeof createDb> {
  if (!cachedDb) {
    const databaseUrl = resolveConfig("DATABASE_URL");
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is not configured — set the DATABASE_URL environment variable or configure it via the dashboard settings.",
      );
    }
    cachedDb = createDb(databaseUrl);
  }
  return cachedDb;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/server-db.test.ts`
Expected: PASS, all 4 tests. (`getDb()` never actually connects in these tests — `pg.Pool` connects lazily on first query, so constructing it with a fake connection string is safe.)

- [ ] **Step 5: Update `dashboard.ts` to use `getDb()`**

`src/lib/dashboard.ts` currently imports the module-level `db` singleton (`import { db } from "./server-db"`) and uses it directly in both `getDashboardData` and `toggleAssess`. Change both call sites to call `getDb()` instead:

```typescript
// src/lib/dashboard.ts
import { action, json, query } from "@solidjs/router";
import { assertAuthenticated } from "./auth-guard";
import { getDashboardView, setRepoAssessControl, type AssessControlValue } from "./dashboard-queries";
import { getDb } from "./server-db";

export const getDashboardData = query(async () => {
  "use server";
  assertAuthenticated();
  return getDashboardView(getDb());
}, "dashboard");

export const toggleAssess = action(async (repoId: number, value: AssessControlValue) => {
  "use server";
  assertAuthenticated();
  await setRepoAssessControl(getDb(), repoId, value);
  return json(null, { revalidate: getDashboardData.key });
}, "toggleAssess");
```

This module has no existing unit tests of its own (`getDashboardView`/`setRepoAssessControl` are tested directly against a real `db` argument in `dashboard-queries.test.ts`, which is unaffected by this change since it never imports `server-db.ts`).

- [ ] **Step 6: Run the full test suite to confirm no regressions**

Run: `pnpm test`
Expected: PASS, no failures introduced.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server-db.ts src/lib/server-db.test.ts src/lib/dashboard.ts
git commit -m "feat(config): make the DB client a lazy, memoized singleton"
```

---

## Task 3: Optional `APP_PASSWORD` via the resolver

**Files:**
- Modify: `src/lib/auth.ts`
- Modify: `src/lib/auth.test.ts`

**Interfaces:**
- Consumes: `resolveConfig`, `isConfigured` from `./config` (Task 1).
- Produces: `isAppPasswordConfigured(): boolean` (new). `isAuthenticatedRequest(request: Request): boolean` changes behavior — returns `true` unconditionally when `APP_PASSWORD` isn't configured.

Today, `isAuthenticatedRequest` always calls `requireAppPassword()`, which throws if `APP_PASSWORD` is unset — meaning the whole app currently requires a password to even boot correctly. Under the new model, an unset `APP_PASSWORD` means "no gate at all" (e.g. a homelab instance behind Tailscale), not a crash.

- [ ] **Step 1: Write the failing tests**

Add to the top of `src/lib/auth.test.ts` (before the existing `describe` blocks), a mock that routes `./config` straight through `process.env` — this keeps every existing test in the file working unchanged, since they already manipulate `process.env.APP_PASSWORD` directly:

```typescript
// Added near the top of src/lib/auth.test.ts, after the existing imports
vi.mock("./config", () => ({
  resolveConfig: (key: string) => process.env[key],
  isConfigured: (key: string) => process.env[key] !== undefined,
}));
```

This requires importing `vi` — the existing import line is `import { afterEach, describe, expect, it } from "vitest";`; change it to:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
```

Then add new tests for the "no password configured" behavior, in a new `describe` block appended to the file:

```typescript
describe("isAppPasswordConfigured", () => {
  it("is false when APP_PASSWORD is unset, true when set", () => {
    delete process.env.APP_PASSWORD;
    expect(isAppPasswordConfigured()).toBe(false);
    process.env.APP_PASSWORD = "hunter2";
    expect(isAppPasswordConfigured()).toBe(true);
  });
});

describe("isAuthenticatedRequest with no APP_PASSWORD configured", () => {
  it("treats every request as authenticated when the gate is off", () => {
    delete process.env.APP_PASSWORD;
    expect(isAuthenticatedRequest(new Request("http://localhost/"))).toBe(true);
  });
});
```

And add `isAppPasswordConfigured` to the existing import from `./auth`:

```typescript
import {
  AUTH_COOKIE,
  buildAuthCookie,
  getCookieValue,
  isAppPasswordConfigured,
  isAuthenticatedRequest,
  isPublicPath,
  requireAppPassword,
} from "./auth";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/auth.test.ts`
Expected: FAIL — `isAppPasswordConfigured` is not exported yet.

- [ ] **Step 3: Write the implementation**

Modify `src/lib/auth.ts`:

```typescript
import { isConfigured, resolveConfig } from "./config";

// ... AUTH_COOKIE, AUTH_COOKIE_MAX_AGE, PUBLIC_PATH_PREFIXES, isPublicPath unchanged ...

/** Cheap presence check — true once APP_PASSWORD is set via env var or the config file. */
export function isAppPasswordConfigured(): boolean {
  return isConfigured("APP_PASSWORD");
}

export function requireAppPassword(): string {
  const value = resolveConfig("APP_PASSWORD");
  if (!value) {
    throw new Error(
      "APP_PASSWORD is not configured — set the APP_PASSWORD environment variable or configure it via the config file before running `pnpm dev`.",
    );
  }
  return value;
}

// ... getCookieValue, buildAuthCookie unchanged ...

/**
 * True when `request` carries a cookie matching the configured APP_PASSWORD
 * — or unconditionally true when no APP_PASSWORD is configured at all (a
 * self-hosted instance with no password gate, e.g. behind Tailscale).
 */
export function isAuthenticatedRequest(request: Request): boolean {
  if (!isAppPasswordConfigured()) return true;
  const cookieValue = getCookieValue(request.headers.get("cookie"), AUTH_COOKIE);
  return cookieValue !== undefined && cookieValue === requireAppPassword();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/auth.test.ts`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth.ts src/lib/auth.test.ts
git commit -m "feat(auth): make APP_PASSWORD optional via the config resolver"
```

---

## Task 4: Pipeline CLI uses the shared resolver

**Files:**
- Modify: `src/pipeline/run.ts`

**Interfaces:**
- Consumes: `resolveConfig` from `../lib/config` (Task 1).

`main()` (the real CLI entrypoint) is not unit tested today — only `parseArgs`, `buildRepoList`, `computeRunCounts`, and `runPipeline` are (confirmed via `src/pipeline/run.test.ts`). This task is a source-only change; no new tests are needed, and none of the existing tests reference `main()` or `process.env`.

- [ ] **Step 1: Modify `main()`**

Add the import (alongside the existing relative imports at the top of the file):

```typescript
import { resolveConfig } from "../lib/config";
```

Replace the three `process.env.X` reads and the two client constructions inside `main()`:

```typescript
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  const databaseUrl = resolveConfig("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not configured — set the DATABASE_URL environment variable or configure it via the dashboard settings before running `node run.js`.",
    );
  }
  const githubToken = resolveConfig("PIPELINE_GH_TOKEN");
  if (!githubToken) {
    throw new Error(
      "PIPELINE_GH_TOKEN is not configured — set the PIPELINE_GH_TOKEN environment variable or configure it via the dashboard settings before running `node run.js`.",
    );
  }
  const anthropicApiKey = resolveConfig("ANTHROPIC_API_KEY");
  if (!anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured — set the ANTHROPIC_API_KEY environment variable or configure it via the dashboard settings before running `node run.js`.",
    );
  }

  const db = createDb(databaseUrl);
  const octokit = createOctokit({ PIPELINE_GH_TOKEN: githubToken } as NodeJS.ProcessEnv);
  const anthropicClient = createAnthropicClient({ ANTHROPIC_API_KEY: anthropicApiKey } as NodeJS.ProcessEnv);
  // ... rest of main() (try/finally, runPipeline call, db.$client.end()) unchanged
```

- [ ] **Step 2: Typecheck and run the full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, no changes to `run.test.ts` needed since `main()` isn't covered by it.

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/run.ts
git commit -m "feat(pipeline): read credentials through the shared config resolver"
```

---

## Task 5: Credential validation functions

**Files:**
- Create: `src/lib/settings-queries.ts`
- Test: `src/lib/settings-queries.test.ts`

**Interfaces:**
- Consumes: `createDb` from `~/db/client`; `createOctokit`, type `Octokit` from `~/pipeline/github/client`; `createAnthropicClient`, type default `Anthropic` from `~/pipeline/anthropic/client`.
- Produces:
  - `type ValidationResult = { ok: true } | { ok: false; error: string }`
  - `validateDatabaseUrl(databaseUrl: string, dbFactory?: typeof createDb): Promise<ValidationResult>`
  - `validateGithubToken(token: string, octokitFactory?: (env: NodeJS.ProcessEnv) => Octokit): Promise<ValidationResult>`
  - `validateAnthropicKey(apiKey: string, anthropicFactory?: (env: NodeJS.ProcessEnv) => Anthropic): Promise<ValidationResult>`

Each function accepts an injectable factory (defaulting to the real one) so tests can supply a fake client instead of hitting real GitHub/Anthropic/Postgres — same dependency-injection pattern `createOctokit`/`createAnthropicClient` themselves already use.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/settings-queries.test.ts
import { describe, expect, it } from "vitest";
import { validateAnthropicKey, validateDatabaseUrl, validateGithubToken } from "./settings-queries";

describe("validateDatabaseUrl", () => {
  it("returns ok when the query succeeds", async () => {
    const fakeDb = { $client: { query: async () => ({}), end: async () => {} } };
    const fakeFactory = (() => fakeDb) as unknown as typeof import("~/db/client").createDb;
    const result = await validateDatabaseUrl("postgres://fake", fakeFactory);
    expect(result).toEqual({ ok: true });
  });

  it("returns the error message when the connection fails", async () => {
    const fakeDb = {
      $client: {
        query: async () => {
          throw new Error("connection refused");
        },
        end: async () => {},
      },
    };
    const fakeFactory = (() => fakeDb) as unknown as typeof import("~/db/client").createDb;
    const result = await validateDatabaseUrl("postgres://fake", fakeFactory);
    expect(result).toEqual({ ok: false, error: "connection refused" });
  });
});

describe("validateGithubToken", () => {
  it("returns ok when the authenticated-user call succeeds", async () => {
    const fakeOctokit = { rest: { users: { getAuthenticated: async () => ({ data: {} }) } } };
    const fakeFactory = (() => fakeOctokit) as unknown as (env: NodeJS.ProcessEnv) => import("octokit").Octokit;
    const result = await validateGithubToken("fake-token", fakeFactory);
    expect(result).toEqual({ ok: true });
  });

  it("returns the error message when the token is rejected", async () => {
    const fakeOctokit = {
      rest: {
        users: {
          getAuthenticated: async () => {
            throw new Error("Bad credentials");
          },
        },
      },
    };
    const fakeFactory = (() => fakeOctokit) as unknown as (env: NodeJS.ProcessEnv) => import("octokit").Octokit;
    const result = await validateGithubToken("fake-token", fakeFactory);
    expect(result).toEqual({ ok: false, error: "Bad credentials" });
  });
});

describe("validateAnthropicKey", () => {
  it("returns ok when the models-list call succeeds", async () => {
    const fakeAnthropic = { models: { list: async () => ({ data: [] }) } };
    const fakeFactory = (() => fakeAnthropic) as unknown as (
      env: NodeJS.ProcessEnv,
    ) => import("@anthropic-ai/sdk").default;
    const result = await validateAnthropicKey("fake-key", fakeFactory);
    expect(result).toEqual({ ok: true });
  });

  it("returns the error message when the key is rejected", async () => {
    const fakeAnthropic = {
      models: {
        list: async () => {
          throw new Error("invalid x-api-key");
        },
      },
    };
    const fakeFactory = (() => fakeAnthropic) as unknown as (
      env: NodeJS.ProcessEnv,
    ) => import("@anthropic-ai/sdk").default;
    const result = await validateAnthropicKey("fake-key", fakeFactory);
    expect(result).toEqual({ ok: false, error: "invalid x-api-key" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/settings-queries.test.ts`
Expected: FAIL — `Cannot find module './settings-queries'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/settings-queries.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { Octokit } from "octokit";
import { createDb } from "~/db/client";
import { createAnthropicClient } from "~/pipeline/anthropic/client";
import { createOctokit } from "~/pipeline/github/client";

/**
 * Save-time validation for each self-host credential: attempt a real call
 * against the actual service before the settings actions in ./settings.ts
 * persist anything, so a self-hoster pasting a malformed value finds out
 * immediately instead of on next real use. Each function takes an
 * injectable factory (defaulting to the real one) so tests never hit a real
 * DB/GitHub/Anthropic — same DI pattern createOctokit/createAnthropicClient
 * already use.
 */

export type ValidationResult = { ok: true } | { ok: false; error: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function validateDatabaseUrl(
  databaseUrl: string,
  dbFactory: typeof createDb = createDb,
): Promise<ValidationResult> {
  const db = dbFactory(databaseUrl);
  try {
    await db.$client.query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    await db.$client.end();
  }
}

export async function validateGithubToken(
  token: string,
  octokitFactory: (env: NodeJS.ProcessEnv) => Octokit = createOctokit,
): Promise<ValidationResult> {
  const octokit = octokitFactory({ PIPELINE_GH_TOKEN: token } as NodeJS.ProcessEnv);
  try {
    await octokit.rest.users.getAuthenticated();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function validateAnthropicKey(
  apiKey: string,
  anthropicFactory: (env: NodeJS.ProcessEnv) => Anthropic = createAnthropicClient,
): Promise<ValidationResult> {
  const client = anthropicFactory({ ANTHROPIC_API_KEY: apiKey } as NodeJS.ProcessEnv);
  try {
    await client.models.list();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/settings-queries.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (The `as unknown as ...` casts in the test file are deliberate — the fakes are structurally partial, not full `Octokit`/`Anthropic`/`NodePgDatabase` instances.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/settings-queries.ts src/lib/settings-queries.test.ts
git commit -m "feat(settings): add save-time credential validation"
```

---

## Task 6: Settings server actions and status query

**Files:**
- Create: `src/lib/settings.ts`
- Test: `src/lib/settings.test.ts`

**Interfaces:**
- Consumes: `isConfigured`, `setConfigValue` from `./config` (Task 1); `assertAuthenticated` from `./auth-guard`; `validateDatabaseUrl`, `validateGithubToken`, `validateAnthropicKey` from `./settings-queries` (Task 5).
- Produces:
  - `getCredentialStatus` — a `query()` returning `{ databaseConfigured: boolean; githubTokenConfigured: boolean; anthropicKeyConfigured: boolean }`
  - `saveDatabaseUrl`, `saveGithubToken`, `saveAnthropicKey` — `action()`s taking `FormData`, returning `{ error: string | null }`

This module wraps `settings-queries.ts`'s pure validation functions in SolidStart's `"use server"` boundary, following the same shape `dashboard.ts` already uses for `getDashboardData`/`toggleAssess`. Because `action()`/`query()` wrapping needs Solid's request-event context (via `assertAuthenticated()`), these are tested by importing and calling the underlying handlers directly with mocked `./config` and `./settings-queries`, the same indirection `dashboard.ts` avoids by keeping its pure logic in `dashboard-queries.ts` — here the wrapping is thin enough to test directly against mocks instead.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/settings.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-guard", () => ({ assertAuthenticated: vi.fn() }));
vi.mock("./config", () => ({
  isConfigured: vi.fn(),
  setConfigValue: vi.fn(),
}));
vi.mock("./settings-queries", () => ({
  validateDatabaseUrl: vi.fn(),
  validateGithubToken: vi.fn(),
  validateAnthropicKey: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function formDataWith(field: string, value: string): FormData {
  const formData = new FormData();
  formData.set(field, value);
  return formData;
}

describe("getCredentialStatus", () => {
  it("reports which credentials are configured", async () => {
    const { isConfigured } = await import("./config");
    vi.mocked(isConfigured).mockImplementation((key: string) => key === "DATABASE_URL");
    const { getCredentialStatus } = await import("./settings");
    expect(await getCredentialStatus()).toEqual({
      databaseConfigured: true,
      githubTokenConfigured: false,
      anthropicKeyConfigured: false,
    });
  });
});

describe("saveDatabaseUrl", () => {
  it("persists the value when validation succeeds", async () => {
    const { validateDatabaseUrl } = await import("./settings-queries");
    vi.mocked(validateDatabaseUrl).mockResolvedValue({ ok: true });
    const { setConfigValue } = await import("./config");
    const { saveDatabaseUrl } = await import("./settings");

    const result = await saveDatabaseUrl(formDataWith("databaseUrl", "postgres://real"));

    expect(result).toEqual({ error: null });
    expect(setConfigValue).toHaveBeenCalledWith("DATABASE_URL", "postgres://real");
  });

  it("does not persist and returns the error when validation fails", async () => {
    const { validateDatabaseUrl } = await import("./settings-queries");
    vi.mocked(validateDatabaseUrl).mockResolvedValue({ ok: false, error: "connection refused" });
    const { setConfigValue } = await import("./config");
    const { saveDatabaseUrl } = await import("./settings");

    const result = await saveDatabaseUrl(formDataWith("databaseUrl", "postgres://bad"));

    expect(result).toEqual({ error: "connection refused" });
    expect(setConfigValue).not.toHaveBeenCalled();
  });
});

describe("saveGithubToken", () => {
  it("persists the value when validation succeeds", async () => {
    const { validateGithubToken } = await import("./settings-queries");
    vi.mocked(validateGithubToken).mockResolvedValue({ ok: true });
    const { setConfigValue } = await import("./config");
    const { saveGithubToken } = await import("./settings");

    const result = await saveGithubToken(formDataWith("githubToken", "ghp_real"));

    expect(result).toEqual({ error: null });
    expect(setConfigValue).toHaveBeenCalledWith("PIPELINE_GH_TOKEN", "ghp_real");
  });
});

describe("saveAnthropicKey", () => {
  it("persists the value when validation succeeds", async () => {
    const { validateAnthropicKey } = await import("./settings-queries");
    vi.mocked(validateAnthropicKey).mockResolvedValue({ ok: true });
    const { setConfigValue } = await import("./config");
    const { saveAnthropicKey } = await import("./settings");

    const result = await saveAnthropicKey(formDataWith("anthropicKey", "sk-ant-real"));

    expect(result).toEqual({ error: null });
    expect(setConfigValue).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "sk-ant-real");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/settings.test.ts`
Expected: FAIL — `Cannot find module './settings'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/settings.ts
import { action, query } from "@solidjs/router";
import { assertAuthenticated } from "./auth-guard";
import { isConfigured, setConfigValue } from "./config";
import { validateAnthropicKey, validateDatabaseUrl, validateGithubToken } from "./settings-queries";

export const getCredentialStatus = query(async () => {
  "use server";
  assertAuthenticated();
  return {
    databaseConfigured: isConfigured("DATABASE_URL"),
    githubTokenConfigured: isConfigured("PIPELINE_GH_TOKEN"),
    anthropicKeyConfigured: isConfigured("ANTHROPIC_API_KEY"),
  };
}, "credentialStatus");

export const saveDatabaseUrl = action(async (formData: FormData) => {
  "use server";
  assertAuthenticated();
  const value = String(formData.get("databaseUrl") ?? "").trim();
  const result = await validateDatabaseUrl(value);
  if (!result.ok) return { error: result.error };
  setConfigValue("DATABASE_URL", value);
  return { error: null };
}, "saveDatabaseUrl");

export const saveGithubToken = action(async (formData: FormData) => {
  "use server";
  assertAuthenticated();
  const value = String(formData.get("githubToken") ?? "").trim();
  const result = await validateGithubToken(value);
  if (!result.ok) return { error: result.error };
  setConfigValue("PIPELINE_GH_TOKEN", value);
  return { error: null };
}, "saveGithubToken");

export const saveAnthropicKey = action(async (formData: FormData) => {
  "use server";
  assertAuthenticated();
  const value = String(formData.get("anthropicKey") ?? "").trim();
  const result = await validateAnthropicKey(value);
  if (!result.ok) return { error: result.error };
  setConfigValue("ANTHROPIC_API_KEY", value);
  return { error: null };
}, "saveAnthropicKey");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/settings.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/settings.ts src/lib/settings.test.ts
git commit -m "feat(settings): add credential status query and save actions"
```

---

## Task 7: Credentials panel and conditional dashboard rendering

**Files:**
- Create: `src/components/CredentialsPanel.tsx`
- Test: `src/components/CredentialsPanel.test.tsx`
- Modify: `src/routes/index.tsx`

**Interfaces:**
- Consumes: `getCredentialStatus`, `saveDatabaseUrl`, `saveGithubToken`, `saveAnthropicKey` from `~/lib/settings` (Task 6). `CredentialStatus` type shape: `{ databaseConfigured: boolean; githubTokenConfigured: boolean; anthropicKeyConfigured: boolean }`.
- Produces: `CredentialsPanel` — default-exported Solid component, props `{ status: CredentialStatus }`.

- [ ] **Step 1: Write the failing test**

Follow `RepoCard.test.tsx`'s established pattern (`@vitest-environment jsdom`, `@solidjs/testing-library`, mocking the actions module):

```tsx
// src/components/CredentialsPanel.test.tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/lib/settings", async () => {
  const { action } = await import("@solidjs/router");
  return {
    saveDatabaseUrl: action(async () => ({ error: null }), "saveDatabaseUrl"),
    saveGithubToken: action(async () => ({ error: null }), "saveGithubToken"),
    saveAnthropicKey: action(async () => ({ error: null }), "saveAnthropicKey"),
  };
});

const CredentialsPanel = (await import("./CredentialsPanel")).default;

afterEach(() => {
  cleanup();
});

describe("CredentialsPanel", () => {
  it("shows all three fields as not configured", () => {
    render(() => (
      <CredentialsPanel
        status={{ databaseConfigured: false, githubTokenConfigured: false, anthropicKeyConfigured: false }}
      />
    ));
    expect(screen.getAllByText(/not configured/i).length).toBe(3);
  });

  it("shows a configured credential as configured, not as an empty field", () => {
    render(() => (
      <CredentialsPanel
        status={{ databaseConfigured: true, githubTokenConfigured: false, anthropicKeyConfigured: false }}
      />
    ));
    expect(screen.getByText(/database.*configured/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/CredentialsPanel.test.tsx`
Expected: FAIL — `Cannot find module './CredentialsPanel'`.

- [ ] **Step 3: Write the implementation**

```tsx
// src/components/CredentialsPanel.tsx
import { useAction, useSubmission } from "@solidjs/router";
import { Show } from "solid-js";
import { saveAnthropicKey, saveDatabaseUrl, saveGithubToken } from "~/lib/settings";

export interface CredentialStatus {
  databaseConfigured: boolean;
  githubTokenConfigured: boolean;
  anthropicKeyConfigured: boolean;
}

function CredentialField(props: {
  label: string;
  fieldName: string;
  inputType: string;
  configured: boolean;
  action: (formData: FormData) => Promise<{ error: string | null }>;
}) {
  const submit = useAction(props.action);
  const submission = useSubmission(props.action);

  async function handleSubmit(event: Event & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    await submit(new FormData(event.currentTarget));
  }

  return (
    <form class="credential-field" onSubmit={handleSubmit}>
      <label for={props.fieldName}>{props.label}</label>
      <p class="credential-status">{props.label} is {props.configured ? "configured" : "not configured"}.</p>
      <input
        id={props.fieldName}
        name={props.fieldName}
        type={props.inputType}
        placeholder={props.configured ? "Enter a new value to replace it" : `Enter your ${props.label}`}
        disabled={submission.pending}
      />
      {submission.result?.error && <p class="credential-error">{submission.result.error}</p>}
      <button type="submit" disabled={submission.pending}>
        {submission.pending ? "Validating…" : "Save"}
      </button>
    </form>
  );
}

export default function CredentialsPanel(props: { status: CredentialStatus }) {
  return (
    <div class="credentials-panel">
      <CredentialField
        label="Database connection string"
        fieldName="databaseUrl"
        inputType="password"
        configured={props.status.databaseConfigured}
        action={saveDatabaseUrl}
      />
      <CredentialField
        label="GitHub personal access token"
        fieldName="githubToken"
        inputType="password"
        configured={props.status.githubTokenConfigured}
        action={saveGithubToken}
      />
      <CredentialField
        label="Anthropic API key"
        fieldName="anthropicKey"
        inputType="password"
        configured={props.status.anthropicKeyConfigured}
        action={saveAnthropicKey}
      />
      <Show when={!props.status.databaseConfigured}>
        <p class="credentials-hint">
          Add a database connection string to get started — GitHub and Anthropic credentials can be added any
          time after, whenever you're ready to run the pipeline.
        </p>
      </Show>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/CredentialsPanel.test.tsx`
Expected: PASS, both tests.

- [ ] **Step 5: Wire conditional rendering into the dashboard route**

Modify `src/routes/index.tsx`. The existing file imports `getDashboardData` and renders the dashboard unconditionally; add `getCredentialStatus` and gate on `databaseConfigured`:

```tsx
// src/routes/index.tsx
import { Title } from "@solidjs/meta";
import { createAsync } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import CredentialsPanel from "~/components/CredentialsPanel";
import RepoCard from "~/components/RepoCard";
import Totals from "~/components/Totals";
import { getDashboardData } from "~/lib/dashboard";
import { computeTotals, filterVisibleRepos } from "~/lib/dashboard-view";
import { getCredentialStatus } from "~/lib/settings";

export default function Home() {
  const status = createAsync(() => getCredentialStatus());
  const data = createAsync(async () => {
    const s = status();
    if (!s?.databaseConfigured) return undefined;
    return getDashboardData();
  });

  const [hideIgnored, setHideIgnored] = createSignal(false);

  onMount(() => {
    try {
      if (localStorage.getItem("hideIgnoredRepos") === "true") {
        setHideIgnored(true);
      }
    } catch {
      /* localStorage unavailable — preference just won't persist */
    }
  });

  createEffect(() => {
    try {
      localStorage.setItem("hideIgnoredRepos", String(hideIgnored()));
    } catch {
      /* localStorage unavailable — preference just won't persist */
    }
  });

  return (
    <div class="wrap">
      <Title>GitHub Project Tracker</Title>
      <Show when={status()}>
        {(s) => (
          <Show
            when={s().databaseConfigured}
            fallback={
              <>
                <header class="page">
                  <h1>Project completion tracker</h1>
                  <p class="sub">Add a database connection to get started.</p>
                </header>
                <CredentialsPanel status={s()} />
              </>
            }
          >
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
              {(dashboard) => {
                const visibleRepos = createMemo(() => filterVisibleRepos(dashboard().repos, hideIgnored()));
                const visibleTotals = createMemo(() =>
                  hideIgnored() ? computeTotals(visibleRepos()) : dashboard().totals,
                );

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
                    <Show
                      when={visibleRepos().length > 0}
                      fallback={<p class="empty">No repos to show — everything is currently ignored.</p>}
                    >
                      <div id="repos">
                        <For each={visibleRepos()}>{(repo) => <RepoCard repo={repo} />}</For>
                      </div>
                    </Show>
                  </>
                );
              }}
            </Show>

            <details class="settings-section">
              <summary>Settings</summary>
              <CredentialsPanel status={s()} />
            </details>

            <footer class="page">
              Percentages are judgment calls about "stated scope shipped," not code coverage. Ignored repos are
              excluded from AI assessment — use the Auto/Yes/No control on any repo to force it ignored, force it
              included, or hand it back to the automatic rules.
            </footer>
          </Show>
        )}
      </Show>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck and run the full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Live verification (per this project's standing rule — wiring previously-independent modules together needs a real end-to-end check, not just unit tests)**

Run the dev server (`pnpm dev`) against three scenarios, in order:

1. **Fresh instance**: temporarily point `CONFIG_FILE_PATH` at a scratch path with nothing there and unset `DATABASE_URL`/`PIPELINE_GH_TOKEN`/`ANTHROPIC_API_KEY`/`APP_PASSWORD` for the dev process. Confirm the page loads the credentials-only view (no crash, no `/login` redirect since no password is configured).
2. **Progressive unlock**: submit a real (or scratch) Postgres connection string into the DB field. Confirm the dashboard shell renders (empty repo list) without restarting the server. Submit a deliberately invalid GitHub PAT and confirm the form shows the real rejection error and does not mark it configured; then submit a valid one and confirm it does.
3. **Regression check (the one that matters most)**: with today's production-style config restored (all three env vars plus `APP_PASSWORD` set, no config file), confirm the dashboard renders and behaves exactly as it does today — real data, password gate active, no credentials panel intruding on the normal view (only reachable via the collapsed "Settings" `<details>`).

- [ ] **Step 8: Commit**

```bash
git add src/components/CredentialsPanel.tsx src/components/CredentialsPanel.test.tsx src/routes/index.tsx
git commit -m "feat(settings): render credentials panel and gate dashboard on DB config"
```
