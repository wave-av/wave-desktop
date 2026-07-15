import { describe, expect, it, vi } from 'vitest';
import {
  startWhep,
  resolveResourceUrl,
  type FetchFn,
  type WhepPeer,
} from './whep-client';

const ENDPOINT = 'https://api.wave.online/v1/whep/subscribe';
const ANSWER = 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n';

/** A fake recvonly peer that records the handshake calls. */
function fakePeer(overrides: Partial<WhepPeer> = {}): WhepPeer & {
  transceivers: Array<{ kind: string; direction: string }>;
  remote: RTCSessionDescriptionInit | null;
  closed: boolean;
  connectionState: string;
  listeners: Record<string, (ev: unknown) => void>;
} {
  const transceivers: Array<{ kind: string; direction: string }> = [];
  const listeners: Record<string, (ev: unknown) => void> = {};
  const peer = {
    transceivers,
    remote: null as RTCSessionDescriptionInit | null,
    closed: false,
    connectionState: 'new',
    listeners,
    addTransceiver: (kind: string, init: { direction: RTCRtpTransceiverDirection }) => {
      transceivers.push({ kind, direction: init.direction });
    },
    createOffer: async () => ({ type: 'offer' as const, sdp: 'OFFER_SDP' }),
    setLocalDescription: vi.fn(async () => {}),
    setRemoteDescription: vi.fn(async function (this: { remote: unknown }, d: RTCSessionDescriptionInit) {
      peer.remote = d;
    }),
    localDescription: { sdp: 'OFFER_SDP' },
    addEventListener: (type: string, listener: (ev: unknown) => void) => {
      listeners[type] = listener;
    },
    close: () => {
      peer.closed = true;
    },
    ...overrides,
  };
  return peer as unknown as ReturnType<typeof fakePeer>;
}

/** A fetch that returns a WHEP 201 answer with a Location header. */
function fetchOk(location: string | null = '/v1/whep/resource/abc123'): FetchFn {
  return vi.fn(async () => ({
    ok: true,
    status: 201,
    headers: { get: (n: string) => (n.toLowerCase() === 'location' ? location : null) },
    text: async () => ANSWER,
  }));
}

describe('resolveResourceUrl', () => {
  it('resolves a gateway-absolute path against the endpoint origin', () => {
    expect(resolveResourceUrl(ENDPOINT, '/v1/whep/resource/abc')).toBe(
      'https://api.wave.online/v1/whep/resource/abc',
    );
  });
  it('returns null for a missing Location', () => {
    expect(resolveResourceUrl(ENDPOINT, null)).toBeNull();
  });
  it('keeps an absolute same-origin gateway URL as-is', () => {
    expect(resolveResourceUrl(ENDPOINT, 'https://api.wave.online/v1/whep/resource/x')).toBe(
      'https://api.wave.online/v1/whep/resource/x',
    );
  });
  it('rejects a cross-origin Location (never leak the Bearer off-gateway)', () => {
    expect(resolveResourceUrl(ENDPOINT, 'https://evil.example/v1/whep/resource/x')).toBeNull();
  });
});

describe('startWhep — resource resolution honors same-origin', () => {
  it('does not DELETE a cross-origin Location on teardown', async () => {
    const peer = fakePeer();
    const fetchImpl = fetchOk('https://evil.example/v1/whep/resource/x');
    const session = await startWhep(
      { endpoint: ENDPOINT, key: 'k' },
      { createPeer: () => peer, fetchImpl },
    );
    expect(session.resourceUrl).toBeNull();
    await session.stop();
    const deletes = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => (c[1] as { method: string }).method === 'DELETE',
    );
    expect(deletes).toHaveLength(0);
    expect(peer.closed).toBe(true);
  });
});

