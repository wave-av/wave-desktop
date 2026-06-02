/**
 * Orchestration tests for initControlPlane(). These exercise the lifecycle
 * end-to-end except for the api-key persistence step (which goes through
 * Electron safeStorage and is mocked out — we don't boot Electron in CI).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock api-key before importing — initControlPlane immediately calls
// loadOrCreate(), so the mock must be installed first.
let mockKey = 'a'.repeat(64);
let regenerateCount = 0;
vi.mock('./api-key.ts', () => ({
  loadOrCreate: vi.fn(async () => mockKey),
  regenerate: vi.fn(async () => {
    regenerateCount += 1;
    mockKey = String.fromCharCode(98 + regenerateCount).repeat(64); // 'bbb…', 'ccc…', …
    return mockKey;
  }),
  safeEqual: (a: string, b: string) => a === b,
}));

import { initControlPlane, type ControlPlaneHandle } from './index.ts';
import type { ControlPlaneState } from './routes.ts';

const baseState: ControlPlaneState = {
  version: '0.3.0',
  bootAt: new Date('2026-06-02T00:00:00.000Z'),
  signedIn: false,
  subject: null,
  expiresInSec: null,
};

async function fetchStatus(port: number, key: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/status`, {
    headers: { Authorization: `Bearer ${key}` },
  });
}

describe('initControlPlane', () => {
  let cp: ControlPlaneHandle;
  const sent: Array<{ channel: string; payload: unknown }> = [];

  beforeEach(async () => {
    mockKey = 'a'.repeat(64);
    regenerateCount = 0;
    sent.length = 0;
    cp = await initControlPlane({
      getState: () => baseState,
      sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
      port: 0, // ephemeral so parallel tests don't collide
    });
  });

  afterEach(async () => {
    await cp.stop();
  });

  it('binds an ephemeral port and serves /v1/status with the minted key', async () => {
    expect(cp.port).toBeGreaterThan(0);
    expect(cp.apiKey).toMatch(/^[0-9a-f]{64}$/);
    const res = await fetchStatus(cp.port, cp.apiKey);
    expect(res.status).toBe(200);
  });

  it('rejects the previous key after rotate', async () => {
    const oldKey = cp.apiKey;
    await cp.rotate();
    expect(cp.apiKey).not.toBe(oldKey);

    const oldKeyRes = await fetchStatus(cp.port, oldKey);
    expect(oldKeyRes.status).toBe(401);

    const newKeyRes = await fetchStatus(cp.port, cp.apiKey);
    expect(newKeyRes.status).toBe(200);
  });

  it('forwards monitor connect to the renderer via the bridge channel', async () => {
    const res = await fetch(`http://127.0.0.1:${cp.port}/v1/monitor/connect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cp.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ slug: 'main-camera' }),
    });
    expect(res.status).toBe(200);
    expect(sent).toContainEqual({
      channel: 'wave:control-plane:monitor-connect',
      payload: { slug: 'main-camera' },
    });
  });

  it('forwards monitor disconnect via the bridge channel', async () => {
    const res = await fetch(`http://127.0.0.1:${cp.port}/v1/monitor/disconnect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cp.apiKey}` },
    });
    expect(res.status).toBe(200);
    expect(sent).toContainEqual({
      channel: 'wave:control-plane:monitor-disconnect',
      payload: {},
    });
  });

  it('stop() closes the listener (subsequent fetch is refused)', async () => {
    const port = cp.port;
    await cp.stop();
    // Re-call stop() in afterEach is safe — node:http close on closed = no-op.
    cp = { port, apiKey: '', rotate: async () => '', stop: async () => {} };
    await expect(
      fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: { Authorization: `Bearer ${'a'.repeat(64)}` },
      }),
    ).rejects.toThrow();
  });
});
