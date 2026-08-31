## What kind of change is this?
- [ ] Feature / behavior change
- [ ] Bug fix
- [ ] Docs only
- [ ] Config / dependency / CI only
- [ ] Refactor, no behavior change

## What problem does this solve?
<!-- Not what the diff does — what breaks, stays wrong, or stays annoying without it? -->

## What did you consider and reject?
<!-- If nothing, say "nothing else considered" — don't leave blank -->

## Related issue(s)
<!-- e.g. Fixes #123 -->

## Blast radius
<!-- If this breaks in prod, what actually breaks? The dashboard, the pipeline's
     next run, or something else? -->

## Verification
- [ ] `pnpm typecheck && pnpm lint && pnpm test` passes
- [ ] Data pipeline: unchanged, or verified live against real GitHub data, not just unit tests
- [ ] Database schema: unchanged, or migration written and run against a real Postgres instance, not just typechecked
- [ ] Rendered UI: unchanged, or loaded in a browser and clicked the golden path — describe what you checked
- [ ] Documented behavior: unchanged, or README/architecture docs updated in this PR
