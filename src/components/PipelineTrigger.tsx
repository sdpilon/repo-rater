import {
  createAsync,
  revalidate,
  useAction,
  useSubmission,
} from "@solidjs/router";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { getPipelineStatus, triggerPipelineRun } from "~/lib/pipeline";

const timestampFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
});

export const POLL_INTERVAL_MS = 3000;

export default function PipelineTrigger() {
  const status = createAsync(() => getPipelineStatus());
  const trigger = useAction(triggerPipelineRun);
  const submission = useSubmission(triggerPipelineRun);
  // True from the moment the trigger is clicked until a poll observes a
  // DIFFERENT run than whatever status() showed right before the click —
  // identified by startedAt, regardless of whether that new run is still
  // in progress or already finished. Needed because the new run's `runs`
  // row isn't written until after discovery's GitHub round-trip completes
  // server-side — for an account with many repos that can easily take
  // longer than one POLL_INTERVAL_MS tick, so an early poll can still
  // reflect the *previous* run. A plain inProgress check can't tell "still
  // the old run" apart from "the new run already finished" (e.g. a fast
  // credential failure) — both read as inProgress:false — so it either
  // stops too early (treating stale data as done) or never stops at all
  // (waiting for an in-progress sighting that may never come).
  const [awaitingStart, setAwaitingStart] = createSignal(false);
  let baselineStartedAt: number | undefined;

  let intervalId: ReturnType<typeof setInterval> | undefined;
  function stopPolling() {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
      intervalId = undefined;
    }
  }
  function ensurePolling() {
    if (intervalId !== undefined) return;
    intervalId = setInterval(
      () => revalidate(getPipelineStatus.key),
      POLL_INTERVAL_MS,
    );
  }
  onCleanup(stopPolling);

  createEffect(() => {
    const s = status();
    if (awaitingStart() && s?.startedAt.getTime() !== baselineStartedAt) {
      setAwaitingStart(false);
    }
    if (!awaitingStart() && !s?.inProgress) {
      stopPolling();
    }
  });

  async function handleTrigger() {
    baselineStartedAt = status()?.startedAt.getTime();
    setAwaitingStart(true);
    try {
      const result = await trigger();
      if (result?.error) {
        alert(result.error);
        setAwaitingStart(false);
        return;
      }
      ensurePolling();
    } catch (err) {
      alert(`Couldn't start pipeline run: ${(err as Error).message}`);
      setAwaitingStart(false);
    }
  }

  const disabled = () =>
    submission.pending || awaitingStart() || status()?.inProgress === true;

  return (
    <div class="pipeline-trigger">
      <button type="button" disabled={disabled()} onClick={handleTrigger}>
        Run pipeline now
      </button>
      <Show when={status()}>
        {(s) => (
          <span class="pipeline-status">
            <Show
              when={s().inProgress}
              fallback={
                <Show when={s().status}>
                  {(st) =>
                    `Last run: ${st()} at ${timestampFormat.format(s().finishedAt as Date)}`
                  }
                </Show>
              }
            >
              {`Running… (started ${timestampFormat.format(s().startedAt)})`}
            </Show>
          </span>
        )}
      </Show>
    </div>
  );
}
