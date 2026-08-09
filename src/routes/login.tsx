import { Title } from "@solidjs/meta";
import { action, redirect, useAction, useSubmission } from "@solidjs/router";
import { buildAuthCookie, requireAppPassword } from "~/lib/auth";

const login = action(async (formData: FormData) => {
  "use server";
  const password = String(formData.get("password") ?? "");
  if (password !== requireAppPassword()) {
    return { error: "Incorrect password." };
  }
  throw redirect("/", { headers: { "Set-Cookie": buildAuthCookie(password) } });
}, "login");

export default function Login() {
  const submit = useAction(login);
  const submission = useSubmission(login);

  async function handleSubmit(event: Event & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    await submit(new FormData(event.currentTarget));
  }

  return (
    <div class="wrap login-wrap">
      <Title>Log in</Title>
      <form class="login-form" onSubmit={handleSubmit}>
        <h1 class="login-title">Log in</h1>
        <p class="login-sub">This dashboard includes private repo data — enter the shared password to continue.</p>
        <label class="login-label" for="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          disabled={submission.pending}
        />
        {submission.result?.error && <p class="login-error">{submission.result.error}</p>}
        <button type="submit" disabled={submission.pending}>
          {submission.pending ? "Checking…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
