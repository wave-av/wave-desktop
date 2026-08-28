import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatEvent,
  record,
  setTelemetryEmit,
  resetTelemetryEmit,
} from './telemetry-sink';
import type { TelemetryEvent } from '@shared/telemetry';

afterEach(() => resetTelemetryEmit());

describe('formatEvent', () => {
  it('formats a session-start with codecs', () => {
    const ev: TelemetryEvent = {
      kind: 'session-start',
      session: 's1',
      transport: 'whep-subscribe',
      videoCodec: 'av1',
      audioCodec: 'opus',
    };
    expect(formatEvent(ev)).toBe(
      '[wave-telemetry] session-start session=s1 transport=whep-subscribe video=av1 audio=opus',
    );
  });

  it('formats a session-stop with duration/bytes/reason', () => {
    const ev: TelemetryEvent = {
      kind: 'session-stop',
      session: 's1',
      transport: 'whip-publish',
      durationSec: 42,
      bytes: 1024,
      reason: 'stopped',
    };
    expect(formatEvent(ev)).toBe(
      '[wave-telemetry] session-stop session=s1 transport=whip-publish durationSec=42 bytes=1024 reason=stopped',
    );
  });

  it('formats an error with a JSON-quoted message (never raw)', () => {
    const ev: TelemetryEvent = {
      kind: 'error',
      session: 's1',
      transport: 'whep-subscribe',
      code: 'whep_subscribe_failed',
      message: 'boom "quoted"',
    };
    expect(formatEvent(ev)).toBe(
      '[wave-telemetry] error session=s1 transport=whep-subscribe code=whep_subscribe_failed message="boom \\"quoted\\""',
    );
  });

  it('formats a state transition', () => {
    const ev: TelemetryEvent = {
      kind: 'state',
      session: 's1',
      transport: 'whep-subscribe',
      state: 'connected',
    };
    expect(formatEvent(ev)).toBe(
      '[wave-telemetry] state session=s1 transport=whep-subscribe state=connected',
    );
  });
});

describe('record', () => {
  it('routes the formatted line + event through the active emit', () => {
    const emit = vi.fn();
    setTelemetryEmit(emit);
    const ev: TelemetryEvent = { kind: 'state', session: 's1', transport: 'whip-publish', state: 'live' };
    record(ev);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toContain('state=live');
    expect(emit.mock.calls[0]![1]).toBe(ev);
  });
});
