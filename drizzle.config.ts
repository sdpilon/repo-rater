import { defineConfig } from "drizzle-kit";

// `dbCredentials.url` is required by Drizzle Kit's config schema even for
// `drizzle-kit generate`, which otherwise only reads `schema.ts` and the
// migration snapshots under `out/` — it does not open a DB connection for
// `generate`. There is no live database available yet (no DATABASE_URL),
// so this deliberately falls back to an obviously-fake placeholder rather
// than a real-looking connection string. `push`/`migrate`/`studio` (which
// do connect) will fail loudly against this placeholder until a real
// DATABASE_URL is set — that's intentional.
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://placeholder:placeholder@localhost:5432/placeholder";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
