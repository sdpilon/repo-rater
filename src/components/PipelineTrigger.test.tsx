// @vitest-environment jsdom
import { MemoryRouter, Route } from "@solidjs/router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineStatus } from "~/lib/pipeline";

// getPipelineStatus is mocked as a plain function (not the real query() HOC)
// — query() calls useNavigate() internally whenever an owner is present,
// which throws ("can be only used inside a Route") when invoked from
// createResource's internal source-tracking computation in this test setup.
// A plain function with a `.key` stub (the only thing PipelineTrigger reads
// off it, for its polling `revalidate` calls) avoids that. triggerPipelineRun
// keeps the real action() HOC, mirroring RepoCard.test.tsx's precedent for
// testing an action-driven component — and, also mirroring that file, this
// mock is static (no vi.resetModules()/dynamic re-import): resetting modules
// mid-file would force @solidjs/router to re-evaluate as a fresh instance
// for anything imported afterward, breaking Context identity between this
// file's statically-imported MemoryRouter/Route and the component tree.
const statusImpl = vi.fn();
const triggerImpl = vi.fn();
vi.mock("~/lib/pipeline", async () => {
  const { action } = await import("@solidjs/router");
  return {
    getPipelineStatus: Object.assign(statusImpl, { key: "pipelineStatus" }),
    triggerPipelineRun: action(triggerImpl, "triggerPipelineRun"),
  };
});

const PipelineTrigger = (await import("./PipelineTrigger")).default;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
});
