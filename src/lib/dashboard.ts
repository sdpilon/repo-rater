import { action, json, query } from "@solidjs/router";
import { assertAuthenticated } from "./auth-guard";
import { getDashboardView, setRepoAssessControl, type AssessControlValue } from "./dashboard-queries";
import { getDb, isDbConfigured } from "./server-db";

export const getDashboardData = query(async () => {
  "use server";
  assertAuthenticated();
  // Defense-in-depth: a direct POST to /_server?id=dashboard on an
  // unconfigured instance would otherwise reach getDb() and throw. The
  // route already gates on getCredentialStatus()'s database.configured
  // before calling this, but that's client-driven and this RPC endpoint is
  // reachable directly regardless of what the page rendered.
  if (!isDbConfigured()) return undefined;
  return getDashboardView(getDb());
}, "dashboard");

export const toggleAssess = action(async (repoId: number, value: AssessControlValue) => {
  "use server";
  assertAuthenticated();
  await setRepoAssessControl(getDb(), repoId, value);
  return json(null, { revalidate: getDashboardData.key });
}, "toggleAssess");
