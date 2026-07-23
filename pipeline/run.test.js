"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeRunCounts } = require("./run");

test("computeRunCounts counts a whole-repo meta-fetch failure as failed, not silently dropped", () => {
  const extractResults = [
    { fullName: "sdpilon/broken-repo", repoId: null, dataType: "meta", status: "error", error: "repo not found" },
    { fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "meta", status: "ok" },
    { fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "commits", status: "ok" },
  ];
  const counts = computeRunCounts(extractResults);
  assert.equal(counts.reposFetchedOk, 1);
  assert.equal(counts.reposFailed, 1);
  assert.deepEqual([...counts.repoIds], [1]);
});

test("computeRunCounts counts a repo as failed (not ok) when only one of its data types errors", () => {
  const extractResults = [
    { fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "meta", status: "ok" },
    { fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "commits", status: "error", error: "rate limited" },
    { fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "issues", status: "ok" },
  ];
  const counts = computeRunCounts(extractResults);
  assert.equal(counts.reposFetchedOk, 0);
  assert.equal(counts.reposFailed, 1);
});

test("computeRunCounts reports all repos ok when nothing failed", () => {
  const extractResults = [
    { fullName: "sdpilon/spilon.dev", repoId: 1, dataType: "meta", status: "ok" },
    { fullName: "sdpilon/typst-resume", repoId: 2, dataType: "meta", status: "ok" },
  ];
  const counts = computeRunCounts(extractResults);
  assert.equal(counts.reposFetchedOk, 2);
  assert.equal(counts.reposFailed, 0);
});
