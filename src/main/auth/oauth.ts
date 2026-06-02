/**
 * OAuth 2.0 Device Authorization Grant — RFC 8628.
 *
 * Two endpoints on the WAVE gateway:
 *   POST {base}/oauth/device/code      — start; returns a user_code the operator
 *                                        types at a verification URI in their
 *                                        browser, plus a device_code we poll with.
 *   POST {base}/oauth/token            — poll until the user approves; same endpoint
 *                                        used later for refresh_token grant.
 *
 * Polling cadence is dictated by the server (`interval` field). On
 * `authorization_pending` we wait `interval` seconds; on `slow_down` we add 5s
 * per RFC 8628 §3.5. Anything else is terminal.
 *
 * No external library — the protocol is ~80 lines of HTTP + a poll loop and a
 * dependency would expand the supply-chain surface for almost no code saved.
 *
 * Everything here returns plain data; persistence + IPC are wired in
 * src/main/ipc.ts so this module stays unit-testable without Electron.
 */

import { decodeJwtPayload } from './jwt';

export interface DeviceChallenge {
  /** Short code the operator types at verificationUri. */
  userCode: string;
  /** URL the operator opens. */
  verificationUri: string;
  /** Same URL with the user_code prefilled. Prefer this when possible. */
  verificationUriComplete?: string;
  /** Seconds before this challenge expires. */
  expiresInSec: number;
}

export interface TokenSet {
  /** JWT — never logged, never returned to the renderer. */
  accessToken: string;
  refreshToken: string | null;
  /** Absolute epoch seconds when accessToken expires (server-stated or JWT-derived). */
  expiresAtSec: number;
  subject: string | null;
}

export class OAuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

interface RawDeviceCodeResp {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  /** Polling interval in seconds (server default 5 if omitted per RFC). */
  interval?: number;
}

interface RawTokenResp {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

interface RawTokenError {
  error: string;
  error_description?: string;
}

const POLL_BASE_DELAY_MS = 5_000;
const SLOW_DOWN_BUMP_MS = 5_000;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Step 1: ask the gateway for a device code. Returns the challenge to display
 * + a continuation that polls until the user approves (or rejects, or expires).
 */
export async function startDeviceCode(
  gatewayBase: string,
  signal?: AbortSignal,
): Promise<{ challenge: DeviceChallenge; pollForToken: () => Promise<TokenSet> }> {
  const raw = await postForm<RawDeviceCodeResp>(
    `${gatewayBase}/oauth/device/code`,
    { client_id: 'wave-desktop' },
    signal,
  );
  const intervalMs = (raw.interval ?? POLL_BASE_DELAY_MS / 1000) * 1000;
  const challenge: DeviceChallenge = {
    userCode: raw.user_code,
    verificationUri: raw.verification_uri,
    verificationUriComplete: raw.verification_uri_complete,
    expiresInSec: raw.expires_in,
  };
  const pollForToken = (): Promise<TokenSet> =>
    pollDeviceToken(gatewayBase, raw.device_code, intervalMs, raw.expires_in * 1000, signal);
  return { challenge, pollForToken };
}

async function pollDeviceToken(
  gatewayBase: string,
  deviceCode: string,
  initialDelayMs: number,
  windowMs: number,
  signal?: AbortSignal,
): Promise<TokenSet> {
  const deadline = Date.now() + windowMs;
  let delay = initialDelayMs;
  while (Date.now() < deadline) {
    await wait(delay, signal);
    try {
      const tok = await postForm<RawTokenResp>(
        `${gatewayBase}/oauth/token`,
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: 'wave-desktop',
        },
        signal,
      );
      return toTokenSet(tok);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      if (err.code === 'authorization_pending') continue;
      if (err.code === 'slow_down') {
        delay += SLOW_DOWN_BUMP_MS;
        continue;
      }
      // access_denied / expired_token / anything else — terminal.
      throw err;
    }
  }
  throw new OAuthError('device code expired before approval', 'expired_token');
}

/**
 * Exchange a refresh_token for a fresh access + refresh pair. Treats every
 * failure as "refresh is dead" — caller should fall back to a fresh sign-in.
 */
export async function refreshToken(
  gatewayBase: string,
  refresh: string,
  signal?: AbortSignal,
): Promise<TokenSet> {
  const tok = await postForm<RawTokenResp>(
    `${gatewayBase}/oauth/token`,
    {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: 'wave-desktop',
    },
    signal,
  );
  return toTokenSet(tok);
}

// ── internals ───────────────────────────────────────────────────────────────

function toTokenSet(raw: RawTokenResp): TokenSet {
  let expiresAtSec = Math.floor(Date.now() / 1000) + raw.expires_in;
  let subject: string | null = null;
  try {
    const claims = decodeJwtPayload(raw.access_token);
    if (typeof claims.exp === 'number') expiresAtSec = claims.exp;
    if (typeof claims.sub === 'string') subject = claims.sub;
  } catch {
    /* opaque access_token (not a JWT) — keep the server-stated expiry */
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    expiresAtSec,
    subject,
  };
}

async function postForm<T>(
  url: string,
  fields: Record<string, string>,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  // Chain abort: if the outer signal fires, propagate to our controller.
  const onOuterAbort = (): void => controller.abort();
  outer?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(fields).toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // Per RFC 8628 §3.5, OAuth error responses are JSON with an `error` field
      // even on 400. Surface that as a typed code so callers can branch.
      let parsed: RawTokenError | null = null;
      try {
        parsed = JSON.parse(text) as RawTokenError;
      } catch {
        /* non-JSON body — treat as generic */
      }
      if (parsed?.error) {
        throw new OAuthError(parsed.error_description ?? parsed.error, parsed.error);
      }
      throw new OAuthError(`oauth http ${res.status}`, 'http_error');
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OAuthError('oauth: response not JSON', 'malformed_response');
    }
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OAuthError('aborted', 'aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OAuthError('aborted', 'aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
