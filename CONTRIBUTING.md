# Contributing

This started, and still mostly runs, as a personal tool — see the README's "AI disclosure" section for how it's actually been built and reviewed so far. It's public and genuinely open to real bug reports and feature ideas, but don't expect a large, actively-maintained OSS project's pace or process.

## Before opening a PR

For anything more than a trivial fix, open an issue first (a bug report or feature request — templates are provided) so the change gets discussed before you spend time on it. Small, obvious fixes can just go straight to a PR.

## Making a change

1. Fork the repo and create a branch off `main`.
2. Set up a local dev environment per the README's "Development" section.
3. Before opening a PR, run:
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```
4. Open a PR against `main` — the PR template will walk you through what to include.

`main` is branch-protected: a PR with passing CI is required, and merges are up to the maintainer. There's no separate CLA or contributor agreement — contributions are accepted under the repo's [MIT license](./LICENSE).
