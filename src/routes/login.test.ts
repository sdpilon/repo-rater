// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { loginAction } from "./login";

const originalPassword = process.env.APP_PASSWORD;

afterEach(() => {
  if (originalPassword === undefined) delete process.env.APP_PASSWORD;
  else process.env.APP_PASSWORD = originalPassword;
});

describe("loginAction", () => {
  it("redirects home without validating a password when APP_PASSWORD isn't configured", async () => {
    delete process.env.APP_PASSWORD;
    const formData = new FormData();
    formData.set("password", "anything");

    try {
      await loginAction(formData);
      expect.unreachable("expected loginAction to throw a redirect");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      const response = thrown as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/");
    }
  });
});
