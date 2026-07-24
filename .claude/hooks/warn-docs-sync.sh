#!/bin/bash
# PreToolUse hook on the Bash tool: warns (does not block) when committing
# a change to one of CLAUDE.md/ARCHITECTURE.md/ROADMAP.md without the other
# two also staged. These three files describe the same pipeline-redesign
# status and drift when only one gets updated — see CLAUDE.md's "Keeping
# docs in sync" section.
set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

if ! echo "$command" | grep -qE '\bgit[[:space:]]+commit\b'; then
  echo '{}'
  exit 0
fi

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$repo_root" ]; then
  echo '{}'
  exit 0
fi

docs=(CLAUDE.md ARCHITECTURE.md ROADMAP.md)
staged=$(git -C "$repo_root" diff --cached --name-only 2>/dev/null || true)

staged_docs=()
missing_docs=()
for doc in "${docs[@]}"; do
  if echo "$staged" | grep -qx "$doc"; then
    staged_docs+=("$doc")
  else
    missing_docs+=("$doc")
  fi
done

count=${#staged_docs[@]}
if [ "$count" -eq 0 ] || [ "$count" -eq 3 ]; then
  echo '{}'
  exit 0
fi

msg="Committing changes to ${staged_docs[*]} without ${missing_docs[*]}. These three files describe the same pipeline redesign status and are meant to stay in sync (see CLAUDE.md's 'Keeping docs in sync') — check whether the others need updating too."
jq -n --arg msg "$msg" '{
  "systemMessage": $msg,
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": $msg
  }
}'
