import { action, json, query } from "@solidjs/router";
import { assertAuthenticated } from "./auth-guard";
import { getDashboardView, setRepoAssessControl, type AssessControlValue } from "./dashboard-queries";
import { db } from "./server-db";

export const getDashboardData = query(async () => {
  "use server";
  assertAuthenticated();
  return getDashboardView(db);
}, "dashboard");

export const toggleAssess = action(async (repoId: number, value: AssessControlValue) => {
  "use server";
  assertAuthenticated();
  await setRepoAssessControl(db, repoId, value);
  return json(null, { revalidate: getDashboardData.key });
}, "toggleAssess");
