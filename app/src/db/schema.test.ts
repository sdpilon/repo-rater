import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  commits,
  fetchFailures,
  fetchWatermarks,
  issues,
  pullRequests,
  repoAssessments,
  repoDiscoveries,
  repos,
  runs,
} from "./schema";

/**
 * Lightweight structural checks that don't need a live DB — Drizzle table
 * objects carry their column/name metadata statically, so this just
 * guards against accidental renames/typos/dropped columns drifting away
 * from the schema this file was translated from (repo-root `schema.sql`).
 */

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.keys(getTableColumns(table));
}

describe("schema table names", () => {
  it("match the old DuckDB schema's table names", () => {
    expect(getTableName(repos)).toBe("repos");
    expect(getTableName(repoDiscoveries)).toBe("repo_discoveries");
    expect(getTableName(commits)).toBe("commits");
    expect(getTableName(issues)).toBe("issues");
    expect(getTableName(pullRequests)).toBe("pull_requests");
    expect(getTableName(fetchWatermarks)).toBe("fetch_watermarks");
    expect(getTableName(fetchFailures)).toBe("fetch_failures");
    expect(getTableName(repoAssessments)).toBe("repo_assessments");
    expect(getTableName(runs)).toBe("runs");
  });
});

describe("repos", () => {
  it("has the expected columns, including the new assessment_source", () => {
    expect(columnNames(repos).sort()).toEqual(
      [
        "repoId",
        "fullName",
        "description",
        "htmlUrl",
        "defaultBranch",
        "language",
        "stargazersCount",
        "isPrivate",
        "isFork",
        "isArchived",
        "isIgnored",
        "ignoreSource",
        "assessmentSource",
        "firstSeenAt",
        "lastSeenAt",
      ].sort(),
    );
  });

  it("gives repoId a number-mode bigint column", () => {
    const columns = getTableColumns(repos);
    expect(columns.repoId.columnType).toBe("PgBigInt53");
    expect(columns.repoId.primary).toBe(true);
  });
});

describe("repoAssessments", () => {
  it("has the expected columns, including the new input_snapshot", () => {
    expect(columnNames(repoAssessments).sort()).toEqual(
      [
        "assessmentId",
        "repoId",
        "runId",
        "inputHash",
        "pct",
        "band",
        "label",
        "text",
        "gaps",
        "inputSnapshot",
        "createdAt",
      ].sort(),
    );
  });

  it("uses a bigserial primary key for assessmentId", () => {
    const columns = getTableColumns(repoAssessments);
    expect(columns.assessmentId.columnType).toBe("PgBigSerial53");
    expect(columns.assessmentId.primary).toBe(true);
  });
});

describe("array columns", () => {
  it("uses Postgres text[] for issues.labels and repoAssessments.gaps", () => {
    const issueColumns = getTableColumns(issues);
    const assessmentColumns = getTableColumns(repoAssessments);
    expect(issueColumns.labels.columnType).toBe("PgArray");
    expect(assessmentColumns.gaps.columnType).toBe("PgArray");
  });
});

describe("composite primary keys", () => {
  it("commits is keyed on (repoId, sha)", () => {
    const columns = getTableColumns(commits);
    expect(columns.repoId.primary).toBeFalsy();
    expect(columns.sha.primary).toBeFalsy();
  });
});
