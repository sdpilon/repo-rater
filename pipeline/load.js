"use strict";
const { setWatermark } = require("./db");
const { readBronzeJson, readBronzeJsonRequired } = require("./extract");
const { computeSuggestedIgnore } = require("./ignore-rules");

async function upsertRepo(db, meta, now) {
  const existing = await db.all(
    "SELECT first_seen_at, is_ignored FROM repos WHERE repo_id = ?",
    meta.repoId,
  );
  const firstSeenAt = existing.length > 0 ? existing[0].first_seen_at : now;
  const isIgnored = existing.length > 0 ? existing[0].is_ignored : false;
  await db.run(
    `INSERT OR REPLACE INTO repos
      (repo_id, full_name, description, html_url, default_branch, language, stargazers_count, is_private, is_fork, is_archived, is_ignored, first_seen_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    meta.repoId,
    meta.fullName,
    meta.description,
    meta.htmlUrl,
    meta.defaultBranch,
    meta.language,
    meta.stargazersCount,
    meta.isPrivate,
    meta.isFork,
    meta.isArchived,
    isIgnored,
    firstSeenAt,
    now,
  );
}

async function upsertCommit(db, repoId, commit, runId) {
  const existing = await db.all(
    "SELECT first_ingested_run_id FROM commits WHERE repo_id = ? AND sha = ?",
    repoId,
    commit.sha,
  );
  const firstIngestedRunId =
    existing.length > 0 ? existing[0].first_ingested_run_id : runId;
  await db.run(
    `INSERT OR REPLACE INTO commits (repo_id, sha, author_name, authored_at, message, first_ingested_run_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    repoId,
    commit.sha,
    commit.authorName,
    commit.authoredAt,
    commit.message,
    firstIngestedRunId,
  );
}

async function upsertIssue(db, repoId, issue, runId) {
  const labelsFragment =
    issue.labels.length === 0
      ? "[]"
      : `list_value(${issue.labels.map(() => "?").join(", ")})`;
  await db.run(
    `INSERT OR REPLACE INTO issues (repo_id, number, title, state, created_at, closed_at, labels, last_updated_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ${labelsFragment}, ?)`,
    repoId,
    issue.number,
    issue.title,
    issue.state,
    issue.createdAt,
    issue.closedAt,
    ...issue.labels,
    runId,
  );
}

async function upsertPr(db, repoId, pr, runId) {
  await db.run(
    `INSERT OR REPLACE INTO pull_requests (repo_id, number, title, state, created_at, merged_at, last_updated_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    repoId,
    pr.number,
    pr.title,
    pr.state,
    pr.createdAt,
    pr.mergedAt,
    runId,
  );
}

async function recordFailure(
  db,
  runId,
  repoId,
  dataType,
  errorMessage,
  occurredAt,
) {
  await db.run(
    `INSERT INTO fetch_failures (run_id, repo_id, data_type, error_message, occurred_at)
     VALUES (?, ?, ?, ?, ?)`,
    runId,
    repoId,
    dataType,
    errorMessage,
    occurredAt,
  );
}

async function loadRun({ db, runId, bronzeDir, extractResults, now }) {
  const summary = { reposLoaded: 0, failuresRecorded: 0 };
  const repoIds = new Set(
    extractResults.filter((r) => r.repoId).map((r) => r.repoId),
  );

  for (const repoId of repoIds) {
    const meta = readBronzeJsonRequired(bronzeDir, runId, repoId, "meta");
    await upsertRepo(db, meta, now);
    summary.reposLoaded += 1;
  }

  for (const result of extractResults) {
    if (result.dataType === "meta" || result.dataType === "repo") continue;
    if (result.status === "error") {
      await recordFailure(
        db,
        runId,
        result.repoId,
        result.dataType,
        result.error,
        now,
      );
      summary.failuresRecorded += 1;
      continue;
    }
    if (
      result.dataType === "commits" ||
      result.dataType === "issues" ||
      result.dataType === "prs"
    ) {
      const rows = readBronzeJsonRequired(
        bronzeDir,
        runId,
        result.repoId,
        result.dataType,
      );
      if (result.dataType === "commits") {
        for (const commit of rows)
          await upsertCommit(db, result.repoId, commit, runId);
      } else if (result.dataType === "issues") {
        for (const issue of rows)
          await upsertIssue(db, result.repoId, issue, runId);
      } else {
        for (const pr of rows) await upsertPr(db, result.repoId, pr, runId);
      }
      // Watermark advances to run time, not max-event time in the data — GitHub's
      // since= semantics vary slightly by endpoint, and run-time is a safe, simple
      // lower bound that never skips data created mid-fetch.
      await setWatermark(
        db,
        result.repoId,
        result.dataType,
        result.fetchedAt,
        runId,
      );
    }
    // "readme" has no silver table and no watermark — it's small enough to refetch
    // in full every run; enrich reads it straight from bronze.
  }

  return summary;
}

async function applySuggestedIgnoreDefaults(db, repoIds, { bronzeDir, runId }) {
  for (const repoId of repoIds) {
    const [repoRow] = await db.all(
      "SELECT is_fork, is_archived, ignore_source FROM repos WHERE repo_id = ?",
      repoId,
    );
    if (!repoRow || repoRow.ignore_source === "manual") continue;

    const readme = readBronzeJson(bronzeDir, runId, repoId, "readme") || "";
    const commits = await db.all(
      "SELECT 1 FROM commits WHERE repo_id = ?",
      repoId,
    );
    const issues = await db.all(
      "SELECT 1 FROM issues WHERE repo_id = ?",
      repoId,
    );
    const prs = await db.all(
      "SELECT 1 FROM pull_requests WHERE repo_id = ?",
      repoId,
    );

    // See the SuggestedIgnoreInput typedef in ignore-rules.js for why this
    // object is assembled inline rather than through a shared helper: the
    // SQL here is intentionally count-only (`SELECT 1 ... WHERE repo_id = ?`)
    // and differs from publish.js's full-column queries by design.
    const { ignored } = computeSuggestedIgnore({
      isFork: repoRow.is_fork,
      isArchived: repoRow.is_archived,
      readme,
      commitCount: commits.length,
      issueCount: issues.length,
      prCount: prs.length,
    });

    await db.run(
      "UPDATE repos SET is_ignored = ?, ignore_source = 'auto' WHERE repo_id = ? AND ignore_source != 'manual'",
      ignored,
      repoId,
    );
  }
}

module.exports = {
  loadRun,
  upsertRepo,
  upsertCommit,
  upsertIssue,
  upsertPr,
  recordFailure,
  applySuggestedIgnoreDefaults,
};
