import { action, json, query } from "@solidjs/router";
import { assertAuthenticated } from "./auth-guard";
import {
  getDashboardView,
  setRepoAssessControl,
  type AssessControlValue,
  type DashboardView,
} from "./dashboard-queries";
import { getDb, isDbConfigured } from "./server-db";
import { isDemoMode } from "./demo-mode";

interface DashboardData {
  view: DashboardView | undefined;
  isDemoMode: boolean;
}

export const getDashboardData = query(async (): Promise<DashboardData> => {
  "use server";
  assertAuthenticated();
  // Defense-in-depth: a direct POST to /_server?id=dashboard on an
  // unconfigured instance would otherwise reach getDb() and throw. The
  // route already gates on getCredentialStatus()'s database.configured
  // before calling this, but that's client-driven and this RPC endpoint is
  // reachable directly regardless of what the page rendered.
  if (!isDbConfigured()) return { view: undefined, isDemoMode: isDemoMode() };
  return { view: await getDashboardView(getDb()), isDemoMode: isDemoMode() };
}, "dashboard");

export const toggleAssess = action(
  async (repoId: number, value: AssessControlValue) => {
    "use server";
    assertAuthenticated();
    if (isDemoMode())
      throw new Error("Demo mode is enabled; changes are restricted.");
    await setRepoAssessControl(getDb(), repoId, value);
    return json(null, { revalidate: getDashboardData.key });
  },
  "toggleAssess",
);
