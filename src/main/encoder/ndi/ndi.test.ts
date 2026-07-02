/**
 * NDI wiring tests (#157). We test what is testable WITHOUT the native SDK:
 *   1. the schema accepts a typed NDI source config;
 *   2. buildNdiArgs wires an NDI format → rawvideo-stdin → encoder → SRT tail;
 *   3. the source controller routes decoded frames into ffmpeg's stdin;
 *   4. the capability gate FAILS CLOSED (actionable #169 error) when the
 *      native binding is absent — and never spawns ffmpeg in that case.
 *
 * The fake adapter/child used in (3) are TEST DOUBLES only. Production code
 * synthesizes nothing: with no native binding there is no receiver and no
 * stream (proven by (4)).
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
// Relative import: vitest here has no `@shared` runtime alias (existing tests
// only import it type-only), so we reach the schema value directly.
import { EncoderSourceSchema, type EncoderStartRequest } from '../../../shared/ipc.ts';
import { buildNdiArgs, ndiInputArgs } from './ndi-args.ts';
import { NdiSourceController } from './source.ts';
import { resolveNdiAdapter, NdiUnavailableError, NDI_UNAVAILABLE_CODE } from './capability.ts';
import type { NdiReceiver, NdiTransportAdapter, NdiVideoFrame, NdiVideoFormat } from './types.ts';

const FORMAT: NdiVideoFormat = {
  width: 1920,
  height: 1080,
  frameRateN: 30000,
  frameRateD: 1001,
  fourCC: 'UYVY',
};
const target = { host: 'ingest.wave.online', port: 6000, streamKey: 'abc12345' };

// ── 1. schema ────────────────────────────────────────────────────────────────
describe('EncoderSourceSchema (ndi)', () => {
  it('accepts an ndi source and defaults bandwidth to highest', () => {
    const parsed = EncoderSourceSchema.parse({ kind: 'ndi', sourceName: 'STUDIO-PC (Cam 1)' });
    expect(parsed).toEqual({ kind: 'ndi', sourceName: 'STUDIO-PC (Cam 1)', bandwidth: 'highest' });
  });

  it('accepts an explicit lowest (proxy) bandwidth', () => {
    const parsed = EncoderSourceSchema.parse({ kind: 'ndi', sourceName: 'cam1', bandwidth: 'lowest' });
    expect(parsed.kind === 'ndi' && parsed.bandwidth).toBe('lowest');
  });

  it('rejects an empty NDI source name and an unknown bandwidth', () => {
    expect(() => EncoderSourceSchema.parse({ kind: 'ndi', sourceName: '' })).toThrow();
    expect(() =>
      EncoderSourceSchema.parse({ kind: 'ndi', sourceName: 'cam1', bandwidth: 'medium' }),
    ).toThrow();
  });
});

// ── 2. arg builder ───────────────────────────────────────────────────────────
describe('buildNdiArgs', () => {
  it('reads rawvideo from stdin dimensioned to the NDI format, then the shared encoder+SRT tail', () => {
    const argv = buildNdiArgs(FORMAT, 'h264', target);
    expect(argv).toContain('rawvideo');
    expect(argv).toContain('-pixel_format');
    expect(argv).toContain('uyvy422');
    expect(argv).toContain('1920x1080');
    expect(argv).toContain('30000/1001');
    expect(argv).toContain('pipe:0');
    // shared tail: same encoder + same SRT caller URL as every other source
    expect(argv).toContain('libx264');
    expect(argv[argv.length - 1]).toMatch(
      /^srt:\/\/ingest\.wave\.online:6000\?streamid=abc12345&mode=caller&latency=120000$/,
    );
  });

  it('maps BGRA and rejects an unsupported pixel format / bad geometry', () => {
    expect(ndiInputArgs({ ...FORMAT, fourCC: 'BGRA' })).toContain('bgra');
    expect(() => ndiInputArgs({ ...FORMAT, fourCC: 'YUYV' as never })).toThrow(/pixel format/);
    expect(() => ndiInputArgs({ ...FORMAT, width: 0 })).toThrow(/width/);
  });
});

// ── test doubles ─────────────────────────────────────────────────────────────
function fakeReceiver(frames: NdiVideoFrame[]): NdiReceiver {
  return {
    sourceName: 'cam1',
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

const ndiReq: EncoderStartRequest = {
  source: { kind: 'ndi', sourceName: 'cam1', bandwidth: 'highest' },
  streamKey: 'abc12345',
  codec: 'h264',
};

// ── 3. routing ───────────────────────────────────────────────────────────────
describe('NdiSourceController routing', () => {
  it('spawns ffmpeg dimensioned to the first frame and writes decoded frames to stdin', async () => {
    const data = Buffer.from([1, 2, 3, 4]);
    const frame: NdiVideoFrame = { format: FORMAT, data, timestamp100ns: 0n };
    const adapter: NdiTransportAdapter = {
      available: true,
      discover: vi.fn(async () => [{ name: 'cam1' }]),
      openReceiver: vi.fn(async () => fakeReceiver([frame])),
    };
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;

    const controller = new NdiSourceController({
      ffmpegBinary: '/usr/bin/ffmpeg',
      resolveAdapter: async () => adapter,
      spawnFn,
    });

    const handle = await controller.start(ndiReq, target);
    // let the async frame pump run
    await new Promise((r) => setTimeout(r, 10));

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const passedArgs = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as string[];
    expect(passedArgs).toContain('rawvideo');
    expect(passedArgs).toContain('1920x1080');
    expect(passedArgs[passedArgs.length - 1]).toContain('srt://ingest.wave.online:6000');
    expect(child.stdin.write).toHaveBeenCalledWith(data);
    expect(handle.id).toMatch(/[0-9a-f-]{36}/);
  });
});

// ── 4. fail-closed capability gate ───────────────────────────────────────────
describe('NDI capability gate (fail closed, #169)', () => {
  it('resolveNdiAdapter throws an actionable #169 error when the binding is absent', async () => {
    // default loader dynamic-imports a package that is NOT installed → rejects
    await expect(resolveNdiAdapter()).rejects.toBeInstanceOf(NdiUnavailableError);
    await expect(resolveNdiAdapter()).rejects.toMatchObject({ code: NDI_UNAVAILABLE_CODE });
    await expect(resolveNdiAdapter()).rejects.toThrow(/#169/);
  });

  it('throws when a module loads but exposes no adapter factory', async () => {
    await expect(resolveNdiAdapter(async () => ({}))).rejects.toThrow(/#169/);
  });

  it('throws when the adapter reports available=false', async () => {
    const dead = { available: false } as unknown as NdiTransportAdapter;
    await expect(
      resolveNdiAdapter(async () => ({ createNdiAdapter: () => dead })),
    ).rejects.toThrow(/available=false/);
  });

  it('the source controller fails closed and NEVER spawns ffmpeg when NDI is unprovisioned', async () => {
    const spawnFn = vi.fn() as unknown as typeof import('node:child_process').spawn;
    const controller = new NdiSourceController({ ffmpegBinary: '/usr/bin/ffmpeg', spawnFn });
    await expect(controller.start(ndiReq, target)).rejects.toThrow(/#169/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
