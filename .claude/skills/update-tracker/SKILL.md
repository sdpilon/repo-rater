---
name: update-tracker
description: Refresh the GitHub project tracker — pull latest repo activity, rewrite the AI assessment for each repo, and re-inject into tracker.html. Use when the user asks to update, refresh, or regenerate the tracker.
disable-model-invocation: true
---

Refresh `tracker.html` with current repo activity and assessments.

$ARGUMENTS may name repos to add or remove from the `repos=` list in `fetch.sh` — apply those edits first. Otherwise, ask whether the repo list is still current before proceeding (it changes often).

1. Run `./fetch.sh`. This overwrites `repos.json` with fresh data (readme, issues, prs, commits, meta) for each repo since the `SINCE` date in the script — bump `SINCE` if the window should move forward.
2. For each repo in the new `repos.json`, read its `readme` against its `commits`/`prs`/`issues` and write (or update) its entry in the `const ASSESS = {...}` block in `tracker.html`:
   - `pct`: 0-100 estimated completion against the README's stated goals, or `null` if there's no stated goal to measure against (e.g. no README, or a living-config repo with no endpoint).
   - `band`: `"good"` (pct >= 80 or clearly on track), `"warn"` (40-79 or a real gap), `"crit"` (< 40), `"none"` (archived/no assessment possible).
   - `label`: a short (2-5 word) status phrase.
   - `text`: 2-5 sentences, evidence-based — cite specific commits, PRs, README claims. Match the tone of existing entries: direct, concrete, no filler.
   - `gaps`: array of short actionable gap strings, or `[]` if none.
   Preserve existing entries for repos not in this run's list only if they're archived/historical context worth keeping — otherwise drop entries for repos no longer in `fetch.sh`'s list.
3. Run `node inject.js` to splice the refreshed `repos.json` into `tracker.html`.
4. Report per-repo what changed (pct movement, new gaps closed/opened, label changes) — not a full re-dump of every entry.
