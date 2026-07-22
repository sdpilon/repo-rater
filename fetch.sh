#!/bin/bash
cd "$(dirname "$0")"
SINCE="2026-06-20T00:00:00Z"
repos="sdpilon/audashio sdpilon/homebrew-rogueamoeba sdpilon/typst-resume sdpilon/typst-template sdpilon/home-server sdpilon/spilon.dev sdpilon/astro-sienna sdpilon/skill-spotlight-scan sdpilon/audashio-2a113e85"

valid() { echo "$1" | jq -e . >/dev/null 2>&1 && echo "$1" || echo "$2"; }

rm -f parts_*.json
i=0
for r in $repos; do
  i=$((i+1))
  readme=$(gh api "repos/$r/readme" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null)
  issues=$(gh api "repos/$r/issues?state=all&since=$SINCE&per_page=100" --jq '[.[] | select(.pull_request == null) | {number, title, state, created_at, closed_at, labels: [.labels[].name]}]' 2>/dev/null)
  issues=$(valid "$issues" "[]")
  prs=$(gh api "repos/$r/pulls?state=all&per_page=50&sort=updated&direction=desc" --jq "[.[] | select(.created_at >= \"$SINCE\" or (.merged_at != null and .merged_at >= \"$SINCE\")) | {number, title, state, created_at, merged_at}]" 2>/dev/null)
  prs=$(valid "$prs" "[]")
  commits=$(gh api "repos/$r/commits?since=$SINCE&per_page=100" --jq '[.[] | {sha: .sha[0:7], date: .commit.author.date, message: (.commit.message | split("\n")[0]), author: .commit.author.name}]' 2>/dev/null)
  commits=$(valid "$commits" "[]")
  meta=$(gh api "repos/$r" --jq '{private, description, html_url, default_branch, stargazers_count, language}' 2>/dev/null)
  meta=$(valid "$meta" "{}")
  jq -n --arg name "$r" --arg readme "$readme" \
    --argjson issues "$issues" --argjson prs "$prs" --argjson commits "$commits" --argjson meta "$meta" \
    '{name: $name, meta: $meta, readme: $readme, issues: $issues, prs: $prs, commits: $commits}' > "parts_$(printf '%02d' $i).json" || echo "FAILED: $r" >&2
done
jq -s '.' parts_*.json > repos.json
jq '[.[] | {name, private: .meta.private, readme_len: (.readme|length), issues: (.issues|length), prs: (.prs|length), commits: (.commits|length)}]' repos.json
