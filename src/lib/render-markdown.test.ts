import { describe, expect, it } from "vitest";
import { renderReadme } from "./render-markdown";

describe("renderReadme", () => {
  it("returns an empty string for empty input", () => {
    expect(renderReadme("", "octocat/hello-world")).toBe("");
  });

  it("renders a level-1 header as an <h1> tag", () => {
    expect(renderReadme("# Hello", "octocat/hello-world")).toContain("<h1>Hello</h1>");
  });

  it("renders unordered lists as <ul><li> markup", () => {
    const html = renderReadme("- one\n- two", "octocat/hello-world");
    expect(html).toContain("<ul>");
    expect(html.match(/<li>/g)?.length).toBe(2);
  });

  it("renders fenced code blocks with a <pre><code> wrapper", () => {
    const html = renderReadme("```js\nconst x = 1;\n```", "octocat/hello-world");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
  });

  it("renders links with an href attribute", () => {
    const html = renderReadme("[docs](https://example.com)", "octocat/hello-world");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain(">docs<");
  });

  it("renders GFM pipe tables as <table> markup", () => {
    const html = renderReadme("| A | B |\n| - | - |\n| 1 | 2 |", "octocat/hello-world");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders GFM strikethrough as <del>", () => {
    expect(renderReadme("~~gone~~", "octocat/hello-world")).toContain("<del>gone</del>");
  });

  it("renders GFM task lists as disabled checkboxes", () => {
    const html = renderReadme("- [ ] todo\n- [x] done", "octocat/hello-world");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
  });

  it("strips <script> tags from malicious markdown input", () => {
    const html = renderReadme("# Title\n\n<script>alert('xss')</script>", "octocat/hello-world");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(");
  });

  it("strips inline event-handler attributes like onerror", () => {
    const html = renderReadme('<img src="x" onerror="alert(1)">', "octocat/hello-world");
    expect(html).not.toContain("onerror");
  });

  it("resolves a relative link href against the repo's GitHub blob URL", () => {
    const html = renderReadme("[guide](docs/guide.md)", "octocat/hello-world");
    expect(html).toContain(
      'href="https://github.com/octocat/hello-world/blob/HEAD/docs/guide.md"',
    );
  });

  it("resolves a leading-slash relative link href the same way", () => {
    const html = renderReadme("[guide](/docs/guide.md)", "octocat/hello-world");
    expect(html).toContain(
      'href="https://github.com/octocat/hello-world/blob/HEAD/docs/guide.md"',
    );
  });

  it("resolves a relative image src against the repo's raw GitHub URL", () => {
    const html = renderReadme("![logo](docs/logo.png)", "octocat/hello-world");
    expect(html).toContain(
      'src="https://raw.githubusercontent.com/octocat/hello-world/HEAD/docs/logo.png"',
    );
  });

  it("leaves absolute link hrefs unchanged", () => {
    const html = renderReadme("[ext](https://example.com/x)", "octocat/hello-world");
    expect(html).toContain('href="https://example.com/x"');
  });

  it("leaves absolute image srcs unchanged", () => {
    const html = renderReadme("![ext](https://example.com/x.png)", "octocat/hello-world");
    expect(html).toContain('src="https://example.com/x.png"');
  });

  it("leaves in-page anchor links unchanged", () => {
    const html = renderReadme("[section](#install)", "octocat/hello-world");
    expect(html).toContain('href="#install"');
  });

  it("leaves mailto links unchanged", () => {
    const html = renderReadme("[email](mailto:a@example.com)", "octocat/hello-world");
    expect(html).toContain('href="mailto:a@example.com"');
  });

  it("resolves relative links against the given repo's own fullName", () => {
    const htmlA = renderReadme("[guide](docs/guide.md)", "octocat/hello-world");
    const htmlB = renderReadme("[guide](docs/guide.md)", "octocat/other-repo");
    expect(htmlA).toContain("octocat/hello-world/blob/HEAD/docs/guide.md");
    expect(htmlB).toContain("octocat/other-repo/blob/HEAD/docs/guide.md");
  });
});
