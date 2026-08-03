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
about the current stack: the SolidStart dashboard in `app/`, deployed live
on Vercel, with a scheduled GitHub Actions pipeline keeping its Postgres
data fresh.

## Now

Nothing currently queued — see Next for what's up.

## Next

- **`PIPELINE_GH_TOKEN`'s expiration.** It's a fine-grained GitHub PAT
  (Contents/Issues/Pull requests: Read-only, account-wide) — fine-grained
  PATs have a mandatory expiration date. Whenever `pipeline.yml`'s
  scheduled run starts failing with an auth error, this is the first thing
  to check and rotate.

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
