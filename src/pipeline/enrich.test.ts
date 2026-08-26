import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { Octokit } from "octokit";
import { afterEach, describe, expect, it } from "vitest";
import {
  commits,
  issues,
  pullRequests,
  repoAssessments,
  repos,
} from "../db/schema";
import type { Assessment } from "./anthropic/client";
import type { DrizzleDb } from "./db-types";
import {
  computeInputHash,
  countUnassessedRepos,
  enrichAll,
  enrichRepo,
  readEnrichInputs,
} from "./enrich";
import { createTestDb } from "./test-helpers/pglite-db";

const fakeOctokit = {} as Octokit;
const fakeClient = {} as Anthropic;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

function stubAssessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    pct: 62,
    band: "warn",
    label: "Partially on track",
    text: "The README claims a working pipeline, and recent commits show progress.",
    gaps: ["needs more tests"],
    ...overrides,
  };
}

async function insertRepo(
  db: DrizzleDb,
  overrides: Partial<typeof repos.$inferInsert> = {},
): Promise<void> {
  await db.insert(repos).values({
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    isFork: false,
    isArchived: false,
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });
}

describe("computeInputHash", () => {
  it("differs when issueStates differs", () => {
    const hash1 = computeInputHash(
      "hello",
      ["fix bug"],
      ["Bug"],
      ["open"],
      [],
      [],
    );
    const hash2 = computeInputHash(
      "hello",
      ["fix bug"],
      ["Bug"],
      ["closed"],
      [],
      [],
    );
    expect(hash1).not.toBe(hash2);
  });

  it("differs when prTitles differs", () => {
    const hash1 = computeInputHash(
      "hello",
      ["fix bug"],
      ["Bug"],
      ["open"],
      [],
      [],
    );
    const hash2 = computeInputHash(
      "hello",
      ["fix bug"],
      ["Bug"],
      ["open"],
      ["Add feature"],
      [],
    );
    expect(hash1).not.toBe(hash2);
  });

  it("differs when prStates differs", () => {
    const hash1 = computeInputHash(
      "hello",
      ["fix bug"],
      ["Bug"],
      ["open"],
      ["Add feature"],
      ["merged"],
    );
    const hash2 = computeInputHash(
      "hello",
      ["fix bug"],
      ["Bug"],
      ["open"],
      ["Add feature"],
      ["open"],
    );
    expect(hash1).not.toBe(hash2);
  });
});

describe("readEnrichInputs", () => {
  it("returns commits/issues/prs ordered deterministically regardless of insertion order", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await db.insert(commits).values([
      {
        repoId: 1,
        sha: "bbb",
        message: "second commit",
        firstIngestedRunId: "run_1",
      },
      {
        repoId: 1,
        sha: "aaa",
        message: "first commit",
        firstIngestedRunId: "run_1",
      },
    ]);
    await db.insert(issues).values([
      {
        repoId: 1,
        number: 2,
        title: "Second issue",
        state: "open",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastUpdatedRunId: "run_1",
      },
      {
        repoId: 1,
        number: 1,
        title: "First issue",
        state: "closed",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastUpdatedRunId: "run_1",
      },
    ]);
    await db.insert(pullRequests).values([
      {
        repoId: 1,
        number: 2,
        title: "Second PR",
        state: "open",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastUpdatedRunId: "run_1",
      },
      {
        repoId: 1,
        number: 1,
        title: "First PR",
        state: "merged",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastUpdatedRunId: "run_1",
      },
    ]);

    const inputs = await readEnrichInputs(db, 1);
    expect(inputs.commitMessages).toEqual(["first commit", "second commit"]);
    expect(inputs.issueTitles).toEqual(["First issue", "Second issue"]);
    expect(inputs.issueStates).toEqual(["closed", "open"]);
    expect(inputs.prTitles).toEqual(["First PR", "Second PR"]);
    expect(inputs.prStates).toEqual(["merged", "open"]);
  });
});

