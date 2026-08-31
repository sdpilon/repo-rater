# Roadmap

This is what's genuinely still missing or planned, kept short and current
rather than speculative. If something isn't listed here, treat it as
working as described in `README.md`.

## Explicitly not planned

GraphQL batching of GitHub API calls, request concurrency/backoff tuning,
and multi-tenant/multi-user support. None of these solve a problem that
exists at this project's scale (a few dozen to a couple hundred repos, one
account per instance) — they'd be complexity for the sake of looking
scalable.
