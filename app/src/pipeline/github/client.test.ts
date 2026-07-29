import type { Octokit } from "octokit";
import { describe, expect, it, vi } from "vitest";
import {
  fetchAccountRepos,
  fetchCommitsSince,
  fetchIssuesSince,
  fetchPrsSince,
  fetchReadme,
  fetchRepoMeta,
} from "./client";

// Minimal stand-in for the surface of Octokit these functions actually
// touch. Cast to `Octokit` at the call site (mirrors the old suite's
// fakeGhApiJson injection pattern, just shaped for Octokit's method-based
// API instead of a single JSON-fetching function).
function makeFakeOctokit(overrides: {
  get?: ReturnType<typeof vi.fn>;
  getReadme?: ReturnType<typeof vi.fn>;
  listCommits?: ReturnType<typeof vi.fn>;
  listForRepo?: ReturnType<typeof vi.fn>;
  pullsList?: ReturnType<typeof vi.fn>;
  listForAuthenticatedUser?: ReturnType<typeof vi.fn>;
  paginate?: ReturnType<typeof vi.fn>;
  paginateIterator?: ReturnType<typeof vi.fn>;
}) {
  const paginate = overrides.paginate ?? vi.fn();
  (paginate as unknown as { iterator: unknown }).iterator =
    overrides.paginateIterator ?? vi.fn();

  return {
    rest: {
      repos: {
        get: overrides.get ?? vi.fn(),
        getReadme: overrides.getReadme ?? vi.fn(),
        listCommits: overrides.listCommits ?? vi.fn(),
        listForAuthenticatedUser: overrides.listForAuthenticatedUser ?? vi.fn(),
      },
      issues: {
        listForRepo: overrides.listForRepo ?? vi.fn(),
      },
      pulls: {
        list: overrides.pullsList ?? vi.fn(),
      },
    },
    paginate,
  } as unknown as Octokit;
}

describe("fetchRepoMeta", () => {
  it("maps raw GitHub fields to camelCase repo meta", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
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
      },
    });
    const octokit = makeFakeOctokit({ get });

    const meta = await fetchRepoMeta("sdpilon/spilon.dev", octokit);

    expect(get).toHaveBeenCalledWith({ owner: "sdpilon", repo: "spilon.dev" });
    expect(meta).toEqual({
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
});

describe("fetchReadme", () => {
  it("base64-decodes the readme content", async () => {
    const getReadme = vi.fn().mockResolvedValue({
      data: { content: Buffer.from("# Hello").toString("base64") },
    });
    const octokit = makeFakeOctokit({ getReadme });

    const readme = await fetchReadme("sdpilon/spilon.dev", octokit);

    expect(getReadme).toHaveBeenCalledWith({ owner: "sdpilon", repo: "spilon.dev" });
    expect(readme).toBe("# Hello");
  });

  it("propagates the error when the README is missing (404)", async () => {
    const notFound = Object.assign(new Error("Not Found"), { status: 404 });
    const getReadme = vi.fn().mockRejectedValue(notFound);
    const octokit = makeFakeOctokit({ getReadme });

    await expect(fetchReadme("sdpilon/spilon.dev", octokit)).rejects.toThrow("Not Found");
  });
});

describe("fetchCommitsSince", () => {
  it("maps commits and takes the first line of the message", async () => {
    const paginate = vi.fn().mockResolvedValue([
      {
        sha: "abc123",
        commit: {
          author: { name: "Spencer", date: "2026-07-01T00:00:00Z" },
          message: "fix bug\n\nlonger body",
        },
      },
    ]);
    const octokit = makeFakeOctokit({ paginate });

    const commits = await fetchCommitsSince(
      "sdpilon/spilon.dev",
      "2026-01-01T00:00:00Z",
      octokit,
    );

    expect(paginate).toHaveBeenCalledWith(octokit.rest.repos.listCommits, {
      owner: "sdpilon",
      repo: "spilon.dev",
      since: "2026-01-01T00:00:00Z",
      per_page: 100,
    });
    expect(commits).toEqual([
      {
        sha: "abc123",
        authorName: "Spencer",
        authoredAt: "2026-07-01T00:00:00Z",
        message: "fix bug",
      },
    ]);
  });

  it("handles missing commit.author by returning null for authorName and authoredAt", async () => {
    const paginate = vi.fn().mockResolvedValue([
      {
        sha: "def456",
        commit: {
          author: null,
          message: "some commit\n\nwith body",
        },
      },
    ]);
    const octokit = makeFakeOctokit({ paginate });

    const commits = await fetchCommitsSince(
      "sdpilon/spilon.dev",
      "2026-01-01T00:00:00Z",
      octokit,
    );

    expect(commits).toEqual([
      {
        sha: "def456",
        authorName: null,
        authoredAt: null,
        message: "some commit",
      },
    ]);
  });
});

