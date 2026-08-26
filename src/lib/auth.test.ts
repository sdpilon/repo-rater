import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_COOKIE,
  buildAuthCookie,
  getCookieValue,
  isAppPasswordConfigured,
  isAuthenticatedRequest,
  isPublicPath,
  requireAppPassword,
} from "./auth";

vi.mock("./config", () => ({
  resolveConfig: (key: string) => process.env[key],
  isConfigured: (key: string) => process.env[key] !== undefined,
}));

const originalPassword = process.env.APP_PASSWORD;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalPassword === undefined) delete process.env.APP_PASSWORD;
  else process.env.APP_PASSWORD = originalPassword;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("getCookieValue", () => {
  it("returns undefined when the header is missing", () => {
    expect(getCookieValue(null, AUTH_COOKIE)).toBeUndefined();
    expect(getCookieValue(undefined, AUTH_COOKIE)).toBeUndefined();
  });

  it("finds the named cookie among several", () => {
    expect(getCookieValue("a=1; site_auth=hunter2; b=3", AUTH_COOKIE)).toBe(
      "hunter2",
    );
  });

  it("returns undefined when the named cookie isn't present", () => {
    expect(getCookieValue("a=1; b=3", AUTH_COOKIE)).toBeUndefined();
  });

  it("decodes URI-encoded values", () => {
    expect(getCookieValue("site_auth=hello%20world", AUTH_COOKIE)).toBe(
      "hello world",
    );
  });

  it("tolerates values that aren't validly encoded", () => {
    expect(getCookieValue("site_auth=100%", AUTH_COOKIE)).toBe("100%");
  });
});

describe("requireAppPassword", () => {
  it("throws when APP_PASSWORD is unset", () => {
    delete process.env.APP_PASSWORD;
    expect(() => requireAppPassword()).toThrow(/APP_PASSWORD/);
  });

  it("returns the configured value", () => {
    process.env.APP_PASSWORD = "hunter2";
    expect(requireAppPassword()).toBe("hunter2");
  });
});

describe("buildAuthCookie", () => {
  it("sets HttpOnly, SameSite=Lax, and a 30-day Max-Age", () => {
    process.env.NODE_ENV = "development";
    const cookie = buildAuthCookie("hunter2");
    expect(cookie).toContain("site_auth=hunter2");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=2592000");
  });

  it("adds Secure only in production", () => {
    process.env.NODE_ENV = "development";
    expect(buildAuthCookie("hunter2")).not.toContain("Secure");

    process.env.NODE_ENV = "production";
    expect(buildAuthCookie("hunter2")).toContain("Secure");
  });
});

describe("isPublicPath", () => {
  it("allows /login exactly", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/login-not-really")).toBe(false);
  });

  it("allows anything under /_build/", () => {
    expect(isPublicPath("/_build/assets/entry.js")).toBe(true);
    expect(isPublicPath("/_build")).toBe(false);
  });

  it("allows /favicon.ico exactly", () => {
    expect(isPublicPath("/favicon.ico")).toBe(true);
  });

  it("blocks everything else", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/about")).toBe(false);
  });
});

describe("isAuthenticatedRequest", () => {
  it("is true when the cookie matches APP_PASSWORD", () => {
    process.env.APP_PASSWORD = "hunter2";
    const request = new Request("http://localhost/", {
      headers: { cookie: "site_auth=hunter2" },
    });
    expect(isAuthenticatedRequest(request)).toBe(true);
  });

  it("is false when the cookie is missing or wrong", () => {
    process.env.APP_PASSWORD = "hunter2";
    expect(isAuthenticatedRequest(new Request("http://localhost/"))).toBe(
      false,
    );
    expect(
      isAuthenticatedRequest(
        new Request("http://localhost/", {
          headers: { cookie: "site_auth=wrong" },
        }),
      ),
    ).toBe(false);
  });
});

describe("isAppPasswordConfigured", () => {
  it("is false when APP_PASSWORD is unset, true when set", () => {
    delete process.env.APP_PASSWORD;
    expect(isAppPasswordConfigured()).toBe(false);
    process.env.APP_PASSWORD = "hunter2";
    expect(isAppPasswordConfigured()).toBe(true);
  });
});

describe("isAuthenticatedRequest with no APP_PASSWORD configured", () => {
  it("treats every request as authenticated when the gate is off", () => {
    delete process.env.APP_PASSWORD;
    expect(isAuthenticatedRequest(new Request("http://localhost/"))).toBe(true);
  });
});
