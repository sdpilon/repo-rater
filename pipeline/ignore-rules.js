"use strict";

/**
 * Parameter shape shared by both callers of computeSuggestedIgnore:
 * `load.js`'s `applySuggestedIgnoreDefaults` (count-only `SELECT 1 ... WHERE
 * repo_id = ?` queries, using only the returned `.ignored`) and
 * `publish.js`'s `buildRepoRecord` (full-column queries it needs anyway for
 * `record.commits`/`record.issues`/`record.prs`, using only the returned
 * `.reasons`). The two call sites deliberately run different SQL — one is
 * count-only, the other reuses rows it already fetched — so there's no
 * shared query helper to extract; this typedef documents the one thing
 * that *is* shared: the object shape each site assembles before calling in.
 *
 * @typedef {Object} SuggestedIgnoreInput
 * @property {boolean} isFork
 * @property {boolean} isArchived
 * @property {string} readme
 * @property {number} commitCount
 * @property {number} issueCount
 * @property {number} prCount
 */

/**
 * @param {SuggestedIgnoreInput} params
 * @returns {{ignored: boolean, reasons: string[]}}
 */
function computeSuggestedIgnore({
  isFork,
  isArchived,
  readme,
  commitCount,
  issueCount,
  prCount,
}) {
  const reasons = [];
  if (isFork) reasons.push("fork");
  if (isArchived) reasons.push("archived");
  if (!readme || !readme.trim()) reasons.push("no README");
  if (commitCount + issueCount + prCount === 0) reasons.push("no activity");
  return { ignored: reasons.length > 0, reasons };
}

module.exports = { computeSuggestedIgnore };
