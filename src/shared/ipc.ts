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
  // Pro-AV network transports. `sourceName` is the human-readable NDI/OMT
  // source string ffmpeg matches against its discovery list — it may contain
  // spaces and parentheses (e.g. `DEV-5 (Camera 1)`), so it never touches a
  // shell: it's a single argv element handed straight to spawn().
  z.object({ kind: z.literal('ndi'), sourceName: z.string().min(1) }),
  z.object({ kind: z.literal('omt'), sourceName: z.string().min(1) }),
  // Dante audio arrives as a CoreAudio (macOS) / WASAPI (Windows) / ALSA
  // (Linux) device courtesy of Dante Virtual Soundcard; `deviceId` is the
  // OS-specific device index or name that avfoundation/dshow/alsa expects.
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

// ── device control (E-CONTROL — WAVE Device Control Protocol v1) ────────────
// Envelope + commands are FROZEN (see gateway `/v1/crest/control`). The
// renderer never talks to the gateway directly — main holds the bearer
// token and forwards. Outcomes (incl. 503 "not armed" / 403 / 400) are
// surfaced verbatim to the renderer; we never synthesize success.

export const CrestCommandSchema = z.discriminatedUnion('cmd', [
  z.object({
    cmd: z.literal('stream.start'),
    args: z.object({
      transport: z.enum(['moq', '2110']).optional(),
      destination: z.string().optional(),
    }),
  }),
  z.object({ cmd: z.literal('stream.stop'), args: z.object({}) }),
  z.object({ cmd: z.literal('captions.on'), args: z.object({}) }),
  z.object({ cmd: z.literal('captions.off'), args: z.object({}) }),
  z.object({
    cmd: z.literal('settings.set'),
    args: z.object({
      codec: z.enum(['h264', 'h265']).optional(),
      bitrate: z.number().int().positive().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fps: z.number().int().min(1).max(240).optional(),
      transport: z.enum(['moq', '2110']).optional(),
      destination: z.string().optional(),
    }),
  }),
  z.object({ cmd: z.literal('settings.get'), args: z.object({}) }),
  z.object({ cmd: z.literal('state.get'), args: z.object({}) }),
]);
export type CrestCommand = z.infer<typeof CrestCommandSchema>;

export const CrestControlRequestSchema = z.object({
  org: z.string().min(1),
  device: z.string().min(1),
  command: CrestCommandSchema,
});
export type CrestControlRequest = z.infer<typeof CrestControlRequestSchema>;

/**
 * Outcome of a control POST / state GET. We never collapse a non-2xx into a
 * thrown error the renderer has to string-match — `ok: false` carries the
 * real HTTP status + gateway body so the UI can show e.g. "503 control
 * bridge not armed" honestly instead of a generic failure toast.
 */
export const CrestResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: z.number().int(), body: z.unknown() }),
  z.object({ ok: z.literal(false), status: z.number().int(), body: z.unknown(), message: z.string() }),
]);
export type CrestResult = z.infer<typeof CrestResultSchema>;

export const CrestStateRequestSchema = z.object({
  org: z.string().min(1),
  device: z.string().min(1),
});
export type CrestStateRequest = z.infer<typeof CrestStateRequestSchema>;

// ── realtime session (WHIP publish — #74 session core) ──────────────────────
// The happy-path "join a WAVE realtime session": the renderer enumerates
// capture devices (navigator.mediaDevices — media MUST live renderer-side),
// then asks main for a one-shot WHIP publish descriptor. Main owns the bearer
// (the OAuth→JWT access token from safeStorage) and returns it alongside the
// frozen WHIP endpoint. The bearer is a SECRET: the renderer hands it straight
// to @wave-av/whip-publish's `publish()` and NEVER persists it (same one-shot
// discipline as controlPlane.revealKey). Media never crosses the IPC bridge —
// only this small descriptor does.

export const SessionPublishDescriptorSchema = z.object({
  /**
   * The gateway WHIP publish endpoint — `https://api.wave.online/v1/whip/publish`.
   * Derived from `settings.gatewayBase`; the client only ever talks to the gateway
   * (frozen WHIP-v1 invariant §9.3), never an edge URL.
   */
  endpoint: z.string().url(),
  /**
   * `Authorization: Bearer <token>` value for the publish. SECRET — treat like
   * revealKey(): hand to publish() immediately, never store in component state
   * beyond the in-flight session.
   */
  bearer: z.string().min(1),
});
export type SessionPublishDescriptor = z.infer<typeof SessionPublishDescriptorSchema>;

