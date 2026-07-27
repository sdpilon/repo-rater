"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fetchRepoMeta,
  fetchReadme,
  fetchCommitsSince,
  fetchIssuesSince,
  fetchPrsSince,
  fetchAccountRepos,
} = require("./github");

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
  const commits = fetchCommitsSince(
    "sdpilon/spilon.dev",
    "2026-01-01T00:00:00Z",
    fakeGhApiJson,
  );
  assert.deepEqual(commits, [
    {
      sha: "abc123",
      authorName: "Spencer",
      authoredAt: "2026-07-01T00:00:00Z",
      message: "fix bug",
    },
  ]);
});

test("fetchCommitsSince handles missing commit.author by returning null for authorName and authoredAt", () => {
  const fakeGhApiJson = () => [
    {
      sha: "def456",
      commit: {
        author: null,
        message: "some commit\n\nwith body",
      },
    },
  ];
  const commits = fetchCommitsSince(
    "sdpilon/spilon.dev",
    "2026-01-01T00:00:00Z",
    fakeGhApiJson,
  );
  assert.deepEqual(commits, [
    {
      sha: "def456",
      authorName: null,
      authoredAt: null,
      message: "some commit",
    },
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
  const issues = fetchIssuesSince(
    "sdpilon/spilon.dev",
    "2026-01-01T00:00:00Z",
    fakeGhApiJson,
  );
  assert.deepEqual(issues, [
    {
      number: 1,
      title: "Bug",
      state: "open",
      createdAt: "2026-01-01T00:00:00Z",
      closedAt: null,
      labels: ["bug"],
    },
  ]);
});

function makeRawPr({ number, title, state = "open", createdAt, mergedAt = null, updatedAt }) {
  return {
    number,
    title,
    state,
    created_at: createdAt,
    merged_at: mergedAt,
    updated_at: updatedAt,
  };
}

test("fetchPrsSince keeps PRs created or merged since the cutoff and maps fields, dropping ones untouched since then", () => {
  const fakeGhApiJson = () => [
    makeRawPr({
      number: 1,
      title: "New feature",
      state: "open",
      createdAt: "2026-07-05T00:00:00Z",
      updatedAt: "2026-07-05T00:00:00Z",
    }),
    makeRawPr({
      number: 2,
      title: "Old PR merged late",
      state: "closed",
      createdAt: "2026-06-01T00:00:00Z",
      mergedAt: "2026-07-03T00:00:00Z",
      updatedAt: "2026-07-03T00:00:00Z",
    }),
    makeRawPr({
      number: 3,
      title: "Stale, untouched since the cutoff",
      state: "closed",
      createdAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    }),
  ];
  const prs = fetchPrsSince(
    "sdpilon/spilon.dev",
    "2026-07-01T00:00:00Z",
    fakeGhApiJson,
  );
  assert.deepEqual(prs, [
    {
      number: 1,
      title: "New feature",
      state: "open",
      createdAt: "2026-07-05T00:00:00Z",
      mergedAt: null,
    },
    {
      number: 2,
      title: "Old PR merged late",
      state: "closed",
      createdAt: "2026-06-01T00:00:00Z",
      mergedAt: "2026-07-03T00:00:00Z",
    },
  ]);
});

test("fetchPrsSince stops paginating once a page is entirely older than the watermark cursor", () => {
  const since = "2026-07-01T00:00:00Z";
  const page1 = Array.from({ length: 100 }, (_, i) =>
    makeRawPr({
      number: i + 1,
      title: `pr ${i + 1}`,
      createdAt: "2026-07-15T00:00:00Z",
      updatedAt: "2026-07-15T00:00:00Z",
    }),
  );
  const page2 = [
    makeRawPr({
      number: 200,
      title: "still recent",
      createdAt: "2026-07-10T00:00:00Z",
      updatedAt: "2026-07-10T00:00:00Z",
    }),
    makeRawPr({
      number: 201,
      title: "now stale",
      createdAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    }),
  ];
  const calledPaths = [];
  const fakeGhApiJson = (pathAndQuery) => {
    calledPaths.push(pathAndQuery);
    const page = Number(
      new URL(`https://x/${pathAndQuery}`).searchParams.get("page"),
    );
    if (page === 1) return page1;
    if (page === 2) return page2;
    throw new Error(
      `should not fetch page ${page} — page 2 already crossed the watermark`,
    );
  };
  const prs = fetchPrsSince("sdpilon/spilon.dev", since, fakeGhApiJson);
  assert.equal(calledPaths.length, 2);
  assert.equal(prs.length, 101);
  assert.ok(!prs.some((p) => p.number === 201));
});

function makeRawRepo(n) {
  return {
    id: n,
    full_name: `sdpilon/repo-${n}`,
    description: `repo ${n}`,
    html_url: `https://github.com/sdpilon/repo-${n}`,
    default_branch: "main",
    language: "JavaScript",
    stargazers_count: n,
    private: false,
    fork: n % 2 === 0,
    archived: false,
  };
}

test("fetchAccountRepos pages through full 100-item pages and stops on a short page", () => {
  const page1 = Array.from({ length: 100 }, (_, i) => makeRawRepo(i + 1));
  const page2 = [makeRawRepo(101), makeRawRepo(102)];
  const calledPaths = [];
  const fakeGhApiJson = (pathAndQuery) => {
    calledPaths.push(pathAndQuery);
    const url = new URL(`https://x/${pathAndQuery}`);
    const page = url.searchParams.get("page");
    if (page === "1") return page1;
    if (page === "2") return page2;
    throw new Error(`unexpected page: ${page}`);
  };
  const repos = fetchAccountRepos(fakeGhApiJson);
  assert.equal(repos.length, 102);
  assert.equal(calledPaths.length, 2);
  assert.match(
    calledPaths[0],
    /^user\/repos\?affiliation=owner&per_page=100&page=1$/,
  );
  assert.match(
    calledPaths[1],
    /^user\/repos\?affiliation=owner&per_page=100&page=2$/,
  );
});

test("fetchAccountRepos maps raw fields to camelCase repo meta", () => {
  const fakeGhApiJson = () => [makeRawRepo(1)];
  const repos = fetchAccountRepos(fakeGhApiJson);
  assert.deepEqual(repos, [
    {
      repoId: 1,
      fullName: "sdpilon/repo-1",
      description: "repo 1",
      htmlUrl: "https://github.com/sdpilon/repo-1",
      defaultBranch: "main",
      language: "JavaScript",
      stargazersCount: 1,
      isPrivate: false,
      isFork: false,
      isArchived: false,
    },
  ]);
});
