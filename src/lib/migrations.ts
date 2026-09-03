import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bundled at build time via Vite's import.meta.glob, so the migration
// content ships inside the JS output itself rather than depending on the
// deployed artifact also including the literal `drizzle/` directory on
// disk. Nitro only traces files that are actually `import`ed — it has no
// way to know drizzle-orm's migrate() reads `./drizzle` off the
// filesystem at runtime, so on targets that don't separately copy that
// folder in (e.g. the Vercel build, unlike the Dockerfile) migrate()
// fails with "Can't find meta/_journal.json file".
const journalModules = import.meta.glob("../../drizzle/meta/_journal.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const sqlModules = import.meta.glob("../../drizzle/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface JournalEntry {
  tag: string;
}

/**
 * Writes the bundled migration content back out to a real temp directory,
 * shaped exactly like `drizzle/` (`meta/_journal.json` plus one `.sql` per
 * journal entry), so drizzle-orm's fs-based `migrate()` can read it via a
 * normal `migrationsFolder` path on any deploy target.
 */
export async function materializeMigrationsFolder(): Promise<string> {
  const journalRaw = journalModules["../../drizzle/meta/_journal.json"];
  if (!journalRaw) {
    throw new Error(
      "drizzle/meta/_journal.json was not bundled at build time",
    );
  }
  const journal = JSON.parse(journalRaw) as { entries: JournalEntry[] };

  const dir = await mkdtemp(join(tmpdir(), "repo-rater-migrations-"));
  await mkdir(join(dir, "meta"));
  await writeFile(join(dir, "meta", "_journal.json"), journalRaw);

  for (const entry of journal.entries) {
    const sql = sqlModules[`../../drizzle/${entry.tag}.sql`];
    if (sql === undefined) {
      throw new Error(
        `drizzle/${entry.tag}.sql was not bundled at build time`,
      );
    }
    await writeFile(join(dir, `${entry.tag}.sql`), sql);
  }

  return dir;
}
