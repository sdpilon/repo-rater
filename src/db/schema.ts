import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Drizzle ORM (Postgres) schema for the pipeline and dashboard.
 *
 * Timestamps: columns use naive (timezone-less) Postgres `timestamp` (no
 * `tz` suffix), a deliberate choice rather than an oversight. If
 * timezone-aware timestamps are wanted later, that's a separate, explicit
 * migration.
 */

export const repos = pgTable("repos", {
  // GitHub numeric repo ids fit within JS's safe-integer range, so we use
  // Drizzle's `mode: 'number'` bigint rather than surfacing bigint/string
  // in application code.
  repoId: bigint("repo_id", { mode: "number" }).primaryKey(),
  fullName: varchar("full_name").notNull(),
  description: varchar("description"),
  htmlUrl: varchar("html_url"),
  defaultBranch: varchar("default_branch"),
  language: varchar("language"),
  stargazersCount: integer("stargazers_count"),
  isPrivate: boolean("is_private"),
  isFork: boolean("is_fork"),
  isArchived: boolean("is_archived"),
  isIgnored: boolean("is_ignored").notNull().default(false),
  // 'auto' | 'manual' — plain text with an app-level union type (see
  // IgnoreSource below) rather than a native Postgres enum.
  ignoreSource: varchar("ignore_source").notNull().default("auto"),
  // Persisted reasons behind an 'auto' ignore decision (e.g. ["no README",
  // "no activity"]), written by `applyIgnoreDefaultForRepo`
  // (pipeline/ignore-rules.ts) at the same time it computes is_ignored. The
  // dashboard reads this directly rather than recomputing it at display
  // time, since README is never persisted for a currently-ignored repo
  // (enrichment, and its input_snapshot, is skipped entirely for ignored
  // repos).
  ignoreReasons: text("ignore_reasons").array(),
  // Mirrors ignoreSource's pattern exactly for the same auto/manual
  // override tracking, but for AI-assessment freshness instead of
  // ignore-state. Plain text for consistency with ignoreSource, not a
  // native enum, for the same reason.
  assessmentSource: varchar("assessment_source").notNull().default("auto"),
  firstSeenAt: timestamp("first_seen_at").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull(),
});

export const repoDiscoveries = pgTable(
  "repo_discoveries",
  {
    runId: varchar("run_id").notNull(),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    seenAt: timestamp("seen_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.repoId] })],
);

export const commits = pgTable(
  "commits",
  {
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    sha: varchar("sha").notNull(),
    authorName: varchar("author_name"),
    authoredAt: timestamp("authored_at"),
    message: varchar("message"),
    firstIngestedRunId: varchar("first_ingested_run_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.sha] })],
);

export const issues = pgTable(
  "issues",
  {
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    number: integer("number").notNull(),
    title: varchar("title"),
    state: varchar("state"),
    createdAt: timestamp("created_at"),
    closedAt: timestamp("closed_at"),
    labels: text("labels").array(),
    lastUpdatedRunId: varchar("last_updated_run_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.number] })],
);

export const pullRequests = pgTable(
  "pull_requests",
  {
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    number: integer("number").notNull(),
    title: varchar("title"),
    state: varchar("state"),
    createdAt: timestamp("created_at"),
    mergedAt: timestamp("merged_at"),
    lastUpdatedRunId: varchar("last_updated_run_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.number] })],
);

export const fetchWatermarks = pgTable(
  "fetch_watermarks",
  {
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    // 'commits' | 'issues' | 'prs'
    dataType: varchar("data_type").notNull(),
    lastFetchedAt: timestamp("last_fetched_at").notNull(),
    lastSuccessRunId: varchar("last_success_run_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.dataType] })],
);

export const fetchFailures = pgTable("fetch_failures", {
  runId: varchar("run_id").notNull(),
  repoId: bigint("repo_id", { mode: "number" }).notNull(),
  dataType: varchar("data_type").notNull(),
  errorMessage: varchar("error_message"),
  occurredAt: timestamp("occurred_at").notNull(),
});

export const repoAssessments = pgTable("repo_assessments", {
  assessmentId: bigserial("assessment_id", { mode: "number" }).primaryKey(),
  repoId: bigint("repo_id", { mode: "number" }).notNull(),
  runId: varchar("run_id").notNull(),
  inputHash: varchar("input_hash").notNull(),
  pct: integer("pct"),
  band: varchar("band"),
  label: varchar("label"),
  text: varchar("text"),
  gaps: text("gaps").array(),
  // Raw snapshot of whatever input was fed to the assessment LLM call, for
  // debuggability — there's no separate raw-data layer to inspect after the
  // fact otherwise.
  inputSnapshot: jsonb("input_snapshot"),
  createdAt: timestamp("created_at").notNull(),
});

export const runs = pgTable("runs", {
  runId: varchar("run_id").primaryKey(),
  startedAt: timestamp("started_at").notNull(),
  finishedAt: timestamp("finished_at"),
  // 'success' | 'partial' | 'failed'
  status: varchar("status"),
  reposDiscovered: integer("repos_discovered"),
  reposFetchedOk: integer("repos_fetched_ok"),
  reposFailed: integer("repos_failed"),
  llmCallsMade: integer("llm_calls_made"),
  llmCallsSkipped: integer("llm_calls_skipped"),
});

// App-level union types for the plain-text "enum-like" columns above
// (kept as text/varchar rather than native Postgres enums — see the
// column comments on `ignoreSource` / `assessmentSource`).
export type IgnoreSource = "auto" | "manual";
export type AssessmentSource = "auto" | "manual";
