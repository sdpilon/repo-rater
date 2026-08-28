# Roadmap

This is what's genuinely still missing or planned, kept short and current
rather than speculative. If something isn't listed here, treat it as
working as described in `README.md`.

## Known gaps

- **No packaged Docker image.** Self-hosting today means running the Node
  process directly (`pnpm dev` / `pnpm build && pnpm start`), a systemd
  unit, or your own container — not a `docker compose up` on this repo yet.
- **No in-UI pipeline trigger.** Refreshing data means running `pnpm run
  pipeline` yourself (see README's "Keeping data fresh"); there's no button
  in the dashboard to kick off a run.
- **A fresh database needs a manual migration step, but only when
  `DATABASE_URL` is set via environment variable.** Pasting it into the
  in-app credentials screen applies the schema automatically as part of
  saving; setting it as an environment variable skips that screen entirely,
  so `drizzle-kit migrate` still has to be run once by hand first (see
  README's Quick start).

## Explicitly not planned

GraphQL batching of GitHub API calls, request concurrency/backoff tuning,
and multi-tenant/multi-user support. None of these solve a problem that
exists at this project's scale (a few dozen to a couple hundred repos, one
account per instance) — they'd be complexity for the sake of looking
scalable.
