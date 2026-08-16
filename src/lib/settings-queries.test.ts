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
});
