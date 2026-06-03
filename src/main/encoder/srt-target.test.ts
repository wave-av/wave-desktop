/**
 * Tests for the SRT-target derivation helper that lives in ipc.ts. We test
 * via the exported pure function rather than spinning up the IPC layer.
 *
 * Why this lives next to encoder/ rather than next to ipc.ts: the encoder
 * directory already owns SRT plumbing; keeping the test file near the
 * related target/argv tests means a single grep finds every SRT contract
 * pin.
 */

import { describe, it, expect } from 'vitest';
import { deriveSrtTarget } from './srt-target.ts';

describe('deriveSrtTarget', () => {
  it('rewrites api.wave.online → ingest.wave.online', () => {
    const t = deriveSrtTarget('https://api.wave.online', 'op_jake_2026');
    expect(t.host).toBe('ingest.wave.online');
    expect(t.port).toBe(6000);
    expect(t.streamKey).toBe('op_jake_2026');
  });

  it('rewrites only the leading api. prefix (not anywhere in the host)', () => {
    const t = deriveSrtTarget('https://api.staging.wave.online', 'op_jake_2026');
    expect(t.host).toBe('ingest.staging.wave.online');
  });

  it('leaves a non-api. host untouched', () => {
    const t = deriveSrtTarget('https://gateway.dev.wave.online', 'op_jake_2026');
    expect(t.host).toBe('gateway.dev.wave.online');
  });

  it('falls back to ingest.wave.online on malformed gatewayBase', () => {
    const t = deriveSrtTarget('not a url at all', 'op_jake_2026');
    expect(t.host).toBe('ingest.wave.online');
  });

  it('passes the streamKey through unchanged', () => {
    const t = deriveSrtTarget('https://api.wave.online', 'k_with-dots.and_underscores-42');
    expect(t.streamKey).toBe('k_with-dots.and_underscores-42');
  });

  it('strips any HTTP port from gatewayBase (URL.hostname, not URL.host)', () => {
    // Cubic flagged this on PR #11: URL.host returns 'api.wave.online:8443'
    // when a non-default port is set, which then becomes
    // 'srt://ingest.wave.online:8443:6000' — broken. URL.hostname returns
    // just the host portion.
    const t = deriveSrtTarget('https://api.wave.online:8443', 'op_jake_2026');
    expect(t.host).toBe('ingest.wave.online');
    expect(t.port).toBe(6000);
    // Defense-in-depth — no colon should ever appear in the host portion.
    expect(t.host).not.toContain(':');
  });
});
