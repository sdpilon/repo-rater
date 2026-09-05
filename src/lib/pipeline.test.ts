// @vitest-environment jsdom
//
// Mirrors dashboard.test.ts's established pattern for testing thin
// "use server" action()/query() wrappers directly against mocks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-guard", () => ({ assertAuthenticated: vi.fn() }));
vi.mock("./server-db", () => ({ getDb: vi.fn(), isDbConfigured: vi.fn() }));
vi.mock("./demo-mode", () => ({ isDemoMode: vi.fn() }));
vi.mock("../pipeline/runs", () => ({ getLatestRun: vi.fn() }));
vi.mock("../pipeline/run", () => ({
  resolvePipelineCredentials: vi.fn(),
  runPipelineFromConfig: vi.fn(),
}));

// @solidjs/router's query() caches results by cache key across calls
// within the same module instance — reset modules between tests so each
// test's (re-mocked) resolver actually gets invoked. Mirrors
// dashboard.test.ts's established pattern.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

// @solidjs/router's action() wraps the server function in a client-side
// "mutate" closure that reads submission bookkeeping off `this.r` (a router
// instance normally supplied by <Router>/useAction()). Outside a rendered
// router tree there's no such `this`, so a bare call throws — bind a
// minimal stand-in, copied verbatim from dashboard.test.ts (the version
// whose submissions[1] "setter" actually invokes its updater, since
// triggerPipelineRun returns json(...) same as toggleAssess does).
const fakeRouterContext = {
  r: {
    submissions: [
      () => [],
      (updater: (submissions: unknown[]) => unknown[]) => updater([]),
    ],
    navigatorFactory: () => () => {},
  },
};

function callAction<A extends (...args: never[]) => unknown>(
  action: A,
  ...args: Parameters<A>
): ReturnType<A> {
  return (action as (...a: Parameters<A>) => ReturnType<A>).apply(
    fakeRouterContext,
    args,
  );
}

describe("getPipelineStatus", () => {
  it("returns undefined without touching the DB when unconfigured", async () => {
    const { isDbConfigured, getDb } = await import("./server-db");
    vi.mocked(isDbConfigured).mockReturnValue(false);
    const { getLatestRun } = await import("../pipeline/runs");
    const { getPipelineStatus } = await import("./pipeline");

    const result = await getPipelineStatus();

    expect(result).toBeUndefined();
    expect(getDb).not.toHaveBeenCalled();
    expect(getLatestRun).not.toHaveBeenCalled();
  });

  it("returns undefined when no run has ever happened", async () => {
    const { isDbConfigured, getDb } = await import("./server-db");
    vi.mocked(isDbConfigured).mockReturnValue(true);
    const fakeDb = { fake: "db" };
    vi.mocked(getDb).mockResolvedValue(fakeDb as never);
    const { getLatestRun } = await import("../pipeline/runs");
    vi.mocked(getLatestRun).mockResolvedValue(undefined);
    const { getPipelineStatus } = await import("./pipeline");

    const result = await getPipelineStatus();

    expect(result).toBeUndefined();
  });

  it("maps an unfinished row to inProgress:true", async () => {
    const { isDbConfigured, getDb } = await import("./server-db");
    vi.mocked(isDbConfigured).mockReturnValue(true);
    const fakeDb = { fake: "db" };
    vi.mocked(getDb).mockResolvedValue(fakeDb as never);
    const { getLatestRun } = await import("../pipeline/runs");
    const startedAt = new Date("2026-09-05T00:00:00.000Z");
    vi.mocked(getLatestRun).mockResolvedValue({
      runId: "run_1",
      startedAt,
      finishedAt: null,
      status: "partial",
      reposDiscovered: 5,
      reposFetchedOk: 0,
      reposFailed: 0,
      llmCallsMade: 0,
      llmCallsSkipped: 0,
    } as never);
    const { getPipelineStatus } = await import("./pipeline");

    const result = await getPipelineStatus();

    expect(result).toEqual({
      inProgress: true,
      status: "partial",
      startedAt,
      finishedAt: null,
      reposFetchedOk: 0,
      reposFailed: 0,
    });
  });

  it("maps a finished row to inProgress:false", async () => {
    const { isDbConfigured, getDb } = await import("./server-db");
    vi.mocked(isDbConfigured).mockReturnValue(true);
    const fakeDb = { fake: "db" };
    vi.mocked(getDb).mockResolvedValue(fakeDb as never);
    const { getLatestRun } = await import("../pipeline/runs");
    const startedAt = new Date("2026-09-05T00:00:00.000Z");
    const finishedAt = new Date("2026-09-05T00:05:00.000Z");
    vi.mocked(getLatestRun).mockResolvedValue({
      runId: "run_1",
      startedAt,
      finishedAt,
      status: "success",
      reposDiscovered: 5,
      reposFetchedOk: 5,
      reposFailed: 0,
      llmCallsMade: 3,
      llmCallsSkipped: 2,
    } as never);
    const { getPipelineStatus } = await import("./pipeline");

    const result = await getPipelineStatus();

    expect(result).toEqual({
      inProgress: false,
      status: "success",
      startedAt,
      finishedAt,
      reposFetchedOk: 5,
      reposFailed: 0,
    });
  });
});

