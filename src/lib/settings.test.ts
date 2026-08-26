// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-guard", () => ({ assertAuthenticated: vi.fn() }));
vi.mock("./auth", () => ({ isAppPasswordConfigured: vi.fn() }));
vi.mock("./config", () => ({
  resolveConfigSource: vi.fn(),
  setConfigValue: vi.fn(),
}));
vi.mock("./settings-queries", () => ({
  validateDatabaseUrl: vi.fn(),
  validateGithubToken: vi.fn(),
  validateAnthropicKey: vi.fn(),
}));

// @solidjs/router's query() caches results by cache key ("credentialStatus")
// across calls within the same module instance — without resetting the
// module registry between tests, a second call to getCredentialStatus()
// would just replay the first test's cached result instead of re-invoking
// the (re-mocked) resolver. Mirrors server-db.test.ts's established pattern.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

function formDataWith(field: string, value: string): FormData {
  const formData = new FormData();
  formData.set(field, value);
  return formData;
}

// @solidjs/router's action() wraps the server function in a client-side
// "mutate" closure that reads submission bookkeeping off `this.r` (a router
// instance normally supplied by <Router>/useAction()). Outside a rendered
// router tree there's no such `this`, so a bare call throws — bind a minimal
// stand-in that satisfies mutate's bookkeeping (submissions signal tuple,
// falsy singleFlight) without pulling in a real router or rendering anything.
const fakeRouterContext = {
  r: { submissions: [() => [], () => {}], navigatorFactory: () => () => {} },
};

function callAction<A extends (...args: never[]) => unknown>(
  action: A,
  ...args: Parameters<A>
): ReturnType<A> {
  return (action as (...a: Parameters<A>) => ReturnType<A>).apply(
    fakeRouterContext,
    args,
  );
}

describe("getCredentialStatus", () => {
  it("reports each credential's configured state and source, plus whether APP_PASSWORD is set", async () => {
    const { resolveConfigSource } = await import("./config");
    vi.mocked(resolveConfigSource).mockImplementation((key: string) => {
      if (key === "DATABASE_URL") return "file";
      if (key === "PIPELINE_GH_TOKEN") return "env";
      return "unset";
    });
    const { isAppPasswordConfigured } = await import("./auth");
    vi.mocked(isAppPasswordConfigured).mockReturnValue(false);
    const { getCredentialStatus } = await import("./settings");

    expect(await getCredentialStatus()).toEqual({
      database: { configured: true, source: "file" },
      githubToken: { configured: true, source: "env" },
      anthropicKey: { configured: false, source: "unset" },
      appPasswordConfigured: false,
    });
  });

  it("reports appPasswordConfigured true when APP_PASSWORD is set", async () => {
    const { resolveConfigSource } = await import("./config");
    vi.mocked(resolveConfigSource).mockReturnValue("unset");
    const { isAppPasswordConfigured } = await import("./auth");
    vi.mocked(isAppPasswordConfigured).mockReturnValue(true);
    const { getCredentialStatus } = await import("./settings");

    expect((await getCredentialStatus()).appPasswordConfigured).toBe(true);
  });
});

