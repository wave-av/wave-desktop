import { useState } from 'react';
import type { CrestCommand } from '@shared/ipc';

type Outcome =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'error'; status: number; message: string };

/**
 * E-CONTROL — commands a device THROUGH WAVE via the gateway
 * (`POST /v1/crest/control`, `GET /v1/crest/state`). The relay control
 * bridge is currently INERT: control POSTs return 503 "control bridge not
 * armed" until the relay/device transport is armed. This view surfaces
 * that (and 403/400) honestly — it never fakes a success.
 */
export function ControlView(): React.JSX.Element {
  const [org, setOrg] = useState('');
  const [device, setDevice] = useState('');
  const [codec, setCodec] = useState<'h264' | 'h265'>('h264');
  const [bitrate, setBitrate] = useState(6000);
  const [fps, setFps] = useState(30);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  const ready = org.trim().length > 0 && device.trim().length > 0;

  const send = async (command: CrestCommand): Promise<void> => {
    setOutcome({ kind: 'pending' });
    const result = await window.wave.crest.control(org.trim(), device.trim(), command);
    setOutcome(
      result.ok
        ? { kind: 'ok', status: result.status, body: result.body }
        : { kind: 'error', status: result.status, message: result.message },
    );
  };

  const getState = async (): Promise<void> => {
    setOutcome({ kind: 'pending' });
    const result = await window.wave.crest.state(org.trim(), device.trim());
    setOutcome(
      result.ok
        ? { kind: 'ok', status: result.status, body: result.body }
        : { kind: 'error', status: result.status, message: result.message },
    );
  };

  return (
    <section aria-label="Device control" className="max-w-2xl space-y-6">
      <h2 className="text-lg font-medium text-zinc-100">
        <b className="wm">WAVE</b> Device Control
      </h2>

      <div className="flex items-center justify-between gap-4 rounded border border-zinc-800 p-4">
        <p className="text-xs text-zinc-500">Manage all your WAVE devices on the web.</p>
        <ActionButton onClick={() => void window.wave.ui.openDeviceControl()}>
          Device Control
        </ActionButton>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <LabeledInput label="Org" value={org} onChange={setOrg} placeholder="org_123" />
        <LabeledInput label="Device" value={device} onChange={setDevice} placeholder="device_abc" />
      </div>

      <div className="flex flex-wrap gap-2">
        <ActionButton disabled={!ready} onClick={() => void send({ cmd: 'stream.start', args: {} })}>
          Start
        </ActionButton>
        <ActionButton disabled={!ready} onClick={() => void send({ cmd: 'stream.stop', args: {} })}>
          Stop
        </ActionButton>
        <ActionButton disabled={!ready} onClick={() => void send({ cmd: 'captions.on', args: {} })}>
          Captions on
        </ActionButton>
        <ActionButton disabled={!ready} onClick={() => void send({ cmd: 'captions.off', args: {} })}>
          Captions off
        </ActionButton>
        <ActionButton disabled={!ready} onClick={() => void getState()}>
          Get state
        </ActionButton>
      </div>

      <fieldset className="space-y-3 rounded border border-zinc-800 p-4">
        <legend className="px-1 text-xs uppercase tracking-wide text-zinc-500">Settings</legend>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1">
            <label htmlFor="codec" className="text-xs text-zinc-500">
              Codec
            </label>
            <select
              id="codec"
              value={codec}
              onChange={(e) => setCodec(e.target.value as 'h264' | 'h265')}
              className="min-h-11 w-full rounded border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
            >
              <option value="h264">h264</option>
              <option value="h265">h265</option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="bitrate" className="text-xs text-zinc-500">
              Bitrate (kbps)
            </label>
            <input
              id="bitrate"
              type="number"
              min={1}
              value={bitrate}
              onChange={(e) => setBitrate(Number(e.target.value))}
              className="min-h-11 w-full rounded border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="fps" className="text-xs text-zinc-500">
              FPS
            </label>
            <input
              id="fps"
              type="number"
              min={1}
              max={240}
              value={fps}
              onChange={(e) => setFps(Number(e.target.value))}
              className="min-h-11 w-full rounded border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
            />
          </div>
        </div>
        <ActionButton
          disabled={!ready}
          onClick={() =>
            void send({ cmd: 'settings.set', args: { codec, bitrate, fps } })
          }
        >
          Apply settings
        </ActionButton>
      </fieldset>

      <ResultArea outcome={outcome} />
    </section>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): React.JSX.Element {
  const id = `control-${label.toLowerCase()}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs text-zinc-500">
        {label}
      </label>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 w-full rounded border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 placeholder:text-zinc-600"
      />
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="min-h-11 rounded bg-[var(--wave-accent)] px-4 text-sm font-medium text-zinc-950 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function ResultArea({ outcome }: { outcome: Outcome }): React.JSX.Element {
  if (outcome.kind === 'idle') {
    return <div className="text-xs text-zinc-500">No command sent yet.</div>;
  }
  if (outcome.kind === 'pending') {
    return (
      <div className="text-xs text-zinc-400" role="status" aria-live="polite">
        Sending…
      </div>
    );
  }
  if (outcome.kind === 'ok') {
    return (
      <div className="space-y-1 rounded border border-emerald-900 bg-emerald-950/40 p-3" role="status">
        <div className="text-xs font-medium text-emerald-400">HTTP {outcome.status}</div>
        <pre className="overflow-auto text-xs text-zinc-300">
          {JSON.stringify(outcome.body, null, 2)}
        </pre>
      </div>
    );
  }
  // 503 "control bridge not armed" is EXPECTED right now — the relay/device
  // transport isn't armed yet. Surface it as-is, not as a generic failure.
  return (
    <div className="space-y-1 rounded border border-amber-900 bg-amber-950/40 p-3" role="alert">
      <div className="text-xs font-medium text-amber-400">HTTP {outcome.status}</div>
      <div className="text-xs text-zinc-300">{outcome.message}</div>
      {outcome.status === 503 && (
        <div className="text-xs text-zinc-500">
          Expected until the relay control bridge is armed — the command was correctly sent.
        </div>
      )}
    </div>
  );
}
