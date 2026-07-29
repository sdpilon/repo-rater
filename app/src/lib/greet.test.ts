import { describe, expect, it } from "vitest";
import { greet } from "./greet";

describe("greet", () => {
  it("returns a greeting for the given name", () => {
    expect(greet("world")).toBe("Hello, world!");
  });
});
