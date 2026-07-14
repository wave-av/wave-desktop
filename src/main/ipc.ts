/**
 * Main-process IPC handler registration.
 *
 * Every channel from src/shared/ipc.ts gets a handler here. We validate every
 * inbound payload with .parse() so a compromised renderer can't push malformed
 * data into the rest of the main process.
 *
 * Auth model:
 *   - In-memory `current: TokenSet | null` is the cached signed-in state.
 *   - On boot, hydrate from disk via token-store (safeStorage).
 *   - On sign-in, run the RFC 8628 device-code flow, stream lifecycle events
 *     back to the renderer, then persist the new token set.
 *   - Tokens never cross the IPC bridge — the renderer only sees a sanitized
 *     `AuthState` (signedIn / subject / expiresInSec).
 *   - A single in-flight sign-in attempt is allowed at a time; a second call
 *     while one is pending throws so the UI doesn't fork two browser windows.
 */

import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { networkInterfaces } from 'node:os';
import {
  IPC,
  SignInRequestSchema,
  SettingsSchema,
  type AuthState,
  type EncoderStatus,
  EncoderStartRequestSchema,
  type NetworkInterface,
  type Settings,
  type SignInEvent,
  CrestControlRequestSchema,
  CrestStateRequestSchema,
  type CrestResult,
  type SessionPublishDescriptor,
  type SessionPublishToken,
} from '@shared/ipc';
import { isEncodeBridgeEnabled } from '@shared/flags';
import { DEVICE_CONTROL_URL } from '@shared/urls';
import { buildCrestEnvelope } from './control-plane/crest-envelope';
import {
  OAuthError,
  refreshToken,
  startDeviceCode,
  exchangeScopedToken,
  type TokenSet,
} from './auth/oauth';
import { clearToken, isAvailable, readToken, writeToken } from './auth/token-store';
import { decodeJwtPayload, expiresInSec } from './auth/jwt';
import { EncoderController } from './encoder/lifecycle';
import { resolve as resolveFfmpeg } from './encoder/binary-resolver';
import { deriveSrtTarget } from './encoder/srt-target';
import type { SrtTarget } from './encoder/srt-args';

// ── auth state (main-process only — never serialized to renderer) ───────────

interface PersistedAuth {
  accessToken: string;
  refreshToken: string | null;
  expiresAtSec: number;
  subject: string | null;
}

let current: TokenSet | null = null;
let inflightSignIn: AbortController | null = null;
const REFRESH_LEAD_SEC = 60; // start refresh this long before exp

const settings: Settings = {
  gatewayBase: 'https://api.wave.online',
  defaultCodec: 'h264',
  preferredInterface: null,
  x402BudgetCapUsd: 10,
};
// The encoder controller owns ffmpeg child processes (one per stream). It's
// instantiated once at module load — Electron's main process is single-
// threaded, so the singleton is safe. The previous stub Map lived here too;
// the controller's `list()` is the drop-in replacement.
const encoderController = new EncoderController();

/**
 * Cached SRT target — derived from `settings.gatewayBase` lazily so changes
 * via `settings:set` get picked up on the next encoder start. See
 * `encoder/srt-target.ts` for the transformation (api. → ingest. host swap).
 */
function srtTargetFor(streamKey: string): SrtTarget {
  return deriveSrtTarget(settings.gatewayBase, streamKey);
}

/** For app.before-quit — kill any active encoders so we don't leak ffmpeg. */
export function stopAllEncoders(): void {
  encoderController.stopAll();
}

function publicAuthState(): AuthState {
  if (!current) return { signedIn: false, subject: null, expiresInSec: null };
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = current.expiresAtSec - nowSec;
  return {
    signedIn: remaining > 0,
    subject: current.subject,
    expiresInSec: remaining > 0 ? remaining : 0,
  };
}

function emit(event: SignInEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.authSignInEvent, event);
  }
}

/**
 * Persist current token set to disk + cache its JWT-derived subject.
 * Persisted shape is a tight JSON envelope so a future field bump (e.g. scope)
 * doesn't change the safeStorage decrypt path.
 */
