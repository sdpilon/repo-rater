import { createAsync, useAction, useSubmission } from "@solidjs/router";
import { Show } from "solid-js";
import { getPipelineStatus, triggerPipelineRun } from "~/lib/pipeline";

const timestampFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
});

export default function PipelineTrigger() {
  const status = createAsync(() => getPipelineStatus());
  const trigger = useAction(triggerPipelineRun);
  const submission = useSubmission(triggerPipelineRun);

  async function handleTrigger() {
    try {
      const result = await trigger();
      if (result?.error) {
        alert(result.error);
      }
    } catch (err) {
      alert(`Couldn't run pipeline: ${(err as Error).message}`);
    }
  }

  const disabled = () => submission.pending || status()?.inProgress === true;

  return (
    <div class="pipeline-trigger">
      <button type="button" disabled={disabled()} onClick={handleTrigger}>
        Run pipeline now
      </button>
      <Show when={submission.pending}>
        <span class="pipeline-status">Running…</span>
      </Show>
      <Show when={!submission.pending && status()}>
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
