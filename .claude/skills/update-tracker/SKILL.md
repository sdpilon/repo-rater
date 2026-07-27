---
name: update-tracker
description: Refresh the GitHub project tracker — pull latest repo activity, rewrite the AI assessment for each repo, and re-inject into tracker.html. Use when the user asks to update, refresh, or regenerate the tracker.
disable-model-invocation: true
---

Refresh `tracker.html` with current repo activity and assessments.

$ARGUMENTS names which repos (by `owner/name`) to write or update `ASSESS`
entries for in this run. Discovery covers the whole GitHub account
automatically now — there's no repo list to edit — so if $ARGUMENTS is
empty, ask the user which repos to assess rather than silently attempting
all ~65.

1. Run `node pipeline/run.js` (add `--limit N` for a quick pass against only
   the first N discovered repos). This re-discovers the account, fetches
   fresh data (readme, issues, prs, commits, meta) per repo, and already
   writes both `repos.json` and `tracker.html`'s `DATA` block itself — no
   separate `inject.js` call needed for this step.
2. For each repo named in $ARGUMENTS, find its entry in the refreshed
   `repos.json` and read its `readme` against its `commits`/`prs`/`issues`
   to write (or update) its entry in the `const ASSESS = {...}` block in
   `tracker.html`:
   - `pct`: 0-100 estimated completion against the README's stated goals, or `null` if there's no stated goal to measure against (e.g. no README, or a living-config repo with no endpoint).
   - `band`: `"good"` (pct >= 80 or clearly on track), `"warn"` (40-79 or a real gap), `"crit"` (< 40), `"none"` (archived/no assessment possible).
   - `label`: a short (2-5 word) status phrase.
   - `text`: 2-5 sentences, evidence-based — cite specific commits, PRs, README claims. Match the tone of existing entries: direct, concrete, no filler.
   - `gaps`: array of short actionable gap strings, or `[]` if none.
   This is a direct text edit to `tracker.html`'s `ASSESS` block — `inject.js`
   never touches it, so no re-injection step is needed afterward. Leave
   entries for repos not named in $ARGUMENTS untouched.
3. Report per-repo what changed (pct movement, new gaps closed/opened, label changes) — not a full re-dump of every entry.
