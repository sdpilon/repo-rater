import { desc, eq } from "drizzle-orm";
import { commits, issues, pullRequests, repoAssessments, repos } from "../db/schema";
import type { DrizzleDb } from "../pipeline/db-types";

/**
 * Read-and-shape logic for the dashboard, plus the ignore-toggle write.
 * Kept free of SolidStart's "use server"/query()/action() wrapping (see
 * ~/lib/dashboard.ts) so it can be unit-tested against a real (PGlite)
 * Postgres the same way pipeline/ code already is, rather than only being
 * exercisable through a live SSR request.
 */

export type IgnoreControlValue = "auto" | "yes" | "no";

export interface RepoAssessmentView {
  pct: number | null;
  band: string;
  label: string;
  text: string;
  gaps: string[];
  readmeText: string | null;
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
  ignoreControl: IgnoreControlValue;
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

function groupByRepoId<T extends { repoId: number }>(rows: T[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const bucket = map.get(row.repoId);
    if (bucket) bucket.push(row);
    else map.set(row.repoId, [row]);
  }
  return map;
}

/** `rows` must already be ordered by (repoId, createdAt DESC) — the first row seen per repoId is kept as "latest". */
function latestByRepoId<T extends { repoId: number }>(rows: T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const row of rows) {
    if (!map.has(row.repoId)) map.set(row.repoId, row);
  }
  return map;
}

export async function getDashboardView(db: DrizzleDb): Promise<DashboardView> {
  const [repoRows, assessmentRows, commitRows, issueRows, prRows] = await Promise.all([
    db.select().from(repos).orderBy(repos.fullName),
    db
      .select()
      .from(repoAssessments)
      .orderBy(repoAssessments.repoId, desc(repoAssessments.createdAt)),
    db.select().from(commits).orderBy(desc(commits.authoredAt)),
    db.select().from(issues).orderBy(desc(issues.createdAt)),
    db.select().from(pullRequests).orderBy(desc(pullRequests.createdAt)),
  ]);

  const latestAssessmentByRepoId = latestByRepoId(assessmentRows);
  const commitsByRepoId = groupByRepoId(commitRows);
  const issuesByRepoId = groupByRepoId(issueRows);
  const prsByRepoId = groupByRepoId(prRows);

  const repoViews: RepoCardView[] = repoRows.map((repo) => {
    const assessmentRow = latestAssessmentByRepoId.get(repo.repoId);
    const inputSnapshot = assessmentRow?.inputSnapshot as { readmeText?: string } | null | undefined;
    const assessment: RepoAssessmentView = assessmentRow
      ? {
          pct: assessmentRow.pct,
          band: assessmentRow.band ?? "none",
          label: assessmentRow.label ?? "Not yet assessed",
          text: assessmentRow.text ?? "",
          gaps: assessmentRow.gaps ?? [],
          readmeText: inputSnapshot?.readmeText ?? null,
        }
      : { pct: null, band: "none", label: "Not yet assessed", text: "", gaps: [], readmeText: null };

    return {
      repoId: repo.repoId,
      fullName: repo.fullName,
      htmlUrl: repo.htmlUrl,
      description: repo.description,
      language: repo.language,
      isPrivate: repo.isPrivate ?? false,
      isIgnored: repo.isIgnored,
      ignoreReasons: repo.isIgnored && repo.ignoreSource === "auto" ? (repo.ignoreReasons ?? []) : [],
      ignoreControl: repo.ignoreSource === "auto" ? "auto" : repo.isIgnored ? "yes" : "no",
      assessment,
      commits: (commitsByRepoId.get(repo.repoId) ?? []).map((c) => ({
        sha: c.sha,
        authoredAt: c.authoredAt,
        message: c.message,
      })),
      issues: (issuesByRepoId.get(repo.repoId) ?? []).map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        createdAt: i.createdAt,
      })),
      pullRequests: (prsByRepoId.get(repo.repoId) ?? []).map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        createdAt: p.createdAt,
        mergedAt: p.mergedAt,
      })),
    };
  });

  const totals: DashboardTotals = {
    repoCount: repoViews.length,
    privateCount: repoViews.filter((r) => r.isPrivate).length,
    commitCount: repoViews.reduce((sum, r) => sum + r.commits.length, 0),
    prCount: repoViews.reduce((sum, r) => sum + r.pullRequests.length, 0),
    mergedPrCount: repoViews.reduce((sum, r) => sum + r.pullRequests.filter((p) => p.mergedAt).length, 0),
    issueCount: repoViews.reduce((sum, r) => sum + r.issues.length, 0),
  };

  return { totals, repos: repoViews };
}

export async function setRepoIgnoreControl(db: DrizzleDb, repoId: number, value: IgnoreControlValue): Promise<void> {
  if (value === "auto") {
    await db
      .update(repos)
      .set({ ignoreSource: "auto", ignoreReasons: null })
      .where(eq(repos.repoId, repoId));
    return;
  }
  await db
    .update(repos)
    .set({ isIgnored: value === "yes", ignoreSource: "manual" })
    .where(eq(repos.repoId, repoId));
}
