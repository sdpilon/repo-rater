import { beforeEach, describe, expect, it } from "vitest";
import { isDemoMode } from "./demo-mode";

describe("isDemoMode", () => {
  beforeEach(() => {
    delete process.env.DEMO_MODE;
  });

  it("should return true when DEMO_MODE is set to true", () => {
    process.env.DEMO_MODE = "true";
    expect(isDemoMode()).toBe(true);
  });

  it("should return false when DEMO_MODE is not set", () => {
    expect(isDemoMode()).toBe(false);
  });

  it("should return false when DEMO_MODE is set to false", () => {
    process.env.DEMO_MODE = "false";
    expect(isDemoMode()).toBe(false);
  });

  it("should return false when DEMO_MODE is set to an invalid value", () => {
    process.env.DEMO_MODE = "";
    expect(isDemoMode()).toBe(false);
  });

  it("should return false when DEMO_MODE is set to an invalid value", () => {
    process.env.DEMO_MODE = "invalid";
    expect(isDemoMode()).toBe(false);
  });
});