describe("saveDatabaseUrl", () => {
  it("persists the value when validation succeeds", async () => {
    const { validateDatabaseUrl } = await import("./settings-queries");
    vi.mocked(validateDatabaseUrl).mockResolvedValue({ ok: true });
    const { setConfigValue } = await import("./config");
    const { saveDatabaseUrl } = await import("./settings");

    const result = await callAction(
      saveDatabaseUrl,
      formDataWith("databaseUrl", "postgres://real"),
    );

    expect(result).toEqual({ error: null });
    expect(setConfigValue).toHaveBeenCalledWith(
      "DATABASE_URL",
      "postgres://real",
    );
  });

  it("does not persist and returns the error when validation fails", async () => {
    const { validateDatabaseUrl } = await import("./settings-queries");
    vi.mocked(validateDatabaseUrl).mockResolvedValue({
      ok: false,
      error: "connection refused",
    });
    const { setConfigValue } = await import("./config");
    const { saveDatabaseUrl } = await import("./settings");

    const result = await callAction(
      saveDatabaseUrl,
      formDataWith("databaseUrl", "postgres://bad"),
    );

    expect(result).toEqual({ error: "connection refused" });
    expect(setConfigValue).not.toHaveBeenCalled();
  });

  // Finding 3: an empty/blank submission must be rejected before ever
  // attempting a real connection — otherwise `validateDatabaseUrl("")`
  // connects to localhost:5432 as the OS user, which can succeed on a
  // homelab box running local Postgres and persist an empty DATABASE_URL,
  // permanently locking the self-hoster out (see config.ts's resolveConfig
  // fix for the other half of this chain).
  it("rejects a blank value without calling the validator or persisting anything", async () => {
    const { validateDatabaseUrl } = await import("./settings-queries");
    const { setConfigValue } = await import("./config");
    const { saveDatabaseUrl } = await import("./settings");

    const result = await callAction(
      saveDatabaseUrl,
      formDataWith("databaseUrl", "   "),
    );

    expect(result).toEqual({
      error: "Database connection string is required.",
    });
    expect(validateDatabaseUrl).not.toHaveBeenCalled();
    expect(setConfigValue).not.toHaveBeenCalled();
  });

  // Finding 2: if setConfigValue throws (e.g. EROFS/EACCES on a read-only
  // filesystem) after validation already succeeded, the action must still
  // resolve to an { error } shape instead of rejecting — a rejected action
  // is invisible in the UI (see CredentialsPanel.test.tsx for the render side).
  it("returns an error instead of throwing when setConfigValue fails", async () => {
    const { validateDatabaseUrl } = await import("./settings-queries");
    vi.mocked(validateDatabaseUrl).mockResolvedValue({ ok: true });
    const { setConfigValue } = await import("./config");
    vi.mocked(setConfigValue).mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied");
    });
    const { saveDatabaseUrl } = await import("./settings");

    const result = await callAction(
      saveDatabaseUrl,
      formDataWith("databaseUrl", "postgres://real"),
    );

    expect(result).toEqual({ error: "EACCES: permission denied" });
  });
});

describe("saveGithubToken", () => {
  it("persists the value when validation succeeds", async () => {
    const { validateGithubToken } = await import("./settings-queries");
    vi.mocked(validateGithubToken).mockResolvedValue({ ok: true });
    const { setConfigValue } = await import("./config");
    const { saveGithubToken } = await import("./settings");

    const result = await callAction(
      saveGithubToken,
      formDataWith("githubToken", "ghp_real"),
    );

    expect(result).toEqual({ error: null });
    expect(setConfigValue).toHaveBeenCalledWith(
      "PIPELINE_GH_TOKEN",
      "ghp_real",
    );
  });

  it("rejects a blank value without calling the validator or persisting anything", async () => {
    const { validateGithubToken } = await import("./settings-queries");
    const { setConfigValue } = await import("./config");
    const { saveGithubToken } = await import("./settings");

    const result = await callAction(
      saveGithubToken,
      formDataWith("githubToken", ""),
    );

    expect(result).toEqual({
      error: "GitHub personal access token is required.",
    });
    expect(validateGithubToken).not.toHaveBeenCalled();
    expect(setConfigValue).not.toHaveBeenCalled();
  });
});

describe("saveAnthropicKey", () => {
  it("persists the value when validation succeeds", async () => {
    const { validateAnthropicKey } = await import("./settings-queries");
    vi.mocked(validateAnthropicKey).mockResolvedValue({ ok: true });
    const { setConfigValue } = await import("./config");
    const { saveAnthropicKey } = await import("./settings");

    const result = await callAction(
      saveAnthropicKey,
      formDataWith("anthropicKey", "sk-ant-real"),
    );

    expect(result).toEqual({ error: null });
    expect(setConfigValue).toHaveBeenCalledWith(
      "ANTHROPIC_API_KEY",
      "sk-ant-real",
    );
  });

  it("rejects a blank value without calling the validator or persisting anything", async () => {
    const { validateAnthropicKey } = await import("./settings-queries");
    const { setConfigValue } = await import("./config");
    const { saveAnthropicKey } = await import("./settings");

    const result = await callAction(
      saveAnthropicKey,
      formDataWith("anthropicKey", "   "),
    );

    expect(result).toEqual({ error: "Anthropic API key is required." });
    expect(validateAnthropicKey).not.toHaveBeenCalled();
    expect(setConfigValue).not.toHaveBeenCalled();
  });
});
