import { and, eq, ne } from "drizzle-orm";
import { repos } from "../db/schema";
import type { DrizzleDb } from "./db-types";

/**
 * Ported from repo-root `pipeline/ignore-rules.js` (read-only reference).
 * `computeSuggestedIgnore` is unchanged: same four conditions, same
 * behavior. `applyIgnoreDefaultForRepo` is the single-repo equivalent of the
 * old `load.js`'s `applySuggestedIgnoreDefaults` loop body — the loop itself
 * now lives in `enrich.ts`'s `enrichAll`, merged with the enrichment loop so
 * README is fetched once per repo instead of twice (see enrich.ts's module
 * comment for why).
 */

export interface SuggestedIgnoreInput {
  isFork: boolean;
  isArchived: boolean;
  readme: string;
  commitCount: number;
  issueCount: number;
  prCount: number;
}

export function computeSuggestedIgnore({
  isFork,
  isArchived,
  readme,
  commitCount,
  issueCount,
  prCount,
}: SuggestedIgnoreInput): { ignored: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (isFork) reasons.push("fork");
  if (isArchived) reasons.push("archived");
  if (!readme?.trim()) reasons.push("no README");
  if (commitCount + issueCount + prCount === 0) reasons.push("no activity");
  return { ignored: reasons.length > 0, reasons };
}

/**
 * Recomputes and persists `is_ignored` for a single repo, unless it's been
 * manually overridden (`ignore_source === 'manual'`) — manual overrides are
 * never recomputed or touched, matching the old stack's invariant. The
 * `WHERE ignore_source != 'manual'` guard on the UPDATE is defense-in-depth
 * against a race with a concurrent manual toggle, ported from the old code.
 */
export async function applyIgnoreDefaultForRepo(
  db: DrizzleDb,
  repoId: number,
  input: Omit<SuggestedIgnoreInput, "isFork" | "isArchived">,
): Promise<{ ignored: boolean; reasons: string[] }> {
  const [repoRow] = await db
    .select({ isFork: repos.isFork, isArchived: repos.isArchived, ignoreSource: repos.ignoreSource, isIgnored: repos.isIgnored })
    .from(repos)
    .where(eq(repos.repoId, repoId));

  if (!repoRow || repoRow.ignoreSource === "manual") {
    return { ignored: repoRow?.isIgnored ?? false, reasons: [] };
  }

  const { ignored, reasons } = computeSuggestedIgnore({
    isFork: repoRow.isFork ?? false,
    isArchived: repoRow.isArchived ?? false,
    ...input,
  });

  await db
    .update(repos)
    .set({ isIgnored: ignored, ignoreSource: "auto", ignoreReasons: reasons })
    .where(and(eq(repos.repoId, repoId), ne(repos.ignoreSource, "manual")));

  return { ignored, reasons };
}
