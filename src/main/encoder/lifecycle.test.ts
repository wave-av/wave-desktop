/**
 * Capability-gate tests for the encoder lifecycle. We only exercise the pure
 * `assertCapable` guard here — `start()` itself spawns ffmpeg, which the unit
 * suite deliberately avoids (see binary-resolver.test.ts rationale). The guard
 * is what turns a missing-build into an actionable error before spawn.
 */

import { describe, it, expect } from 'vitest';
import { assertCapable } from './lifecycle.ts';
import type { EncoderStartRequest } from '@shared/ipc';

function req(source: EncoderStartRequest['source']): EncoderStartRequest {
  return { source, streamKey: 'abc12345', codec: 'h264' };
}

describe('assertCapable', () => {
  it('throws an actionable error when NDI is requested but the build lacks it', () => {
    expect(() =>
      assertCapable(req({ kind: 'ndi', sourceName: 'cam1' }), { hasNdi: false, hasOmt: true }),
    ).toThrow(/--enable-libndi_newtek/);
  });

  it('throws an actionable error when OMT is requested but the build lacks it', () => {
    expect(() =>
      assertCapable(req({ kind: 'omt', sourceName: 'HOST (feed)' }), { hasNdi: true, hasOmt: false }),
    ).toThrow(/--enable-libomt/);
  });

  it('passes NDI/OMT through when the build has the device', () => {
    expect(() =>
      assertCapable(req({ kind: 'ndi', sourceName: 'cam1' }), { hasNdi: true, hasOmt: true }),
    ).not.toThrow();
    expect(() =>
      assertCapable(req({ kind: 'omt', sourceName: 'HOST (feed)' }), { hasNdi: true, hasOmt: true }),
    ).not.toThrow();
  });

  it('never blocks source kinds that need no special build', () => {
    // Dante rides an OS audio device; file/screen/camera need nothing special.
    // Even with an empty capability set, none of these should be gated.
    for (const source of [
      { kind: 'dante', channelId: '2' } as const,
      { kind: 'file', path: '/tmp/x.mp4' } as const,
      { kind: 'camera', deviceId: '0' } as const,
    ]) {
      expect(() => assertCapable(req(source), { hasNdi: false, hasOmt: false })).not.toThrow();
    }
  });

  it('does not gate when capabilities are unknown (undefined) — probe is the caller’s job', () => {
    // When capabilities is omitted we assume the caller already probed; the
    // guard only fires on a *known-absent* capability.
    expect(() => assertCapable(req({ kind: 'ndi', sourceName: 'cam1' }))).not.toThrow();
  });
});
