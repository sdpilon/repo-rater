"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { readBronzeJson } = require("./extract");
const { computeSuggestedIgnore } = require("./ignore-rules");

async function buildRepoRecord(db, repoId, runId, bronzeDir) {
  const [repoRow] = await db.all(
    `SELECT full_name, description, html_url, default_branch, stargazers_count, is_private, is_ignored, is_fork, is_archived, ignore_source, language
     FROM repos WHERE repo_id = ?`,
    repoId,
  );
  const commits = await db.all(
    `SELECT sha, authored_at, message, author_name FROM commits WHERE repo_id = ? ORDER BY authored_at DESC`,
    repoId,
  );
  const issues = await db.all(
    `SELECT number, title, state, created_at, closed_at, labels FROM issues WHERE repo_id = ? ORDER BY created_at DESC`,
    repoId,
  );
  const prs = await db.all(
    `SELECT number, title, state, created_at, merged_at FROM pull_requests WHERE repo_id = ? ORDER BY created_at DESC`,
    repoId,
  );
  const [assessmentRow] = await db.all(
    `SELECT pct, band, label, text, gaps FROM repo_assessments WHERE repo_id = ? ORDER BY created_at DESC LIMIT 1`,
    repoId,
  );
  const readme =
    runId && bronzeDir
      ? readBronzeJson(bronzeDir, runId, repoId, "readme") || ""
      : "";
  // See the SuggestedIgnoreInput typedef in ignore-rules.js for why this
  // object is assembled inline rather than through a shared helper: the
  // counts here are a free `.length` byproduct of the full-column queries
  // above (already needed for record.commits/issues/prs), not a re-query —
  // unlike load.js's intentionally count-only SQL.
  const ignoreReasons =
    repoRow.is_ignored && repoRow.ignore_source === "auto"
      ? computeSuggestedIgnore({
          isFork: repoRow.is_fork,
          isArchived: repoRow.is_archived,
          readme,
          commitCount: commits.length,
          issueCount: issues.length,
          prCount: prs.length,
        }).reasons
      : [];
  return {
    name: repoRow.full_name,
    repo_id: repoId,
    meta: {
      private: repoRow.is_private,
      ignored: repoRow.is_ignored,
      ignoreReasons,
      description: repoRow.description,
      html_url: repoRow.html_url,
      default_branch: repoRow.default_branch,
      stargazers_count: repoRow.stargazers_count,
      language: repoRow.language,
    },
    readme,
    issues: issues.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      created_at: i.created_at,
      closed_at: i.closed_at,
      labels: i.labels,
    })),
    prs: prs.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      created_at: p.created_at,
      merged_at: p.merged_at,
    })),
    commits: commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      date: c.authored_at,
      message: c.message,
      author: c.author_name,
    })),
    assessment: assessmentRow
      ? {
          pct: assessmentRow.pct,
          band: assessmentRow.band,
          label: assessmentRow.label,
          text: assessmentRow.text,
          gaps: assessmentRow.gaps,
        }
      : null,
  };
}

async function publish({
  db,
  repoIds,
  repoRoot = path.join(__dirname, ".."),
  runId,
  bronzeDir,
}) {
  const records = [];
  for (const repoId of repoIds)
    records.push(await buildRepoRecord(db, repoId, runId, bronzeDir));
  fs.writeFileSync(
    path.join(repoRoot, "repos.json"),
    JSON.stringify(records, null, 2),
  );
  execFileSync("node", ["inject.js"], { cwd: repoRoot, stdio: "inherit" });
}

module.exports = { buildRepoRecord, publish };
