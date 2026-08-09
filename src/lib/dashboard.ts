import { action, json, query } from "@solidjs/router";
import { assertAuthenticated } from "./auth-guard";
import { getDashboardView, setRepoIgnoreControl, type IgnoreControlValue } from "./dashboard-queries";
import { db } from "./server-db";

export const getDashboardData = query(async () => {
  "use server";
  assertAuthenticated();
  return getDashboardView(db);
}, "dashboard");

export const toggleIgnore = action(async (repoId: number, value: IgnoreControlValue) => {
  "use server";
  assertAuthenticated();
  await setRepoIgnoreControl(db, repoId, value);
  return json(null, { revalidate: getDashboardData.key });
}, "toggleIgnore");