describe("enrichRepo", () => {
  it("inserts a new assessment on first run for a repo", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const result = await enrichRepo({
      client: fakeClient,
      db,
      repoId: 1,
      runId: "run_1",
      fullName: "sdpilon/spilon.dev",
      readmeText: "hello",
      commitMessages: ["fix bug"],
      issueTitles: ["Bug"],
      issueStates: ["open"],
      prTitles: [],
      prStates: [],
      now: new Date("2026-07-22T00:00:00Z"),
      generateAssessment: async () => stubAssessment(),
    });

    expect(result.called).toBe(true);
    const rows = await db
      .select()
      .from(repoAssessments)
      .where(eq(repoAssessments.repoId, 1));
    expect(rows).toHaveLength(1);
    expect(rows[0].pct).toBe(62);
    expect(rows[0].band).toBe("warn");
    expect(rows[0].gaps).toEqual(["needs more tests"]);
    expect(rows[0].inputSnapshot).toMatchObject({
      fullName: "sdpilon/spilon.dev",
    });
  });

  it("skips the LLM call when the input hash is unchanged since the last assessment", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    let callCount = 0;
    const generateAssessment = async () => {
      callCount += 1;
      return stubAssessment();
    };
    const base = {
      client: fakeClient,
      db,
      repoId: 1,
      fullName: "sdpilon/spilon.dev",
      readmeText: "hello",
      commitMessages: ["fix bug"],
      issueTitles: ["Bug"],
      issueStates: ["open"],
      prTitles: [],
      prStates: [],
      generateAssessment,
    };

    await enrichRepo({
      ...base,
      runId: "run_1",
      now: new Date("2026-07-22T00:00:00Z"),
    });
    const second = await enrichRepo({
      ...base,
      runId: "run_2",
      now: new Date("2026-07-23T00:00:00Z"),
    });

    expect(second.called).toBe(false);
    expect(callCount).toBe(1);
    const rows = await db
      .select()
      .from(repoAssessments)
      .where(eq(repoAssessments.repoId, 1));
    expect(rows).toHaveLength(1);
  });

  it("inserts a second distinct row when only issue state changes", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    const base = {
      client: fakeClient,
      db,
      repoId: 1,
      fullName: "sdpilon/spilon.dev",
      readmeText: "hello",
      commitMessages: ["fix bug"],
      issueTitles: ["Bug"],
      prTitles: [],
      prStates: [],
      generateAssessment: async () => stubAssessment(),
    };

    await enrichRepo({
      ...base,
      issueStates: ["open"],
      runId: "run_1",
      now: new Date("2026-07-22T00:00:00Z"),
    });
    const second = await enrichRepo({
      ...base,
      issueStates: ["closed"],
      runId: "run_2",
      now: new Date("2026-07-23T00:00:00Z"),
    });

    expect(second.called).toBe(true);
    const rows = await db
      .select()
      .from(repoAssessments)
      .where(eq(repoAssessments.repoId, 1));
    expect(rows).toHaveLength(2);
  });
});

describe("countUnassessedRepos", () => {
  it("counts repos with no repo_assessments row among the given ids", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await db.insert(repoAssessments).values({
      repoId: 1,
      runId: "run_1",
      inputHash: "abc",
      pct: 50,
      band: "warn",
      label: "x",
      text: "y",
      gaps: [],
      createdAt: new Date("2026-07-22T00:00:00Z"),
    });

    expect(await countUnassessedRepos(db, new Set([1, 2, 3]))).toBe(2);
  });

  it("returns 0 for an empty set", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    expect(await countUnassessedRepos(db, new Set())).toBe(0);
  });
});

