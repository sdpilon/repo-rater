import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { buildUserContent, createAnthropicClient, generateAssessment } from "./client";

describe("createAnthropicClient", () => {
  it("throws when ANTHROPIC_API_KEY is missing", () => {
    expect(() => createAnthropicClient({})).toThrow(/ANTHROPIC_API_KEY/);
  });
});

const EMPTY_INPUT = {
  fullName: "sdpilon/spilon.dev",
  readmeText: "",
  commitMessages: [],
  issueTitles: [],
  issueStates: [],
  prTitles: [],
  prStates: [],
};

describe("buildUserContent", () => {
  it("falls back to placeholder text for each empty section", () => {
    const content = buildUserContent(EMPTY_INPUT);
    expect(content).toContain("(no README)");
    expect(content).toContain("(no commits)");
    expect(content).toContain("(no issues)");
    expect(content).toContain("(no pull requests)");
  });

  it("pairs issue/PR titles with their states positionally", () => {
    const content = buildUserContent({
      fullName: "sdpilon/spilon.dev",
      readmeText: "# Hi",
      commitMessages: ["fix bug"],
      issueTitles: ["Authentication Bug", "Documentation"],
      issueStates: ["open", "closed"],
      prTitles: ["Add feature", "Fix typo"],
      prStates: ["merged", "open"],
    });
    expect(content).toContain("Authentication Bug (open)");
    expect(content).toContain("Documentation (closed)");
    expect(content).toContain("Add feature (merged)");
    expect(content).toContain("Fix typo (open)");
    expect(content).toContain("Pull requests:");
  });
});

const STUB_ASSESSMENT = {
  pct: 62,
  band: "warn",
  label: "Partially on track",
  text: "The README claims a working pipeline, and recent commits show progress.",
  gaps: ["needs more tests"],
};

describe("generateAssessment", () => {
  it("parses the JSON text block from the response", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(STUB_ASSESSMENT) }],
    });
    const client = { messages: { create } } as unknown as Anthropic;

    const result = await generateAssessment(client, EMPTY_INPUT);

    expect(result).toEqual(STUB_ASSESSMENT);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-opus-4-8" }));
  });

  it("throws a clear error when the response has no text content block", async () => {
    const client = {
      messages: { create: vi.fn().mockResolvedValue({ content: [] }) },
    } as unknown as Anthropic;

    await expect(generateAssessment(client, EMPTY_INPUT)).rejects.toThrow(
      /no text content block/,
    );
  });
});
