/**
 * Cross-process IPC contract for wave-desktop.
 *
 * Every channel is defined here as a Zod schema pair (request / response).
 * The preload exposes a typed `window.wave` surface that mirrors these names;
 * the main process registers handlers under the same names. Renderer code
 * never reaches Node APIs — all OS / network / codec work goes through these
 * channels and is validated on both sides.
 *
 * Discipline (from burnrate CLAUDE.md, applied here):
 *   - Renderer is the untrusted side. Validate every payload at the main
 *     handler boundary with `.parse()` (throws on bad input → IPC error).
 *   - Main never returns secrets to renderer; if a value is sensitive
 *     (tokens, credentials), it lives in safeStorage and only its presence
 *     flag is surfaced.
 */

import { z } from 'zod';

// ── auth ────────────────────────────────────────────────────────────────────
// Gateway OAuth → short-lived JWT stored encrypted in OS secure-storage
// (macOS Keychain via safeStorage / Win DPAPI / Linux libsecret). The
// renderer can only check presence + initiate sign-in / sign-out.

export const AuthStateSchema = z.object({
  signedIn: z.boolean(),
  /** sub from JWT — display only, never the raw token */
  subject: z.string().nullable(),
  /** seconds until token expiry, null when not signed in */
  expiresInSec: z.number().int().nonnegative().nullable(),
});
export type AuthState = z.infer<typeof AuthStateSchema>;

export const SignInRequestSchema = z.object({
  /** override default gateway base for staging / dev */
  gatewayBase: z.string().url().optional(),
});
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

/**
 * Streaming sign-in event — renderer subscribes to display the device code +
 * verification URL while the operator approves in their browser. The main
 * process emits one `pending` (with the challenge) then either `success` or
 * `error`. The userCode + verificationUri are PUBLIC display strings; no
 * tokens / device_codes ever cross the IPC bridge.
 */
export const SignInEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pending'),
    userCode: z.string().min(1),
    verificationUri: z.string().url(),
    /** prefilled link; renderer should prefer this when present */
    verificationUriComplete: z.string().url().optional(),
    expiresInSec: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('success'), state: AuthStateSchema }),
  z.object({
    kind: z.literal('error'),
    /** RFC 8628 code (`access_denied`, `expired_token`, etc.) or `aborted` / `http_error` */
    code: z.string(),
    /** human-readable; never includes tokens */
    message: z.string(),
  }),
]);
export type SignInEvent = z.infer<typeof SignInEventSchema>;

// ── settings ────────────────────────────────────────────────────────────────

export const NetworkInterfaceSchema = z.object({
  name: z.string(),
  address: z.string(),
  family: z.enum(['IPv4', 'IPv6']),
  internal: z.boolean(),
});
export type NetworkInterface = z.infer<typeof NetworkInterfaceSchema>;

export const SettingsSchema = z.object({
  gatewayBase: z.string().url(),
  defaultCodec: z.enum(['h264', 'hevc', 'av1', 'av2']),
  preferredInterface: z.string().nullable(),
  x402BudgetCapUsd: z.number().nonnegative(),
});
export type Settings = z.infer<typeof SettingsSchema>;

// ── encoders (Layer-0 source → WAVE gateway) ────────────────────────────────

