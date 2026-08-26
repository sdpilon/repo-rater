// @vitest-environment jsdom
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStatus } from "./CredentialsPanel";

const saveDatabaseUrlImpl = vi.fn(
  async (_formData: FormData) => ({ error: null }) as { error: string | null },
);

vi.mock("~/lib/settings", async () => {
  const { action } = await import("@solidjs/router");
  return {
    saveDatabaseUrl: action(
      (formData: FormData) => saveDatabaseUrlImpl(formData),
      "saveDatabaseUrl",
    ),
    saveGithubToken: action(async () => ({ error: null }), "saveGithubToken"),
    saveAnthropicKey: action(async () => ({ error: null }), "saveAnthropicKey"),
  };
});

const CredentialsPanel = (await import("./CredentialsPanel")).default;

afterEach(() => {
  cleanup();
  saveDatabaseUrlImpl.mockReset();
  saveDatabaseUrlImpl.mockImplementation(async () => ({ error: null }));
});

const notConfiguredEnvNone: CredentialStatus = {
  database: { configured: false, source: "unset" },
  githubToken: { configured: false, source: "unset" },
  anthropicKey: { configured: false, source: "unset" },
  appPasswordConfigured: true,
};

// CredentialsPanel's fields call useAction/useSubmission, which (per
// @solidjs/router's useRouter()) throw "can only be used inside a Route"
// outside a rendered router tree — a real <Router>/<Route> is required, not
// just a bare render(). This mirrors RepoCard.test.tsx's established pattern.
function renderPanel(status: CredentialStatus, showDatabaseField?: boolean) {
  return render(() => (
    <MemoryRouter>
      <Route
        path="/"
        component={() => (
          <CredentialsPanel
            status={status}
            showDatabaseField={showDatabaseField}
          />
        )}
      />
    </MemoryRouter>
  ));
}

describe("CredentialsPanel", () => {
  it("shows all three fields as not configured", () => {
    renderPanel(notConfiguredEnvNone);
    expect(screen.getAllByText(/not configured/i).length).toBe(3);
  });

  it("shows a configured credential as configured, not as an empty field", () => {
    renderPanel({
      ...notConfiguredEnvNone,
      database: { configured: true, source: "file" },
    });
    expect(screen.getByText(/database.*configured/i)).toBeTruthy();
  });

  it("shows the database field by default", () => {
    renderPanel(notConfiguredEnvNone);
    expect(screen.getByLabelText("Database connection string")).toBeTruthy();
  });

  it("hides the database field when showDatabaseField is false, but still shows the other two", () => {
    renderPanel(
      {
        ...notConfiguredEnvNone,
        database: { configured: true, source: "file" },
      },
      false,
    );
    expect(screen.queryByLabelText("Database connection string")).toBeNull();
    expect(screen.getByLabelText("GitHub personal access token")).toBeTruthy();
    expect(screen.getByLabelText("Anthropic API key")).toBeTruthy();
  });

  // Finding 5: a credential configured via env var must not present as a
  // normal editable field — saving through the UI would write the file but
  // the app keeps using the (unchanged) env var forever, silently. The field
  // should instead be non-editable with an explanatory note.
  describe("a credential sourced from an environment variable", () => {
    it("disables editing and explains why instead of showing a normal save form", () => {
      renderPanel({
        ...notConfiguredEnvNone,
        database: { configured: true, source: "env" },
      });
      expect(screen.queryByLabelText("Database connection string")).toBeNull();
      const envNote = screen.getByText(/set via environment variable/i);
      expect(envNote).toBeTruthy();
      // Scoped to the env-sourced field's own container — the other two
      // (unset) fields still render their normal editable forms with Save
      // buttons elsewhere on the page, so a page-wide query would false-fail.
      const envField = envNote.closest(".credential-field-env");
      if (!envField)
        throw new Error(
          "expected the env-sourced field to render inside .credential-field-env",
        );
      expect(
        within(envField as HTMLElement).queryByRole("button", {
          name: /save/i,
        }),
      ).toBeNull();
      expect(envField.querySelector("input")).toBeNull();
    });

    it("still renders file-sourced and unset fields normally alongside an env-sourced one", () => {
      renderPanel({
        database: { configured: true, source: "env" },
        githubToken: { configured: true, source: "file" },
        anthropicKey: { configured: false, source: "unset" },
        appPasswordConfigured: true,
      });
      expect(
        screen.getByLabelText("GitHub personal access token"),
      ).toBeTruthy();
      expect(screen.getByLabelText("Anthropic API key")).toBeTruthy();
    });
  });

  // Finding 7: intentional no-auth tradeoff must be visible, not silent.
  describe("APP_PASSWORD visibility banner", () => {
    it("shows a no-auth-gate note when APP_PASSWORD is not configured", () => {
      renderPanel({ ...notConfiguredEnvNone, appPasswordConfigured: false });
      expect(screen.getByText(/no password is configured/i)).toBeTruthy();
    });

    it("does not show the note when APP_PASSWORD is configured", () => {
      renderPanel({ ...notConfiguredEnvNone, appPasswordConfigured: true });
      expect(screen.queryByText(/no password is configured/i)).toBeNull();
    });
  });

  // Finding 2: a thrown/rejected action (submission.error) must render the
  // same as a returned { error } result — @solidjs/router re-throws a
  // rejected action out of `await submit(...)`, so without checking
  // submission.error a thrown failure is invisible in the UI.
  it("renders submission.error (the action having thrown) not just submission.result.error", async () => {
    saveDatabaseUrlImpl.mockImplementation(async () => {
      throw new Error("unexpected server error");
    });
    renderPanel(notConfiguredEnvNone);

    const input = screen.getByLabelText(
      "Database connection string",
    ) as HTMLInputElement;
    input.value = "postgres://example";
    const form = input.closest("form");
    if (!form)
      throw new Error("expected the database field to render inside a form");
    form.requestSubmit();

    const errorText = await screen.findByText("unexpected server error");
    expect(errorText).toBeTruthy();
  });
});
