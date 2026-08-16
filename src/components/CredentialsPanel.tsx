import type { Action } from "@solidjs/router";
import { useAction, useSubmission } from "@solidjs/router";
import { Show } from "solid-js";
import {
  saveAnthropicKey,
  saveDatabaseUrl,
  saveGithubToken,
} from "~/lib/settings";

export interface CredentialStatus {
  databaseConfigured: boolean;
  githubTokenConfigured: boolean;
  anthropicKeyConfigured: boolean;
}

function CredentialField(props: {
  label: string;
  fieldName: string;
  inputType: string;
  configured: boolean;
  action: Action<[formData: FormData], { error: string | null }>;
}) {
  const submit = useAction(props.action);
  const submission = useSubmission(props.action);

  async function handleSubmit(
    event: Event & { currentTarget: HTMLFormElement },
  ) {
    event.preventDefault();
    await submit(new FormData(event.currentTarget));
  }

  return (
    <form class="credential-field" onSubmit={handleSubmit}>
      <label for={props.fieldName}>{props.label}</label>
      <p class="credential-status">
        {props.label} is {props.configured ? "configured" : "not configured"}.
      </p>
      <input
        id={props.fieldName}
        name={props.fieldName}
        type={props.inputType}
        placeholder={
          props.configured
            ? "Enter a new value to replace it"
            : `Enter your ${props.label}`
        }
        disabled={submission.pending}
      />
      {submission.result?.error && (
        <p class="credential-error">{submission.result.error}</p>
      )}
      <button type="submit" disabled={submission.pending}>
        {submission.pending ? "Validating…" : "Save"}
      </button>
    </form>
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
          configured={props.status.databaseConfigured}
          action={saveDatabaseUrl}
        />
      </Show>
      <CredentialField
        label="GitHub personal access token"
        fieldName="githubToken"
        inputType="password"
        configured={props.status.githubTokenConfigured}
        action={saveGithubToken}
      />
      <CredentialField
        label="Anthropic API key"
        fieldName="anthropicKey"
        inputType="password"
        configured={props.status.anthropicKeyConfigured}
        action={saveAnthropicKey}
      />
      <Show when={!props.status.databaseConfigured}>
        <p class="credentials-hint">
          Add a database connection string to get started — GitHub and Anthropic
          credentials can be added any time after, whenever you're ready to run
          the pipeline.
        </p>
      </Show>
    </div>
  );
}
