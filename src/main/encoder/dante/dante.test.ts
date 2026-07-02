/**
 * Dante wiring tests (#159, GA #74). We test what is testable WITHOUT the native
 * Audinate SDK:
 *   1. the schema accepts a typed Dante source config;
 *   2. buildDanteArgs wires a Dante PCM format → rawaudio-stdin → AAC → SRT tail
 *      (audio-only: no video codec);
 *   3. the source controller routes decoded PCM buffers into ffmpeg's stdin;
 *   4. the capability gate FAILS CLOSED (actionable #160 error) when the native
 *      binding is absent — and never spawns ffmpeg in that case.
 *
 * The fake adapter/child used in (3) are TEST DOUBLES only. Production code
 * synthesizes nothing: with no native binding there is no receiver and no stream
 * (proven by (4)).
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
// Relative import: vitest here has no `@shared` runtime alias (existing tests
// only import it type-only), so we reach the schema value directly.
import { EncoderSourceSchema, type EncoderStartRequest } from '../../../shared/ipc.ts';
import { buildDanteArgs, danteInputArgs } from './dante-args.ts';
import { DanteSourceController } from './source.ts';
import { resolveDanteAdapter, DanteUnavailableError, DANTE_UNAVAILABLE_CODE } from './capability.ts';
import type { DanteAudioFormat, DanteAudioFrame, DanteReceiver, DanteTransportAdapter } from './types.ts';

const FORMAT: DanteAudioFormat = { sampleRate: 48000, channels: 2, pcm: 's24le' };
const target = { host: 'ingest.wave.online', port: 6000, streamKey: 'abc12345' };

// ── 1. schema ────────────────────────────────────────────────────────────────
describe('EncoderSourceSchema (dante)', () => {
  it('accepts a dante source with a channel id', () => {
    const parsed = EncoderSourceSchema.parse({ kind: 'dante', channelId: 'MixerA@stagebox-01' });
    expect(parsed).toEqual({ kind: 'dante', channelId: 'MixerA@stagebox-01' });
  });

  it('rejects an empty Dante channel id', () => {
    expect(() => EncoderSourceSchema.parse({ kind: 'dante', channelId: '' })).toThrow();
  });
});

// ── 2. arg builder ───────────────────────────────────────────────────────────
describe('buildDanteArgs', () => {
  it('reads rawaudio PCM from stdin, encodes AAC, and lands on the shared SRT tail', () => {
    const argv = buildDanteArgs(FORMAT, target);
    expect(argv).toContain('-f');
    expect(argv).toContain('s24le');
    expect(argv).toContain('-ar');
    expect(argv).toContain('48000');
    expect(argv).toContain('-ac');
    expect(argv).toContain('2');
    expect(argv).toContain('pipe:0');
    // AAC audio tail — and NO video codec (audio-only source)
    expect(argv).toContain('aac');
    expect(argv).not.toContain('-c:v');
    expect(argv).not.toContain('libx264');
    expect(argv[argv.length - 1]).toMatch(
      /^srt:\/\/ingest\.wave\.online:6000\?streamid=abc12345&mode=caller&latency=120000$/,
    );
  });

  it('scales AAC bitrate with channel count and rejects bad formats / geometry', () => {
    // 8-channel flow → 8*64=512k (capped)
    expect(buildDanteArgs({ ...FORMAT, channels: 8 }, target)).toContain('512k');
    expect(() => danteInputArgs({ ...FORMAT, pcm: 'f32le' as never })).toThrow(/PCM format/);
    expect(() => danteInputArgs({ ...FORMAT, sampleRate: 0 })).toThrow(/sample rate/);
    expect(() => danteInputArgs({ ...FORMAT, channels: 0 })).toThrow(/channel count/);
    expect(() => danteInputArgs({ ...FORMAT, channels: 128 })).toThrow(/channel count/);
  });
});

// ── test doubles ─────────────────────────────────────────────────────────────
function fakeReceiver(frames: DanteAudioFrame[]): DanteReceiver {
  return {
    channelId: 'MixerA@stagebox-01',
    async *frames() {
      for (const f of frames) yield f;
    },
    close: vi.fn(async () => {}),
  };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

const danteReq: EncoderStartRequest = {
  source: { kind: 'dante', channelId: 'MixerA@stagebox-01' },
  streamKey: 'abc12345',
  codec: 'h264', // ignored for audio-only Dante, but required by the schema
};

// ── 3. routing ───────────────────────────────────────────────────────────────
describe('DanteSourceController routing', () => {
  it('spawns ffmpeg dimensioned to the first PCM buffer and writes decoded audio to stdin', async () => {
    const data = Buffer.from([1, 2, 3, 4, 5, 6]);
    const frame: DanteAudioFrame = { format: FORMAT, data, timestamp100ns: 0n };
    const adapter: DanteTransportAdapter = {
      available: true,
      discover: vi.fn(async () => [{ channelId: 'MixerA@stagebox-01' }]),
      openReceiver: vi.fn(async () => fakeReceiver([frame])),
    };
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;

    const controller = new DanteSourceController({
      ffmpegBinary: '/usr/bin/ffmpeg',
      resolveAdapter: async () => adapter,
      spawnFn,
    });

    const handle = await controller.start(danteReq, target);
    await new Promise((r) => setTimeout(r, 10));

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const passedArgs = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as string[];
    expect(passedArgs).toContain('s24le');
    expect(passedArgs).toContain('aac');
    expect(passedArgs[passedArgs.length - 1]).toContain('srt://ingest.wave.online:6000');
    expect(child.stdin.write).toHaveBeenCalledWith(data);
    expect(handle.id).toMatch(/[0-9a-f-]{36}/);
  });
});

// ── 4. fail-closed capability gate ───────────────────────────────────────────
describe('Dante capability gate (fail closed, #160)', () => {
  it('resolveDanteAdapter throws an actionable #160 error when the binding is absent', async () => {
    await expect(resolveDanteAdapter()).rejects.toBeInstanceOf(DanteUnavailableError);
    await expect(resolveDanteAdapter()).rejects.toMatchObject({ code: DANTE_UNAVAILABLE_CODE });
    await expect(resolveDanteAdapter()).rejects.toThrow(/#160/);
  });

  it('throws when a module loads but exposes no adapter factory', async () => {
    await expect(resolveDanteAdapter(async () => ({}))).rejects.toThrow(/#160/);
  });

  it('throws when the adapter reports available=false', async () => {
    const dead = { available: false } as unknown as DanteTransportAdapter;
    await expect(
      resolveDanteAdapter(async () => ({ createDanteAdapter: () => dead })),
    ).rejects.toThrow(/available=false/);
  });

  it('the source controller fails closed and NEVER spawns ffmpeg when Dante is unprovisioned', async () => {
    const spawnFn = vi.fn() as unknown as typeof import('node:child_process').spawn;
    const controller = new DanteSourceController({ ffmpegBinary: '/usr/bin/ffmpeg', spawnFn });
    await expect(controller.start(danteReq, target)).rejects.toThrow(/#160/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
