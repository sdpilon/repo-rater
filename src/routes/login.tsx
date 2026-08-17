import { Title } from "@solidjs/meta";
import { action, redirect, useAction, useSubmission } from "@solidjs/router";
import { buildAuthCookie, isAppPasswordConfigured, requireAppPassword } from "~/lib/auth";

/**
 * Extracted (rather than inlined in `action(...)`) so it can be unit-tested
 * directly without needing a live router context — `action()`'s wrapper
 * requires one, this plain function doesn't.
 */
export async function loginAction(formData: FormData) {
  "use server";
  if (!isAppPasswordConfigured()) {
    // No password gate configured at all (e.g. a homelab instance behind
    // Tailscale) — nothing meaningful to log in to, so just send them home.
    throw redirect("/");
  }
  const password = String(formData.get("password") ?? "");
  if (password !== requireAppPassword()) {
    return { error: "Incorrect password." };
  }
  throw redirect("/", { headers: { "Set-Cookie": buildAuthCookie(password) } });
}

const login = action(loginAction, "login");

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
