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

const POLL_INTERVAL_MS = 3000;

export default function PipelineTrigger() {
  const status = createAsync(() => getPipelineStatus());
  const trigger = useAction(triggerPipelineRun);
  const submission = useSubmission(triggerPipelineRun);
  const [triggering, setTriggering] = createSignal(false);

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

  // Stop + clear once the polled status confirms the run is no longer in
  // progress. This does NOT start polling on its own — see handleTrigger:
  // the runs row for a new run isn't written until after discovery's
  // GitHub round-trip, so status() won't show inProgress:true right away.
  createEffect(() => {
    if (!status()?.inProgress) {
      stopPolling();
      setTriggering(false);
    }
  });

  async function handleTrigger() {
    setTriggering(true);
    try {
      const result = await trigger();
      if (result?.error) {
        alert(result.error);
        setTriggering(false);
        return;
      }
      ensurePolling();
    } catch (err) {
      alert(`Couldn't start pipeline run: ${(err as Error).message}`);
      setTriggering(false);
    }
  }

  const disabled = () =>
    submission.pending || triggering() || status()?.inProgress === true;

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
