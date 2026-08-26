import Anthropic from "@anthropic-ai/sdk";

/**
 * Assessment-generation client backed by the Anthropic SDK, ported from
 * repo-root `pipeline/enrich.js` (read-only reference). The API call shape
 * (`output_config`/`json_schema`, `thinking: {type: "adaptive"}`) is kept
 * verbatim — it's already live-verified working in the old stack, so this
 * is a faithful port, not a "corrected" rewrite against older API docs.
 */

export function createAnthropicClient(
  env: NodeJS.ProcessEnv = process.env,
): Anthropic {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required to create an Anthropic client",
    );
  }
  return new Anthropic({ apiKey });
}

export interface Assessment {
  pct: number | null;
  band: string;
  label: string;
  text: string;
  gaps: string[];
}

export interface AssessmentInput {
  fullName: string;
  readmeText: string;
  commitMessages: string[];
  issueTitles: string[];
  issueStates: string[];
  prTitles: string[];
  prStates: string[];
}

const ASSESSMENT_SCHEMA = {
  type: "object",
  properties: {
    pct: { type: ["integer", "null"] },
    band: { type: "string", enum: ["good", "warn", "crit", "none"] },
    label: { type: "string" },
    text: { type: "string" },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["pct", "band", "label", "text", "gaps"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are assessing a GitHub repo's stated goals against its actual activity (README, commits, issues). Read the README against the commits and issue titles and produce a structured, evidence-based assessment.

Return an assessment with these fields:

- pct: 0-100 estimated completion against the README's stated goals, or null if there's no stated goal to measure against (e.g. no README, or a living-config repo with no endpoint).
- band: "good" (pct >= 80 or clearly on track), "warn" (40-79 or a real gap), "crit" (< 40), "none" (archived/no assessment possible).
- label: a short (2-5 word) status phrase.
- text: 2-5 sentences, evidence-based — cite specific commits, issues, README claims. Be direct and concrete, no filler.
- gaps: array of short actionable gap strings, or [] if none.`;

export function buildUserContent({
  fullName,
  readmeText,
  commitMessages,
  issueTitles,
  issueStates,
  prTitles,
  prStates,
}: AssessmentInput): string {
  const commitsBlock =
    commitMessages.length > 0
      ? commitMessages.map((m) => `- ${m}`).join("\n")
      : "(no commits)";
  const issuesBlock =
    issueTitles.length > 0
      ? issueTitles
          .map((title, idx) => `- ${title} (${issueStates[idx]})`)
          .join("\n")
      : "(no issues)";
  const prsBlock =
    prTitles.length > 0
      ? prTitles.map((title, idx) => `- ${title} (${prStates[idx]})`).join("\n")
      : "(no pull requests)";
  return `Repo: ${fullName}

README:
${readmeText || "(no README)"}

Recent commits:
${commitsBlock}

Issues:
${issuesBlock}

Pull requests:
${prsBlock}`;
}

export async function generateAssessment(
  client: Anthropic,
  input: AssessmentInput,
): Promise<Assessment> {
  const userContent = buildUserContent(input);
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: ASSESSMENT_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    // biome-ignore lint/suspicious/noExplicitAny: `output_config`/`thinking: {type: "adaptive"}` predate this SDK version's published types
  } as any);
  const textBlock = response.content.find(
    (block: { type: string }) => block.type === "text",
  ) as { type: "text"; text: string } | undefined;
  if (!textBlock) {
    throw new Error("Anthropic response contained no text content block");
  }
  return JSON.parse(textBlock.text);
}
