"use strict";

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
