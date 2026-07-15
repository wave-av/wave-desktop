import { useCallback, useEffect, useRef, useState } from 'react';
import { publish } from '@wave-av/whip-publish';
import { isEncodeBridgeEnabled } from '@shared/flags';
import { newSessionId } from '@shared/telemetry';
import { startPublish, type StartPublishResult, type PublishFn } from '../session/publish-session';

/**
 * Session view — the #74 "join a WAVE realtime session" happy-path.
 *
 * Session core (#47) =
 *   1. Enumerate capture devices (navigator.mediaDevices — media lives ONLY in
 *      the renderer; it never crosses the IPC bridge).
 *   2. On "Publish", ask main for a WHIP target, capture the selected device,
 *      and (when the encode bridge is enabled) drive the encoded leg into
 *      @wave-av/whip-publish's `publish()`.
 *
 * #74.b encode bridge: gated behind `WAVE_ENABLE_ENCODE_BRIDGE` (default OFF).
 *   - OFF (default): the original session-core behavior — resolve the descriptor,
 *     open capture, report readiness, release the stream. Nothing publishes.
 *   - ON: mint a least-privilege `whip:write` token, select codecs (AV1/Opus
 *     preferred), encode the tracks via WebCodecs, and publish over WHIP. A
 *     "Stop" button tears the live session down.
 */

