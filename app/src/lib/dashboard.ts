import { action, json, query } from "@solidjs/router";
import { getDashboardView, setRepoIgnored } from "./dashboard-queries";
import { db } from "./server-db";

export const getDashboardData = query(async () => {
  "use server";
  return getDashboardView(db);
}, "dashboard");

export const toggleIgnore = action(async (repoId: number, ignored: boolean) => {
  "use server";
  await setRepoIgnored(db, repoId, ignored);
  return json(null, { revalidate: getDashboardData.key });
}, "toggleIgnore");
