"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb, ensureSchema } = require("./db");
const { enrichRepo } = require("./enrich");

function makeStubClient(assessment, { onCall } = {}) {
  return {
    messages: {
      create: async () => {
        if (onCall) onCall();
        return {
          content: [{ type: "text", text: JSON.stringify(assessment) }],
        };
      },
    },
  };
}

const STUB_ASSESSMENT = {
  pct: 62,
  band: "warn",
  label: "Partially on track",
  text: "The README claims a working pipeline, and recent commits show progress, but the fix-bug commit suggests unresolved issues.",
  gaps: ["needs more tests"],
};

test("enrichRepo inserts a new assessment on first run for a repo", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const client = makeStubClient(STUB_ASSESSMENT);
  const result = await enrichRepo({
    client,
    db,
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    runId: "run_1",
    readmeText: "hello",
    commitMessages: ["fix bug"],
    issueTitles: ["Bug"],
    issueStates: ["open"],
    prTitles: [],
    prStates: [],
    now: "2026-07-22T00:00:00.000Z",
  });
  assert.equal(result.called, true);
  const rows = await db.all(
    "SELECT COUNT(*)::INTEGER AS n FROM repo_assessments WHERE repo_id = 1",
  );
  assert.equal(rows[0].n, 1);
  await db.close();
});

test("enrichRepo skips the LLM call when the input hash has not changed since the last assessment", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  let callCount = 0;
  const client = makeStubClient(STUB_ASSESSMENT, {
    onCall: () => {
      callCount += 1;
    },
  });
  const args = {
    client,
    db,
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    readmeText: "hello",
    commitMessages: ["fix bug"],
    issueTitles: ["Bug"],
    issueStates: ["open"],
    prTitles: [],
    prStates: [],
  };
  await enrichRepo({
    ...args,
    runId: "run_1",
    now: "2026-07-22T00:00:00.000Z",
  });
  const second = await enrichRepo({
    ...args,
    runId: "run_2",
    now: "2026-07-23T00:00:00.000Z",
  });
  assert.equal(second.called, false);
  assert.equal(callCount, 1, "client.messages.create should not be called on the dedup path");
  const rows = await db.all(
    "SELECT COUNT(*)::INTEGER AS n FROM repo_assessments WHERE repo_id = 1",
  );
  assert.equal(rows[0].n, 1);
  await db.close();
});

test("enrichRepo inserts a second, distinct assessment row when the input hash changes", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const client = makeStubClient(STUB_ASSESSMENT);
  await enrichRepo({
    client,
    db,
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    runId: "run_1",
    readmeText: "hello",
    commitMessages: ["fix bug"],
    issueTitles: ["Bug"],
    issueStates: ["open"],
    prTitles: [],
    prStates: [],
    now: "2026-07-22T00:00:00.000Z",
  });
  const second = await enrichRepo({
    client,
    db,
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    runId: "run_2",
    readmeText: "hello",
    commitMessages: ["fix bug", "add feature"],
    issueTitles: ["Bug"],
    issueStates: ["open"],
    prTitles: [],
    prStates: [],
    now: "2026-07-23T00:00:00.000Z",
  });
  assert.equal(second.called, true);
  const rows = await db.all(
    "SELECT COUNT(*)::INTEGER AS n FROM repo_assessments WHERE repo_id = 1",
  );
  assert.equal(rows[0].n, 2);
  await db.close();
});

test("enrichRepo round-trips a stub response's fields into the repo_assessments row", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  const client = makeStubClient(STUB_ASSESSMENT);
  await enrichRepo({
    client,
    db,
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    runId: "run_1",
    readmeText: "hello",
    commitMessages: ["fix bug"],
    issueTitles: ["Bug"],
    issueStates: ["open"],
    prTitles: [],
    prStates: [],
    now: "2026-07-22T00:00:00.000Z",
  });
  const rows = await db.all(
    "SELECT pct, band, label, text, gaps FROM repo_assessments WHERE repo_id = 1",
  );
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.pct, STUB_ASSESSMENT.pct);
  assert.equal(row.band, STUB_ASSESSMENT.band);
  assert.equal(row.label, STUB_ASSESSMENT.label);
  assert.equal(row.text, STUB_ASSESSMENT.text);
  assert.deepEqual(row.gaps, STUB_ASSESSMENT.gaps);
  await db.close();
});

test("enrichRepo includes PR titles/states and issue states in the LLM prompt", async () => {
  const db = openDb(":memory:");
  await ensureSchema(db);
  let capturedRequest = null;
  const client = {
    messages: {
      create: async (params) => {
        capturedRequest = params;
        return {
          content: [{ type: "text", text: JSON.stringify(STUB_ASSESSMENT) }],
        };
      },
    },
  };
  await enrichRepo({
    client,
    db,
    repoId: 1,
    fullName: "sdpilon/spilon.dev",
    runId: "run_1",
    readmeText: "hello",
    commitMessages: ["fix bug"],
    issueTitles: ["Authentication Bug", "Documentation"],
    issueStates: ["open", "closed"],
    prTitles: ["Add feature", "Fix typo"],
    prStates: ["merged", "open"],
    now: "2026-07-22T00:00:00.000Z",
  });
  assert(capturedRequest, "client.messages.create should have been called");
  const userMessage = capturedRequest.messages[0];
  assert.equal(userMessage.role, "user");
  const content = userMessage.content;
  // Verify issue titles and states are in the prompt
  assert(content.includes("Authentication Bug (open)"), "prompt should include issue title and state");
  assert(content.includes("Documentation (closed)"), "prompt should include closed issue");
  // Verify PR titles and states are in the prompt
  assert(content.includes("Add feature (merged)"), "prompt should include PR title and state");
  assert(content.includes("Fix typo (open)"), "prompt should include open PR");
  // Verify PR section exists
  assert(content.includes("Pull requests:"), "prompt should include Pull requests section");
  await db.close();
});
