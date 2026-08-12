import { desc, eq } from "drizzle-orm";
import { commits, issues, pullRequests, repoAssessments, repos } from "../db/schema";
import type { DrizzleDb } from "../pipeline/db-types";
import {
  type AssessControlValue,
  computeTotals,
  type DashboardView,
  type RepoAssessmentView,
  type RepoCardView,
} from "./dashboard-view";

export * from "./dashboard-view";

/**
 * Read-and-shape logic for the dashboard, plus the ignore-toggle write.
 * Kept free of SolidStart's "use server"/query()/action() wrapping (see
 * ~/lib/dashboard.ts) so it can be unit-tested against a real (PGlite)
 * Postgres the same way pipeline/ code already is, rather than only being
 * exercisable through a live SSR request.
 *
 * View types and pure helpers (computeTotals, filterVisibleRepos, etc.) live
 * in ./dashboard-view.ts, which is free of drizzle imports so it's safe for
 * the client bundle; this file re-exports them for convenience but anything
 * importing only those should import ./dashboard-view directly.
 */

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
      assessControl: repo.ignoreSource === "auto" ? "auto" : repo.isIgnored ? "no" : "yes",
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

  return { totals: computeTotals(repoViews), repos: repoViews };
}

export async function setRepoAssessControl(db: DrizzleDb, repoId: number, value: AssessControlValue): Promise<void> {
  if (value === "auto") {
    await db
      .update(repos)
      .set({ ignoreSource: "auto", ignoreReasons: null })
      .where(eq(repos.repoId, repoId));
    return;
  }
  await db
    .update(repos)
    .set({ isIgnored: value === "no", ignoreSource: "manual" })
    .where(eq(repos.repoId, repoId));
}
