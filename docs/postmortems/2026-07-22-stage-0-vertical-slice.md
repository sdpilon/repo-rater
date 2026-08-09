# Postmortem: Stage 0 vertical slice

Branch: `stage-0-vertical-slice` (merged to `main` 2026-07-22).
Plan: [`docs/retired/2026-07-22-stage-0-vertical-slice.md`](../retired/2026-07-22-stage-0-vertical-slice.md).

Six tasks landed clean (all approved by independent review, whole-branch
review said ready-to-merge with no Critical/Important issues). This isn't a
"what went wrong" writeup in the sense of failure — it's a look at every
place real time got lost or a real bug slipped through a gate, with the
question: **which of these can be caught automatically next time, instead of
by luck or a human noticing?**

Each incident below has a root cause and a proposed fix, graded by how
mechanically enforceable the fix actually is.

---

## 1. Corrupted `pnpm-lock.yaml` (Task 1, Critical)

**What happened:** `pnpm init` auto-added a `devEngines.packageManager`
block to `package.json`. That triggered pnpm's package-manager
self-management feature, which wrote `pnpm-lock.yaml` as two concatenated
YAML documents (two `lockfileVersion:` keys). Caught by task review, not by
any tooling.

**Root cause:** an environment default, not a code decision — nothing in
the plan asked for `devEngines`.

