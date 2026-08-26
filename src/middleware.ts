import { createMiddleware } from "@solidjs/start/middleware";
import { isAuthenticatedRequest, isPublicPath } from "~/lib/auth";

/**
 * App-wide shared-secret cookie gate. Vercel's Deployment Protection can't
 * cover production deployments on the free Hobby plan (only ephemeral
 * preview URLs), so this fills that gap in-app instead.
 *
 * `onRequest` runs before Solid's request context is provided (see
 * `wrapRequestMiddleware` in `@solidjs/start/dist/middleware/index.js`), so
 * this reads cookies directly off the standard `Request` on the
 * `FetchEvent` rather than via `@solidjs/start/http`'s ambient-context
 * cookie helpers, which are not guaranteed to work here.
 *
 * `/_server` (the RPC endpoint every "use server" query/action posts to,
 * including the login action itself) is intentionally left reachable —
 * blocking it here would also block the login submission. The
 * `assertAuthenticated()` guard inside `getDashboardData`/`toggleAssess`
 * (see `~/lib/dashboard.ts`) is what actually keeps that endpoint from
 * leaking data unauthenticated.
 */
export default createMiddleware({
  onRequest: (event) => {
    const { pathname } = new URL(event.request.url);
    if (pathname === "/_server" || isPublicPath(pathname)) return;

    if (!isAuthenticatedRequest(event.request)) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      });
    }
  },
});
