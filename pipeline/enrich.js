"use strict";
const crypto = require("crypto");

function computeInputHash(repoId, readmeText, commitMessages, issueTitles, issueStates = [], prTitles = [], prStates = []) {
  const combined = [
    readmeText || "", ...commitMessages, ...issueTitles, ...issueStates, ...prTitles, ...prStates,
  ].join("\n---\n");
  return crypto.createHash("sha256").update(combined).digest("hex");
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

function buildUserContent({
  fullName,
  readmeText,
  commitMessages,
  issueTitles,
  issueStates,
  prTitles,
  prStates,
}) {
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

async function generateAssessment(
  client,
  {
    fullName,
    inputHash,
    readmeText,
    commitMessages,
    issueTitles,
    issueStates,
    prTitles,
    prStates,
  },
) {
  const userContent = buildUserContent({
    fullName,
    readmeText,
    commitMessages,
    issueTitles,
    issueStates,
    prTitles,
    prStates,
  });
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
  });
  const textBlock = response.content.find((block) => block.type === "text");
  return JSON.parse(textBlock.text);
}

async function enrichRepo({
  client,
  db,
  repoId,
  fullName,
  runId,
  readmeText,
  commitMessages,
  issueTitles,
  issueStates,
  prTitles,
  prStates,
  now,
}) {
  const inputHash = computeInputHash(
    repoId,
    readmeText,
    commitMessages,
    issueTitles,
    issueStates,
    prTitles,
    prStates,
  );
  const latest = await db.all(
    "SELECT input_hash FROM repo_assessments WHERE repo_id = ? ORDER BY created_at DESC LIMIT 1",
    repoId,
  );
  if (latest.length > 0 && latest[0].input_hash === inputHash) {
    return { repoId, called: false };
  }
  const assessment = await generateAssessment(client, {
    fullName,
    inputHash,
    readmeText,
    commitMessages,
    issueTitles,
    issueStates,
    prTitles,
    prStates,
  });
  const gapsFragment =
    assessment.gaps.length === 0
      ? "[]"
      : `list_value(${assessment.gaps.map(() => "?").join(", ")})`;
  await db.run(
    `INSERT INTO repo_assessments (repo_id, run_id, input_hash, pct, band, label, text, gaps, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${gapsFragment}, ?)`,
    repoId,
    runId,
    inputHash,
    assessment.pct,
    assessment.band,
    assessment.label,
    assessment.text,
    ...assessment.gaps,
    now,
  );
  return { repoId, called: true };
}

module.exports = { computeInputHash, generateAssessment, enrichRepo };
