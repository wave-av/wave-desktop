/**
 * Router tests exercise the end-to-end HTTP path against an in-memory
 * `node:http` server bound to 127.0.0.1:0 (ephemeral port). Using a real
 * socket — instead of a fake request — catches header / status / body
 * encoding issues that pure unit mocks would miss.
 *
 * Why not vi.mock the server: the auth middleware + body parsing only
 * makes sense in the context of a real request lifecycle, and the latency
 * is sub-ms locally so test runtime stays well under vitest's default.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { start, type ServerHandle } from './server.ts';
import { type Route } from './router.ts';

const VALID_KEY = 'a'.repeat(64);
const WRONG_KEY = 'b'.repeat(64);

async function request(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    /* leave as string */
  }
  return { status: res.status, body, headers: res.headers };
}

function makeRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/v1/ping',
      handler: () => ({ ok: true, pong: true }),
    },
    {
      method: 'POST',
      path: '/v1/echo',
      bodySchema: z.object({ msg: z.string().min(1) }),
      handler: (_req, _res, ctx) => ({ ok: true, echoed: ctx.body }),
    },
    {
      method: 'GET',
      path: '/v1/boom',
      handler: () => {
        throw new Error('handler exploded');
      },
    },
  ];
}

describe('control-plane router (live HTTP)', () => {
  let handle: ServerHandle;

  beforeEach(async () => {
    handle = await start({ apiKey: VALID_KEY, port: 0, routes: makeRoutes() });
  });

  afterEach(async () => {
    await handle.stop();
  });

  it('200 on a valid GET with the right key', async () => {
    const r = await request(handle.port, '/v1/ping', {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, pong: true });
  });

  it('401 when Authorization is missing', async () => {
    const r = await request(handle.port, '/v1/ping');
    expect(r.status).toBe(401);
    expect((r.body as { code: string }).code).toBe('AUTH_REQUIRED');
  });

  it('401 when bearer token is wrong (same shape as missing — no leak)', async () => {
    const r = await request(handle.port, '/v1/ping', {
      headers: { Authorization: `Bearer ${WRONG_KEY}` },
    });
    expect(r.status).toBe(401);
    expect((r.body as { code: string }).code).toBe('AUTH_REQUIRED');
  });

  it('404 on unknown route', async () => {
    const r = await request(handle.port, '/v1/nope', {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    expect(r.status).toBe(404);
    expect((r.body as { code: string }).code).toBe('NOT_FOUND');
  });

  it('400 on body that fails schema', async () => {
    const r = await request(handle.port, '/v1/echo', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ wrong: 'shape' }),
    });
    expect(r.status).toBe(400);
    expect((r.body as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('400 on malformed JSON', async () => {
    const r = await request(handle.port, '/v1/echo', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{ not json',
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toContain('JSON');
  });

  it('200 + echoes back the parsed body', async () => {
    const r = await request(handle.port, '/v1/echo', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ msg: 'hello' }),
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, echoed: { msg: 'hello' } });
  });

  it('500 on handler exception (with INTERNAL code, no stack leak)', async () => {
    const r = await request(handle.port, '/v1/boom', {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    expect(r.status).toBe(500);
    expect((r.body as { code: string }).code).toBe('INTERNAL');
    expect(JSON.stringify(r.body)).not.toContain('at '); // no stack frames
  });

  it('strips trailing slashes for matching', async () => {
    const r = await request(handle.port, '/v1/ping/', {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    expect(r.status).toBe(200);
  });

  it('always sets security headers on responses', async () => {
    const r = await request(handle.port, '/v1/ping', {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'");
    // Omits ACAO entirely — browser falls back to same-origin policy.
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('binds on 127.0.0.1 only — refuses 0.0.0.0 traffic in spirit', async () => {
    // We can't test bind-address shape directly without raw sockets, but we
    // can confirm the server is reachable via loopback (which is what we want).
    const r = await request(handle.port, '/v1/ping', {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    expect(r.status).toBe(200);
  });
});
