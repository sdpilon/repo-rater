"use strict";
const { execFileSync } = require("child_process");

function defaultGhApiJson(pathAndQuery) {
  const out = execFileSync("gh", ["api", pathAndQuery], { encoding: "utf8" });
  return JSON.parse(out);
}

function fetchRepoMeta(fullName, ghApiJson = defaultGhApiJson) {
  const raw = ghApiJson(`repos/${fullName}`);
  return {
    repoId: raw.id,
    fullName: raw.full_name,
    description: raw.description,
    htmlUrl: raw.html_url,
    defaultBranch: raw.default_branch,
    language: raw.language,
    stargazersCount: raw.stargazers_count,
    isPrivate: raw.private,
    isFork: raw.fork,
    isArchived: raw.archived,
  };
}

function fetchReadme(fullName, ghApiJson = defaultGhApiJson) {
  const raw = ghApiJson(`repos/${fullName}/readme`);
  return Buffer.from(raw.content, "base64").toString("utf8");
}

function fetchCommitsSince(fullName, since, ghApiJson = defaultGhApiJson) {
  const raw = ghApiJson(`repos/${fullName}/commits?since=${since}&per_page=100`);
  return raw.map((c) => ({
    sha: c.sha,
    authorName: c.commit.author ? c.commit.author.name : null,
    authoredAt: c.commit.author ? c.commit.author.date : null,
    message: c.commit.message.split("\n")[0],
  }));
}

function fetchIssuesSince(fullName, since, ghApiJson = defaultGhApiJson) {
  const raw = ghApiJson(`repos/${fullName}/issues?state=all&since=${since}&per_page=100`);
  return raw
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      createdAt: issue.created_at,
      closedAt: issue.closed_at,
      labels: issue.labels.map((label) => label.name),
    }));
}

module.exports = { fetchRepoMeta, fetchReadme, fetchCommitsSince, fetchIssuesSince, defaultGhApiJson };
