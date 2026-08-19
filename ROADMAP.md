# Roadmap

This is a personal-use, single-repo learning project — one owner (you), no team,
no hard deadlines. Kept in Now/Next/Later form deliberately: it says what's
true and what's next without pretending to have dates or capacity numbers
that don't exist for a solo side project. See `ARCHITECTURE.md` for the full
design rationale and build history behind each item; this file is just the
sequencing.

The project's original DuckDB-backed pipeline (`pipeline/`, `tracker.html`)
has been fully retired — see `ARCHITECTURE.md`'s "Original design (retired)"
section and its "Status" section's Phase 4 write-up. Everything below is
about the current stack: the SolidStart dashboard at the repo root,
deployed live on Vercel, with a scheduled GitHub Actions pipeline keeping
its Postgres data fresh.

## Now

- **Self-hostable / bring-your-own-credentials.** Tracked live as a `bd`
  epic (`tracker-jm8`) rather than duplicated here — run `bd show
  tracker-jm8` for current status. Goal: make this a distributable app
  (single-tenant, no OAuth yet), then move the maintainer's own real-data
  usage to a homelab deployment and convert the current Vercel production
  instance into a public zero-auth demo (fake data). Phase 1 (credential
  UI + env-var/config-file resolver) is merged and live; phases 2
  (homelab cutover) and 3 (demo conversion) are next.

## Next

- **Secrets & environment isolation.** Tracked live as a `bd` epic
  (`tracker-6rd`) rather than duplicated here — run `bd show tracker-6rd`
  for current status. Covers `PIPELINE_GH_TOKEN`'s mandatory expiration
  (fine-grained PATs always expire — when `pipeline.yml`'s scheduled run
  starts failing with an auth error, this is the first thing to check),
  centralizing secrets in 1Password, and general prod-grade isolation.

## Later

- Nothing specific queued. If a real pain point shows up while using the
  live dashboard day to day, capture it here rather than speculating about
  future work nobody's asked for.

## Explicitly not planned

Carried over from the retired pipeline's original design rationale (see
`ARCHITECTURE.md`): GraphQL batching of GitHub API calls, request
concurrency/backoff tuning, and multi-tenancy/multi-user support. None of
these solve a problem that exists at ~65 repos / one user; they'd be
complexity for the sake of looking scalable, which isn't the point of this
project.