describe("enrichAll", () => {
  it("recomputes ignore state, skips ignored repos without calling the LLM, and enriches active repos", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { repoId: 1, fullName: "sdpilon/active-repo" });
    await insertRepo(db, {
      repoId: 2,
      fullName: "sdpilon/fork-repo",
      isFork: true,
    });
    await db.insert(commits).values({
      repoId: 1,
      sha: "aaa",
      message: "fix",
      firstIngestedRunId: "run_1",
    });

    let llmCalls = 0;
    const result = await enrichAll({
      db,
      octokit: fakeOctokit,
      anthropicClient: fakeClient,
      repoIds: new Set([1, 2]),
      runId: "run_1",
      now: new Date("2026-07-22T00:00:00Z"),
      fetchReadme: async () => "# Hello",
      generateAssessment: async () => {
        llmCalls += 1;
        return stubAssessment();
      },
    });

    expect(result.llmCallsMade).toBe(1);
    expect(result.llmCallsSkipped).toBe(1);
    expect(llmCalls).toBe(1);

    const [forkRow] = await db.select().from(repos).where(eq(repos.repoId, 2));
    expect(forkRow.isIgnored).toBe(true);
    expect(forkRow.ignoreSource).toBe("auto");

    const assessments = await db
      .select()
      .from(repoAssessments)
      .where(eq(repoAssessments.repoId, 1));
    expect(assessments).toHaveLength(1);
  });

  it("recomputes ignore state before the skip check, in the same pass", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    // Not currently ignored, but zero activity this run — should become
    // ignored and skip enrichment within the same enrichAll call.
    await insertRepo(db, {
      repoId: 1,
      fullName: "sdpilon/quiet-repo",
      isIgnored: false,
    });

    const result = await enrichAll({
      db,
      octokit: fakeOctokit,
      anthropicClient: fakeClient,
      repoIds: new Set([1]),
      runId: "run_1",
      now: new Date("2026-07-22T00:00:00Z"),
      fetchReadme: async () => "",
      generateAssessment: async () => stubAssessment(),
    });

    expect(result.llmCallsMade).toBe(0);
    expect(result.llmCallsSkipped).toBe(1);
    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.isIgnored).toBe(true);
  });

  it("never recomputes ignore state for a manually-overridden repo, and still fetches README exactly once for enrichment", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, {
      repoId: 1,
      fullName: "sdpilon/manual-repo",
      isIgnored: false,
      ignoreSource: "manual",
    });

    let readmeFetches = 0;
    const result = await enrichAll({
      db,
      octokit: fakeOctokit,
      anthropicClient: fakeClient,
      repoIds: new Set([1]),
      runId: "run_1",
      now: new Date("2026-07-22T00:00:00Z"),
      fetchReadme: async () => {
        readmeFetches += 1;
        return "# Hello";
      },
      generateAssessment: async () => stubAssessment(),
    });

    expect(readmeFetches).toBe(1);
    expect(result.llmCallsMade).toBe(1);
    const [row] = await db.select().from(repos).where(eq(repos.repoId, 1));
    expect(row.ignoreSource).toBe("manual");
  });

  it("skips enrichment for a repo with assessment_source 'manual', without touching repo_assessments", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, {
      repoId: 1,
      fullName: "sdpilon/manual-assessment-repo",
      assessmentSource: "manual",
    });

    let llmCalls = 0;
    const result = await enrichAll({
      db,
      octokit: fakeOctokit,
      anthropicClient: fakeClient,
      repoIds: new Set([1]),
      runId: "run_1",
      now: new Date("2026-07-22T00:00:00Z"),
      fetchReadme: async () => "# Hello",
      generateAssessment: async () => {
        llmCalls += 1;
        return stubAssessment();
      },
    });

    expect(result.llmCallsMade).toBe(0);
    expect(result.llmCallsSkipped).toBe(1);
    expect(llmCalls).toBe(0);
    const assessments = await db
      .select()
      .from(repoAssessments)
      .where(eq(repoAssessments.repoId, 1));
    expect(assessments).toHaveLength(0);
  });

  it("isolates a per-repo enrichment failure as skipped, without blocking the rest of the batch", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;
    await insertRepo(db, { repoId: 1, fullName: "sdpilon/broken-repo" });
    await insertRepo(db, { repoId: 2, fullName: "sdpilon/ok-repo" });
    await db.insert(commits).values([
      { repoId: 1, sha: "aaa", message: "fix", firstIngestedRunId: "run_1" },
      { repoId: 2, sha: "bbb", message: "fix", firstIngestedRunId: "run_1" },
    ]);

    const result = await enrichAll({
      db,
      octokit: fakeOctokit,
      anthropicClient: fakeClient,
      repoIds: new Set([1, 2]),
      runId: "run_1",
      now: new Date("2026-07-22T00:00:00Z"),
      fetchReadme: async () => "# Hello",
      generateAssessment: async (_client, input) => {
        if (input.fullName === "sdpilon/broken-repo") {
          throw new Error("boom");
        }
        return stubAssessment();
      },
    });

    expect(result.llmCallsMade).toBe(1);
    expect(result.llmCallsSkipped).toBe(1);
    const okAssessments = await db
      .select()
      .from(repoAssessments)
      .where(eq(repoAssessments.repoId, 2));
    expect(okAssessments).toHaveLength(1);
    const brokenAssessments = await db
      .select()
      .from(repoAssessments)
      .where(eq(repoAssessments.repoId, 1));
    expect(brokenAssessments).toHaveLength(0);
  });
});