/**
 * A minted, LEAST-PRIVILEGE WHIP publish token (#74.b, Jake dual-auth ruling
 * 2026-07-14). Instead of handing the broad session JWT to the media route, main
 * exchanges it at `POST {gatewayBase}/v1/oauth/token` for a short-lived token
 * scoped to `whip:write` ONLY, and returns that. The renderer feeds `key`
 * straight into `@wave-av/whip-publish`'s `publish()` (as the Bearer) and never
 * persists it. `scope` is echoed for the UI to prove least-privilege; `key` is
 * still a SECRET (same one-shot discipline as the descriptor bearer).
 *
 * ONLY surfaced when the encode-bridge feature flag is ON — with the flag off,
 * `session.mintPublishToken()` rejects so no publish token is ever minted.
 */
export const SessionPublishTokenSchema = z.object({
  /** Gateway WHIP publish endpoint (same derivation as the descriptor). */
  endpoint: z.string().url(),
  /** The short-lived `whip:write`-scoped Bearer token. SECRET — never persist. */
  key: z.string().min(1),
  /** Seconds until the minted token expires (server-stated). */
  expiresInSec: z.number().int().positive(),
  /** The granted scope string, e.g. `"whip:write"` — display/observability only. */
  scope: z.string(),
});
export type SessionPublishToken = z.infer<typeof SessionPublishTokenSchema>;

/**
 * A minted, LEAST-PRIVILEGE WHEP subscribe token (#74.d). Mirrors the WHIP
 * publish-token mint exactly (Jake dual-auth ruling 2026-07-14): main exchanges
 * the session bearer at `POST {gatewayBase}/v1/oauth/token` for a short-lived
 * token scoped to `whep:write` ONLY, and returns it. The renderer feeds `key`
 * straight into the WHEP client's `startWhep()` (as the Bearer) and never
 * persists it. `whep:write` (not `whep:read`) because a WHEP subscribe is a
 * POST — every WHEP verb is a mutation on the gateway (see wave-gateway/whep.ts).
 *
 * ONLY surfaced when the encode-bridge flag is ON (same gate as the publish
 * token) — with the flag off, `session.mintSubscribeToken()` rejects.
 */
export const SessionSubscribeTokenSchema = z.object({
  /** Gateway WHEP subscribe endpoint — `https://api.wave.online/v1/whep/subscribe`. */
  endpoint: z.string().url(),
  /** The short-lived `whep:write`-scoped Bearer token. SECRET — never persist. */
  key: z.string().min(1),
  /** Seconds until the minted token expires (server-stated). */
  expiresInSec: z.number().int().positive(),
  /** The granted scope string, e.g. `"whep:write"` — display/observability only. */
  scope: z.string(),
});
export type SessionSubscribeToken = z.infer<typeof SessionSubscribeTokenSchema>;

// ── telemetry (#74.c) ────────────────────────────────────────────────────────
// The renderer emits structured session lifecycle events; main validates + sinks
// them (telemetry-sink.ts). One-way (renderer → main, no response). The event
// shape lives in @shared/telemetry so both sides share the schema.
export { TelemetryEventSchema, type TelemetryEvent } from './telemetry';

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
  crestControl: 'wave:crest:control',
  crestState: 'wave:crest:state',
  /** one-shot WHIP publish descriptor (endpoint + bearer) for a realtime session */
  sessionPublishDescriptor: 'wave:session:publish-descriptor',
  /** mint a least-privilege whip:write-scoped publish token (#74.b, flag-gated) */
  sessionMintPublishToken: 'wave:session:mint-publish-token',
  /** mint a least-privilege whep:write-scoped subscribe token (#74.d, flag-gated) */
  sessionMintSubscribeToken: 'wave:session:mint-subscribe-token',
  /** renderer → main one-way structured telemetry event (#74.c) */
  telemetryEmit: 'wave:telemetry:emit',
  uiOpenDeviceControl: 'wave:ui:open-device-control',
} as const;
export type IpcChannel = (typeof IPC)[keyof typeof IPC];