describe('startWhep — SDP handshake', () => {
  it('posts the offer SDP with a Bearer + application/sdp and applies the answer', async () => {
    const peer = fakePeer();
    const fetchImpl = fetchOk();
    const session = await startWhep(
      { endpoint: ENDPOINT, key: 'whep_scoped' },
      { createPeer: () => peer, fetchImpl },
    );

    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[0]).toBe(ENDPOINT);
    const init = call[1] as { method: string; headers: Record<string, string>; body: string };
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer whep_scoped');
    expect(init.headers['content-type']).toBe('application/sdp');
    expect(init.body).toBe('OFFER_SDP');
    expect(peer.remote).toEqual({ type: 'answer', sdp: ANSWER });
    expect(session.resourceUrl).toBe('https://api.wave.online/v1/whep/resource/abc123');
  });

  it('adds two recvonly transceivers (audio + video)', async () => {
    const peer = fakePeer();
    await startWhep({ endpoint: ENDPOINT, key: 'k' }, { createPeer: () => peer, fetchImpl: fetchOk() });
    expect(peer.transceivers).toEqual([
      { kind: 'video', direction: 'recvonly' },
      { kind: 'audio', direction: 'recvonly' },
    ]);
  });

  it('surfaces the incoming MediaStream to onStream', async () => {
    const peer = fakePeer();
    const onStream = vi.fn();
    await startWhep(
      { endpoint: ENDPOINT, key: 'k' },
      { createPeer: () => peer, fetchImpl: fetchOk(), onStream },
    );
    const stream = {} as MediaStream;
    peer.listeners['track']!({ streams: [stream] } as unknown);
    expect(onStream).toHaveBeenCalledWith(stream);
  });

  it('forwards connectionstatechange to onState with the peer connectionState', async () => {
    const peer = fakePeer();
    const onState = vi.fn();
    await startWhep(
      { endpoint: ENDPOINT, key: 'k' },
      { createPeer: () => peer, fetchImpl: fetchOk(), onState },
    );
    peer.connectionState = 'connected';
    peer.listeners['connectionstatechange']!(undefined);
    expect(onState).toHaveBeenCalledWith('connected');
  });

  it('throws a WHEP-unconfigured message on 503 and closes the pc', async () => {
    const peer = fakePeer();
    const fetch503: FetchFn = vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => '',
    }));
    await expect(
      startWhep({ endpoint: ENDPOINT, key: 'k' }, { createPeer: () => peer, fetchImpl: fetch503 }),
    ).rejects.toThrow(/not available.*503/);
    expect(peer.closed).toBe(true);
  });

  it('throws on an empty answer body', async () => {
    const peer = fakePeer();
    const fetchEmpty: FetchFn = vi.fn(async () => ({
      ok: true,
      status: 201,
      headers: { get: () => null },
      text: async () => '   ',
    }));
    await expect(
      startWhep({ endpoint: ENDPOINT, key: 'k' }, { createPeer: () => peer, fetchImpl: fetchEmpty }),
    ).rejects.toThrow(/empty SDP answer/);
    expect(peer.closed).toBe(true);
  });
});

describe('startWhep — teardown', () => {
  it('stop() DELETEs the resource with the Bearer and closes the pc', async () => {
    const peer = fakePeer();
    const fetchImpl = fetchOk();
    const session = await startWhep(
      { endpoint: ENDPOINT, key: 'k' },
      { createPeer: () => peer, fetchImpl },
    );
    await session.stop();

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const del = calls[1]!;
    expect(del[0]).toBe('https://api.wave.online/v1/whep/resource/abc123');
    expect((del[1] as { method: string }).method).toBe('DELETE');
    expect(peer.closed).toBe(true);
  });

  it('stop() is idempotent (second call is a no-op)', async () => {
    const peer = fakePeer();
    const fetchImpl = fetchOk();
    const session = await startWhep(
      { endpoint: ENDPOINT, key: 'k' },
      { createPeer: () => peer, fetchImpl },
    );
    await session.stop();
    await session.stop();
    const deletes = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => (c[1] as { method: string }).method === 'DELETE',
    );
    expect(deletes).toHaveLength(1);
  });

  it('stop() still closes the pc when the resource DELETE fails', async () => {
    const peer = fakePeer();
    const fetchImpl: FetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: { get: () => '/v1/whep/resource/x' },
        text: async () => ANSWER,
      })
      .mockRejectedValueOnce(new Error('network'));
    const session = await startWhep(
      { endpoint: ENDPOINT, key: 'k' },
      { createPeer: () => peer, fetchImpl },
    );
    await session.stop();
    expect(peer.closed).toBe(true);
  });
});
