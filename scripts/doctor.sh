#!/bin/bash
# Fast environment sanity check for the pipeline/ stack.
# Run this before trusting a fresh checkout or a fresh `pnpm install` —
# see docs/postmortems/2026-07-22-stage-0-vertical-slice.md for what each
# check would have caught, and when it actually did.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

echo "== pnpm-lock.yaml is a single valid document =="
if [ -f pnpm-lock.yaml ]; then
  count=$(grep -c '^lockfileVersion' pnpm-lock.yaml)
  if [ "$count" = "1" ]; then
    echo "OK"
  else
    echo "FAIL: pnpm-lock.yaml has $count lockfileVersion lines (expected 1) — likely corrupted by an auto-inserted devEngines block. Remove any \"devEngines\" key from package.json, delete pnpm-lock.yaml, and run pnpm install again."
    fail=1
  fi
else
  echo "SKIP: no pnpm-lock.yaml yet"
fi

echo
echo "== duckdb native binding loads =="
if node -e "require('duckdb')" 2>/dev/null; then
  echo "OK"
else
  echo "FAIL: duckdb binding not built or not installed. If this is a fresh install, pnpm likely blocked duckdb's native build script — check pnpm-workspace.yaml has 'allowBuilds: { duckdb: true }', then run pnpm install. This can take ~15-20 minutes if no prebuilt binary exists for your Node version."
  fail=1
fi

echo
echo "== gh CLI can actually reach the network (not just gh auth status) =="
if gh api user >/dev/null 2>&1; then
  echo "OK"
else
  echo "FAIL: gh api unreachable. This can look identical to an auth failure (gh auth status may even report a valid token) but actually be a network/sandbox restriction — check that api.github.com is reachable before assuming re-authentication is needed."
  fail=1
fi

echo
echo "== pnpm test actually discovers all suites =="
test_file_count=$(find pipeline -name '*.test.js' 2>/dev/null | wc -l | tr -d ' ')
if [ "$test_file_count" = "0" ]; then
  echo "SKIP: no pipeline/*.test.js files yet"
else
  # Capture the exit code of `pnpm test` itself, not of a downstream pipe
  # stage (piping through sed for ANSI-stripping would otherwise report
  # sed's exit code instead).
  test_raw=$(CI=true pnpm test 2>&1)
  test_exit=$?
  test_output=$(echo "$test_raw" | sed 's/\x1b\[[0-9;]*m//g')
  ran_count=$(echo "$test_output" | grep -m1 'tests [0-9]*$' | grep -o '[0-9]*$' || echo "0")
  # Check the exit code, not just the reported count: a module-load crash
  # (e.g. `node --test pipeline/` with a trailing slash trying to require
  # "pipeline" as a module) reports as "1 test" failing, not "0 tests" —
  # a pure count check misses it. The exit code doesn't.
  if [ "$test_exit" != "0" ] || [ "$ran_count" -lt "$test_file_count" ]; then
    echo "FAIL: pnpm test exited $test_exit and reported $ran_count test(s) run against $test_file_count test file(s) under pipeline/ — the test script likely isn't discovering files correctly (check package.json's \"test\" script uses a glob like \"pipeline/**/*.test.js\", not a bare directory path)."
    echo "$test_output" | tail -20
    fail=1
  else
    echo "OK ($ran_count tests ran across $test_file_count file(s))"
  fi
fi

echo
echo "== ANTHROPIC_API_KEY is set =="
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "OK"
else
  echo "FAIL: ANTHROPIC_API_KEY is not set. pipeline/run.js constructs an Anthropic client with new Anthropic(), which resolves credentials from this env var (or an \`ant auth login\` profile) automatically — set it before running \`pnpm pipeline\` for real."
  fail=1
fi

echo
if [ "$fail" = "1" ]; then
  echo "One or more checks failed — see above."
  exit 1
else
  echo "All checks passed."
fi
