#!/usr/bin/env bash
set -euo pipefail

# Requires PREVIEW_URL and BYPASS_SECRET in the environment (see
# .github/workflows/preview-smoke-test.yml).

echo "Checking $PREVIEW_URL"

status="000"
attempt=0
max_attempts=5
while [ "$attempt" -lt "$max_attempts" ]; do
  attempt=$((attempt + 1))
  # The `if !` form (rather than `cmd || fallback`) keeps this safe under
  # `set -e` without letting curl's own -w output on a transport failure
  # (which still prints "000") concatenate with a separate fallback value.
  if ! status=$(curl -sS -o /tmp/body.html -w '%{http_code}' \
    -H "x-vercel-protection-bypass: $BYPASS_SECRET" \
    "$PREVIEW_URL"); then
    status="000"
  fi
  if [ "$status" = "200" ]; then
    break
  fi
  echo "Attempt $attempt/$max_attempts: got HTTP $status, retrying in 3s..."
  sleep 3
done

echo "Final HTTP status: $status"
if [ "$status" != "200" ]; then
  echo "::error::Preview deploy returned HTTP $status after $max_attempts attempts"
  exit 1
fi

if grep -q "Something went wrong" /tmp/body.html; then
  echo "::error::Preview deploy rendered the error boundary fallback (\"Something went wrong\")"
  exit 1
fi

echo "Preview deploy looks healthy"
