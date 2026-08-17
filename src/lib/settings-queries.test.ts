import { describe, expect, it } from "vitest";
import { validateAnthropicKey, validateDatabaseUrl, validateGithubToken } from "./settings-queries";

describe("validateDatabaseUrl", () => {
  it("returns ok when the query succeeds", async () => {
    const fakeDb = { $client: { query: async () => ({}), end: async () => {} } };
    const fakeFactory = (() => fakeDb) as unknown as typeof import("~/db/client").createDb;
    const result = await validateDatabaseUrl("postgres://fake", fakeFactory);
    expect(result).toEqual({ ok: true });
  });

  it("returns the error message when the connection fails", async () => {
    const fakeDb = {
      $client: {
        query: async () => {
          throw new Error("connection refused");
        },
        end: async () => {},
      },
    };
    const fakeFactory = (() => fakeDb) as unknown as typeof import("~/db/client").createDb;
    const result = await validateDatabaseUrl("postgres://fake", fakeFactory);
    expect(result).toEqual({ ok: false, error: "connection refused" });
  });

  // Finding 1: `pg` throws an AggregateError with an empty top-level
  // `.message` whenever a hostname resolves to multiple addresses — exactly
  // what happens connecting to `localhost` (::1 + 127.0.0.1), the most
  // likely first thing a self-hoster types. The old `errorMessage()`
  // returned `err.message`, i.e. "", leaving the UI showing nothing.
  it("joins sub-error messages when the connection throws an AggregateError with an empty top-level message", async () => {
    const aggregateError = new AggregateError(
      [new Error("connect ECONNREFUSED 127.0.0.1:5432"), new Error("connect ECONNREFUSED ::1:5432")],
      "",
    );
    const fakeDb = {
      $client: {
        query: async () => {
          throw aggregateError;
        },
        end: async () => {},
      },
    };
    const fakeFactory = (() => fakeDb) as unknown as typeof import("~/db/client").createDb;
    const result = await validateDatabaseUrl("postgres://fake", fakeFactory);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBe("");
      expect(result.error).toContain("ECONNREFUSED 127.0.0.1:5432");
      expect(result.error).toContain("ECONNREFUSED ::1:5432");
    }
  });

  it("never returns an empty error string, even for an error with no message at all", async () => {
    const fakeDb = {
      $client: {
        query: async () => {
          throw new Error("");
        },
        end: async () => {},
      },
    };
    const fakeFactory = (() => fakeDb) as unknown as typeof import("~/db/client").createDb;
    const result = await validateDatabaseUrl("postgres://fake", fakeFactory);
    expect(result).toEqual({ ok: false, error: "Connection failed" });
  });

  // Finding: an unreachable host/port (wrong IP, firewalled) hung forever
  // with no connect timeout, contradicting "find out immediately".
  it("passes a connect timeout to the factory so an unreachable host fails fast instead of hanging", async () => {
    const fakeDb = { $client: { query: async () => ({}), end: async () => {} } };
    let receivedOptions: unknown;
    const fakeFactory = ((_url: string, options: unknown) => {
      receivedOptions = options;
      return fakeDb;
    }) as unknown as typeof import("~/db/client").createDb;
    await validateDatabaseUrl("postgres://fake", fakeFactory);
    expect(receivedOptions).toEqual({ connectionTimeoutMillis: expect.any(Number) });
    expect((receivedOptions as { connectionTimeoutMillis: number }).connectionTimeoutMillis).toBeGreaterThan(0);
  });
});

describe("validateGithubToken", () => {
  it("returns ok when the authenticated-user call succeeds", async () => {
    const fakeOctokit = { rest: { users: { getAuthenticated: async () => ({ data: {} }) } } };
    const fakeFactory = (() => fakeOctokit) as unknown as (env: NodeJS.ProcessEnv) => import("octokit").Octokit;
    const result = await validateGithubToken("fake-token", fakeFactory);
    expect(result).toEqual({ ok: true });
  });

  it("returns the error message when the token is rejected", async () => {
    const fakeOctokit = {
      rest: {
        users: {
          getAuthenticated: async () => {
            throw new Error("Bad credentials");
          },
        },
      },
    };
    const fakeFactory = (() => fakeOctokit) as unknown as (env: NodeJS.ProcessEnv) => import("octokit").Octokit;
    const result = await validateGithubToken("fake-token", fakeFactory);
    expect(result).toEqual({ ok: false, error: "Bad credentials" });
  });

  it("resolves ok:false (not a rejected promise) when the real factory throws synchronously on a falsy token", async () => {
    const result = await validateGithubToken("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/PIPELINE_GH_TOKEN/);
    }
  });
});

describe("validateAnthropicKey", () => {
  it("returns ok when the models-list call succeeds", async () => {
    const fakeAnthropic = { models: { list: async () => ({ data: [] }) } };
    const fakeFactory = (() => fakeAnthropic) as unknown as (
      env: NodeJS.ProcessEnv,
    ) => import("@anthropic-ai/sdk").default;
    const result = await validateAnthropicKey("fake-key", fakeFactory);
    expect(result).toEqual({ ok: true });
  });

  it("returns the error message when the key is rejected", async () => {
    const fakeAnthropic = {
      models: {
        list: async () => {
          throw new Error("invalid x-api-key");
        },
      },
    };
    const fakeFactory = (() => fakeAnthropic) as unknown as (
      env: NodeJS.ProcessEnv,
    ) => import("@anthropic-ai/sdk").default;
    const result = await validateAnthropicKey("fake-key", fakeFactory);
    expect(result).toEqual({ ok: false, error: "invalid x-api-key" });
  });

  it("resolves ok:false (not a rejected promise) when the real factory throws synchronously on a falsy key", async () => {
    const result = await validateAnthropicKey("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ANTHROPIC_API_KEY/);
    }
  });
});
