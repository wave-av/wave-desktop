/**
 * Wire schemas for the control-plane HTTP API. Both sides — the server
 * handlers in this directory AND the Companion module / vMix bridge that
 * talks to it — should derive their TypeScript types from these schemas so
 * a wire-protocol change cannot drift silently.
 *
 * Discoverability: the OpenAPI doc is generated from these schemas (see
 * scripts/emit-openapi.ts in a follow-up). For now, the source of truth is
 * the Zod definitions here.
 */

import { z } from 'zod';

// ── status / health ─────────────────────────────────────────────────────────

export const StatusResponseSchema = z.object({
  /** Module is alive and the API key matched. */
  ok: z.literal(true),
  /** wave-desktop semver (from package.json). */
  version: z.string(),
  /** ISO-8601 instant the server bound the socket. */
  bootAt: z.string(),
  /** Number of seconds the API has been running. */
  uptimeSec: z.number().int().nonnegative(),
  /** Whether the operator is currently signed in to the cloud gateway. */
  signedIn: z.boolean(),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// ── auth ────────────────────────────────────────────────────────────────────

export const AuthResponseSchema = z.object({
  signedIn: z.boolean(),
  /** sub claim from the gateway JWT — display only, never the token. */
  subject: z.string().nullable(),
  /** Seconds until JWT expiry, null when not signed in. */
  expiresInSec: z.number().int().nonnegative().nullable(),
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

// ── monitor (feed binding) ──────────────────────────────────────────────────

const SLUG = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'slug must be lowercase alphanumerics + hyphens, not starting or ending with a hyphen',
  );

export const MonitorConnectRequestSchema = z.object({
  slug: SLUG,
});
export type MonitorConnectRequest = z.infer<typeof MonitorConnectRequestSchema>;

// Response slug must match the request-side contract — echoing back an
// unvalidated string would let a future server change weaken the round-
// trip guarantee that "what the client sent is what comes back."
export const MonitorConnectResponseSchema = z.object({
  ok: z.literal(true),
  slug: SLUG,
});
export type MonitorConnectResponse = z.infer<typeof MonitorConnectResponseSchema>;

export const MonitorDisconnectResponseSchema = z.object({
  ok: z.literal(true),
});
export type MonitorDisconnectResponse = z.infer<typeof MonitorDisconnectResponseSchema>;

// ── errors ──────────────────────────────────────────────────────────────────

export const ErrorResponseSchema = z.object({
  error: z.string(),
  /** Optional machine-readable code (e.g. "AUTH_REQUIRED", "BAD_REQUEST"). */
  code: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
