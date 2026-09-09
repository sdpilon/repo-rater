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
// action() HOCs (not plain mocked functions), matching production shape.
// This mock is static (no vi.resetModules()/dynamic re-import): resetting
// modules mid-file would force @solidjs/router to re-evaluate as a fresh
// instance for anything imported afterward, breaking Context identity
// between this file's statically-imported MemoryRouter/Route and the
// component tree (confirmed — that's what caused an earlier "can be only
// used inside a Route" crash here).
const statusImpl = vi.fn();
const triggerImpl = vi.fn();
vi.mock("~/lib/pipeline", async () => {
  const { action, query } = await import("@solidjs/router");
  return {
    getPipelineStatus: query(statusImpl, "pipelineStatus"),
    triggerPipelineRun: action(triggerImpl, "triggerPipelineRun"),
  };
});

const { default: PipelineTrigger } = await import("./PipelineTrigger");

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

  it("shows an in-progress message and disables the button when a run is already in progress at load", async () => {
    renderTrigger({
      inProgress: true,
      status: "partial",
      startedAt: new Date("2026-09-06T12:00:00.000Z"),
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
      startedAt: new Date("2026-09-06T12:00:00.000Z"),
      finishedAt: new Date("2026-09-06T12:05:00.000Z"),
      reposFetchedOk: 5,
      reposFailed: 0,
    });

    expect(await screen.findByText(/Last run: success at/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Run pipeline now" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables the button and shows Running… while the blocking trigger is in flight", async () => {
    renderTrigger(undefined);
    let resolveTrigger!: (value: { error: string | null }) => void;
    triggerImpl.mockReturnValue(
      new Promise((resolve) => {
        resolveTrigger = resolve;
      }),
    );
    const button = await screen.findByRole("button", {
      name: "Run pipeline now",
    });

    fireEvent.click(button);

    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByText("Running…")).toBeTruthy();

    resolveTrigger({ error: null });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("alerts with the error message when triggering fails, and doesn't leave the button stuck disabled", async () => {
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
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    alertSpy.mockRestore();
  });
});
