# Self-host config: progressive credential resolution & storage — design

Status: approved
Date: 2026-08-16

## Context

`tracker-jm8` ("Make self-hostable") aims to let other people run their own
instance of this dashboard, tracking their own GitHub account, without
asking the maintainer questions. That epic decomposes into three sequential
phases, each its own spec → plan → build cycle:

1. **This spec** — self-host config & auth rework: an interactive credential
   UI, env-var/config-file hybrid storage, no-auth-by-default mode.
2. Homelab deployment — standing up the user's real data on their homelab
   once phase 1 works, retiring personal reliance on the Vercel instance.
3. Demo site conversion — swap the now-freed Vercel production instance to
   fake data, drop the password, link it from a resume.

Phases 2 and 3 are out of scope here. Production
(`github-project-tracker-chi.vercel.app`) is not touched by this phase at
all — it keeps running exactly as it does today (env-var secrets,
`APP_PASSWORD` gate, real personal data) until phase 2 proves the homelab
deployment works. This phase is built and verified independently first.

Today, every secret is already read from `process.env` directly (no
literal hardcoded credentials in code) — but two things block self-hosting:
`package.json`'s `dev`/`start` scripts hardcode a personal 1Password
Environment ID, and `src/lib/server-db.ts` creates the Postgres client at
module load time via `requireEnv("DATABASE_URL")`, hard-throwing and
crashing the entire server if it's unset. `dashboard.ts` is the only
consumer of that module.

## Decisions

- **All three pipeline-facing credentials are optional and independently
  settable**: DB connection string, GitHub PAT, Anthropic API key. The
  target experience is "minimal server running" → "add credentials one at a
  time" → "everything works" — not a single blocking wizard collecting all
  three up front.
- **Storage is a hybrid**: for each credential, check the environment
  variable first; if unset, fall back to a local JSON config file; if
  neither is present, the app treats it as unconfigured. A self-hoster who
  prefers Docker Compose `env_file`/k8s secrets never needs to touch the UI;
  one who wants pure UI-driven setup never needs to touch env vars. Values
  entered via the UI are written to the config file, never to env vars.
- **GitHub auth is PAT-paste only for this phase.** "Sign in with GitHub"
  (OAuth) would need a registered OAuth App with a callback URL matching
  wherever the instance runs — that only really makes sense again once
  there's a reason to run this as a shared, fully-hosted multi-tenant
  service, which isn't this phase's model (single-tenant, one instance per
  deployer). OAuth is deferred indefinitely, not scheduled.
- **`APP_PASSWORD` stays optional and off the progressive credentials
  form.** It resolves through the same env-var/config-file hybrid as the
  other three, but isn't a UI field — it's advanced/rare (relevant mainly
  when an instance isn't already behind something like Tailscale), so
  surfacing it in the main setup flow would just add clutter for the common
  case.
- **Save-time validation**: each credential is tested before being
  persisted (real DB connection + trivial query; authenticated GitHub API
  call; minimal Anthropic API call), not saved blindly and left to fail on
  first real use. A self-hoster pasting a malformed value finds out
  immediately.
- **The DB client is a lazy singleton, not hot-reconnecting.** `getDb()`
  resolves config and creates the client on first call, caching it after.
  Editing an *already-set* DB connection string via settings requires a
  server restart to take effect — deliberately not building
  connection-pool teardown/hot-swap for a single-user tool. First-time
  setup never hits this, since there's no existing connection to replace.
- **The pipeline CLI shares the same resolver.** `run.ts` currently reads
  `DATABASE_URL`/`PIPELINE_GH_TOKEN`/`ANTHROPIC_API_KEY` straight from
  `process.env` and hard-throws if any are missing. It switches to the same
  `resolveConfig()` used by the web app, so credentials set via the UI on a
  homelab deployment are picked up by pipeline runs on that same host
  without separate configuration. The CLI is a fresh process per invocation
  (cron/`workflow_dispatch`/manual), so there are no in-process reactivity
  concerns the way there are for the long-running web server's DB client.
- **On-demand pipeline triggering from the UI (`tracker-jm8.6`) is
  explicitly separate follow-on work**, not part of this phase. It depends
  on this phase's shared resolver (so a trigger reads credentials the same
  way the CLI does) but isn't built here. `run.ts`'s current
  hard-throw-on-missing-credential behavior will need to become a
  reportable error rather than an uncaught crash when that lands, since
  credentials are now optional/progressive — noted on that issue, not
  addressed in this phase.

## Architecture & data flow

