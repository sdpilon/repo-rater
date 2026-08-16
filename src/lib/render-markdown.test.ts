import { describe, expect, it } from "vitest";
import { renderReadme } from "./render-markdown";

describe("renderReadme", () => {
  it("renders a level-1 header as an <h1> tag", () => {
    expect(renderReadme("# Hello")).toContain("<h1>Hello</h1>");
  });
});
