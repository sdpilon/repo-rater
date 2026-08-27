// @vitest-environment jsdom
//
// @solidjs/router's action()/query() wrapping touches `window` at module
// init (see lifecycle.js's saveCurrentDepth()) unless solid-js resolves its
// server build — jsdom keeps `window` around as a safe fallback either way.
// This mirrors settings.test.ts, the established pattern for testing thin
// "use server" action()/query() wrappers directly against mocks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-guard", () => ({ assertAuthenticated: vi.fn() }));
vi.mock("./server-db", () => ({ getDb: vi.fn(), isDbConfigured: vi.fn() }));
vi.mock("./dashboard-queries", () => ({
  getDashboardView: vi.fn(),
  setRepoAssessControl: vi.fn(),
}));
vi.mock("./demo-mode", () => ({ isDemoMode: vi.fn() }));

// @solidjs/router's query() caches results by cache key ("dashboard") across
// calls within the same module instance — without resetting the module
// registry between tests, the second test's call would just replay the
// first test's cached `undefined` result instead of re-invoking the
// (re-mocked) resolver. Mirrors settings.test.ts's established pattern.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

// @solidjs/router's action() wraps the server function in a client-side
// "mutate" closure that reads submission bookkeeping off `this.r` (a router
// instance normally supplied by <Router>/useAction()). Outside a rendered
// router tree there's no such `this`, so a bare call throws — bind a minimal
// stand-in that satisfies mutate's bookkeeping (submissions signal tuple,
// falsy singleFlight) without pulling in a real router or rendering anything.
// Mirrors settings.test.ts's established pattern, but the submissions[1]
// "setter" here must actually invoke its updater (unlike settings.test.ts's
// no-op): toggleAssess returns json(null, ...), so mutate's handler takes
// the `!result` branch and calls `submission.clear()` — that variable is
// only assigned as a side effect of the updater actually running.
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

// Finding 6: isDbConfigured() had no production caller. Wired in here as a
// defense-in-depth guard — a direct POST to /_server?id=dashboard on an
// unconfigured instance previously fell through to getDb(), which throws,
// instead of failing cleanly.
describe("getDashboardData", () => {
  it("returns undefined without touching the DB when unconfigured", async () => {
    const { isDbConfigured, getDb } = await import("./server-db");
    vi.mocked(isDbConfigured).mockReturnValue(false);
    const { getDashboardView } = await import("./dashboard-queries");
    const { getDashboardData } = await import("./dashboard");

    const result = await getDashboardData();

    expect(result).toBeUndefined();
    expect(getDb).not.toHaveBeenCalled();
    expect(getDashboardView).not.toHaveBeenCalled();
  });

  it("queries the dashboard view through getDb() when configured", async () => {
    const { isDbConfigured, getDb } = await import("./server-db");
    vi.mocked(isDbConfigured).mockReturnValue(true);
    const fakeDb = { fake: "db" };
    vi.mocked(getDb).mockReturnValue(fakeDb as never);
    const { getDashboardView } = await import("./dashboard-queries");
    const fakeView = { repos: [], totals: {} };
    vi.mocked(getDashboardView).mockResolvedValue(fakeView as never);
    const { getDashboardData } = await import("./dashboard");

    const result = await getDashboardData();

    expect(getDashboardView).toHaveBeenCalledWith(fakeDb);
    expect(result).toEqual(fakeView);
  });
});

// Acceptance criteria
// Calling toggleAssess throws before touching the database when
// isDemoMode() is true and works normally when false
describe("toggleAssess", () => {
  it("throws an error if isDemoMode() is true", async () => {
    const { isDemoMode } = await import("./demo-mode");
    vi.mocked(isDemoMode).mockReturnValue(true);
    const { setRepoAssessControl } = await import("./dashboard-queries");

    const { toggleAssess } = await import("./dashboard");
    await expect(callAction(toggleAssess, 0, "no")).rejects.toThrow(
      "Demo mode is enabled; changes are restricted.",
    );
    expect(setRepoAssessControl).not.toHaveBeenCalled();
  });

  it("toggles the assess control if isDemoMode() is false", async () => {
    const { isDemoMode } = await import("./demo-mode");
    vi.mocked(isDemoMode).mockReturnValue(false);
    const { getDb } = await import("./server-db");
    const fakeDb = { fake: "db" };
    vi.mocked(getDb).mockReturnValue(fakeDb as never);
    const { setRepoAssessControl } = await import("./dashboard-queries");

    const { toggleAssess } = await import("./dashboard");
    await callAction(toggleAssess, 0, "no");
    expect(setRepoAssessControl).toHaveBeenCalledWith(fakeDb, 0, "no");
  });
});
