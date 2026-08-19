import { eq, inArray } from "drizzle-orm";
import { createDb } from "../db/client";
import { commits, issues, pullRequests, repoAssessments, repos, runs } from "../db/schema";
import { resolveConfig } from "../lib/config";
import type { DrizzleDb } from "./db-types";

/**
 * Hand-authored fixture data for a fake GitHub account, used to populate the
 * dashboard for public-facing purposes (READ ME screenshots, a future
 * zero-auth demo instance) without exposing anything from the real account.
 * Deliberately spans the variety a screenshot needs to look representative:
 * good/warn/crit assessments, a repo with no assessment yet, an
 * auto-ignored fork, and a private repo.
 */

interface FakeCommit {
  sha: string;
  authorName: string;
  authoredAt: Date;
  message: string;
}

interface FakeIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  createdAt: Date;
  closedAt: Date | null;
  labels: string[];
}

interface FakePullRequest {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  createdAt: Date;
  mergedAt: Date | null;
}

interface FakeAssessment {
  pct: number | null;
  band: "good" | "warn" | "crit" | "none";
  label: string;
  text: string;
  gaps: string[];
}

interface FakeRepoFixture {
  repoId: number;
  fullName: string;
  description: string;
  htmlUrl: string;
  defaultBranch: string;
  language: string;
  stargazersCount: number;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  isIgnored: boolean;
  ignoreSource: "auto" | "manual";
  ignoreReasons: string[] | null;
  /** Rendered on the card alongside the assessment when set; only assessed repos carry one, matching how the real pipeline only persists README text as part of an assessment's input snapshot. */
  readme: string | null;
  commits: FakeCommit[];
  issues: FakeIssue[];
  pullRequests: FakePullRequest[];
  assessment: FakeAssessment | null;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function buildFakeRepos(now: Date): FakeRepoFixture[] {
  return [
    {
      repoId: 900001,
      fullName: "demo-user/order-tracking-api",
      description: "REST API for tracking multi-warehouse order fulfillment status.",
      htmlUrl: "https://github.com/demo-user/order-tracking-api",
      defaultBranch: "main",
      language: "TypeScript",
      stargazersCount: 42,
      isPrivate: false,
      isFork: false,
      isArchived: false,
      isIgnored: false,
      ignoreSource: "auto",
      ignoreReasons: null,
      readme:
        "# order-tracking-api\n\nREST API for tracking multi-warehouse order fulfillment status.\n\n## Roadmap\n\n- [x] Order creation with idempotency keys\n- [x] Webhook retry backoff\n- [ ] Partial shipment status\n\n## Running locally\n\n```\nnpm install\nnpm run dev\n```\n",
      commits: [
        { sha: "a1b2c3d", authorName: "demo-user", authoredAt: daysAgo(now, 1), message: "Add idempotency keys to order creation endpoint" },
        { sha: "b2c3d4e", authorName: "demo-user", authoredAt: daysAgo(now, 3), message: "Fix race condition in warehouse stock reservation" },
        { sha: "c3d4e5f", authorName: "demo-user", authoredAt: daysAgo(now, 6), message: "Add integration tests for fulfillment webhook" },
      ],
      issues: [
        { number: 41, title: "Webhook retries don't back off", state: "closed", createdAt: daysAgo(now, 10), closedAt: daysAgo(now, 2), labels: ["bug"] },
        { number: 44, title: "Support partial shipment status", state: "open", createdAt: daysAgo(now, 4), closedAt: null, labels: ["enhancement"] },
      ],
      pullRequests: [
        { number: 52, title: "Idempotency keys for order creation", state: "merged", createdAt: daysAgo(now, 2), mergedAt: daysAgo(now, 1) },
      ],
      assessment: {
        pct: 88,
        band: "good",
        label: "On track, nearly feature-complete",
        text: "Recent commits and merged PRs directly close out open issues (webhook retry backoff, idempotency keys) called out in the README's roadmap. Test coverage for the fulfillment webhook was added alongside the fix, not after.",
        gaps: ["Partial shipment status still open"],
      },
    },
    {
      repoId: 900002,
      fullName: "demo-user/recipe-notes",
      description: "A minimal note-taking app for recipes, with tag-based search.",
      htmlUrl: "https://github.com/demo-user/recipe-notes",
      defaultBranch: "main",
      language: "Svelte",
      stargazersCount: 7,
      isPrivate: false,
      isFork: false,
      isArchived: false,
      isIgnored: false,
      ignoreSource: "auto",
      ignoreReasons: null,
      readme:
        "# recipe-notes\n\nA minimal note-taking app for recipes, with tag-based search.\n\n## Features\n\n- Tag-based filtering\n- Full-text search across all notes\n- One-click export to Markdown or PDF\n\nBuilt with SvelteKit.\n",
      commits: [
        { sha: "d4e5f6a", authorName: "demo-user", authoredAt: daysAgo(now, 5), message: "Add tag filter UI" },
        { sha: "e5f6a7b", authorName: "demo-user", authoredAt: daysAgo(now, 20), message: "Basic CRUD for recipes" },
      ],
      issues: [
        { number: 3, title: "No way to export recipes", state: "open", createdAt: daysAgo(now, 30), closedAt: null, labels: [] },
        { number: 5, title: "Search is case-sensitive", state: "open", createdAt: daysAgo(now, 12), closedAt: null, labels: ["bug"] },
      ],
      pullRequests: [],
      assessment: {
        pct: 55,
        band: "warn",
        label: "Core flow works, stated features missing",
        text: "The README promises export and full-text search; only tag filtering has landed. Commit cadence has slowed to roughly one push every couple weeks, and two issues describing README-promised behavior remain open.",
        gaps: ["Recipe export", "Case-insensitive search"],
      },
    },
    {
      repoId: 900003,
      fullName: "demo-user/old-blog-generator",
      description: "Static site generator for a personal blog, built in a weekend.",
      htmlUrl: "https://github.com/demo-user/old-blog-generator",
      defaultBranch: "main",
      language: "Python",
      stargazersCount: 2,
      isPrivate: false,
      isFork: false,
      isArchived: false,
      isIgnored: false,
      ignoreSource: "auto",
      ignoreReasons: null,
      readme:
        "# old-blog-generator\n\nA fully working static site generator for my personal blog, with themes and RSS support, built in a weekend.\n\n## Usage\n\n```\npython generate.py\n```\n\nMore themes coming soon!\n",
      commits: [
        { sha: "f6a7b8c", authorName: "demo-user", authoredAt: daysAgo(now, 210), message: "Initial commit" },
      ],
      issues: [
        { number: 1, title: "RSS feed is malformed", state: "open", createdAt: daysAgo(now, 200), closedAt: null, labels: ["bug"] },
      ],
      pullRequests: [],
      assessment: {
        pct: 15,
        band: "crit",
        label: "Stalled, README overstates status",
        text: "The README describes a 'fully working' generator with themes and RSS support, but there's a single initial commit and one long-open bug against the only shipped feature. No activity in over six months.",
        gaps: ["Themes", "Working RSS feed", "Any activity since initial commit"],
      },
    },
    {
      repoId: 900004,
      fullName: "demo-user/notes-cli",
      description: "Command-line notes app with fuzzy search.",
      htmlUrl: "https://github.com/demo-user/notes-cli",
      defaultBranch: "main",
      language: "Rust",
      stargazersCount: 15,
      isPrivate: false,
      isFork: false,
      isArchived: false,
      isIgnored: false,
      ignoreSource: "auto",
      ignoreReasons: null,
      readme: null,
      commits: [
        { sha: "a7b8c9d", authorName: "demo-user", authoredAt: daysAgo(now, 0), message: "Scaffold CLI with clap" },
      ],
      issues: [],
      pullRequests: [],
      assessment: null,
    },
    {
      repoId: 900005,
      fullName: "demo-user/upstream-linter-fork",
      description: "Fork of a linter with a couple of local patches.",
      htmlUrl: "https://github.com/demo-user/upstream-linter-fork",
      defaultBranch: "main",
      language: "Go",
      stargazersCount: 0,
      isPrivate: false,
      isFork: true,
      isArchived: false,
      isIgnored: true,
      ignoreSource: "auto",
      ignoreReasons: ["fork"],
      readme: null,
      commits: [],
      issues: [],
      pullRequests: [],
      assessment: null,
    },
    {
      repoId: 900006,
      fullName: "demo-user/internal-billing-service",
      description: "Private billing reconciliation service.",
      htmlUrl: "https://github.com/demo-user/internal-billing-service",
      defaultBranch: "main",
      language: "TypeScript",
      stargazersCount: 0,
      isPrivate: true,
      isFork: false,
      isArchived: false,
      isIgnored: false,
      ignoreSource: "auto",
      ignoreReasons: null,
      readme:
        "# internal-billing-service\n\nPrivate billing reconciliation service. Reconciles Stripe payouts against the internal ledger, and handles the full range of Stripe dispute types.\n\n## Deploying\n\nSee the internal runbook.\n",
      commits: [
        { sha: "b8c9d0e", authorName: "demo-user", authoredAt: daysAgo(now, 2), message: "Reconcile Stripe payouts against ledger" },
        { sha: "c9d0e1f", authorName: "demo-user", authoredAt: daysAgo(now, 8), message: "Add dead-letter queue for failed reconciliations" },
      ],
      issues: [
        { number: 12, title: "Handle partial refunds in reconciliation", state: "closed", createdAt: daysAgo(now, 15), closedAt: daysAgo(now, 9), labels: [] },
      ],
      pullRequests: [
        { number: 20, title: "Dead-letter queue for failed reconciliations", state: "merged", createdAt: daysAgo(now, 9), mergedAt: daysAgo(now, 8) },
      ],
      assessment: {
        pct: 72,
        band: "warn",
        label: "Core reconciliation works, edge cases remain",
        text: "Partial refunds were closed out, but the README's stated goal of handling all Stripe dispute types isn't reflected in commits or issues yet.",
        gaps: ["Dispute handling"],
      },
    },
    {
      repoId: 900007,
      fullName: "demo-user/dotfiles",
      description: "Personal shell and editor configuration.",
      htmlUrl: "https://github.com/demo-user/dotfiles",
      defaultBranch: "main",
      language: "Shell",
      stargazersCount: 3,
      isPrivate: false,
      isFork: false,
      isArchived: true,
      isIgnored: true,
      ignoreSource: "auto",
      ignoreReasons: ["archived"],
      readme: null,
      commits: [],
      issues: [],
      pullRequests: [],
      assessment: null,
    },
  ];
}

export interface SeedFakeDataOptions {
  force?: boolean;
  now?: Date;
}

export interface SeedFakeDataResult {
  repoCount: number;
}

const FAKE_RUN_ID = "fake-seed-run";

async function isRepoTableEmpty(db: DrizzleDb): Promise<boolean> {
  const rows = await db.select({ repoId: repos.repoId }).from(repos).limit(1);
  return rows.length === 0;
}

/**
 * Deletes any rows this script previously wrote (scoped to its own fixed
 * fake repoIds / run id) so re-running with --force is idempotent instead
 * of colliding on the fixture's static primary keys. Never touches rows
 * outside that namespace, so real data alongside it is left alone.
 */
async function clearPreviousFakeData(db: DrizzleDb, fakeRepoIds: number[]): Promise<void> {
  await db.delete(repoAssessments).where(inArray(repoAssessments.repoId, fakeRepoIds));
  await db.delete(commits).where(inArray(commits.repoId, fakeRepoIds));
  await db.delete(issues).where(inArray(issues.repoId, fakeRepoIds));
  await db.delete(pullRequests).where(inArray(pullRequests.repoId, fakeRepoIds));
  await db.delete(repos).where(inArray(repos.repoId, fakeRepoIds));
  await db.delete(runs).where(eq(runs.runId, FAKE_RUN_ID));
}

export async function seedFakeData(
  db: DrizzleDb,
  options?: SeedFakeDataOptions,
): Promise<SeedFakeDataResult> {
  if (!options?.force && !(await isRepoTableEmpty(db))) {
    throw new Error(
      "Database already has repos — refusing to seed fake data over real (or previously seeded) data. Pass --force to seed anyway.",
    );
  }

  const now = options?.now ?? new Date();
  const runId = FAKE_RUN_ID;
  const fakeRepos = buildFakeRepos(now);

  await clearPreviousFakeData(db, fakeRepos.map((r) => r.repoId));

  await db.insert(runs).values({
    runId,
    startedAt: now,
    finishedAt: now,
    status: "success",
    reposDiscovered: fakeRepos.length,
    reposFetchedOk: fakeRepos.length,
    reposFailed: 0,
    llmCallsMade: fakeRepos.filter((r) => r.assessment !== null).length,
    llmCallsSkipped: 0,
  });

  for (const fixture of fakeRepos) {
    await db.insert(repos).values({
      repoId: fixture.repoId,
      fullName: fixture.fullName,
      description: fixture.description,
      htmlUrl: fixture.htmlUrl,
      defaultBranch: fixture.defaultBranch,
      language: fixture.language,
      stargazersCount: fixture.stargazersCount,
      isPrivate: fixture.isPrivate,
      isFork: fixture.isFork,
      isArchived: fixture.isArchived,
      isIgnored: fixture.isIgnored,
      ignoreSource: fixture.ignoreSource,
      ignoreReasons: fixture.ignoreReasons,
      assessmentSource: "auto",
      firstSeenAt: now,
      lastSeenAt: now,
    });

    if (fixture.commits.length > 0) {
      await db.insert(commits).values(
        fixture.commits.map((c) => ({
          repoId: fixture.repoId,
          sha: c.sha,
          authorName: c.authorName,
          authoredAt: c.authoredAt,
          message: c.message,
          firstIngestedRunId: runId,
        })),
      );
    }

    if (fixture.issues.length > 0) {
      await db.insert(issues).values(
        fixture.issues.map((i) => ({
          repoId: fixture.repoId,
          number: i.number,
          title: i.title,
          state: i.state,
          createdAt: i.createdAt,
          closedAt: i.closedAt,
          labels: i.labels,
          lastUpdatedRunId: runId,
        })),
      );
    }

    if (fixture.pullRequests.length > 0) {
      await db.insert(pullRequests).values(
        fixture.pullRequests.map((p) => ({
          repoId: fixture.repoId,
          number: p.number,
          title: p.title,
          state: p.state,
          createdAt: p.createdAt,
          mergedAt: p.mergedAt,
          lastUpdatedRunId: runId,
        })),
      );
    }

    if (fixture.assessment) {
      await db.insert(repoAssessments).values({
        repoId: fixture.repoId,
        runId,
        inputHash: `fake-${fixture.repoId}`,
        pct: fixture.assessment.pct,
        band: fixture.assessment.band,
        label: fixture.assessment.label,
        text: fixture.assessment.text,
        gaps: fixture.assessment.gaps,
        inputSnapshot: {
          fullName: fixture.fullName,
          readmeText: fixture.readme ?? "",
          commitMessages: fixture.commits.map((c) => c.message),
          issueTitles: fixture.issues.map((i) => i.title),
          issueStates: fixture.issues.map((i) => i.state),
          prTitles: fixture.pullRequests.map((p) => p.title),
          prStates: fixture.pullRequests.map((p) => p.state),
        },
        createdAt: now,
      });
    }
  }

  return { repoCount: fakeRepos.length };
}

/**
 * Real CLI entrypoint, mirroring `run.ts`'s `main()`: reads `DATABASE_URL`
 * from the environment/config file, connects, seeds, closes. `--force`
 * bypasses the empty-table guard.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const force = argv.includes("--force");

  const databaseUrl = resolveConfig("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not configured — set the DATABASE_URL environment variable before running `seed-fake-data.ts`.",
    );
  }

  const db = createDb(databaseUrl);
  try {
    const result = await seedFakeData(db, { force });
    console.log(`Seeded ${result.repoCount} fake repos.`);
  } finally {
    await db.$client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
