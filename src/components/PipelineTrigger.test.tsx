// @vitest-environment jsdom
import { MemoryRouter, revalidate, Route } from "@solidjs/router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineStatus } from "~/lib/pipeline";

// getPipelineStatus and triggerPipelineRun both use the real query()/
// action() HOCs (not plain mocked functions) — a real query() is needed to
// faithfully reproduce action()'s built-in "revalidate matching keys after
// this action resolves" behavior, which is exactly what the race-condition
// test below is about. This mock is static (no vi.resetModules()/dynamic
// re-import): resetting modules mid-file would force @solidjs/router to
// re-evaluate as a fresh instance for anything imported afterward, breaking
// Context identity between this file's statically-imported MemoryRouter/
// Route and the component tree (confirmed — that's what caused an earlier
// "can be only used inside a Route" crash here).
const statusImpl = vi.fn();
const triggerImpl = vi.fn();
vi.mock("~/lib/pipeline", async () => {
  const { action, query } = await import("@solidjs/router");
  return {
    getPipelineStatus: query(statusImpl, "pipelineStatus"),
    triggerPipelineRun: action(triggerImpl, "triggerPipelineRun"),
  };
});

const { default: PipelineTrigger, POLL_INTERVAL_MS } = await import(
  "./PipelineTrigger"
);

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  // query()'s cache is module-level and persists across tests in this file
  // (no vi.resetModules() here — see the comment above). Force-invalidate
  // it so the next test's render actually calls the freshly-mocked
  // statusImpl instead of reusing a previous test's cached value.
  await revalidate("pipelineStatus");
});

function renderTrigger(status: PipelineStatus | undefined) {
  statusImpl.mockResolvedValue(status);
  return render(() => (
    <MemoryRouter>
      <Route path="/" component={() => <PipelineTrigger />} />
    </MemoryRouter>
  ));
}

describe("PipelineTrigger", () => {
  it("renders the button with no status text when no run has ever happened", async () => {
    renderTrigger(undefined);

    expect(
      await screen.findByRole("button", { name: "Run pipeline now" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Running|Last run/)).toBeNull();
  });

  it("shows an in-progress message and disables the button while a run is in progress", async () => {
    renderTrigger({
      inProgress: true,
      status: "partial",
      startedAt: new Date("2026-09-05T12:00:00.000Z"),
      finishedAt: null,
      reposFetchedOk: 0,
      reposFailed: 0,
    });

    expect(await screen.findByText(/Running…/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Run pipeline now" });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it("shows the last run's outcome and an enabled button when no run is in progress", async () => {
    renderTrigger({
      inProgress: false,
      status: "success",
      startedAt: new Date("2026-09-05T12:00:00.000Z"),
      finishedAt: new Date("2026-09-05T12:05:00.000Z"),
      reposFetchedOk: 5,
      reposFailed: 0,
    });

    expect(await screen.findByText(/Last run: success at/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Run pipeline now" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("alerts with the error message when triggering fails", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    renderTrigger(undefined);
    triggerImpl.mockResolvedValue({
      error: "A pipeline run is already in progress.",
    });
    const button = await screen.findByRole("button", {
      name: "Run pipeline now",
    });

    fireEvent.click(button);

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        "A pipeline run is already in progress.",
      ),
    );
    alertSpy.mockRestore();
  });

  it("keeps polling (doesn't treat 'not started yet' as 'finished') when the first poll tick fires before the new run's row exists", async () => {
    vi.useFakeTimers();
    try {
      // A prior FINISHED run — status() reads "not in progress" both
      // before the click and on an early poll that still hasn't seen the
      // new run's row (recordRunStart only happens after discovery's
      // GitHub round-trip completes server-side, which for an account
      // with many repos can easily take longer than one POLL_INTERVAL_MS
      // tick). Each mocked call returns a *fresh* object instance (not
      // `undefined`, and not the same object reference every time) to
      // match production: every DB read produces a distinct deserialized
      // object even when the underlying data is unchanged, so Solid's
      // reference-equality-based reactivity actually re-runs the effect —
      // an `undefined -> undefined` (or same-reference) mock would falsely
      // look like "no change" and never re-trigger it at all.
      const priorFinished: PipelineStatus = {
        inProgress: false,
        status: "success",
        startedAt: new Date("2026-09-06T11:00:00.000Z"),
        finishedAt: new Date("2026-09-06T11:05:00.000Z"),
        reposFetchedOk: 3,
        reposFailed: 0,
      };
      statusImpl.mockImplementation(async () => ({ ...priorFinished }));
      triggerImpl.mockResolvedValue({ error: null });

      render(() => (
        <MemoryRouter>
          <Route path="/" component={() => <PipelineTrigger />} />
        </MemoryRouter>
      ));
      await vi.advanceTimersByTimeAsync(0);
      const button = screen.getByRole("button", {
        name: "Run pipeline now",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);

      fireEvent.click(button);
      await vi.advanceTimersByTimeAsync(0);
      expect(button.disabled).toBe(true);

      // First poll tick fires — the new run still hasn't written its row,
      // so this still resolves the same (stale) prior-finished run. The
      // button must stay disabled and polling must stay alive through
      // this, not treat it as done.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(button.disabled).toBe(true);

      // The real run finally shows up on a later poll.
      const newRunInProgress: PipelineStatus = {
        inProgress: true,
        status: "partial",
        startedAt: new Date("2026-09-06T12:00:00.000Z"),
        finishedAt: null,
        reposFetchedOk: 0,
        reposFailed: 0,
      };
      statusImpl.mockResolvedValue(newRunInProgress);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(button.disabled).toBe(true);
      expect(screen.getByText(/Running…/)).toBeTruthy();

      // And once it genuinely finishes, the button re-enables.
      statusImpl.mockResolvedValue({
        ...newRunInProgress,
        inProgress: false,
        status: "success",
        finishedAt: new Date("2026-09-06T12:05:00.000Z"),
      });
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(button.disabled).toBe(false);
      expect(screen.getByText(/Last run: success at/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-enables the button once a new run appears already finished, even if no poll ever caught it in progress", async () => {
    vi.useFakeTimers();
    try {
      // Discovery can fail fast enough (e.g. a bad credential rejected
      // immediately) that the discoverError bugfix writes a "failed" row
      // before any poll ever observes an inProgress:true state for it.
      // The button must still re-enable once that new, already-finished
      // run is observed — it can't wait forever for an in-progress
      // sighting that will never come.
      statusImpl.mockResolvedValue(undefined); // no prior runs
      triggerImpl.mockResolvedValue({ error: null });

      render(() => (
        <MemoryRouter>
          <Route path="/" component={() => <PipelineTrigger />} />
        </MemoryRouter>
      ));
      await vi.advanceTimersByTimeAsync(0);
      const button = screen.getByRole("button", {
        name: "Run pipeline now",
      }) as HTMLButtonElement;

      fireEvent.click(button);
      await vi.advanceTimersByTimeAsync(0);
      expect(button.disabled).toBe(true);

      const newRunFailed: PipelineStatus = {
        inProgress: false,
        status: "failed",
        startedAt: new Date("2026-09-06T15:31:15.000Z"),
        finishedAt: new Date("2026-09-06T15:31:16.000Z"),
        reposFetchedOk: 0,
        reposFailed: 0,
      };
      statusImpl.mockResolvedValue(newRunFailed);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(button.disabled).toBe(false);
      expect(screen.getByText(/Last run: failed at/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
