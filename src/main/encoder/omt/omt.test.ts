/**
 * OMT wiring tests (#158, GA #74). We test what is testable WITHOUT the native
 * libomt binding:
 *   1. the schema accepts a typed OMT source config (quality defaults to full);
 *   2. buildOmtArgs wires an OMT format → rawvideo-stdin → encoder → SRT tail;
 *   3. the source controller routes decoded frames into ffmpeg's stdin;
 *   4. the capability gate FAILS CLOSED (actionable #168 error) when the native
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
import { buildOmtArgs, omtInputArgs } from './omt-args.ts';
import { OmtSourceController } from './source.ts';
import { resolveOmtAdapter, OmtUnavailableError, OMT_UNAVAILABLE_CODE } from './capability.ts';
import type { OmtReceiver, OmtTransportAdapter, OmtVideoFrame, OmtVideoFormat } from './types.ts';

const FORMAT: OmtVideoFormat = {
  width: 1920,
  height: 1080,
  frameRateN: 30000,
  frameRateD: 1001,
  fourCC: 'UYVY',
};
const target = { host: 'ingest.wave.online', port: 6000, streamKey: 'abc12345' };

// ── 1. schema ────────────────────────────────────────────────────────────────
describe('EncoderSourceSchema (omt)', () => {
  it('accepts an omt source and defaults quality to full', () => {
    const parsed = EncoderSourceSchema.parse({ kind: 'omt', sourceName: 'STUDIO-PC (Program)' });
    expect(parsed).toEqual({ kind: 'omt', sourceName: 'STUDIO-PC (Program)', quality: 'full' });
  });

  it('accepts an explicit preview (proxy) quality', () => {
    const parsed = EncoderSourceSchema.parse({ kind: 'omt', sourceName: 'prog', quality: 'preview' });
    expect(parsed.kind === 'omt' && parsed.quality).toBe('preview');
  });

  it('rejects an empty OMT source name and an unknown quality', () => {
    expect(() => EncoderSourceSchema.parse({ kind: 'omt', sourceName: '' })).toThrow();
    expect(() =>
      EncoderSourceSchema.parse({ kind: 'omt', sourceName: 'prog', quality: 'medium' }),
    ).toThrow();
  });
});

// ── 2. arg builder ───────────────────────────────────────────────────────────
describe('buildOmtArgs', () => {
  it('reads rawvideo from stdin dimensioned to the OMT format, then the shared encoder+SRT tail', () => {
    const argv = buildOmtArgs(FORMAT, 'h264', target);
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

  it('maps NV12/BGRA and rejects an unsupported pixel format / bad geometry', () => {
    expect(omtInputArgs({ ...FORMAT, fourCC: 'NV12' })).toContain('nv12');
    expect(omtInputArgs({ ...FORMAT, fourCC: 'BGRA' })).toContain('bgra');
    expect(() => omtInputArgs({ ...FORMAT, fourCC: 'YUYV' as never })).toThrow(/pixel format/);
    expect(() => omtInputArgs({ ...FORMAT, width: 0 })).toThrow(/width/);
  });
});

// ── test doubles ─────────────────────────────────────────────────────────────
function fakeReceiver(frames: OmtVideoFrame[]): OmtReceiver {
  return {
    sourceName: 'prog',
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

const omtReq: EncoderStartRequest = {
  source: { kind: 'omt', sourceName: 'prog', quality: 'full' },
  streamKey: 'abc12345',
  codec: 'h264',
};

// ── 3. routing ───────────────────────────────────────────────────────────────
describe('OmtSourceController routing', () => {
  it('spawns ffmpeg dimensioned to the first frame and writes decoded frames to stdin', async () => {
    const data = Buffer.from([1, 2, 3, 4]);
    const frame: OmtVideoFrame = { format: FORMAT, data, timestamp100ns: 0n };
    const adapter: OmtTransportAdapter = {
      available: true,
      discover: vi.fn(async () => [{ name: 'prog' }]),
      openReceiver: vi.fn(async () => fakeReceiver([frame])),
    };
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;

    const controller = new OmtSourceController({
      ffmpegBinary: '/usr/bin/ffmpeg',
      resolveAdapter: async () => adapter,
      spawnFn,
    });

    const handle = await controller.start(omtReq, target);
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
describe('OMT capability gate (fail closed, #168)', () => {
  it('resolveOmtAdapter throws an actionable #168 error when the binding is absent', async () => {
    // default loader dynamic-imports a package that is NOT installed → rejects
    await expect(resolveOmtAdapter()).rejects.toBeInstanceOf(OmtUnavailableError);
    await expect(resolveOmtAdapter()).rejects.toMatchObject({ code: OMT_UNAVAILABLE_CODE });
    await expect(resolveOmtAdapter()).rejects.toThrow(/#168/);
  });

  it('throws when a module loads but exposes no adapter factory', async () => {
    await expect(resolveOmtAdapter(async () => ({}))).rejects.toThrow(/#168/);
  });

  it('throws when the adapter reports available=false', async () => {
    const dead = { available: false } as unknown as OmtTransportAdapter;
    await expect(
      resolveOmtAdapter(async () => ({ createOmtAdapter: () => dead })),
    ).rejects.toThrow(/available=false/);
  });

  it('the source controller fails closed and NEVER spawns ffmpeg when OMT is unprovisioned', async () => {
    const spawnFn = vi.fn() as unknown as typeof import('node:child_process').spawn;
    const controller = new OmtSourceController({ ffmpegBinary: '/usr/bin/ffmpeg', spawnFn });
    await expect(controller.start(omtReq, target)).rejects.toThrow(/#168/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
