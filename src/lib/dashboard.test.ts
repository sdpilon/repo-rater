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