async function persist(tok: TokenSet): Promise<void> {
  const envelope: PersistedAuth = {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    expiresAtSec: tok.expiresAtSec,
    subject: tok.subject,
  };
  await writeToken(JSON.stringify(envelope));
}

/**
 * Restore the previous session at app boot. Returns true if a valid (or
 * refreshable) token set was loaded.
 */
export async function hydrateAuth(): Promise<boolean> {
  if (!isAvailable()) return false;
  const raw = await readToken();
  if (!raw) return false;
  let env: PersistedAuth;
  try {
    env = JSON.parse(raw) as PersistedAuth;
  } catch {
    await clearToken();
    return false;
  }
  current = {
    accessToken: env.accessToken,
    refreshToken: env.refreshToken,
    expiresAtSec: env.expiresAtSec,
    subject: env.subject ?? deriveSubject(env.accessToken),
  };
  const nowSec = Math.floor(Date.now() / 1000);
  if (current.expiresAtSec - nowSec < REFRESH_LEAD_SEC) {
    await tryRefresh();
  }
  return current !== null;
}

function deriveSubject(token: string): string | null {
  try {
    const claims = decodeJwtPayload(token);
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

async function tryRefresh(): Promise<void> {
  if (!current?.refreshToken) {
    current = null;
    await clearToken();
    return;
  }
  try {
    const next = await refreshToken(settings.gatewayBase, current.refreshToken);
    current = next;
    await persist(next);
  } catch {
    current = null;
    await clearToken();
  }
}

/**
 * Public accessor for downstream protocol handlers (libsrt / NDI / Dante) to
 * fetch the current bearer for gateway API calls. Auto-refreshes inside the
 * lead window so callers don't have to think about expiry.
 */
export async function getAccessToken(): Promise<string | null> {
  if (!current) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (current.expiresAtSec - nowSec < REFRESH_LEAD_SEC) await tryRefresh();
  return current?.accessToken ?? null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function listInterfaces(): NetworkInterface[] {
  const out: NetworkInterface[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      out.push({
        name,
        address: a.address,
        family: a.family as 'IPv4' | 'IPv6',
        internal: a.internal,
      });
    }
  }
  return out;
}

// ── registration ────────────────────────────────────────────────────────────

export function registerIpcHandlers(): void {
  // ── auth ─────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.authState, (): AuthState => publicAuthState());

  ipcMain.handle(IPC.authSignIn, async (_e: IpcMainInvokeEvent, raw: unknown): Promise<AuthState> => {
    const req = SignInRequestSchema.parse(raw ?? {});
    if (!isAvailable()) {
      throw new Error('OS secure-storage not available; cannot sign in');
    }
    if (inflightSignIn) {
      throw new Error('sign-in already in progress');
    }
    const gatewayBase = req.gatewayBase ?? settings.gatewayBase;
    const controller = new AbortController();
    inflightSignIn = controller;
    try {
      const { challenge, pollForToken } = await startDeviceCode(gatewayBase, controller.signal);
      // Tell the renderer what to display + open the verification URL in the
      // user's browser. Prefer the prefilled "complete" URL so the operator
      // doesn't have to type the code manually.
      emit({
        kind: 'pending',
        userCode: challenge.userCode,
        verificationUri: challenge.verificationUri,
        verificationUriComplete: challenge.verificationUriComplete,
        expiresInSec: challenge.expiresInSec,
      });
      void shell.openExternal(challenge.verificationUriComplete ?? challenge.verificationUri);

      const tok = await pollForToken();
      current = tok;
      await persist(tok);
      const state = publicAuthState();
      emit({ kind: 'success', state });
      return state;
    } catch (err) {
      const code = err instanceof OAuthError ? err.code : 'http_error';
      const message = err instanceof Error ? err.message : 'unknown sign-in failure';
      emit({ kind: 'error', code, message });
      throw err;
    } finally {
      inflightSignIn = null;
    }
  });

  ipcMain.handle(IPC.authSignInCancel, (): void => {
    inflightSignIn?.abort();
  });

  ipcMain.handle(IPC.authSignOut, async (): Promise<AuthState> => {
    current = null;
    await clearToken();
    return publicAuthState();
  });

  // ── settings ─────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.settingsGet, (): Settings => settings);

  ipcMain.handle(IPC.settingsSet, (_e: IpcMainInvokeEvent, raw: unknown): Settings => {
    const next = SettingsSchema.parse(raw);
    Object.assign(settings, next);
    return settings;
  });

  ipcMain.handle(IPC.settingsListInterfaces, (): NetworkInterface[] => listInterfaces());

  // ── encoders ─────────────────────────────────────────────────────────────
  // Real ffmpeg+libsrt encoder (#173). We resolve the binary once per start
  // rather than caching: the operator may install / update ffmpeg without
  // restarting the app, and the probe is cheap (~50ms). If no binary is
  // found, we throw a clear actionable error rather than silently failing.
  ipcMain.handle(
    IPC.encoderStart,
    async (_e: IpcMainInvokeEvent, raw: unknown): Promise<EncoderStatus> => {
      const req = EncoderStartRequestSchema.parse(raw);
      const binary = await resolveFfmpeg();
      if (!binary) {
        throw new Error(
          'ffmpeg not found — install via Homebrew (`brew install ffmpeg`), apt, or Chocolatey, or set WAVE_FFMPEG to a binary path',
        );
      }
      if (!binary.hasLibsrt) {
        throw new Error(
          `ffmpeg at ${binary.path} was built without --enable-libsrt — install a Homebrew bottle or rebuild with libsrt support`,
        );
      }
      const record = encoderController.start({
        binary: binary.path,
        request: req,
        target: srtTargetFor(req.streamKey),
      });
      return record.status;
    },
  );

  ipcMain.handle(IPC.encoderStop, (_e: IpcMainInvokeEvent, id: unknown): boolean => {
    if (typeof id !== 'string') throw new Error('encoder id must be a string');
    return encoderController.stop(id);
  });

  ipcMain.handle(IPC.encoderListStatus, (): EncoderStatus[] =>
    encoderController.list(),
  );

  // ── device control (E-CONTROL) ──────────────────────────────────────────
  // Renderer never holds the bearer token — main mints it via getAccessToken()
  // and forwards the frozen envelope. Non-2xx (503 not-armed / 403 / 400) is
  // returned as a structured `ok:false` result, never thrown as a generic
  // error, so the UI can surface the real gateway outcome honestly.
  ipcMain.handle(
    IPC.crestControl,
    async (_e: IpcMainInvokeEvent, raw: unknown): Promise<CrestResult> => {
      const req = CrestControlRequestSchema.parse(raw);
      const token = await getAccessToken();
      if (!token) {
        return {
          ok: false,
          status: 401,
          body: null,
          message: 'not signed in — sign in with WAVE first',
        };
      }
      const envelope = buildCrestEnvelope(req.org, req.device, req.command);
      return postCrestControl(settings.gatewayBase, token, envelope);
    },
  );

  ipcMain.handle(
    IPC.crestState,
    async (_e: IpcMainInvokeEvent, raw: unknown): Promise<CrestResult> => {
      const req = CrestStateRequestSchema.parse(raw);
      const token = await getAccessToken();
      if (!token) {
        return {
          ok: false,
          status: 401,
          body: null,
          message: 'not signed in — sign in with WAVE first',
        };
      }
      return getCrestState(settings.gatewayBase, token, req.org, req.device);
    },
  );

  // ── realtime session (WHIP publish — #74) ─────────────────────────────────
  // One-shot descriptor: the frozen WHIP endpoint + the current bearer. The
  // renderer feeds this straight into @wave-av/whip-publish's publish(). We
  // never persist the bearer here beyond the live token set, and it never
  // touches disk on the renderer side (see SessionPublishDescriptorSchema doc).
  ipcMain.handle(
    IPC.sessionPublishDescriptor,
    async (): Promise<SessionPublishDescriptor> => {
      const bearer = await getAccessToken();
      if (!bearer) {
        throw new Error('not signed in — sign in with WAVE before joining a session');
      }
      const base = settings.gatewayBase.replace(/\/$/, '');
      return { endpoint: `${base}/v1/whip/publish`, bearer };
    },
  );

  // ── realtime session: least-privilege publish token (#74.b) ───────────────
  // Flag-gated (OFF by default). When enabled, exchange the stored session
  // bearer for a SHORT-LIVED token scoped to `whip:write` ONLY, so the media
  // route never carries the broad session JWT (Jake dual-auth ruling 2026-07-14).
  // The scoped token is the SECRET the renderer hands straight to publish();
  // it's never persisted. With the flag off we reject rather than mint.
  ipcMain.handle(
    IPC.sessionMintPublishToken,
    async (): Promise<SessionPublishToken> => {
      if (!isEncodeBridgeEnabled()) {
        throw new Error('encode bridge disabled — set WAVE_ENABLE_ENCODE_BRIDGE to publish');
      }
      const bearer = await getAccessToken();
      if (!bearer) {
        throw new Error('not signed in — sign in with WAVE before joining a session');
      }
      const base = settings.gatewayBase.replace(/\/$/, '');
      const scoped = await exchangeScopedToken(settings.gatewayBase, bearer, ['whip:write']);
      return {
        endpoint: `${base}/v1/whip/publish`,
        key: scoped.accessToken,
        expiresInSec: scoped.expiresInSec,
        scope: scoped.scope,
      };
    },
  );

  // ── deep-link: web-always Mesh device control (E-CONTROL #78b) ──────────
  // Fixed constant, never renderer-supplied input — a compromised renderer
  // can only ever trigger opening this ONE known-good WAVE URL, not an
  // arbitrary shell.openExternal target.
  ipcMain.handle(IPC.uiOpenDeviceControl, (): void => {
    void shell.openExternal(DEVICE_CONTROL_URL);
  });
}

async function postCrestControl(
  gatewayBase: string,
  token: string,
  envelope: ReturnType<typeof buildCrestEnvelope>,
): Promise<CrestResult> {
  try {
    const res = await fetch(`${gatewayBase}/v1/crest/control`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    const body = await safeJson(res);
    if (res.ok) return { ok: true, status: res.status, body };
    return { ok: false, status: res.status, body, message: messageFor(res.status, body) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      message: err instanceof Error ? err.message : 'network error contacting gateway',
    };
  }
}

async function getCrestState(
  gatewayBase: string,
  token: string,
  org: string,
  device: string,
): Promise<CrestResult> {
  try {
    const url = new URL(`${gatewayBase}/v1/crest/state`);
    url.searchParams.set('device', device);
    url.searchParams.set('org', org);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await safeJson(res);
    if (res.ok) return { ok: true, status: res.status, body };
    return { ok: false, status: res.status, body, message: messageFor(res.status, body) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      message: err instanceof Error ? err.message : 'network error contacting gateway',
    };
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function messageFor(status: number, body: unknown): string {
  const detail =
    body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : null;
  if (status === 503) return detail ?? 'control bridge not armed';
  if (status === 403) return detail ?? 'forbidden — cross-org device';
  if (status === 400) return detail ?? 'malformed request';
  return detail ?? `gateway returned ${status}`;
}

// Re-export for tests that exercise the JWT helpers without booting Electron.
export { expiresInSec };

// ── control-plane state accessor ────────────────────────────────────────────
// The control-plane HTTP server needs a cheap snapshot of the current auth
// state on every request. Rather than threading the `current` cache through
// initControlPlane(), we expose a function the caller can pass directly.
// This keeps the auth cache module-private and avoids re-implementing the
// "is the token still valid?" check in two places.

/**
 * Snapshot of auth state for the control-plane HTTP /v1/auth + /v1/status
 * endpoints. Cheap — no I/O. Calls publicAuthState() and combines with the
 * static main-process metadata (version, bootAt) that the caller supplies.
 */
export function authSnapshot(): {
  signedIn: boolean;
  subject: string | null;
  expiresInSec: number | null;
} {
  return publicAuthState();
}
