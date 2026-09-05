import { action, json, query } from "@solidjs/router";
import {
  resolvePipelineCredentials,
  runPipelineFromConfig,
} from "../pipeline/run";
import { getLatestRun } from "../pipeline/runs";
import { assertAuthenticated } from "./auth-guard";
import { isDemoMode } from "./demo-mode";
import { getDb, isDbConfigured } from "./server-db";

export interface PipelineStatus {
  inProgress: boolean;
  status: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  reposFetchedOk: number | null;
  reposFailed: number | null;
}

export const getPipelineStatus = query(
  async (): Promise<PipelineStatus | undefined> => {
    "use server";
    assertAuthenticated();
    if (!isDbConfigured()) return undefined;
    const latest = await getLatestRun(await getDb());
    if (!latest) return undefined;
    return {
      inProgress: latest.finishedAt === null,
      status: latest.status,
      startedAt: latest.startedAt,
      finishedAt: latest.finishedAt,
      reposFetchedOk: latest.reposFetchedOk,
      reposFailed: latest.reposFailed,
    };
  },
  "pipelineStatus",
);

export const triggerPipelineRun = action(async () => {
  "use server";
  assertAuthenticated();
  if (isDemoMode()) {
    return { error: "Demo mode is enabled; changes are restricted." };
  }

  const credentials = resolvePipelineCredentials();
  if (!credentials.ok) {
    return { error: credentials.error };
  }

  const latest = await getLatestRun(await getDb());
  if (latest && latest.finishedAt === null) {
    return { error: "A pipeline run is already in progress." };
  }

  // Fire-and-forget: the UI polls getPipelineStatus for outcome instead of
  // blocking this action on the full discover -> extract-load -> enrich run.
  runPipelineFromConfig({ dryRun: false, limit: null }).catch((err) => {
    console.error("pipeline run failed:", err);
  });

  return json({ error: null }, { revalidate: getPipelineStatus.key });
}, "triggerPipelineRun");
