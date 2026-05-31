import { useEffect } from 'react';
import { create } from 'zustand';
import type { AuthState } from '@shared/ipc';
import { EncodersView } from './views/Encoders';
import { ReceiversView } from './views/Receivers';
import { MultiviewView } from './views/Multiview';
import { SettingsView } from './views/Settings';

type Tab = 'encoders' | 'receivers' | 'multiview' | 'settings';

interface UiState {
  tab: Tab;
  setTab: (t: Tab) => void;
  auth: AuthState;
  setAuth: (a: AuthState) => void;
}

export const useUi = create<UiState>((set) => ({
  tab: 'encoders',
  setTab: (tab) => set({ tab }),
  auth: { signedIn: false, subject: null, expiresInSec: null },
  setAuth: (auth) => set({ auth }),
}));

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'encoders', label: 'Encoders' },
  { id: 'receivers', label: 'Receivers' },
  { id: 'multiview', label: 'Multiview' },
  { id: 'settings', label: 'Settings' },
];

export function App(): React.JSX.Element {
  const { tab, setTab, setAuth } = useUi();

  useEffect(() => {
    void window.wave.auth.state().then(setAuth);
  }, [setAuth]);

  return (
    <div className="flex h-screen flex-col">
      <TitleBar />
      <TabBar current={tab} onChange={setTab} />
      <main className="flex-1 overflow-auto p-6">
        {tab === 'encoders' && <EncodersView />}
        {tab === 'receivers' && <ReceiversView />}
        {tab === 'multiview' && <MultiviewView />}
        {tab === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}

function TitleBar(): React.JSX.Element {
  return (
    <header
      className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-6 py-3"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold tracking-wide text-zinc-100">WAVE</span>
        <span className="text-xs text-zinc-500">Operator Console</span>
      </div>
    </header>
  );
}

function TabBar({
  current,
  onChange,
}: {
  current: Tab;
  onChange: (t: Tab) => void;
}): React.JSX.Element {
  return (
    <nav
      role="tablist"
      aria-label="Workspace"
      className="flex gap-1 border-b border-zinc-800 bg-zinc-950 px-3"
    >
      {TABS.map((t) => {
        const active = t.id === current;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={`min-h-11 min-w-24 border-b-2 px-4 text-sm transition-colors ${
              active
                ? 'border-[var(--wave-accent)] text-zinc-100'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