describe("triggerPipelineRun", () => {
  it("blocks in demo mode before checking credentials", async () => {
    const { isDemoMode } = await import("./demo-mode");
    vi.mocked(isDemoMode).mockReturnValue(true);
    const { resolvePipelineCredentials, runPipelineFromConfig } = await import(
      "../pipeline/run"
    );
    const { getLatestRun } = await import("../pipeline/runs");
    const { triggerPipelineRun } = await import("./pipeline");

    const result = await callAction(triggerPipelineRun);

    expect(result).toEqual({
      error: "Demo mode is enabled; changes are restricted.",
    });
    expect(resolvePipelineCredentials).not.toHaveBeenCalled();
    expect(getLatestRun).not.toHaveBeenCalled();
    expect(runPipelineFromConfig).not.toHaveBeenCalled();
  });

  it("reports a missing credential without touching the db", async () => {
    const { isDemoMode } = await import("./demo-mode");
    vi.mocked(isDemoMode).mockReturnValue(false);
    const { resolvePipelineCredentials, runPipelineFromConfig } = await import(
      "../pipeline/run"
    );
    vi.mocked(resolvePipelineCredentials).mockReturnValue({
      ok: false,
      error: "DATABASE_URL is not configured — ...",
    });
    const { getDb } = await import("./server-db");
    const { getLatestRun } = await import("../pipeline/runs");
    const { triggerPipelineRun } = await import("./pipeline");

    const result = await callAction(triggerPipelineRun);

    expect(result).toEqual({ error: "DATABASE_URL is not configured — ..." });
    expect(getDb).not.toHaveBeenCalled();
    expect(getLatestRun).not.toHaveBeenCalled();
    expect(runPipelineFromConfig).not.toHaveBeenCalled();
  });

  it("blocks when a run is already in progress", async () => {
    const { isDemoMode } = await import("./demo-mode");
    vi.mocked(isDemoMode).mockReturnValue(false);
    const { resolvePipelineCredentials, runPipelineFromConfig } = await import(
      "../pipeline/run"
    );
    vi.mocked(resolvePipelineCredentials).mockReturnValue({
      ok: true,
      databaseUrl: "postgres://localhost/test",
      githubToken: "gh-token",
      anthropicApiKey: "anthropic-key",
    });
    const { getDb } = await import("./server-db");
    const fakeDb = { fake: "db" };
    vi.mocked(getDb).mockResolvedValue(fakeDb as never);
    const { getLatestRun } = await import("../pipeline/runs");
    vi.mocked(getLatestRun).mockResolvedValue({
      runId: "run_1",
      finishedAt: null,
    } as never);
    const { triggerPipelineRun } = await import("./pipeline");

    const result = await callAction(triggerPipelineRun);

    expect(result).toEqual({ error: "A pipeline run is already in progress." });
    expect(runPipelineFromConfig).not.toHaveBeenCalled();
  });

  it("fires the pipeline run without awaiting it", async () => {
    const { isDemoMode } = await import("./demo-mode");
    vi.mocked(isDemoMode).mockReturnValue(false);
    const { resolvePipelineCredentials, runPipelineFromConfig } = await import(
      "../pipeline/run"
    );
    vi.mocked(resolvePipelineCredentials).mockReturnValue({
      ok: true,
      databaseUrl: "postgres://localhost/test",
      githubToken: "gh-token",
      anthropicApiKey: "anthropic-key",
    });
    const { getDb } = await import("./server-db");
    const fakeDb = { fake: "db" };
    vi.mocked(getDb).mockResolvedValue(fakeDb as never);
    const { getLatestRun } = await import("../pipeline/runs");
    vi.mocked(getLatestRun).mockResolvedValue(undefined);
    // A never-resolving promise proves the action doesn't await it.
    vi.mocked(runPipelineFromConfig).mockReturnValue(new Promise(() => {}));
    const { triggerPipelineRun } = await import("./pipeline");

    const result = await callAction(triggerPipelineRun);

    expect(result).toEqual({ error: null });
    expect(runPipelineFromConfig).toHaveBeenCalledWith({
      dryRun: false,
      limit: null,
    });
  });
});
