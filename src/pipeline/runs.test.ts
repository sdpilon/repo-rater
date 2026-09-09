import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { runs } from "../db/schema";
import {
  getLatestRun,
  makeRunId,
  recordRunFinish,
  recordRunStart,
} from "./runs";
import { createTestDb } from "./test-helpers/pglite-db";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

describe("makeRunId", () => {
  it("produces a run_-prefixed id from the given timestamp", () => {
    const runId = makeRunId(new Date("2026-07-23T00:00:00.000Z"));
    expect(runId).toBe("run_2026-07-23T00-00-00-000Z");
  });

  it("defaults to the current time when no timestamp is given", () => {
    const runId = makeRunId();
    expect(runId).toMatch(/^run_/);
  });
});

describe("recordRunStart / recordRunFinish", () => {
  it("inserts a partial run row, then updates it to its final status and counts", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    const runId = "run_test_1";
    await recordRunStart(db, runId, new Date("2026-07-23T00:00:00.000Z"), 5);

    const afterStart = await db
      .select()
      .from(runs)
      .where(eq(runs.runId, runId));
    expect(afterStart).toHaveLength(1);
    expect(afterStart[0].status).toBe("partial");
    expect(afterStart[0].reposDiscovered).toBe(5);
    expect(afterStart[0].reposFetchedOk).toBe(0);
    expect(afterStart[0].finishedAt).toBeNull();

    await recordRunFinish(db, runId, new Date("2026-07-23T00:05:00.000Z"), {
      status: "success",
      reposFetchedOk: 4,
      reposFailed: 1,
      llmCallsMade: 3,
      llmCallsSkipped: 2,
    });

    const afterFinish = await db
      .select()
      .from(runs)
      .where(eq(runs.runId, runId));
    expect(afterFinish).toHaveLength(1);
    expect(afterFinish[0].status).toBe("success");
    expect(afterFinish[0].reposFetchedOk).toBe(4);
    expect(afterFinish[0].reposFailed).toBe(1);
    expect(afterFinish[0].llmCallsMade).toBe(3);
    expect(afterFinish[0].llmCallsSkipped).toBe(2);
    expect(afterFinish[0].finishedAt?.toISOString()).toBe(
      "2026-07-23T00:05:00.000Z",
    );
  });
});

describe("getLatestRun", () => {
  it("returns undefined when no runs exist", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    expect(await getLatestRun(db)).toBeUndefined();
  });

  it("returns the row with the most recent startedAt", async () => {
    const { db, close } = await createTestDb();
    cleanup = close;

    await recordRunStart(
      db,
      "run_older",
      new Date("2026-07-23T00:00:00.000Z"),
      1,
    );
    await recordRunStart(
      db,
      "run_newer",
      new Date("2026-07-23T01:00:00.000Z"),
      2,
    );

    const latest = await getLatestRun(db);
    expect(latest?.runId).toBe("run_newer");
  });
});
