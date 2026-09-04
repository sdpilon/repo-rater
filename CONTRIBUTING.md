# Contributing

This started, and still mostly runs, as a personal tool — see the README's "AI disclosure" section for how it's actually been built and reviewed so far. It's public and genuinely open to real bug reports and feature ideas, but don't expect a large, actively-maintained OSS project's pace or process.

## Before opening a PR

For anything more than a trivial fix, open an issue first (a bug report or feature request — templates are provided) so the change gets discussed before you spend time on it. Small, obvious fixes can just go straight to a PR.

## Making a change

1. Fork the repo and create a branch off `main`.
2. Set up a local dev environment per the README's "Development" section.
3. Before opening a PR, run `pnpm tidy` (applies Biome's lint/format autofixes), then `pnpm check` (typecheck, lint, format check, test — the same gate CI runs).
4. Open a PR against `main` — the PR template will walk you through what to include.

`main` is branch-protected: a PR with passing CI is required, and merges are up to the maintainer. There's no separate CLA or contributor agreement — contributions are accepted under the repo's [MIT license](./LICENSE).

## Working with fake data

`pnpm run seed:fake` (see the README's "Seeding fake data") populates a fresh database with a small fake GitHub account (a handful of repos spanning good/warn/crit assessments, one unassessed, one auto-ignored fork, one private repo) — it's how the screenshot/demo data in the README is generated. A throwaway local Postgres works well for this, no real credentials needed:

```bash
docker run -d --name repo-rater-demo-db -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine

export DATABASE_URL="postgres://postgres:postgres@localhost:55432/postgres"
pnpm exec drizzle-kit migrate   # apply schema, one-time per database
pnpm run seed:fake

pnpm dev   # open http://localhost:3000 — no GitHub token or Anthropic key required
```

Drop the container when done: `docker rm -f repo-rater-demo-db`.

To regenerate `.github/assets/dashboard.png` from a UI change, with the dev server above still running:

```bash
npx playwright install chromium   # one-time, downloads Playwright's managed browser
pnpm run screenshot
```
