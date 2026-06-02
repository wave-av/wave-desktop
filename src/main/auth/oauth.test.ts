/**
 * OAuth device-code tests — mock global fetch + fake timers to exercise the
 * polling loop without actually waiting 5+ seconds between attempts. The
 * fixtures cover the three branches we care about: pending → success,
 * slow_down (delay grows), and a terminal error (access_denied).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthError, startDeviceCode } from './oauth';

const BASE = 'https://gateway.example.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Drain timers fully — pollDeviceToken alternates `wait` (timer) and `fetch`
// (microtask). Each cycle needs both queues drained.
async function drainCycles(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
}

describe('startDeviceCode → pollForToken', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns a TokenSet after authorization_pending → success', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    // 1: device code
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        device_code: 'devcode',
        user_code: 'AB-CD',
        verification_uri: 'https://x.test/dev',
        expires_in: 600,
        interval: 1,
      }),
    );
    // 2: pending
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'authorization_pending' }, 400),
    );
    // 3: success
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'opaque-token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r-token',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { challenge, pollForToken } = await startDeviceCode(BASE);
    expect(challenge.userCode).toBe('AB-CD');
    const tokPromise = pollForToken();
    await drainCycles(2);
    const tok = await tokPromise;
    expect(tok.accessToken).toBe('opaque-token');
    expect(tok.refreshToken).toBe('r-token');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('propagates access_denied as a terminal OAuthError', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        device_code: 'd',
        user_code: 'X',
        verification_uri: 'https://x.test/dev',
        expires_in: 600,
        interval: 1,
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'access_denied', error_description: 'user said no' }, 400),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { pollForToken } = await startDeviceCode(BASE);
    const tokPromise = pollForToken();
    // Attach the rejection assertion BEFORE driving the clock — otherwise the
    // unhandled rejection fires before we can catch it.
    const assertion = expect(tokPromise).rejects.toMatchObject({
      code: 'access_denied',
    });
    await drainCycles(2);
    await assertion;
  });

  it('bumps the polling delay on slow_down', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        device_code: 'd',
        user_code: 'X',
        verification_uri: 'https://x.test/dev',
        expires_in: 600,
        interval: 1,
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'slow_down' }, 400));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }, 400));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'opaque',
        token_type: 'Bearer',
        expires_in: 60,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { pollForToken } = await startDeviceCode(BASE);
    const tokPromise = pollForToken();
    await drainCycles(3);
    const tok = await tokPromise;
    expect(tok.accessToken).toBe('opaque');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('OAuthError', () => {
  it('preserves code + message', () => {
    const e = new OAuthError('boom', 'expired_token');
    expect(e.code).toBe('expired_token');
    expect(e.message).toBe('boom');
    expect(e.name).toBe('OAuthError');
  });
});
