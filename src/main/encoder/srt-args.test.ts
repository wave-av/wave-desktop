/**
 * Argv-builder tests. These pin the argv shape because ffmpeg flag order /
 * spelling errors won't surface until an actual stream attempt fails — by
 * which point the operator has already pulled out their hair.
 */

import { describe, it, expect } from 'vitest';
import { buildArgs } from './srt-args.ts';
import type { EncoderStartRequest } from '@shared/ipc';

const target = { host: 'ingest.wave.online', port: 6000, streamKey: 'abc12345' };

function req(overrides: Partial<EncoderStartRequest> = {}): EncoderStartRequest {
  return {
    source: { kind: 'file', path: '/tmp/sample.mp4' },
    streamKey: 'abc12345',
    codec: 'h264',
    ...overrides,
  };
}

describe('buildArgs', () => {
  it('builds a libx264 + aac mpegts pipeline pointing at the SRT URL', () => {
    const argv = buildArgs(req(), target);
    expect(argv).toContain('-c:v');
    expect(argv).toContain('libx264');
    expect(argv).toContain('-c:a');
    expect(argv).toContain('aac');
    expect(argv).toContain('-f');
    expect(argv).toContain('mpegts');
    const srt = argv[argv.length - 1] ?? '';
    expect(srt).toMatch(/^srt:\/\/ingest\.wave\.online:6000\?streamid=abc12345&mode=caller&latency=120000$/);
  });

  it('places the stream key in the streamid query param', () => {
    // Valid keys are constrained to [a-zA-Z0-9._-]{8,128}, none of which need
    // URL escaping. The encodeURIComponent call is defense-in-depth in case
    // the regex is relaxed later — verify it's wired in by passing a key with
    // characters that survive encoding unchanged.
    const argv = buildArgs(req(), { ...target, streamKey: 'op_jake-2026.06' });
    expect(argv[argv.length - 1]).toContain('streamid=op_jake-2026.06');
  });

  it('rejects stream keys containing URL-unsafe chars (defense-in-depth)', () => {
    expect(() =>
      buildArgs(req(), { ...target, streamKey: 'a+b/c-12345' }),
    ).toThrow(/stream key shape/);
  });

  it('selects libx265 for hevc', () => {
    const argv = buildArgs(req({ codec: 'hevc' }), target);
    expect(argv).toContain('libx265');
    expect(argv).toContain('-tag:v');
  });

  it('selects libsvtav1 for av1', () => {
    const argv = buildArgs(req({ codec: 'av1' }), target);
    expect(argv).toContain('libsvtav1');
  });

  it('throws a clear error when av2 is requested (upstream-gated #170)', () => {
    expect(() => buildArgs(req({ codec: 'av2' }), target)).toThrow(/codec-watch/);
  });

  it('builds an NDI input via the libndi_newtek device', () => {
    const argv = buildArgs(req({ source: { kind: 'ndi', sourceName: 'DEV-5 (Camera 1)' } }), target);
    const i = argv.indexOf('libndi_newtek');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i - 1]).toBe('-f');
    // Source name is one argv element — spaces/parens ride along untouched
    // (no shell), so it must be present verbatim as its own token.
    expect(argv[i + 1]).toBe('-i');
    expect(argv[i + 2]).toBe('DEV-5 (Camera 1)');
  });

  it('builds an OMT input via the libomt device', () => {
    const argv = buildArgs(req({ source: { kind: 'omt', sourceName: 'HOST (Feed A)' } }), target);
    const i = argv.indexOf('libomt');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i - 1]).toBe('-f');
    expect(argv[i + 1]).toBe('-i');
    expect(argv[i + 2]).toBe('HOST (Feed A)');
  });

  it('builds a Dante audio input via the current-OS audio device', () => {
    const argv = buildArgs(req({ source: { kind: 'dante', channelId: '2' } }), target);
    // Exactly one of the per-OS audio-capture formats must appear.
    const hasAudioFormat =
      argv.includes('avfoundation') || argv.includes('alsa') || argv.includes('dshow');
    expect(hasAudioFormat).toBe(true);
    expect(argv).toContain('-i');
  });

  it('never wraps NDI/OMT source names in quotes or splits on spaces (spawn is shell-free)', () => {
    const argv = buildArgs(req({ source: { kind: 'ndi', sourceName: 'a b; rm -rf /' } }), target);
    // The whole string is a single argv element — no shell metachar can bite.
    expect(argv).toContain('a b; rm -rf /');
    expect(argv).not.toContain('a');
    expect(argv).not.toContain('"a b; rm -rf /"');
  });

  it('rejects an invalid SRT host (no shell injection via host string)', () => {
    expect(() =>
      buildArgs(req(), { ...target, host: 'ingest.wave.online; rm -rf /' }),
    ).toThrow(/invalid SRT host/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => buildArgs(req(), { ...target, port: 0 })).toThrow(/invalid SRT port/);
    expect(() => buildArgs(req(), { ...target, port: 99999 })).toThrow(/invalid SRT port/);
  });

  it('rejects a short or weirdly-shaped stream key', () => {
    expect(() => buildArgs(req(), { ...target, streamKey: 'short' })).toThrow(/stream key shape/);
    expect(() =>
      buildArgs(req(), { ...target, streamKey: 'has spaces and @ chars' }),
    ).toThrow(/stream key shape/);
  });

  it('does NOT emit -progress pipe:2 (multi-line format that stats-parser cannot consume)', () => {
    // Cubic + Sentry flagged this on PR #10: `-progress pipe:2` emits
    // multi-line key=value blocks, but stats-parser.ts expects ffmpeg's
    // single-line interactive stats. Until the parser learns the
    // multi-line format we rely on the default stderr stats line.
    const argv = buildArgs(req(), target);
    expect(argv).not.toContain('-progress');
    expect(argv).not.toContain('pipe:2');
  });

  it('accepts bracketed IPv6 SRT targets', () => {
    const argv = buildArgs(req(), { ...target, host: '[2001:db8::1]' });
    const url = argv[argv.length - 1] ?? '';
    expect(url).toContain('srt://[2001:db8::1]:6000');
  });

  it('still rejects unbracketed IPv6 / shell-special characters in host', () => {
    expect(() => buildArgs(req(), { ...target, host: '2001:db8::1' })).toThrow(/invalid SRT host/);
    expect(() => buildArgs(req(), { ...target, host: 'host; rm -rf /' })).toThrow(/invalid SRT host/);
  });
});
