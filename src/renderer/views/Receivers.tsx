import { useCallback, useEffect, useRef, useState } from 'react';
import { isEncodeBridgeEnabled } from '@shared/flags';
import { newSessionId } from '@shared/telemetry';
import { startWhep, type WhepSession } from '../session/whep-client';

/**
 * Receivers view — the #74.d WHEP PLAYBACK path (the receive/watch counterpart
 * to the Session view's WHIP publish).
 *
 * On "Watch": mint a least-privilege `whep:write` subscribe token, open a
 * recvonly RTCPeerConnection, POST the SDP offer to the gateway's
 * `/v1/whep/subscribe`, apply the answer, and attach the incoming MediaStream to
 * the <video> element. "Stop" DELETEs the WHEP resource + closes the pc.
 *
 * Flag-gated behind `WAVE_ENABLE_ENCODE_BRIDGE` (same gate as publish): with the
 * flag off, the subscribe-token mint rejects, so nothing plays. Media never
 * crosses the IPC bridge — only the small token descriptor does. Session
 * lifecycle telemetry (start/state/stop/error) is emitted via window.wave.telemetry.
 */

type Phase = 'idle' | 'subscribing' | 'playing' | 'error';

export function ReceiversView(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState<string>('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<WhepSession | null>(null);
  const sessionIdRef = useRef<string>('');
  const startedAtRef = useRef<number>(0);
  const bridgeEnabled = isEncodeBridgeEnabled();

  const teardown = useCallback(async (reason: 'stopped' | 'error' | 'quit'): Promise<void> => {
    // Capture + clear the refs up front so a re-entrant teardown (Stop then
    // unmount, a double-click, or a failed watch() then unmount) is a no-op and
    // never re-emits a phantom session-stop. The stop-emit is gated on an actual
    // session having existed, not merely on `sid` being set.
    const session = sessionRef.current;
    sessionRef.current = null;
    const sid = sessionIdRef.current;
    sessionIdRef.current = '';
    try {
      await session?.stop();
    } catch {
      /* best-effort teardown — a failed stop() must not throw out of unmount */
    } finally {
      if (videoRef.current) videoRef.current.srcObject = null;
      if (session && sid) {
        window.wave.telemetry.emit({
          kind: 'session-stop',
          session: sid,
          transport: 'whep-subscribe',
          durationSec: startedAtRef.current ? Math.round((Date.now() - startedAtRef.current) / 1000) : 0,
          reason,
        });
      }
    }
  }, []);

  const watch = useCallback(async (): Promise<void> => {
    setPhase('subscribing');
    setMsg('Minting subscribe token…');
    const sid = newSessionId();
    sessionIdRef.current = sid;
    try {
      const token = await window.wave.session.mintSubscribeToken();
      startedAtRef.current = Date.now();
      const session = await startWhep(
        { endpoint: token.endpoint, key: token.key },
        {
          onStream: (stream) => {
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
              void videoRef.current.play().catch(() => {
                /* autoplay may be blocked until user gesture — the controls handle it */
              });
            }
          },
          onState: (state) => {
            window.wave.telemetry.emit({ kind: 'state', session: sid, transport: 'whep-subscribe', state });
            setMsg(`WHEP: ${state}`);
          },
        },
      );
      sessionRef.current = session;
      // Emit session-start only AFTER the handshake succeeds, so every
      // session-start is bracketed by a session-stop. A failed subscribe (e.g.
      // the 503 WHEP-unconfigured case) emits only an `error`, never a dangling
      // start.
      window.wave.telemetry.emit({ kind: 'session-start', session: sid, transport: 'whep-subscribe' });
      setPhase('playing');
      setMsg(`Playing (scope: ${token.scope}).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'subscribe failed';
      window.wave.telemetry.emit({
        kind: 'error',
        session: sid,
        transport: 'whep-subscribe',
        code: 'whep_subscribe_failed',
        message,
      });
      setPhase('error');
      setMsg(message);
    }
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    await teardown('stopped');
    setPhase('idle');
    setMsg('Stopped.');
  }, [teardown]);

  // Tear down a live subscription if the view unmounts (tab switch / quit).
  useEffect(() => {
    return () => {
      void teardown('quit');
    };
  }, [teardown]);

  const isPlaying = phase === 'playing';

  return (
    <section aria-label="Receivers" className="space-y-4">
      <h2 className="text-lg font-medium text-zinc-100">Receivers</h2>
      <p className="text-sm text-zinc-400">
        Subscribe to a live WAVE feed over WHEP and play it back here. Media stays in this window;
        the subscribe token is minted per-session (least-privilege <code>whep:write</code>) and
        never persisted.
      </p>

      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-black">
        <video
          ref={videoRef}
          className="aspect-video w-full bg-black"
          aria-label="WHEP live playback"
          playsInline
          controls
          autoPlay
        />
      </div>

      <div className="flex items-center gap-3">
        {!isPlaying && (
          <button
            type="button"
            onClick={() => void watch()}
            disabled={phase === 'subscribing' || !bridgeEnabled}
            className="min-h-11 min-w-32 rounded bg-[var(--wave-accent)] px-5 text-sm font-medium text-zinc-950 transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {phase === 'subscribing' ? 'Subscribing…' : 'Watch'}
          </button>
        )}
        {isPlaying && (
          <button
            type="button"
            onClick={() => void stop()}
            className="min-h-11 min-w-32 rounded bg-red-600 px-5 text-sm font-medium text-zinc-50 transition-opacity hover:opacity-90"
          >
            Stop
          </button>
        )}
      </div>

      {!bridgeEnabled && (
        <p className="text-sm text-zinc-500">
          Playback disabled — set <code>WAVE_ENABLE_ENCODE_BRIDGE</code> to subscribe.
        </p>
      )}

      {msg && (
        <p role="status" className={`text-sm ${phase === 'error' ? 'text-red-400' : 'text-zinc-400'}`}>
          {msg}
        </p>
      )}
    </section>
  );
}
