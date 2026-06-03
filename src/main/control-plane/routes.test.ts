/**
 * Route-handler unit tests. These hit the pure handler functions returned
 * by `buildRoutes()` directly, bypassing the live HTTP server. The live
 * end-to-end path is covered separately by `router.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildRoutes, type ControlPlaneState, type MonitorBridge } from './routes.ts';

function state(overrides: Partial<ControlPlaneState> = {}): ControlPlaneState {
  return {
    version: '0.2.0',
    bootAt: new Date('2026-06-02T00:00:00.000Z'),
    signedIn: true,
    subject: 'jake@wave.online',
    expiresInSec: 3600,
    ...overrides,
  };
}

function monitor(): MonitorBridge & { _calls: string[] } {
  const calls: string[] = [];
  return {
    _calls: calls,
    async connect(slug: string) {
      calls.push(`connect:${slug}`);
    },
    async disconnect() {
      calls.push('disconnect');
      return true;
    },
  };
}

describe('route handlers', () => {
  it('GET /v1/status returns version + uptime + signedIn', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(
      new Date('2026-06-02T00:00:42.000Z').getTime(),
    );
    const routes = buildRoutes(() => state(), monitor());
    const r = routes.find((x) => x.path === '/v1/status')!;
    const out = (await r.handler({} as never, {} as never, {})) as {
      version: string;
      uptimeSec: number;
      signedIn: boolean;
    };
    expect(out.version).toBe('0.2.0');
    expect(out.uptimeSec).toBe(42);
    expect(out.signedIn).toBe(true);
    now.mockRestore();
  });

  it('GET /v1/auth surfaces sanitized auth state', async () => {
    const routes = buildRoutes(() => state({ signedIn: false, subject: null }), monitor());
    const r = routes.find((x) => x.path === '/v1/auth')!;
    const out = (await r.handler({} as never, {} as never, {})) as {
      signedIn: boolean;
      subject: string | null;
    };
    expect(out.signedIn).toBe(false);
    expect(out.subject).toBeNull();
  });

  it('POST /v1/monitor/connect calls the bridge with the slug', async () => {
    const m = monitor();
    const routes = buildRoutes(() => state(), m);
    const r = routes.find((x) => x.path === '/v1/monitor/connect')!;
    const out = (await r.handler({} as never, {} as never, {
      body: { slug: 'main-camera' },
    })) as { ok: true; slug: string };
    expect(out.ok).toBe(true);
    expect(out.slug).toBe('main-camera');
    expect(m._calls).toContain('connect:main-camera');
  });

  it('POST /v1/monitor/disconnect calls the bridge', async () => {
    const m = monitor();
    const routes = buildRoutes(() => state(), m);
    const r = routes.find((x) => x.path === '/v1/monitor/disconnect')!;
    const out = (await r.handler({} as never, {} as never, {})) as { ok: true };
    expect(out.ok).toBe(true);
    expect(m._calls).toContain('disconnect');
  });
});

describe('slug schema (security boundary)', () => {
  // These exercise the zod regex via the route's bodySchema. Defense against
  // an attacker who controls the wire payload (despite Bearer auth, we want
  // every input layer to validate independently — see `frameworks/threat-model`).
  it('accepts valid lowercase slugs', () => {
    const routes = buildRoutes(() => state(), monitor());
    const r = routes.find((x) => x.path === '/v1/monitor/connect')!;
    for (const ok of ['camera', 'main-camera', 'cam-1', 'a', 'a-b-c-d']) {
      expect(r.bodySchema!.safeParse({ slug: ok }).success).toBe(true);
    }
  });

  it('rejects malicious / malformed slugs', () => {
    const routes = buildRoutes(() => state(), monitor());
    const r = routes.find((x) => x.path === '/v1/monitor/connect')!;
    const bad = [
      '',
      ' ',
      '-leading',
      'trailing-',
      'UPPER',
      'with space',
      '../etc/passwd',
      'sql; DROP TABLE',
      '<script>',
      'x'.repeat(65),
    ];
    for (const b of bad) {
      expect(r.bodySchema!.safeParse({ slug: b }).success).toBe(false);
    }
  });
});
