# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, single-file dashboard (`tracker.html`) summarizing recent activity across a hardcoded list of GitHub repos, plus an AI-written "stated goals vs. reality" assessment for each repo.

## Pipeline

1. `./fetch.sh` — pulls readme/issues/prs/commits/meta for each repo in the `repos=` list via `gh api`, writes `parts_NN.json` per repo, then combines them into `repos.json`. Requires `gh` authenticated.
2. `node inject.js` — splices `repos.json` into `tracker.html`'s `const DATA = ...` block.
3. Open `tracker.html` in a browser to view.

The repo list in `fetch.sh` (the `repos=` variable) changes often as projects come and go — check whether it's still current before running a refresh.

## The ASSESS block

`tracker.html` also contains a hand-authored `const ASSESS = {...}` object, one entry per repo (`pct`, `band`, `label`, `text`, `gaps`). This is a qualitative assessment — written by reading each repo's README against its actual commits/PRs/issues — not derived data. It is maintained via the `/update-tracker` skill, not written by hand.

## Gotcha

`inject.js` splices `repos.json` into `tracker.html` using slice-based string splicing, not `String.replace()` — README content can contain `$'`/`$$` sequences that `replace()` would interpret as substitution patterns and corrupt.
