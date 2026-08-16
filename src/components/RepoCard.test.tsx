// @vitest-environment jsdom
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoCardView } from "~/lib/dashboard-view";

vi.mock("~/lib/dashboard", async () => {
  const { action } = await import("@solidjs/router");
  return { toggleAssess: action(async () => null, "toggleAssess") };
});

const RepoCard = (await import("./RepoCard")).default;

afterEach(() => {
  cleanup();
});

function makeRepo(overrides: Partial<RepoCardView> = {}): RepoCardView {
  return {
    repoId: 1,
    fullName: "octocat/hello-world",
    htmlUrl: null,
    description: null,
    language: "TypeScript",
    isPrivate: false,
    isIgnored: false,
    ignoreReasons: [],
    assessControl: "auto",
    assessment: { pct: 50, band: "ok", label: "In progress", text: "", gaps: [], readmeText: null },
    commits: [],
    issues: [],
    pullRequests: [],
    ...overrides,
  };
}

function renderCard(repo: RepoCardView) {
  return render(() => (
    <MemoryRouter>
      <Route path="/" component={() => <RepoCard repo={repo} />} />
    </MemoryRouter>
  ));
}

describe("RepoCard assess-control placement", () => {
  it("groups the assess control as the toprow's third child when a language badge is present", () => {
    const { container } = renderCard(makeRepo({ language: "TypeScript" }));
    const toprow = container.querySelector(".toprow");
    expect(toprow).toBeTruthy();
    expect(toprow?.children.length).toBe(3);
    expect(toprow?.children[1].className).toContain("badges");
    expect(toprow?.children[2].className).toContain("assess-group");
  });

  it("keeps the assess control as the toprow's third child when the language badge is absent", () => {
    const { container } = renderCard(makeRepo({ language: null }));
    const toprow = container.querySelector(".toprow");
    expect(toprow).toBeTruthy();
    expect(toprow?.children.length).toBe(3);
    expect(toprow?.children[1].className).toContain("badges");
    expect(toprow?.children[2].className).toContain("assess-group");
  });

  it("shows a descriptive 'Assess:' label next to the control", () => {
    renderCard(makeRepo());
    expect(screen.getByText("Assess:")).toBeTruthy();
  });

  it("labels the radiogroup with an assess-specific aria-label", () => {
    renderCard(makeRepo());
    expect(screen.getByRole("radiogroup", { name: "Assess status" })).toBeTruthy();
  });

  it("keeps the visibility and language badges grouped together, separate from the assess control", () => {
    const { container } = renderCard(makeRepo({ language: "TypeScript" }));
    const badges = container.querySelector(".badges");
    expect(badges).toBeTruthy();
    expect(badges?.textContent).toContain("public");
    expect(badges?.textContent).toContain("TypeScript");
    expect(badges?.querySelector(".assess-control")).toBeNull();
  });
});

describe("RepoCard README rendering", () => {
  it("renders README markdown as formatted HTML", () => {
    const { container } = renderCard(
      makeRepo({
        assessment: {
          pct: 50,
          band: "ok",
          label: "In progress",
          text: "",
          gaps: [],
          readmeText: "# Title\n\n- one\n- two",
        },
      }),
    );
    const readme = container.querySelector(".readme");
    expect(readme).toBeTruthy();
    expect(readme?.innerHTML).toContain("<h1>Title</h1>");
    expect(readme?.querySelectorAll("li").length).toBe(2);
  });

  it("still shows the no-README fallback when readmeText is null", () => {
    const { container } = renderCard(
      makeRepo({
        assessment: { pct: 50, band: "ok", label: "In progress", text: "", gaps: [], readmeText: null },
      }),
    );
    expect(container.querySelector(".readme")).toBeNull();
    expect(screen.getByText("Not yet assessed — no README captured.")).toBeTruthy();
  });

  it("does not render a raw <script> element from malicious README content", () => {
    const { container } = renderCard(
      makeRepo({
        assessment: {
          pct: 50,
          band: "ok",
          label: "In progress",
          text: "",
          gaps: [],
          readmeText: "<script>window.__pwned = true;</script>\n\nSafe text.",
        },
      }),
    );
    expect(container.querySelector(".readme script")).toBeNull();
    expect(container.querySelector(".readme")?.textContent).toContain("Safe text.");
  });

  it("resolves a relative README link against the repo's GitHub blob URL", () => {
    const { container } = renderCard(
      makeRepo({
        fullName: "octocat/hello-world",
        assessment: {
          pct: 50,
          band: "ok",
          label: "In progress",
          text: "",
          gaps: [],
          readmeText: "[guide](docs/guide.md)",
        },
      }),
    );
    const link = container.querySelector(".readme a");
    expect(link?.getAttribute("href")).toBe(
      "https://github.com/octocat/hello-world/blob/HEAD/docs/guide.md",
    );
  });
});