interface DeviceOpt {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

type Phase = 'idle' | 'enumerating' | 'ready' | 'joining' | 'previewing' | 'live' | 'error';

export function SessionView(): React.JSX.Element {
  const [devices, setDevices] = useState<DeviceOpt[]>([]);
  const [camId, setCamId] = useState<string>('');
  const [micId, setMicId] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState<string>('');
  const sessionRef = useRef<StartPublishResult | null>(null);
  const sessionIdRef = useRef<string>('');
  const startedAtRef = useRef<number>(0);
  const bridgeEnabled = isEncodeBridgeEnabled();

  const enumerate = useCallback(async (): Promise<void> => {
    setPhase('enumerating');
    setMsg('');
    try {
      // Prompt for permission so labels populate (Chromium hides labels until
      // the user has granted capture at least once).
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      probe.getTracks().forEach((t) => t.stop());
      const list = await navigator.mediaDevices.enumerateDevices();
      const opts = list
        .filter((d) => d.kind === 'videoinput' || d.kind === 'audioinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          kind: d.kind,
          label: d.label || `${d.kind} ${i + 1}`,
        }));
      setDevices(opts);
      setCamId(opts.find((d) => d.kind === 'videoinput')?.deviceId ?? '');
      setMicId(opts.find((d) => d.kind === 'audioinput')?.deviceId ?? '');
      setPhase('ready');
    } catch (err) {
      setPhase('error');
      setMsg(err instanceof Error ? err.message : 'device enumeration failed');
    }
  }, []);

  useEffect(() => {
    void enumerate();
  }, [enumerate]);

  const openCaptureStream = useCallback(async (): Promise<MediaStream> => {
    return navigator.mediaDevices.getUserMedia({
      video: camId ? { deviceId: { exact: camId } } : true,
      audio: micId ? { deviceId: { exact: micId } } : true,
    });
  }, [camId, micId]);

  // Flag OFF (session-core, #47): resolve the descriptor + open capture, report
  // readiness, then RELEASE the stream so nothing publishes until the encode
  // bridge is explicitly enabled.
  const previewOnly = useCallback(async (): Promise<void> => {
    const desc = await window.wave.session.publishDescriptor();
    const stream = await openCaptureStream();
    void desc.endpoint;
    void desc.bearer;
    stream.getTracks().forEach((t) => t.stop());
    setPhase('previewing');
    setMsg(
      `Ready to publish to ${desc.endpoint} — capture opened, ${stream.getTracks().length} track(s). ` +
        'Encode bridge disabled (set WAVE_ENABLE_ENCODE_BRIDGE to publish).',
    );
  }, [openCaptureStream]);

  // Flag ON (#74.b): mint a least-privilege whip:write token, encode the tracks,
  // and publish over WHIP. The minted token is handed straight to publish() as
  // `key` and never persisted.
  const publishLive = useCallback(async (): Promise<void> => {
    const sid = newSessionId();
    sessionIdRef.current = sid;
    const token = await window.wave.session.mintPublishToken();
    const stream = await openCaptureStream();
    const session = await startPublish(
      stream,
      { endpoint: token.endpoint, key: token.key },
      {
        publish: publish as unknown as PublishFn,
        onState: (s) => {
          window.wave.telemetry.emit({ kind: 'state', session: sid, transport: 'whip-publish', state: s });
          setMsg(`WHIP: ${s}`);
        },
      },
    );
    sessionRef.current = session;
    startedAtRef.current = Date.now();
    window.wave.telemetry.emit({
      kind: 'session-start',
      session: sid,
      transport: 'whip-publish',
      videoCodec: session.videoCodec,
      audioCodec: session.audioCodec,
    });
    setPhase('live');
    setMsg(
      `Publishing to ${token.endpoint} — video: ${session.videoCodec ?? 'none'}, ` +
        `audio: ${session.audioCodec ?? 'none'} (scope: ${token.scope}).`,
    );
  }, [openCaptureStream]);

  const publishAction = useCallback(async (): Promise<void> => {
    setPhase('joining');
    setMsg(bridgeEnabled ? 'Minting publish token…' : 'Requesting WHIP descriptor…');
    try {
      if (bridgeEnabled) await publishLive();
      else await previewOnly();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'join failed';
      if (sessionIdRef.current) {
        window.wave.telemetry.emit({
          kind: 'error',
          session: sessionIdRef.current,
          transport: 'whip-publish',
          code: 'whip_publish_failed',
          message,
        });
      }
      setPhase('error');
      setMsg(message);
    }
  }, [bridgeEnabled, publishLive, previewOnly]);

  const stop = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    sessionRef.current = null;
    const sid = sessionIdRef.current;
    try {
      await session?.stop();
    } finally {
      if (sid) {
        window.wave.telemetry.emit({
          kind: 'session-stop',
          session: sid,
          transport: 'whip-publish',
          durationSec: startedAtRef.current ? Math.round((Date.now() - startedAtRef.current) / 1000) : 0,
          reason: 'stopped',
        });
      }
      setPhase('ready');
      setMsg('Session stopped.');
    }
  }, []);

  // Ensure a live session is torn down if the view unmounts (tab switch / app
  // quit closes the window → React unmounts → this fires). stop() closes the pc,
  // stops the raw capture tracks, and tears down the WHIP publish; we also emit
  // a `quit`-reason stop so the lifecycle is bracketed in telemetry.
  useEffect(() => {
    return () => {
      const sid = sessionIdRef.current;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) {
        void session.stop();
        if (sid) {
          window.wave.telemetry.emit({
            kind: 'session-stop',
            session: sid,
            transport: 'whip-publish',
            durationSec: startedAtRef.current ? Math.round((Date.now() - startedAtRef.current) / 1000) : 0,
            reason: 'quit',
          });
        }
      }
    };
  }, []);

  const cams = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const isLive = phase === 'live';

  return (
    <section aria-label="Session" className="space-y-4">
      <h2 className="text-lg font-medium text-zinc-100">Realtime Session</h2>
      <p className="text-sm text-zinc-400">
        Join a WAVE realtime session: pick a camera + mic, then publish over WHIP to{' '}
        <code className="text-zinc-300">api.wave.online</code>. Media stays in this window; the
        publish token is minted per-session (least-privilege <code>whip:write</code>) and never
        persisted.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-zinc-300">
          Camera
          <select
            value={camId}
            onChange={(e) => setCamId(e.target.value)}
            disabled={isLive}
            className="min-h-11 rounded border border-zinc-700 bg-zinc-900 px-3 text-zinc-100 disabled:opacity-40"
          >
            {cams.length === 0 && <option value="">No camera found</option>}
            {cams.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-zinc-300">
          Microphone
          <select
            value={micId}
            onChange={(e) => setMicId(e.target.value)}
            disabled={isLive}
            className="min-h-11 rounded border border-zinc-700 bg-zinc-900 px-3 text-zinc-100 disabled:opacity-40"
          >
            {mics.length === 0 && <option value="">No microphone found</option>}
            {mics.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        {!isLive && (
          <button
            type="button"
            onClick={() => void publishAction()}
            disabled={phase === 'joining' || phase === 'enumerating'}
            className="min-h-11 min-w-32 rounded bg-[var(--wave-accent)] px-5 text-sm font-medium text-zinc-950 transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {phase === 'joining' ? 'Joining…' : 'Publish'}
          </button>
        )}
        {isLive && (
          <button
            type="button"
            onClick={() => void stop()}
            className="min-h-11 min-w-32 rounded bg-red-600 px-5 text-sm font-medium text-zinc-50 transition-opacity hover:opacity-90"
          >
            Stop
          </button>
        )}
        <button
          type="button"
          onClick={() => void enumerate()}
          disabled={isLive}
          className="min-h-11 rounded border border-zinc-700 px-4 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-40"
        >
          Refresh devices
        </button>
      </div>

      {msg && (
        <p
          role="status"
          className={`text-sm ${phase === 'error' ? 'text-red-400' : 'text-zinc-400'}`}
        >
          {msg}
        </p>
      )}
    </section>
  );
}