describe("fetchIssuesSince", () => {
  it("filters out pull requests and maps labels to names", async () => {
    const paginate = vi.fn().mockResolvedValue([
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
    ]);
    const octokit = makeFakeOctokit({ paginate });

    const issues = await fetchIssuesSince("sdpilon/spilon.dev", "2026-01-01T00:00:00Z", octokit);

    expect(paginate).toHaveBeenCalledWith(octokit.rest.issues.listForRepo, {
      owner: "sdpilon",
      repo: "spilon.dev",
      state: "all",
      since: "2026-01-01T00:00:00Z",
      per_page: 100,
    });
    expect(issues).toEqual([
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
});

function makeRawPr({
  number,
  title,
  state = "open",
  createdAt,
  mergedAt = null,
  updatedAt,
}: {
  number: number;
  title: string;
  state?: string;
  createdAt: string;
  mergedAt?: string | null;
  updatedAt: string;
}) {
  return {
    number,
    title,
    state,
    created_at: createdAt,
    merged_at: mergedAt,
    updated_at: updatedAt,
  };
}

describe("fetchPrsSince", () => {
  it("keeps PRs created or merged since the cutoff and maps fields, dropping ones untouched since then", async () => {
    const page = [
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
    async function* iterator() {
      yield { data: page };
    }
    const paginateIterator = vi.fn().mockReturnValue(iterator());
    const octokit = makeFakeOctokit({ paginateIterator });

    const prs = await fetchPrsSince("sdpilon/spilon.dev", "2026-07-01T00:00:00Z", octokit);

    expect(paginateIterator).toHaveBeenCalledWith(octokit.rest.pulls.list, {
      owner: "sdpilon",
      repo: "spilon.dev",
      state: "all",
      per_page: 100,
      sort: "updated",
      direction: "desc",
    });
    expect(prs).toEqual([
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

  it("stops paginating once a page is entirely older than the watermark cursor", async () => {
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
    // A 3rd page exists in the fixture but must never be consumed — the
    // early-break-on-stale-page logic should stop pulling from the
    // iterator after page 2.
    const page3 = [
      makeRawPr({
        number: 300,
        title: "should never be fetched",
        createdAt: "2026-07-20T00:00:00Z",
        updatedAt: "2026-07-20T00:00:00Z",
      }),
    ];
    const pagesConsumed: number[] = [];
    async function* iterator() {
      pagesConsumed.push(1);
      yield { data: page1 };
      pagesConsumed.push(2);
      yield { data: page2 };
      pagesConsumed.push(3);
      yield { data: page3 };
    }
    const paginateIterator = vi.fn().mockReturnValue(iterator());
    const octokit = makeFakeOctokit({ paginateIterator });

    const prs = await fetchPrsSince("sdpilon/spilon.dev", since, octokit);

    expect(pagesConsumed).toEqual([1, 2]);
    expect(prs.length).toBe(101);
    expect(prs.some((p) => p.number === 201)).toBe(false);
    expect(prs.some((p) => p.number === 300)).toBe(false);
  });
});

function makeRawRepo(n: number) {
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

describe("fetchAccountRepos", () => {
  it("assembles and maps repos across full 100-item pages down to a short final page", async () => {
    // Octokit's built-in paginate() owns the actual page-walking now (it's
    // already tested upstream); this test simulates its contract — the
    // fully assembled, flattened array spanning a full page plus a short
    // page — and asserts our function passes the right call params through
    // and maps every item correctly.
    const page1 = Array.from({ length: 100 }, (_, i) => makeRawRepo(i + 1));
    const page2 = [makeRawRepo(101), makeRawRepo(102)];
    const paginate = vi.fn().mockResolvedValue([...page1, ...page2]);
    const octokit = makeFakeOctokit({ paginate });

    const repos = await fetchAccountRepos(octokit);

    expect(paginate).toHaveBeenCalledWith(octokit.rest.repos.listForAuthenticatedUser, {
      affiliation: "owner",
      per_page: 100,
    });
    expect(repos.length).toBe(102);
  });

  it("maps raw fields to camelCase repo meta", async () => {
    const paginate = vi.fn().mockResolvedValue([makeRawRepo(1)]);
    const octokit = makeFakeOctokit({ paginate });

    const repos = await fetchAccountRepos(octokit);

    expect(repos).toEqual([
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
});
