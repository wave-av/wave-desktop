import { useEffect, useState } from 'react';
import type { EncoderStatus } from '@shared/ipc';

export function EncodersView(): React.JSX.Element {
  const [statuses, setStatuses] = useState<EncoderStatus[]>([]);
  useEffect(() => {
    void window.wave.encoder.listStatus().then(setStatuses);
  }, []);
  return (
    <section aria-label="Encoders" className="space-y-4">
      <h2 className="text-lg font-medium text-zinc-100">Encoders</h2>
      <p className="text-sm text-zinc-400">
        Wave 2: pick a source (camera, screen, file, NDI receive, Dante receive, OBS scene) →
        pick a destination stream key → pick a codec (H.264 / HEVC / AV1 / AV2) → one-click live.
      </p>
      {statuses.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
          No active encoders. Wire the protocol handlers (Wave 2) to enable.
        </div>
      ) : (
        <ul className="space-y-2">
          {statuses.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between rounded border border-zinc-800 px-4 py-3"
            >
              <span className="text-sm text-zinc-200">{s.id}</span>
              <span className="text-xs text-zinc-500">{s.state}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
