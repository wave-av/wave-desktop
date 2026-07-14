import { useCallback, useEffect, useState } from 'react';

/**
 * Session view — the #74 "join a WAVE realtime session" happy-path stub.
 *
 * Session core =
 *   1. Enumerate capture devices (navigator.mediaDevices — media lives ONLY in
 *      the renderer; it never crosses the IPC bridge).
 *   2. On "Publish", ask main for a one-shot WHIP descriptor (endpoint + bearer),
 *      capture the selected device via getUserMedia, and hand the encoded leg to
 *      @wave-av/whip-publish's `publish()` — the frozen WHIP-v1 client.
 *
 * INERT by design: this run stands up the wiring + UI. The WebCodecs encode
 * bridge (MediaStreamTrack → EncodedVideoChunk feed) is the next task (#74.b);
 * until then Publish resolves the descriptor + opens the capture stream and
 * reports readiness rather than pushing bytes, so nothing goes live by accident.
 */

interface DeviceOpt {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

type Phase = 'idle' | 'enumerating' | 'ready' | 'joining' | 'previewing' | 'error';

export function SessionView(): React.JSX.Element {
  const [devices, setDevices] = useState<DeviceOpt[]>([]);
  const [camId, setCamId] = useState<string>('');
  const [micId, setMicId] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState<string>('');

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

  const publish = useCallback(async (): Promise<void> => {
    setPhase('joining');
    setMsg('Requesting WHIP descriptor…');
    try {
      // Main owns the bearer + the frozen endpoint (api.wave.online/v1/whip/publish).
      const desc = await window.wave.session.publishDescriptor();
      // Open the selected capture devices (renderer-side only).
      const stream = await navigator.mediaDevices.getUserMedia({
        video: camId ? { deviceId: { exact: camId } } : true,
        audio: micId ? { deviceId: { exact: micId } } : true,
      });
      // NEXT (#74.b): drive `stream`'s tracks through a WebCodecs encode leg and
      // hand the EncodedVideo/AudioChunk feeds to publish(). For this session-core
      // stub we prove the full control path (descriptor + capture) is live, then
      // release the stream so nothing publishes until the encode bridge lands.
      void desc.endpoint; // wired: publish target
      void desc.bearer; // wired: Authorization bearer (never persisted)
      stream.getTracks().forEach((t) => t.stop());
      setPhase('previewing');
      setMsg(
        `Ready to publish to ${desc.endpoint} — capture opened, ${stream.getTracks().length} track(s). ` +
          'Encode bridge (#74.b) pending.',
      );
    } catch (err) {
      setPhase('error');
      setMsg(err instanceof Error ? err.message : 'join failed');
    }
  }, [camId, micId]);

  const cams = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput');

  return (
    <section aria-label="Session" className="space-y-4">
      <h2 className="text-lg font-medium text-zinc-100">Realtime Session</h2>
      <p className="text-sm text-zinc-400">
        Join a WAVE realtime session: pick a camera + mic, then publish over WHIP to{' '}
        <code className="text-zinc-300">api.wave.online</code>. Media stays in this window; the
        bearer key is minted per-session by the app and never persisted.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-zinc-300">
          Camera
          <select
            value={camId}
            onChange={(e) => setCamId(e.target.value)}
            className="min-h-11 rounded border border-zinc-700 bg-zinc-900 px-3 text-zinc-100"
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
            className="min-h-11 rounded border border-zinc-700 bg-zinc-900 px-3 text-zinc-100"
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
        <button
          type="button"
          onClick={() => void publish()}
          disabled={phase === 'joining' || phase === 'enumerating'}
          className="min-h-11 min-w-32 rounded bg-[var(--wave-accent)] px-5 text-sm font-medium text-zinc-950 transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {phase === 'joining' ? 'Joining…' : 'Publish'}
        </button>
        <button
          type="button"
          onClick={() => void enumerate()}
          className="min-h-11 rounded border border-zinc-700 px-4 text-sm text-zinc-300 hover:text-zinc-100"
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
