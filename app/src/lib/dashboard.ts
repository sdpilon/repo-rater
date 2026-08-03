import { action, json, query } from "@solidjs/router";
import { assertAuthenticated } from "./auth-guard";
import { getDashboardView, setRepoIgnored } from "./dashboard-queries";
import { db } from "./server-db";

export const getDashboardData = query(async () => {
  "use server";
  assertAuthenticated();
  return getDashboardView(db);
}, "dashboard");

export const toggleIgnore = action(async (repoId: number, ignored: boolean) => {
  "use server";
  assertAuthenticated();
  await setRepoIgnored(db, repoId, ignored);
  return json(null, { revalidate: getDashboardData.key });
}, "toggleIgnore");
