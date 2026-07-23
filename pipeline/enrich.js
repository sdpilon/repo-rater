"use strict";
const crypto = require("crypto");

function computeInputHash(repoId, readmeText, commitMessages, issueTitles) {
  const combined = [readmeText || "", ...commitMessages, ...issueTitles].join("\n---\n");
  return crypto.createHash("sha256").update(combined).digest("hex");
}

// Stub: proves the hash-gate and append-only history pattern. Replace with a
// real LLM call in a later stage — that's an AI-engineering concern, explicitly
// out of scope for ARCHITECTURE.md and for this slice.
function generateAssessment(fullName, inputHash) {
  return {
    pct: 50,
    band: "unknown",
    label: "Not yet assessed by a real reviewer",
    text: `Placeholder assessment for ${fullName} (input hash ${inputHash.slice(0, 8)}).`,
    gaps: ["real LLM assessment not implemented yet"],
  };
}

async function enrichRepo({ db, repoId, fullName, runId, readmeText, commitMessages, issueTitles, now }) {
  const inputHash = computeInputHash(repoId, readmeText, commitMessages, issueTitles);
  const latest = await db.all(
    "SELECT input_hash FROM repo_assessments WHERE repo_id = ? ORDER BY created_at DESC LIMIT 1",
    repoId
  );
  if (latest.length > 0 && latest[0].input_hash === inputHash) {
    return { repoId, called: false };
  }
  const assessment = generateAssessment(fullName, inputHash);
  const gapsFragment = assessment.gaps.length === 0 ? "[]" : `list_value(${assessment.gaps.map(() => "?").join(", ")})`;
  await db.run(
    `INSERT INTO repo_assessments (repo_id, run_id, input_hash, pct, band, label, text, gaps, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${gapsFragment}, ?)`,
    repoId, runId, inputHash, assessment.pct, assessment.band, assessment.label, assessment.text,
    ...assessment.gaps,
    now
  );
  return { repoId, called: true };
}

module.exports = { computeInputHash, generateAssessment, enrichRepo };