**Proposed fix:** a fast **doctor script** (see #4 below) that asserts
`pnpm-lock.yaml` has exactly one `lockfileVersion:` line. Mechanical,
5-second check, would have caught this the moment it happened instead of
during review.

**Enforceability: high.** This is a one-line grep.

---

## 2. Controller forgot to commit a fix before handing off — **twice**

**What happened:**
- Task 1: fixed the lockfile corruption in the working tree, moved on to
  re-dispatching the reviewer without committing. The reviewer correctly
  refused to approve based on a diff that didn't contain what it was told
  it would contain — caught by "verify the diff, not the description," but
  cost a full extra review round.
- Later: added Task 7 to the plan file, again didn't commit before moving
  on to the live verification step. Caught by `git status --short` before
  running Step 7, this time by the controller's own habit rather than by a
  reviewer.

**Root cause:** no check ever ran between "I edited a file" and "I handed
this off to something else that trusts the file is committed."

**Proposed fix:** a **PreToolUse hook** on subagent dispatch (the `Agent`
tool) that shell-execs `git status --porcelain` in the repo root and
surfaces a warning (or blocks) if the tree is dirty. This is the single
highest-value fix on this list — it happened twice, and both times cost a
full round-trip that a one-line check would have caught instantly.

**Enforceability: high, but a real design choice.** A hard block could be
annoying if a dispatch legitimately doesn't depend on working-tree state
(e.g. a research/Explore dispatch). Scoping it to Agent dispatches whose
description/prompt mentions "review" would narrow it to exactly this
failure mode.

---

## 3. Environment friction: DuckDB build, pnpm build-approval, sandboxed network

**What happened:** three separate multi-minute detours: DuckDB compiling
from C++ source (~19 min, no prebuilt binary for this Node version), pnpm
silently ignoring `duckdb`'s native build script until explicitly
allow-listed, and `gh api` calls failing with a *TLS certificate error*
that looked exactly like an auth failure but was actually the sandbox
blocking network egress by default.

**Root cause:** each of these is a real, one-time environment fact — not a
bug — but each was rediscovered by trial and error rather than diagnosed
in one step. The TLS-vs-auth confusion specifically cost a full "please
re-authenticate" round-trip that turned out to be unnecessary.

**Proposed fix:** same **doctor script** (#4) checks all of these up front:
DuckDB binding loads, `pnpm-lock.yaml` is valid, `gh api user` actually
succeeds (not just `gh auth status`, which doesn't catch network-layer
failures), and `pnpm test` discovers the expected number of test files.

**Enforceability: high.** These are all fast, mechanical checks — the
value is having them in one place instead of re-deriving the diagnosis
under time pressure.

---

## 4. `package.json`'s own `test` script was broken from Task 1 to Task 5

**What happened:** `node --test pipeline/` (the script Task 1 wrote)
never actually discovered test files on this Node version — it silently
tried to `require("pipeline")` as a module and errored. Every task from 1
through 5 verified tests by running `node --test pipeline/<file>.test.js`
directly, so nobody ran the actual `pnpm test` entry point until it came up
by accident while compiling a summary.

**Root cause:** the plan and every task brief specified per-file test
commands for TDD (correctly, for focused iteration) but never called for
running the *aggregate* script end-to-end until this happened to come up.

**Proposed fix:** fold into the same doctor script — `pnpm test` should be
part of the routine "is everything wired correctly" check, not just
per-file commands during active development. This is the same root
category as #1 and #3: a fast, mechanical check that was simply never run.

**Enforceability: high** as part of the doctor script; **medium** as a
standing habit otherwise (habits erode, scripts don't).

### Proposal: `scripts/doctor.sh` (or `pnpm run doctor`)

Bundling #1, #3, and #4 above into one script:

```bash
#!/bin/bash
set -e
echo "== pnpm-lock.yaml is a single valid document =="
[ "$(grep -c '^lockfileVersion' pnpm-lock.yaml)" = "1" ] || { echo "FAIL: corrupted lockfile"; exit 1; }

echo "== duckdb native binding loads =="
node -e "require('duckdb')" || { echo "FAIL: duckdb binding not built"; exit 1; }

echo "== gh CLI can actually reach the network (not just gh auth status) =="
gh api user >/dev/null || { echo "FAIL: gh api unreachable — check sandbox/network, not just auth"; exit 1; }

echo "== pnpm test actually discovers all suites =="
pnpm test 2>&1 | tail -5

echo "All checks passed."
```

A 10-second script that would have shortcut every piece of environment
friction hit on this branch.

---

## 5. The most severe bug was only found by a live end-to-end run, not unit tests

**What happened:** Task 6's orchestrator fed the Task 5 content-hash gate
data from the *current run's* incremental bronze delta instead of the
repo's full accumulated history in DuckDB — silently defeating the entire
point of the hash gate (the gate always saw "something changed" and
re-triggered every run). All 28 unit tests passed. It was only caught
because the plan explicitly required running the orchestrator twice
against real GitHub data and checking the second run's LLM-call count.

**Root cause:** this isn't really a failure — it's the plan working
exactly as designed. It's included here because it's worth stating
explicitly as a **pattern to keep, not a gap to close**: unit tests of
individual modules, even at 100% pass, cannot catch a bug in how two
already-correct modules are wired together across a data-shape boundary
(bronze delta vs. silver full-state).

**Proposed fix:** not a hook — a **standing rule for future plans on this
project**: any task that orchestrates previously-independent, already-
approved modules together must include a live/manual end-to-end
verification step, not just unit tests of the pieces. Worth writing into
`CLAUDE.md` so it's not tribal knowledge.

**Enforceability: process, not mechanical.** This requires judgment when
writing a plan, not a script. Best lever available: making the rule
explicit and checked-in so it's not forgotten under time pressure.

---

## 6. Documentation staleness (the reason this postmortem exists)

**What happened:** `ARCHITECTURE.md`'s "Status" section and `CLAUDE.md`'s
"Future direction" section both said "design only, nothing implemented"
throughout the entire branch, and would have merged that way if the user
hadn't asked about it mid-session. Separately, a *leftover, never-merged*
worktree (`documentation-consistency-b04c3b`) had an uncommitted `CLAUDE.md`
edit claiming "no build/test tooling" — already false the moment Task 1
added `package.json`.

**Root cause:** no step in the plan or the finishing-a-branch workflow ever
asked "do the docs still describe reality?" It was added post-hoc, as
Task 7, only because it was raised explicitly.

**Proposed fix:** a short, permanent instruction in `CLAUDE.md` itself —
not a private memory note, since a checked-in instruction helps *any*
session or contributor, not just one with access to this session's memory:

> Before finishing any `pipeline/`-related branch, check whether
> `ARCHITECTURE.md`'s "Status" section and this file's "Future direction"
> section still accurately describe what's implemented vs. not. Update
> them in the same branch if not.

**Enforceability: high as a checked-in instruction, not as a hook.**
Nothing about "does this text still describe reality" is mechanically
checkable — it requires reading and judgment — but writing the reminder
into the file everyone (and every session) reads first is the closest
thing to enforcement available.

---

## Summary table

| # | Issue | Fix type | Enforceability |
|---|---|---|---|
| 1 | Corrupted lockfile | doctor script check | High |
| 2 | Forgot to commit before handoff (2x) | PreToolUse hook on Agent dispatch | High (but a real UX tradeoff) |
| 3 | DuckDB/pnpm/network friction | doctor script | High |
| 4 | Broken `test` script unnoticed for 5 tasks | doctor script | High |
| 5 | Hash-gate bug only caught live | standing plan-writing rule (`CLAUDE.md`) | Process, not mechanical |
| 6 | Docs went stale | `CLAUDE.md` instruction | Process, not mechanical |

Four of six are one script away from being caught in seconds instead of
minutes-to-review-rounds. The other two are judgment calls that are best
served by writing the rule down where it'll actually be read, not by
inventing a mechanism to force it.
