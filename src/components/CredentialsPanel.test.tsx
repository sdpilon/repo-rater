// @vitest-environment jsdom
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStatus } from "./CredentialsPanel";

vi.mock("~/lib/settings", async () => {
  const { action } = await import("@solidjs/router");
  return {
    saveDatabaseUrl: action(async () => ({ error: null }), "saveDatabaseUrl"),
    saveGithubToken: action(async () => ({ error: null }), "saveGithubToken"),
    saveAnthropicKey: action(async () => ({ error: null }), "saveAnthropicKey"),
  };
});

const CredentialsPanel = (await import("./CredentialsPanel")).default;

afterEach(() => {
  cleanup();
});

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
    renderPanel({
      databaseConfigured: false,
      githubTokenConfigured: false,
      anthropicKeyConfigured: false,
    });
    expect(screen.getAllByText(/not configured/i).length).toBe(3);
  });

  it("shows a configured credential as configured, not as an empty field", () => {
    renderPanel({
      databaseConfigured: true,
      githubTokenConfigured: false,
      anthropicKeyConfigured: false,
    });
    expect(screen.getByText(/database.*configured/i)).toBeTruthy();
  });

  it("shows the database field by default", () => {
    renderPanel({
      databaseConfigured: false,
      githubTokenConfigured: false,
      anthropicKeyConfigured: false,
    });
    expect(screen.getByLabelText("Database connection string")).toBeTruthy();
  });

  it("hides the database field when showDatabaseField is false, but still shows the other two", () => {
    renderPanel(
      {
        databaseConfigured: true,
        githubTokenConfigured: false,
        anthropicKeyConfigured: false,
      },
      false,
    );
    expect(screen.queryByLabelText("Database connection string")).toBeNull();
    expect(screen.getByLabelText("GitHub personal access token")).toBeTruthy();
    expect(screen.getByLabelText("Anthropic API key")).toBeTruthy();
  });
});
