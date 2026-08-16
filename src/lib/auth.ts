/**
 * Minimal shared-secret cookie gate protecting the whole app (see
 * `src/middleware.ts`). This is a single-user personal tool — a plain
 * shared secret compared server-side is an appropriate bar here, matching
 * what Vercel's own basic password protection would offer. No hashing,
 * no session store, no multi-user accounts by design.
 *
 * Kept free of `@solidjs/router`/`solid-js/web` imports (see `./auth-guard.ts`
 * for the one piece that needs those) so it can be unit-tested directly —
 * same reasoning as `dashboard-queries.ts`'s split from `dashboard.ts`.
 */

import { isConfigured, resolveConfig } from "./config";

export const AUTH_COOKIE = "site_auth";

/** 30 days, in seconds. */
export const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** Paths the auth gate lets through unauthenticated. Prefix-matched. */
export const PUBLIC_PATH_PREFIXES = ["/login", "/_build/", "/favicon.ico"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix,
  );
}

/** Cheap presence check — true once APP_PASSWORD is set via env var or the config file. */
export function isAppPasswordConfigured(): boolean {
  return isConfigured("APP_PASSWORD");
}

export function requireAppPassword(): string {
  const value = resolveConfig("APP_PASSWORD");
  if (!value) {
    throw new Error(
      "APP_PASSWORD is not configured — set the APP_PASSWORD environment variable or configure it via the config file before running `pnpm dev`.",
    );
  }
  return value;
}

/** Reads a single cookie's value out of a raw `Cookie` request header. */
export function getCookieValue(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/** Builds a `Set-Cookie` header value for the auth cookie. */
export function buildAuthCookie(value: string): string {
  const attrs = [
    `${AUTH_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${AUTH_COOKIE_MAX_AGE}`,
  ];
  if (process.env.NODE_ENV === "production") {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}

/**
 * True when `request` carries a cookie matching the configured APP_PASSWORD
 * — or unconditionally true when no APP_PASSWORD is configured at all (a
 * self-hosted instance with no password gate, e.g. behind Tailscale).
 */
export function isAuthenticatedRequest(request: Request): boolean {
  if (!isAppPasswordConfigured()) return true;
  const cookieValue = getCookieValue(request.headers.get("cookie"), AUTH_COOKIE);
  return cookieValue !== undefined && cookieValue === requireAppPassword();
}
