/**
 * Stats-parser unit tests. We pin the exact ffmpeg progress-line shape
 * because if upstream ever drifts the format we want the test to scream
 * before a user sees garbage stats in the UI.
 */

import { describe, it, expect } from 'vitest';
import { parseProgressLine, consumeChunk, type ParseState } from './stats-parser.ts';

describe('parseProgressLine', () => {
  it('parses a standard ffmpeg progress line', () => {
    const line =
      'frame=  120 fps= 30 q=28.0 size=    2048kB time=00:00:04.00 bitrate=4194.1kbits/s speed=1.0x';
    const p = parseProgressLine(line);
    expect(p).not.toBeNull();
    expect(p?.frames).toBe(120);
    expect(p?.fps).toBe(30);
    expect(p?.bitrateKbps).toBe(4194.1);
    expect(p?.uptimeSec).toBe(4);
    expect(p?.speed).toBe(1.0);
  });

  it('handles fractional fps + sub-second time', () => {
    const line =
      'frame=    5 fps= 14.5 q=23.0 size=       0kB time=00:00:00.50 bitrate=  16.0kbits/s speed=0.5x';
    const p = parseProgressLine(line);
    expect(p?.fps).toBe(14.5);
    expect(p?.uptimeSec).toBe(0); // floored
    expect(p?.bitrateKbps).toBe(16);
  });

  it('parses HH:MM:SS into seconds correctly', () => {
    const line = 'frame= 1000 fps= 30 q=28.0 size=  100kB time=01:23:45.67 bitrate=100.0kbits/s speed=1.0x';
    const p = parseProgressLine(line);
    expect(p?.uptimeSec).toBe(1 * 3600 + 23 * 60 + 45);
  });

  it('returns null for non-progress lines (banner / config / warnings)', () => {
    expect(parseProgressLine('ffmpeg version 7.1.1 Copyright (c) 2000-2024')).toBeNull();
    expect(parseProgressLine('  configuration: --enable-libx264 --enable-libsrt')).toBeNull();
    expect(parseProgressLine('[mpegts @ 0x7f8d2e80b800] frame size not set')).toBeNull();
    expect(parseProgressLine('')).toBeNull();
  });

  it('returns null for partial / malformed progress', () => {
    expect(parseProgressLine('frame=')).toBeNull();
    expect(parseProgressLine('fps= 30 q=28.0')).toBeNull();
  });
});

describe('consumeChunk', () => {
  it('handles chunked stderr where progress arrives over multiple writes', () => {
    const state: ParseState = { buf: '' };
    const a = consumeChunk(state, 'frame=  120 fps= 30 q=28.0 size=    2048kB time=00:00:04.00 ');
    expect(a).toBeNull();
    const b = consumeChunk(state, 'bitrate=4194.1kbits/s speed=1.0x\n');
    expect(b?.frames).toBe(120);
    expect(b?.bitrateKbps).toBe(4194.1);
  });

  it('handles \\r-style overwrites (ffmpeg default)', () => {
    const state: ParseState = { buf: '' };
    const r = consumeChunk(
      state,
      'frame=  50 fps= 30 q=28.0 size=  500kB time=00:00:01.67 bitrate=2000.0kbits/s speed=0.9x\r' +
        'frame= 120 fps= 30 q=28.0 size= 2048kB time=00:00:04.00 bitrate=4194.1kbits/s speed=1.0x\r',
    );
    // Picks the *latest* progress, not the first.
    expect(r?.frames).toBe(120);
  });

  it('returns null when the chunk contains no progress line', () => {
    const state: ParseState = { buf: '' };
    const r = consumeChunk(state, '[h264 @ 0x12345] profile High, level 4.0\n');
    expect(r).toBeNull();
  });

  it('keeps a partial trailing line buffered for the next chunk', () => {
    const state: ParseState = { buf: '' };
    consumeChunk(state, 'frame=  10 fps= 30 q=28.0 size=  50kB time=00:00:00.33 bit');
    expect(state.buf).toContain('frame=  10');
    const next = consumeChunk(state, 'rate=2000.0kbits/s speed=1.0x\n');
    expect(next?.frames).toBe(10);
    expect(next?.bitrateKbps).toBe(2000);
    expect(state.buf).toBe('');
  });
});
