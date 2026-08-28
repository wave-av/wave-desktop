import { useCallback, useEffect, useRef, useState } from 'react';
import { isEncodeBridgeEnabled } from '@shared/flags';
import { newSessionId } from '@shared/telemetry';
import type { SessionSource } from '@shared/ipc';
import { startWhep, buildSubscribeEndpoint, type WhepSession } from '../session/whep-client';

/**
 * Receivers view — the #74.d WHEP PLAYBACK path (the receive/watch counterpart
 * to the Session view's WHIP publish), with WHEP-C source discovery.
 *
 * On mount (flag on) we list this org's live WHEP sources via `whep:read`
 * discovery and populate a picker. On "Watch": mint a least-privilege
 * `whep:write` subscribe token, thread the SELECTED source uid into the
 * gateway subscribe URL as `?resource=<uid>` (the edge requires it — a bare
 * subscribe 400s), open a recvonly RTCPeerConnection, POST the SDP offer, apply
 * the answer, and attach the incoming MediaStream to the <video>. "Stop"
 * DELETEs the WHEP resource + closes the pc.
 *
 * Flag-gated behind `WAVE_ENABLE_ENCODE_BRIDGE` (same gate as publish): with the
 * flag off, discovery + the subscribe-token mint reject, so nothing plays. Media
 * never crosses the IPC bridge — only the small token/source descriptors do.
 * Session lifecycle telemetry (start/state/stop/error) is emitted via
 * window.wave.telemetry.
 */

type Phase = 'idle' | 'subscribing' | 'playing' | 'error';

export function ReceiversView(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState<string>('');
  const [sources, setSources] = useState<SessionSource[]>([]);
  const [selectedUid, setSelectedUid] = useState<string>('');
  const [loadingSources, setLoadingSources] = useState<boolean>(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<WhepSession | null>(null);
  const sessionIdRef = useRef<string>('');
  const startedAtRef = useRef<number>(0);
  const bridgeEnabled = isEncodeBridgeEnabled();

  const refreshSources = useCallback(async (): Promise<void> => {
    if (!bridgeEnabled) return;
    setLoadingSources(true);
    try {
      const list = await window.wave.session.listSources();
      setSources(list);
      // Keep the current selection if it still exists; else default to the first
      // source (so a single-source org needs zero clicks to Watch).
      setSelectedUid((prev) => (list.some((s) => s.uid === prev) ? prev : (list[0]?.uid ?? '')));
    } catch (err) {
      // Discovery failure is non-fatal: leave the picker empty and let the user
      // retry. Never throw out of an effect / click handler.
      setSources([]);
      setSelectedUid('');
      setMsg(err instanceof Error ? err.message : 'source discovery failed');
    } finally {
      setLoadingSources(false);
    }
  }, [bridgeEnabled]);

  // Populate the picker once on mount (flag on).
  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

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
    // A subscribe with no source 400s at the edge (§ `?resource=` is required);
    // guard here so the UI gives a clear reason instead of a raw gateway 400.
    if (!selectedUid) {
      setPhase('error');
      setMsg('Select a source to watch.');
      return;
    }
    setPhase('subscribing');
    setMsg('Minting subscribe token…');
    const sid = newSessionId();
    sessionIdRef.current = sid;
    try {
      const token = await window.wave.session.mintSubscribeToken();
      startedAtRef.current = Date.now();
      // Thread the chosen source uid into the subscribe URL as `?resource=` —
      // the WHEP client POSTs `endpoint` verbatim, so the resource must be baked
      // into it here (the token endpoint carries no query string).
      const endpoint = buildSubscribeEndpoint(token.endpoint, selectedUid);
      const session = await startWhep(
        { endpoint, key: token.key },
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
  }, [selectedUid]);

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
  const canWatch = bridgeEnabled && !!selectedUid && phase !== 'subscribing';

  return (
    <section aria-label="Receivers" className="space-y-4">
      <h2 className="text-lg font-medium text-zinc-100">Receivers</h2>
      <p className="text-sm text-zinc-400">
        Subscribe to a live WAVE feed over WHEP and play it back here. Media stays in this window;
        the subscribe token is minted per-session (least-privilege <code>whep:write</code>) and
        never persisted.
      </p>

      {/* Source picker — WHEP-C org-scoped discovery. */}
      <div className="flex items-end gap-3">
        <label className="flex-1 space-y-1">
          <span className="block text-sm text-zinc-400">Source</span>
          <select
            aria-label="WHEP source"
            value={selectedUid}
            onChange={(e) => setSelectedUid(e.target.value)}
            disabled={!bridgeEnabled || isPlaying || phase === 'subscribing' || sources.length === 0}
            className="min-h-11 w-full rounded border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 disabled:opacity-40"
          >
            {sources.length === 0 ? (
              <option value="">{loadingSources ? 'Loading sources…' : 'No live sources'}</option>
            ) : (
              sources.map((s) => (
                <option key={s.uid} value={s.uid}>
                  {s.room} · {s.uid.slice(0, 8)}…
                </option>
              ))
            )}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void refreshSources()}
          disabled={!bridgeEnabled || loadingSources || isPlaying}
          className="min-h-11 rounded border border-zinc-700 px-4 text-sm font-medium text-zinc-200 transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {loadingSources ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

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
            disabled={!canWatch}
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
