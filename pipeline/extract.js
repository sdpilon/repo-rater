"use strict";
const fs = require("fs");
const path = require("path");
const { getWatermark } = require("./db");
const {
  fetchRepoMeta,
  fetchReadme,
  fetchCommitsSince,
  fetchIssuesSince,
  defaultGhApiJson,
} = require("./github");

const DATA_TYPES = ["commits", "issues"];
const DEFAULT_SINCE = "2020-01-01T00:00:00Z";

function writeBronze(bronzeDir, runId, repoId, name, payload) {
  const dir = path.join(bronzeDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${repoId}_${name}.json`),
    JSON.stringify(payload, null, 2),
  );
}

async function extractRepo({
  fullName,
  db,
  runId,
  bronzeDir,
  ghApiJson = defaultGhApiJson,
  now = () => new Date().toISOString(),
}) {
  const results = [];
  let meta;
  try {
    meta = fetchRepoMeta(fullName, ghApiJson);
    writeBronze(bronzeDir, runId, meta.repoId, "meta", meta);
  } catch (err) {
    results.push({
      fullName,
      repoId: null,
      dataType: "meta",
      status: "error",
      error: String(err),
    });
    return results;
  }

  try {
    const readme = fetchReadme(fullName, ghApiJson);
    writeBronze(bronzeDir, runId, meta.repoId, "readme", readme);
    results.push({
      fullName,
      repoId: meta.repoId,
      dataType: "readme",
      status: "ok",
    });
  } catch (err) {
    try {
      writeBronze(bronzeDir, runId, meta.repoId, "readme", "");
    } catch {
      // fallback write also failed; the readme error result below still records the failure
    }
    results.push({
      fullName,
      repoId: meta.repoId,
      dataType: "readme",
      status: "error",
      error: String(err),
    });
  }

  for (const dataType of DATA_TYPES) {
    try {
      const watermark = await getWatermark(db, meta.repoId, dataType);
      const since = watermark ? watermark.toISOString() : DEFAULT_SINCE;
      const rows =
        dataType === "commits"
          ? fetchCommitsSince(fullName, since, ghApiJson)
          : fetchIssuesSince(fullName, since, ghApiJson);
      writeBronze(bronzeDir, runId, meta.repoId, dataType, rows);
      results.push({
        fullName,
        repoId: meta.repoId,
        dataType,
        status: "ok",
        since,
        fetchedAt: now(),
      });
    } catch (err) {
      results.push({
        fullName,
        repoId: meta.repoId,
        dataType,
        status: "error",
        error: String(err),
      });
    }
  }
  return results;
}

async function extractAll({
  repos,
  db,
  runId,
  bronzeDir,
  ghApiJson = defaultGhApiJson,
}) {
  const allResults = [];
  for (const fullName of repos) {
    try {
      allResults.push(
        ...(await extractRepo({ fullName, db, runId, bronzeDir, ghApiJson })),
      );
    } catch (err) {
      allResults.push({
        fullName,
        repoId: null,
        dataType: "repo",
        status: "error",
        error: String(err),
      });
    }
  }
  return allResults;
}

module.exports = {
  extractRepo,
  extractAll,
  writeBronze,
  DATA_TYPES,
  DEFAULT_SINCE,
};