- **`src/lib/config.ts`** (new): the shared resolver.
  - `resolveConfig(key: string): string | undefined` — checks
    `process.env[key]`, then the local config file, else `undefined`.
  - `isConfigured(key: string): boolean` — cheap presence check, no side
    effects.
  - `setConfigValue(key: string, value: string): void` — writes to the
    config file (creating it if missing).
  - Config file path defaults to `./data/config.json`, overridable via
    `CONFIG_FILE_PATH`. Gitignored. This is the same path convention that
    phase 2's Docker/homelab deployment will volume-mount for persistence.
- **`src/lib/server-db.ts`** changes from a module-load singleton to
  `getDb()` (lazy, memoized after first successful resolution) plus
  `isDbConfigured()` (calls `isConfigured("DATABASE_URL")`, no client
  creation). `dashboard.ts` calls `isDbConfigured()` before querying.
- **`src/pipeline/run.ts`** switches its three `process.env.X` reads to
  `resolveConfig()`.
- **`src/lib/auth.ts`**'s `requireAppPassword()` switches from
  `process.env.APP_PASSWORD` to `resolveConfig("APP_PASSWORD")`; gate
  behavior is otherwise unchanged — set → same cookie-check flow as today,
  unset → no gate at all (no field forced anywhere in the credentials UI).
- **Dashboard route**: conditional rendering based on `isDbConfigured()`.
  Unconfigured → render only the credentials form (DB connection string,
  GitHub PAT, Anthropic key — each independently optional). Configured →
  render the normal dashboard plus a persistent settings section for
  adding/updating GitHub PAT and Anthropic key (DB alone doesn't unlock
  pipeline runs or assessments).
- **Settings forms**: each credential gets its own server action —
  independent submission per field, not one combined form — so adding the
  DB string doesn't require having a GitHub PAT ready yet, and vice versa.
  Each action validates before calling `setConfigValue`:
  - DB connection string → attempt a real connection + `SELECT 1`.
  - GitHub PAT → an authenticated Octokit call (e.g. `GET /user`).
  - Anthropic key → a minimal API call.
  A failed validation returns an error to the form without persisting
  anything.

## Testing, verification & error handling

- **Unit tests** for `config.ts`: env-var precedence over file, file
  fallback when env unset, `undefined` when neither present — using a temp
  directory for the config file, following this project's existing
  in-memory/temp-fixture test patterns.
- **Unit tests** for `getDb()`/`isDbConfigured()` lazy behavior (memoized
  after first call, `isDbConfigured()` never triggers client creation).
- **Unit tests** for each settings server action's validate-then-persist
  path: a mocked failing connection/API call must reject without writing to
  the config file; a mocked success must persist.
- **Live verification** (required per this project's standing rule that
  wiring together previously-independent modules needs a real end-to-end
  check, not just unit tests):
  - Boot the app with zero env vars and no config file present — confirm it
    renders the credentials-only view, not a crash.
  - Add DB connection string via the UI — confirm the dashboard shell
    renders (empty, since no data yet) without a restart.
  - Add GitHub PAT and Anthropic key via the UI — confirm both save-time
    validations actually call the real APIs and correctly accept a valid
    credential / reject an invalid one.
  - Confirm today's production-style config (all three env vars +
    `APP_PASSWORD` set, no config file) still behaves exactly as it does
    now — this is the regression check that matters most, since production
    isn't migrating onto this yet but must remain a drop-in-compatible
    target when phase 2 does the cutover.
- **Edge cases**: Postgres unreachable after being configured (e.g. bad
  network, not caught at save-time because it passed validation at the
  time) falls back to SolidStart's default error boundary — no bespoke
  handling, consistent with the existing single-user-tool philosophy.

## Explicitly out of scope

- GitHub OAuth sign-in — deferred indefinitely (see Decisions).
- On-demand pipeline trigger UI — tracked separately as `tracker-jm8.6`.
- Docker packaging (`tracker-jm8.3`), a portable (non-Neon-specific)
  Postgres driver (`tracker-jm8.1`), decoupling CI/deploy from Vercel
  (`tracker-jm8.4`), and self-host docs/`.env.example`/license
  (`tracker-jm8.5`) — separate epic children, not touched here.
- Homelab deployment (phase 2) and demo-site conversion (phase 3) —
  separate specs, later.
- Hot-reconnect for an edited DB connection string — restart required by
  design.
- Encrypting the local config file — plaintext JSON is an accepted
  tradeoff for a single-user self-hosted tool, matching `auth.ts`'s
  existing "no hashing, no session store" reasoning for the same class of
  decision.
