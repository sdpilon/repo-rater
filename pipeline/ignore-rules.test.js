"use strict";
const test = require("node:test");
const { equal, deepEqual } = require("node:assert/strict");
const { computeSuggestedIgnore } = require("./ignore-rules");

function baseInputs(overrides = {}) {
  return {
    isFork: false,
    isArchived: false,
    readme: "# Real project\nSome content.",
    commitCount: 3,
    issueCount: 1,
    prCount: 0,
    ...overrides,
  };
}

test("a repo with a README and activity, not a fork or archived, is not suggested-ignored", () => {
  const result = computeSuggestedIgnore(baseInputs());
  equal(result.ignored, false);
  deepEqual(result.reasons, []);
});

test("a fork is suggested-ignored with reason 'fork'", () => {
  const result = computeSuggestedIgnore(baseInputs({ isFork: true }));
  equal(result.ignored, true);
  deepEqual(result.reasons, ["fork"]);
});

test("an archived repo is suggested-ignored with reason 'archived'", () => {
  const result = computeSuggestedIgnore(baseInputs({ isArchived: true }));
  equal(result.ignored, true);
  deepEqual(result.reasons, ["archived"]);
});

test("a repo with no README is suggested-ignored with reason 'no README'", () => {
  const result = computeSuggestedIgnore(baseInputs({ readme: "" }));
  equal(result.ignored, true);
  deepEqual(result.reasons, ["no README"]);
});

test("a whitespace-only README counts as no README", () => {
  const result = computeSuggestedIgnore(baseInputs({ readme: "   \n  " }));
  equal(result.ignored, true);
  deepEqual(result.reasons, ["no README"]);
});

test("a repo with zero commits, issues, and PRs is suggested-ignored with reason 'no activity'", () => {
  const result = computeSuggestedIgnore(
    baseInputs({ commitCount: 0, issueCount: 0, prCount: 0 }),
  );
  equal(result.ignored, true);
  deepEqual(result.reasons, ["no activity"]);
});

test("multiple matching signals all appear in reasons, in signal order", () => {
  const result = computeSuggestedIgnore(
    baseInputs({ isFork: true, isArchived: true, readme: "" }),
  );
  equal(result.ignored, true);
  deepEqual(result.reasons, ["fork", "archived", "no README"]);
});
