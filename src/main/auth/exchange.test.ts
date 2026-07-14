import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeScopedToken, OAuthError } from './oauth';

/** Stub global fetch with a single canned Response. */
function stubFetch(status: number, body: string, ok = status >= 200 && status < 300): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status,
      text: async () => body,
    })) as unknown as typeof fetch,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exchangeScopedToken — least-privilege whip:write mint', () => {
  it('returns the minted token, ttl, and scope on 200', async () => {
    stubFetch(
      200,
      JSON.stringify({ access_token: 'wif_abc', token_type: 'Bearer', expires_in: 900, scope: 'whip:write' }),
    );
    const tok = await exchangeScopedToken('https://api.wave.online', 'session_jwt', ['whip:write']);
    expect(tok.accessToken).toBe('wif_abc');
    expect(tok.expiresInSec).toBe(900);
    expect(tok.scope).toBe('whip:write');
  });

  it('sends the session bearer + JSON scopes body to /v1/oauth/token', async () => {
    stubFetch(200, JSON.stringify({ access_token: 't', expires_in: 900, scope: 'whip:write' }));
    await exchangeScopedToken('https://api.wave.online/', 'session_jwt', ['whip:write'], 600);
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toBe('https://api.wave.online/v1/oauth/token');
    const init = call[1] as { headers: Record<string, string>; body: string };
    expect(init.headers.authorization).toBe('Bearer session_jwt');
    expect(JSON.parse(init.body)).toEqual({ scopes: ['whip:write'], ttl: 600 });
  });

  it('throws OAuthError carrying the gateway error code on 403 SCOPE_OVERREACH', async () => {
    stubFetch(
      403,
      JSON.stringify({ error: { code: 'SCOPE_OVERREACH', message: 'requested scopes exceed the key grant' } }),
      false,
    );
    await expect(
      exchangeScopedToken('https://api.wave.online', 'session_jwt', ['whip:write']),
    ).rejects.toMatchObject({ code: 'SCOPE_OVERREACH' });
  });

  it('throws malformed_response when a 200 body is not JSON', async () => {
    stubFetch(200, '<html>not json</html>');
    await expect(
      exchangeScopedToken('https://api.wave.online', 'session_jwt', ['whip:write']),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it('throws malformed_response when access_token is missing', async () => {
    stubFetch(200, JSON.stringify({ expires_in: 900, scope: 'whip:write' }));
    await expect(
      exchangeScopedToken('https://api.wave.online', 'session_jwt', ['whip:write']),
    ).rejects.toMatchObject({ code: 'malformed_response' });
  });
});
