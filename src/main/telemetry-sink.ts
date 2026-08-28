/**
 * Main-process telemetry sink (#74.c).
 *
 * The renderer emits `TelemetryEvent`s (see @shared/telemetry) over IPC; this
 * module is where they land in the main process. Today the sink is a structured
 * `console` line (picked up by the packaged app's log stream / Sentry
 * breadcrumbs); the `record()` seam is deliberately narrow so a real transport
 * (OTLP, Sentry, a gateway usage beacon) can be dropped in without touching the
 * IPC handler or the renderer.
 *
 * Validation happens at the IPC boundary (ipc.ts `.parse()`); `record()` trusts
 * its already-parsed input.
 */

import type { TelemetryEvent } from '@shared/telemetry';

/** A pluggable emit target — defaults to a structured console line. */
export type TelemetryEmit = (line: string, event: TelemetryEvent) => void;

const defaultEmit: TelemetryEmit = (line) => {
  console.log(line);
};

let emit: TelemetryEmit = defaultEmit;

/** Swap the emit target (tests inject a spy; a future wiring injects a real sink). */
export function setTelemetryEmit(next: TelemetryEmit): void {
  emit = next;
}

/** Reset to the default console emit (test cleanup). */
export function resetTelemetryEmit(): void {
  emit = defaultEmit;
}

/**
 * Render a telemetry event to a single structured, greppable line. Kept pure so
 * it is trivially testable and so the exact wire format is asserted in one place.
 * Only whitelisted fields are formatted — no spread of arbitrary keys — so a
 * future schema field can never leak an unexpected value into the log.
 */
export function formatEvent(ev: TelemetryEvent): string {
  const parts: string[] = [`[wave-telemetry] ${ev.kind}`, `session=${ev.session}`];
  if ('transport' in ev && ev.transport) parts.push(`transport=${ev.transport}`);
  switch (ev.kind) {
    case 'session-start':
      if (ev.videoCodec) parts.push(`video=${ev.videoCodec}`);
      if (ev.audioCodec) parts.push(`audio=${ev.audioCodec}`);
      break;
    case 'session-stop':
      if (ev.durationSec != null) parts.push(`durationSec=${ev.durationSec}`);
      if (ev.bytes != null) parts.push(`bytes=${ev.bytes}`);
      if (ev.reason) parts.push(`reason=${ev.reason}`);
      break;
    case 'state':
      parts.push(`state=${ev.state}`);
      break;
    case 'error':
      parts.push(`code=${ev.code}`, `message=${JSON.stringify(ev.message)}`);
      break;
    default: {
      // Exhaustiveness guard: a new TelemetryEventSchema variant that isn't
      // handled above becomes a compile-time error here, instead of silently
      // dropping its kind-specific fields from the log line.
      const _exhaustive: never = ev;
      void _exhaustive;
    }
  }
  return parts.join(' ');
}

/** Record one already-validated telemetry event through the active sink. */
export function record(ev: TelemetryEvent): void {
  emit(formatEvent(ev), ev);
}
