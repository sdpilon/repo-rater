import { Octokit } from "octokit";

/**
 * GitHub data-ingestion client backed by Octokit (REST + built-in pagination
 * + throttling), replacing the old `gh`-CLI-shell-out version at repo root
 * `pipeline/github.js`. Function-for-function port: same names, same
 * shapes, same behavior — only the transport changed.
 */

/**
 * Builds an Octokit instance authenticated from the `GITHUB_TOKEN`
 * environment variable. Throws a clear, actionable error rather than
 * constructing an unauthenticated client if the token is missing — callers
 * (namely `run.ts`'s `main()`) are expected to fail fast on a missing token
 * rather than let it surface later as a cryptic 401/403 from GitHub.
 */
export function createOctokit(env: NodeJS.ProcessEnv = process.env): Octokit {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required to create an Octokit client");
  }
  return new Octokit({ auth: token });
}

export interface RepoMeta {
  repoId: number;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  defaultBranch: string;
  language: string | null;
  stargazersCount: number;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
}

export interface Commit {
  sha: string;
  authorName: string | null;
  authoredAt: string | null;
  message: string;
}

export interface Issue {
  number: number;
  title: string;
  state: string;
  createdAt: string;
  closedAt: string | null;
  labels: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  createdAt: string;
  mergedAt: string | null;
}

interface RawRepo {
  id: number;
  full_name: string;
  description?: string | null;
  html_url: string;
  default_branch: string;
  language?: string | null;
  stargazers_count: number;
  private: boolean;
  fork: boolean;
  archived: boolean;
}

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  return { owner, repo };
}

function mapRawRepo(raw: RawRepo): RepoMeta {
  return {
    repoId: raw.id,
    fullName: raw.full_name, // full_name = 'owner.login/name'
    description: raw.description ?? null,
    htmlUrl: raw.html_url,
    defaultBranch: raw.default_branch,
    language: raw.language ?? null,
    stargazersCount: raw.stargazers_count,
    isPrivate: raw.private,
    isFork: raw.fork,
    isArchived: raw.archived,
  };
}

export async function fetchRepoMeta(fullName: string, octokit: Octokit): Promise<RepoMeta> {
  const { owner, repo } = splitFullName(fullName);
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return mapRawRepo(data);
}

export async function fetchReadme(fullName: string, octokit: Octokit): Promise<string> {
  const { owner, repo } = splitFullName(fullName);
  // A missing README (404) is a real error case, same as the old
  // `gh api` version (a non-2xx response made execFileSync throw). Octokit
  // throws a RequestError for it too, and we deliberately let that
  // propagate rather than swallowing it into an empty string.
  const { data } = await octokit.rest.repos.getReadme({ owner, repo });
  return Buffer.from(data.content, "base64").toString("utf8");
}

export async function fetchCommitsSince(
  fullName: string,
  since: string,
  octokit: Octokit,
): Promise<Commit[]> {
  const { owner, repo } = splitFullName(fullName);
  const commits = await octokit.paginate(octokit.rest.repos.listCommits, {
    owner,
    repo,
    since,
    per_page: 100,
  });
  return commits.map((c) => ({
    sha: c.sha,
    authorName: c.commit.author ? (c.commit.author.name ?? null) : null,
    authoredAt: c.commit.author ? (c.commit.author.date ?? null) : null,
    message: c.commit.message.split("\n")[0],
  }));
}

function labelName(label: string | { name?: string | null }): string {
  return typeof label === "string" ? label : (label.name ?? "");
}

export async function fetchIssuesSince(
  fullName: string,
  since: string,
  octokit: Octokit,
): Promise<Issue[]> {
  const { owner, repo } = splitFullName(fullName);
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    since,
    per_page: 100,
  });
  return issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      createdAt: issue.created_at,
      closedAt: issue.closed_at,
      labels: issue.labels.map(labelName),
    }));
}

// The /pulls endpoint has no server-side `since=` support (unlike /commits
// and /issues) — this is a GitHub API limitation, not a `gh`-CLI artifact —
// so incremental fetching still has to be done by hand: walk pages sorted
// by updated_at desc via Octokit's async iterator, and keep only PRs
// created or merged on/after `since`, breaking early once a whole page is
// stale.
export async function fetchPrsSince(
  fullName: string,
  since: string,
  octokit: Octokit,
): Promise<PullRequest[]> {
  const { owner, repo } = splitFullName(fullName);
  const perPage = 100;
  const kept: Array<{
    number: number;
    title: string;
    state: string;
    created_at: string;
    merged_at: string | null;
    updated_at: string;
  }> = [];

  const iterator = octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "all",
    per_page: perPage,
    sort: "updated",
    direction: "desc",
  });

  for await (const { data: page } of iterator) {
    for (const pr of page) {
      if (pr.created_at >= since || (pr.merged_at && pr.merged_at >= since)) {
        kept.push(pr);
      }
    }
    const pageIsFullyStale = page.every((pr) => pr.updated_at < since);
    if (page.length < perPage || pageIsFullyStale) break;
  }

  return kept.map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    createdAt: pr.created_at,
    mergedAt: pr.merged_at,
  }));
}

export async function fetchAccountRepos(octokit: Octokit): Promise<RepoMeta[]> {
  const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
    affiliation: "owner",
    per_page: 100,
  });
  return repos.map(mapRawRepo);
}