export const EncoderSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('screen'), displayId: z.string() }),
  z.object({ kind: z.literal('camera'), deviceId: z.string() }),
  z.object({ kind: z.literal('file'), path: z.string() }),
  // NDI (#157). Discovered on the LAN via mDNS — the capture is CLIENT-SIDE
  // because NDI is a link-local protocol the cloud can never see. `sourceName`
  // is the human-facing name NDI advertises (e.g. "STUDIO-PC (Cam 1)"); the
  // native adapter resolves it to a receiver. `bandwidth` maps to the NDI
  // receiver bandwidth mode — `highest` = full-quality stream (default),
  // `lowest` = the proxy/preview stream (a fraction of the bitrate, for
  // multiview/monitoring). Frames are decoded by the native adapter and piped
  // into the SAME ffmpeg encoder + SRT caller tail every other source uses.
  z.object({
    kind: z.literal('ndi'),
    sourceName: z.string().min(1),
    bandwidth: z.enum(['highest', 'lowest']).default('highest'),
  }),
  // OMT (Open Media Transport) (#158, GA #74). The open, royalty-free
  // replacement for NDI — a link-local LAN video transport, so capture is
  // CLIENT-SIDE (the cloud never sees the source). `sourceName` is the name OMT
  // advertises; the native adapter resolves it to a receiver. `quality` maps to
  // the OMT receiver mode — `full` = primary high-quality stream (default),
  // `preview` = the low-bitrate proxy (for multiview/monitoring). Frames are
  // decoded by the native adapter and piped into the SAME ffmpeg encoder + SRT
  // caller tail as NDI/every other source — which relays them over WAVE MESH.
  z.object({
    kind: z.literal('omt'),
    sourceName: z.string().min(1),
    quality: z.enum(['full', 'preview']).default('full'),
  }),
  // Dante (Audinate) (#159, GA #74). Low-latency AUDIO-over-IP — audio-only, so
  // it encodes raw PCM → AAC (not the rawvideo path). Subscribed on the LAN, so
  // capture is CLIENT-SIDE. `channelId` names the Dante flow/channel the native
  // adapter subscribes to; decoded PCM is piped into an audio-only ffmpeg tail
  // that pushes over the shared SRT caller → WAVE MESH.
  z.object({ kind: z.literal('dante'), channelId: z.string().min(1) }),
]);
export type EncoderSource = z.infer<typeof EncoderSourceSchema>;

export const EncoderStartRequestSchema = z.object({
  source: EncoderSourceSchema,
  streamKey: z.string().min(8),
  codec: z.enum(['h264', 'hevc', 'av1', 'av2']),
});
export type EncoderStartRequest = z.infer<typeof EncoderStartRequestSchema>;

export const EncoderStatusSchema = z.object({
  id: z.string(),
  state: z.enum(['idle', 'connecting', 'live', 'errored']),
  bitrateKbps: z.number().nonnegative(),
  uptimeSec: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type EncoderStatus = z.infer<typeof EncoderStatusSchema>;

// ── channel names (single source of truth — used by main + preload) ─────────

// ── control plane (localhost HTTP API — wired in #189) ──────────────────────
// The plaintext API key is sensitive. It NEVER ships in `info()` — only the
// dedicated `revealKey()` channel returns plaintext, and the renderer is
// expected to immediately hand it to the OS clipboard or paste-buffer rather
// than persist it. `regenerateKey()` rotates server-side and returns the new
// plaintext for the same one-shot reveal.

export const ControlPlaneInfoSchema = z.object({
  /** Bound TCP port (always 127.0.0.1). */
  port: z.number().int().min(1).max(65535),
  /** True once `loadOrCreate()` has minted (or read) a key on disk. */
  hasKey: z.boolean(),
  /** ISO-8601 instant the server bound the socket. */
  startedAt: z.string(),
});
export type ControlPlaneInfo = z.infer<typeof ControlPlaneInfoSchema>;

export const ControlPlaneRevealResponseSchema = z.object({
  /** 64-char hex (32 random bytes). Treat as a secret — never persist in renderer. */
  apiKey: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ControlPlaneRevealResponse = z.infer<typeof ControlPlaneRevealResponseSchema>;

export const IPC = {
  authState: 'wave:auth:state',
  authSignIn: 'wave:auth:sign-in',
  authSignInCancel: 'wave:auth:sign-in-cancel',
  authSignOut: 'wave:auth:sign-out',
  /** main → renderer stream of sign-in lifecycle events */
  authSignInEvent: 'wave:auth:sign-in-event',
  settingsGet: 'wave:settings:get',
  settingsSet: 'wave:settings:set',
  settingsListInterfaces: 'wave:settings:list-interfaces',
  encoderStart: 'wave:encoder:start',
  encoderStop: 'wave:encoder:stop',
  encoderListStatus: 'wave:encoder:list-status',
  controlPlaneInfo: 'wave:control-plane:info',
  controlPlaneRevealKey: 'wave:control-plane:reveal-key',
  controlPlaneRegenerateKey: 'wave:control-plane:regenerate-key',
} as const;
export type IpcChannel = (typeof IPC)[keyof typeof IPC];
