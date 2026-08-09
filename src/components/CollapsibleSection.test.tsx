// @vitest-environment jsdom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import CollapsibleSection from "./CollapsibleSection";

afterEach(() => {
  cleanup();
});

describe("CollapsibleSection", () => {
  it("renders the title and count in the summary", () => {
    render(() => (
      <CollapsibleSection title="Commits" count="3">
        <p>Recent commits</p>
      </CollapsibleSection>
    ));

    expect(screen.getByText("Commits")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("Recent commits")).toBeTruthy();
  });
});
