import type { Action } from "@solidjs/router";
import { useAction, useSubmission } from "@solidjs/router";
import { Show } from "solid-js";
import {
  saveAnthropicKey,
  saveDatabaseUrl,
  saveGithubToken,
} from "~/lib/settings";

export interface CredentialFieldStatus {
  configured: boolean;
  /** Which source the credential currently resolves from — see settings.ts. */
  source: "env" | "file" | "unset";
}

export interface CredentialStatus {
  database: CredentialFieldStatus;
  githubToken: CredentialFieldStatus;
  anthropicKey: CredentialFieldStatus;
  appPasswordConfigured: boolean;
}

/**
 * Renders `submission.result?.error` (the action returning `{ error }`) and
 * `submission.error` (the action itself throwing/rejecting — e.g. an
 * unhandled network error). `@solidjs/router` re-throws a rejected action
 * out of `await submit(...)`, so without this second check a thrown failure
 * shows nothing in the UI at all.
 */
function submissionErrorMessage(submission: {
  result?: { error: string | null };
  error?: unknown;
}): string | undefined {
  if (submission.result?.error) return submission.result.error;
  if (submission.error !== undefined) {
    return submission.error instanceof Error
      ? submission.error.message
      : "Something went wrong. Please try again.";
  }
  return undefined;
}

function CredentialField(props: {
  label: string;
  fieldName: string;
  inputType: string;
  status: CredentialFieldStatus;
  action: Action<[formData: FormData], { error: string | null }>;
}) {
  const submit = useAction(props.action);
  const submission = useSubmission(props.action);

  async function handleSubmit(
    event: Event & { currentTarget: HTMLFormElement },
  ) {
    event.preventDefault();
    try {
      await submit(new FormData(event.currentTarget));
    } catch {
      // A thrown/rejected action is already captured by useSubmission's
      // `.error` (rendered via submissionErrorMessage above) — swallow it
      // here so it doesn't also surface as an unhandled promise rejection.
    }
  }

  // A credential set via env var always wins over the config file (see
  // config.ts's resolveConfig). Submitting a new value here would write the
  // file but the app would keep using the unchanged env var forever with no
  // indication anything is wrong — so this case isn't a normal editable
  // field at all, just an explanation.
  return (
    <Show
      when={props.status.source !== "env"}
      fallback={
        <div class="credential-field credential-field-env">
          <span class="credential-field-label">{props.label}</span>
          <p class="credential-status">
            {props.label} is set via environment variable — changes here won't
            take effect.
          </p>
        </div>
      }
    >
      <form class="credential-field" onSubmit={handleSubmit}>
        <label for={props.fieldName}>{props.label}</label>
        <p class="credential-status">
          {props.label} is{" "}
          {props.status.configured ? "configured" : "not configured"}.
        </p>
        <input
          id={props.fieldName}
          name={props.fieldName}
          type={props.inputType}
          placeholder={
            props.status.configured
              ? "Enter a new value to replace it"
              : `Enter your ${props.label}`
          }
          disabled={submission.pending}
        />
        {submissionErrorMessage(submission) && (
          <p class="credential-error">{submissionErrorMessage(submission)}</p>
        )}
        <button type="submit" disabled={submission.pending}>
          {submission.pending ? "Validating…" : "Save"}
        </button>
      </form>
    </Show>
  );
}

export default function CredentialsPanel(props: {
  status: CredentialStatus;
  showDatabaseField?: boolean;
}) {
  const showDatabaseField = () => props.showDatabaseField ?? true;

  return (
    <div class="credentials-panel">
      <Show when={showDatabaseField()}>
        <CredentialField
          label="Database connection string"
          fieldName="databaseUrl"
          inputType="password"
          status={props.status.database}
          action={saveDatabaseUrl}
        />
      </Show>
      <CredentialField
        label="GitHub personal access token"
        fieldName="githubToken"
        inputType="password"
        status={props.status.githubToken}
        action={saveGithubToken}
      />
      <CredentialField
        label="Anthropic API key"
        fieldName="anthropicKey"
        inputType="password"
        status={props.status.anthropicKey}
        action={saveAnthropicKey}
      />
      <Show when={!props.status.database.configured}>
        <p class="credentials-hint">
          Add a database connection string to get started — GitHub and Anthropic
          credentials can be added any time after, whenever you're ready to run
          the pipeline.
        </p>
      </Show>
      <Show when={!props.status.appPasswordConfigured}>
        <p class="credentials-note">
          No password is configured — this instance has no login gate. Fine
          behind a private network (e.g. Tailscale); set APP_PASSWORD via
          environment variable if this is reachable from elsewhere.
        </p>
      </Show>
    </div>
  );
}
