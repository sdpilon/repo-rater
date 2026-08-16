// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-guard", () => ({ assertAuthenticated: vi.fn() }));
vi.mock("./config", () => ({
  isConfigured: vi.fn(),
  setConfigValue: vi.fn(),
}));
vi.mock("./settings-queries", () => ({
  validateDatabaseUrl: vi.fn(),
  validateGithubToken: vi.fn(),
  validateAnthropicKey: vi.fn(),
}));

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
  return (action as (...a: Parameters<A>) => ReturnType<A>).apply(fakeRouterContext, args);
}

describe("getCredentialStatus", () => {
  it("reports which credentials are configured", async () => {
    const { isConfigured } = await import("./config");
    vi.mocked(isConfigured).mockImplementation((key: string) => key === "DATABASE_URL");
    const { getCredentialStatus } = await import("./settings");
    expect(await getCredentialStatus()).toEqual({
      databaseConfigured: true,
      githubTokenConfigured: false,
      anthropicKeyConfigured: false,
    });
  });
});

describe("saveDatabaseUrl", () => {
  it("persists the value when validation succeeds", async () => {
    const { validateDatabaseUrl } = await import("./settings-queries");
    vi.mocked(validateDatabaseUrl).mockResolvedValue({ ok: true });
    const { setConfigValue } = await import("./config");
    const { saveDatabaseUrl } = await import("./settings");

    const result = await callAction(saveDatabaseUrl, formDataWith("databaseUrl", "postgres://real"));

    expect(result).toEqual({ error: null });
    expect(setConfigValue).toHaveBeenCalledWith("DATABASE_URL", "postgres://real");
  });

  it("does not persist and returns the error when validation fails", async () => {
    const { validateDatabaseUrl } = await import("./settings-queries");
    vi.mocked(validateDatabaseUrl).mockResolvedValue({ ok: false, error: "connection refused" });
    const { setConfigValue } = await import("./config");
    const { saveDatabaseUrl } = await import("./settings");

    const result = await callAction(saveDatabaseUrl, formDataWith("databaseUrl", "postgres://bad"));

    expect(result).toEqual({ error: "connection refused" });
    expect(setConfigValue).not.toHaveBeenCalled();
  });
});

describe("saveGithubToken", () => {
  it("persists the value when validation succeeds", async () => {
    const { validateGithubToken } = await import("./settings-queries");
    vi.mocked(validateGithubToken).mockResolvedValue({ ok: true });
    const { setConfigValue } = await import("./config");
    const { saveGithubToken } = await import("./settings");

    const result = await callAction(saveGithubToken, formDataWith("githubToken", "ghp_real"));

    expect(result).toEqual({ error: null });
    expect(setConfigValue).toHaveBeenCalledWith("PIPELINE_GH_TOKEN", "ghp_real");
  });
});

describe("saveAnthropicKey", () => {
  it("persists the value when validation succeeds", async () => {
    const { validateAnthropicKey } = await import("./settings-queries");
    vi.mocked(validateAnthropicKey).mockResolvedValue({ ok: true });
    const { setConfigValue } = await import("./config");
    const { saveAnthropicKey } = await import("./settings");

    const result = await callAction(saveAnthropicKey, formDataWith("anthropicKey", "sk-ant-real"));

    expect(result).toEqual({ error: null });
    expect(setConfigValue).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "sk-ant-real");
  });
});
