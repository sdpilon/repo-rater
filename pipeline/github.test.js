"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchRepoMeta, fetchReadme, fetchCommitsSince, fetchIssuesSince } = require("./github");

test("fetchRepoMeta maps raw GitHub fields to camelCase repo meta", () => {
  const fakeGhApiJson = (pathAndQuery) => {
    assert.equal(pathAndQuery, "repos/sdpilon/spilon.dev");
    return {
      id: 123,
      full_name: "sdpilon/spilon.dev",
      description: "my site",
      html_url: "https://github.com/sdpilon/spilon.dev",
      default_branch: "main",
      language: "Astro",
      stargazers_count: 2,
      private: false,
      fork: false,
      archived: false,
    };
  };
  const meta = fetchRepoMeta("sdpilon/spilon.dev", fakeGhApiJson);
  assert.deepEqual(meta, {
    repoId: 123,
    fullName: "sdpilon/spilon.dev",
    description: "my site",
    htmlUrl: "https://github.com/sdpilon/spilon.dev",
    defaultBranch: "main",
    language: "Astro",
    stargazersCount: 2,
    isPrivate: false,
    isFork: false,
    isArchived: false,
  });
});

test("fetchReadme base64-decodes the readme content", () => {
  const fakeGhApiJson = (pathAndQuery) => {
    assert.equal(pathAndQuery, "repos/sdpilon/spilon.dev/readme");
    return { content: Buffer.from("# Hello").toString("base64") };
  };
  assert.equal(fetchReadme("sdpilon/spilon.dev", fakeGhApiJson), "# Hello");
});

test("fetchCommitsSince maps commits and takes the first line of the message", () => {
  const fakeGhApiJson = () => [
    {
      sha: "abc123",
      commit: {
        author: { name: "Spencer", date: "2026-07-01T00:00:00Z" },
        message: "fix bug\n\nlonger body",
      },
    },
  ];
  const commits = fetchCommitsSince("sdpilon/spilon.dev", "2026-01-01T00:00:00Z", fakeGhApiJson);
  assert.deepEqual(commits, [
    { sha: "abc123", authorName: "Spencer", authoredAt: "2026-07-01T00:00:00Z", message: "fix bug" },
  ]);
});

test("fetchIssuesSince filters out pull requests and maps labels to names", () => {
  const fakeGhApiJson = () => [
    {
      number: 1,
      title: "Bug",
      state: "open",
      created_at: "2026-01-01T00:00:00Z",
      closed_at: null,
      labels: [{ name: "bug" }],
      pull_request: null,
    },
    {
      number: 2,
      title: "A PR",
      state: "open",
      created_at: "2026-01-02T00:00:00Z",
      closed_at: null,
      labels: [],
      pull_request: {},
    },
  ];
  const issues = fetchIssuesSince("sdpilon/spilon.dev", "2026-01-01T00:00:00Z", fakeGhApiJson);
  assert.deepEqual(issues, [
    { number: 1, title: "Bug", state: "open", createdAt: "2026-01-01T00:00:00Z", closedAt: null, labels: ["bug"] },
  ]);
});
