import { describe, expect, it } from "vitest";
import { renderReadme } from "./render-markdown";

describe("renderReadme", () => {
  it("renders a level-1 header as an <h1> tag", () => {
    expect(renderReadme("# Hello")).toContain("<h1>Hello</h1>");
  });

  it("renders unordered lists as <ul><li> markup", () => {
    const html = renderReadme("- one\n- two");
    expect(html).toContain("<ul>");
    expect(html.match(/<li>/g)?.length).toBe(2);
  });

  it("renders fenced code blocks with a <pre><code> wrapper", () => {
    const html = renderReadme("```js\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
  });

  it("renders links with an href attribute", () => {
    const html = renderReadme("[docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain(">docs<");
  });

  it("renders GFM pipe tables as <table> markup", () => {
    const html = renderReadme("| A | B |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders GFM strikethrough as <del>", () => {
    expect(renderReadme("~~gone~~")).toContain("<del>gone</del>");
  });

  it("renders GFM task lists as disabled checkboxes", () => {
    const html = renderReadme("- [ ] todo\n- [x] done");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
  });

  it("strips <script> tags from malicious markdown input", () => {
    const html = renderReadme("# Title\n\n<script>alert('xss')</script>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(");
  });

  it("strips inline event-handler attributes like onerror", () => {
    const html = renderReadme('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
  });
});
