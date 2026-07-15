/**
 * Session lifecycle telemetry (#74.c).
 *
 * No telemetry channel existed in this repo before (only a stray "consumed by
 * Sentry tag" comment in version.ts). This module introduces the CONTRACT: a
 * small, typed set of session lifecycle events the renderer emits and the main
 * process records through one sink. Keeping the event shapes here (shared) means
 * both sides validate the SAME schema, exactly like the IPC contract.
 *
 * PRIVACY: events carry only non-sensitive operational fields — no bearer
 * tokens, no SDP, no capture-device labels. `session` is a random per-session id
 * the renderer generates; it never identifies a user.
 */

import { z } from 'zod';

/**
 * The transport a session uses (WHIP publish or WHEP subscribe). Referenced by
 * every event kind below — required on `session-start` / `session-stop` /
 * `state`, and optional on `error`.
 */
export const TelemetryTransportSchema = z.enum(['whip-publish', 'whep-subscribe']);
export type TelemetryTransport = z.infer<typeof TelemetryTransportSchema>;

/**
 * A structured session lifecycle event. Discriminated on `kind`:
 *   - `session-start` / `session-stop` — bracket a publish/subscribe session,
 *     with optional bytes + duration on stop for the meter-adjacent view.
 *   - `state` — a transport state transition (WHIP/WHEP connection state).
 *   - `error` — a non-fatal or fatal error, with a stable `code` + safe message.
 */
export const TelemetryEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session-start'),
    session: z.string().min(1),
    transport: TelemetryTransportSchema,
    /** Negotiated codec labels (observability only), when known. */
    videoCodec: z.string().nullable().optional(),
    audioCodec: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal('session-stop'),
    session: z.string().min(1),
    transport: TelemetryTransportSchema,
    /** Wall-clock session duration in seconds. */
    durationSec: z.number().nonnegative().optional(),
    /** Approximate bytes moved this session (from RTCStats), when available. */
    bytes: z.number().nonnegative().optional(),
    /** Why the session ended: normal teardown, an error, or the app quitting. */
    reason: z.enum(['stopped', 'error', 'quit']).optional(),
  }),
  z.object({
    kind: z.literal('state'),
    session: z.string().min(1),
    transport: TelemetryTransportSchema,
    /** e.g. `connected`, `disconnected`, `failed`, or a WHIP publish state. */
    state: z.string().min(1),
  }),
  z.object({
    kind: z.literal('error'),
    session: z.string().min(1),
    transport: TelemetryTransportSchema.optional(),
    /** Stable machine code, e.g. `whep_subscribe_failed`. */
    code: z.string().min(1),
    /** Human-readable; MUST NOT contain tokens/SDP. */
    message: z.string(),
  }),
]);
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

/** Generate a random per-session id (opaque; not user-identifying). */
export function newSessionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `s_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
