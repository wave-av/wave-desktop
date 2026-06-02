/**
 * Security headers for the localhost HTTP control plane.
 *
 * Mirrors the subset of Helmet defaults that make sense for an API-only
 * server bound to 127.0.0.1 (no HTML, no cookies, no cross-origin browsers
 * meant to consume this). We set them by hand rather than pulling helmet in
 * because we don't run on Express — and the surface is small enough that
 * one named function is easier to audit than a middleware chain.
 *
 * Notable choices:
 *   - `Access-Control-Allow-Origin: null` (explicit deny — Companion is a
 *     Node process, not a browser, so it never sends Origin and never
 *     triggers CORS). Browsers that wander to http://127.0.0.1:31415 get
 *     a flat refusal rather than implicit allow-anything.
 *   - `X-Frame-Options: DENY` — defense against clickjacking from any
 *     local HTML page that might load us in an iframe.
 *   - `Cache-Control: no-store` — control responses are real-time state,
 *     not cacheable, and we never want intermediaries (none on loopback,
 *     but discipline) to keep them.
 *   - `Content-Security-Policy: default-src 'none'` — we never serve HTML,
 *     so the strictest possible CSP is correct.
 */

import type { ServerResponse } from 'node:http';

export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'interest-cohort=()');
  // Explicit cross-origin deny — there's no legitimate browser caller.
  res.setHeader('Access-Control-Allow-Origin', 'null');
  res.setHeader('Vary', 'Origin');
}

/**
 * Extract a Bearer token from the Authorization header.
 * Returns null when the header is missing, malformed, or uses any non-Bearer
 * scheme. The caller is expected to compare via `safeEqual` from api-key.ts.
 */
export function parseBearer(authHeader: string | string[] | undefined): string | null {
  if (typeof authHeader !== 'string') return null;
  const trimmed = authHeader.trim();
  const prefix = 'Bearer ';
  if (!trimmed.startsWith(prefix)) return null;
  const token = trimmed.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
}
