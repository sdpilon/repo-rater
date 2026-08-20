/**
 * Client-safe view types and pure functions for the dashboard.
 *
 * Deliberately free of any `drizzle-orm`/`../db/schema` imports — those pull
 * in the whole DB schema (top-level `pgTable()` calls Rollup can't
 * tree-shake) into any bundle that imports this module's exports, including
 * client-side route code. Keep it that way; DB-touching logic belongs in
 * dashboard-queries.ts instead.
 */

export type AssessControlValue = "auto" | "yes" | "no";

export interface RepoAssessmentView {
  pct: number | null;
  band: string;
  label: string;
  text: string;
  gaps: string[];
  readmeText: string | null;
  updatedAt: Date | null;
}

export interface RepoCommitView {
  sha: string;
  authoredAt: Date | null;
  message: string | null;
}

export interface RepoIssueView {
  number: number;
  title: string | null;
  state: string | null;
  createdAt: Date | null;
}

export interface RepoPullRequestView {
  number: number;
  title: string | null;
  state: string | null;
  createdAt: Date | null;
  mergedAt: Date | null;
}

export interface RepoCardView {
  repoId: number;
  fullName: string;
  htmlUrl: string | null;
  description: string | null;
  language: string | null;
  isPrivate: boolean;
  isIgnored: boolean;
  ignoreReasons: string[];
  assessControl: AssessControlValue;
  assessment: RepoAssessmentView;
  commits: RepoCommitView[];
  issues: RepoIssueView[];
  pullRequests: RepoPullRequestView[];
}

export interface DashboardTotals {
  repoCount: number;
  privateCount: number;
  commitCount: number;
  prCount: number;
  mergedPrCount: number;
  issueCount: number;
}

export interface DashboardView {
  totals: DashboardTotals;
  repos: RepoCardView[];
}

export function computeTotals(repos: RepoCardView[]): DashboardTotals {
  return {
    repoCount: repos.length,
    privateCount: repos.filter((r) => r.isPrivate).length,
    commitCount: repos.reduce((sum, r) => sum + r.commits.length, 0),
    prCount: repos.reduce((sum, r) => sum + r.pullRequests.length, 0),
    mergedPrCount: repos.reduce(
      (sum, r) => sum + r.pullRequests.filter((p) => p.mergedAt).length,
      0,
    ),
    issueCount: repos.reduce((sum, r) => sum + r.issues.length, 0),
  };
}

export function deriveAccountOwner(repos: { fullName: string }[]): string | undefined {
  const owners = new Set(repos.map((r) => r.fullName.split("/")[0]));
  return owners.size === 1 ? [...owners][0] : undefined;
}

export function filterVisibleRepos(
  repos: RepoCardView[],
  hideIgnored: boolean,
): RepoCardView[] {
  return hideIgnored ? repos.filter((r) => !r.isIgnored) : repos;
}
