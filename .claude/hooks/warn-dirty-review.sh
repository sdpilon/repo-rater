#!/bin/bash
# PreToolUse hook on the Agent tool: warns (does not block) when dispatching
# a subagent whose description looks like a review while the git tree has
# uncommitted changes. See
# docs/postmortems/2026-07-22-stage-0-vertical-slice.md item 2 — this exact
# mistake (forgetting to commit before handoff) cost two full review rounds
# on Stage 0.
set -euo pipefail

input=$(cat)
description=$(echo "$input" | jq -r '.tool_input.description // empty')

if ! echo "$description" | grep -qi 'review'; then
  echo '{}'
  exit 0
fi

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$repo_root" ]; then
  echo '{}'
  exit 0
fi

dirty=$(git -C "$repo_root" status --porcelain 2>/dev/null || true)
if [ -z "$dirty" ]; then
  echo '{}'
  exit 0
fi

file_count=$(echo "$dirty" | wc -l | tr -d ' ')
msg="Dispatching a review while git status is dirty ($file_count file(s) uncommitted). If the reviewer is meant to see these changes, commit them first — reviewers only see the committed diff, not the working tree."
jq -n --arg msg "$msg" '{
  "systemMessage": $msg,
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": $msg
  }
}'
