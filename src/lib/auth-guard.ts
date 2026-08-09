import { redirect } from "@solidjs/router";
import { getRequestEvent } from "solid-js/web";
import { isAuthenticatedRequest } from "./auth";

/**
 * Guard for "use server" query/action bodies. Server functions are invoked
 * over their own `/_server` RPC endpoint (not the page path they're called
 * from), so the page-level redirect in `src/middleware.ts` alone doesn't
 * stop a direct unauthenticated POST to `/_server?id=...` — this closes
 * that gap. Throws a redirect Response to `/login` when unauthenticated.
 *
 * Not unit-tested directly (needs Solid's request-event context) — split
 * out from `./auth.ts` so the plain-logic pieces there stay testable, same
 * reasoning as `dashboard-queries.ts`'s split from `dashboard.ts`.
 */
export function assertAuthenticated(): void {
  const event = getRequestEvent();
  if (!event || !isAuthenticatedRequest(event.request)) {
    throw redirect("/login");
  }
}
