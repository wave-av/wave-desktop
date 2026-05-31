import { useEffect, useState } from 'react';
import type { NetworkInterface, Settings } from '@shared/ipc';
import { useUi } from '../App';

export function SettingsView(): React.JSX.Element {
  const { auth, setAuth } = useUi();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);

  useEffect(() => {
    void window.wave.settings.get().then(setSettings);
    void window.wave.settings.listInterfaces().then(setInterfaces);
  }, []);

  const signIn = async (): Promise<void> => {
    const next = await window.wave.auth.signIn();
    setAuth(next);
  };
  const signOut = async (): Promise<void> => {
    const next = await window.wave.auth.signOut();
    setAuth(next);
  };

  return (
    <section aria-label="Settings" className="max-w-2xl space-y-6">
      <h2 className="text-lg font-medium text-zinc-100">Settings</h2>

      <Field label="Gateway">
        <code className="text-sm text-zinc-300">{settings?.gatewayBase ?? '—'}</code>
      </Field>

      <Field label="Account">
        {auth.signedIn ? (
          <button
            type="button"
            onClick={signOut}
            className="min-h-11 rounded border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-800"
          >
            Sign out
          </button>
        ) : (
          <button
            type="button"
            onClick={signIn}
            className="min-h-11 rounded bg-[var(--wave-accent)] px-4 text-sm font-medium text-zinc-950"
          >
            Sign in with WAVE
          </button>
        )}
      </Field>

      <Field label="Default codec">
        <code className="text-sm text-zinc-300">{settings?.defaultCodec ?? '—'}</code>
      </Field>

      <Field label="Network interfaces">
        <ul className="space-y-1">
          {interfaces
            .filter((i) => !i.internal)
            .map((i) => (
              <li key={`${i.name}-${i.address}`} className="text-xs text-zinc-400">
                <span className="text-zinc-200">{i.name}</span> · {i.address} · {i.family}
              </li>
            ))}
        </ul>
      </Field>

      <Field label="x402 budget cap">
        <code className="text-sm text-zinc-300">
          ${settings?.x402BudgetCapUsd.toFixed(2) ?? '—'}
        </code>
      </Field>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div>{children}</div>
    </div>
  );
}
