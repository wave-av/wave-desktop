import { useEffect, useState } from 'react';
import type { NetworkInterface, Settings, SignInEvent } from '@shared/ipc';
import { useUi } from '../App';

type SignInUiState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | {
      kind: 'pending';
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      expiresInSec: number;
    }
  | { kind: 'error'; code: string; message: string };

export function SettingsView(): React.JSX.Element {
  const { auth, setAuth } = useUi();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [signIn, setSignIn] = useState<SignInUiState>({ kind: 'idle' });

  useEffect(() => {
    void window.wave.settings.get().then(setSettings);
    void window.wave.settings.listInterfaces().then(setInterfaces);

    // Subscribe to sign-in lifecycle events. Cleaned up on unmount.
    const off = window.wave.auth.onSignInEvent((ev: SignInEvent) => {
      switch (ev.kind) {
        case 'pending':
          setSignIn({
            kind: 'pending',
            userCode: ev.userCode,
            verificationUri: ev.verificationUri,
            verificationUriComplete: ev.verificationUriComplete,
            expiresInSec: ev.expiresInSec,
          });
          break;
        case 'success':
          setAuth(ev.state);
          setSignIn({ kind: 'idle' });
          break;
        case 'error':
          setSignIn({ kind: 'error', code: ev.code, message: ev.message });
          break;
      }
    });
    return off;
  }, [setAuth]);

  const startSignIn = async (): Promise<void> => {
    setSignIn({ kind: 'starting' });
    try {
      const next = await window.wave.auth.signIn();
      setAuth(next);
    } catch (err) {
      // The error event from the stream already drove state; this catch just
      // prevents an unhandled rejection if the main throws before emitting.
      if (signIn.kind === 'starting') {
        setSignIn({
          kind: 'error',
          code: 'unknown',
          message: err instanceof Error ? err.message : 'sign-in failed',
        });
      }
    }
  };

  const cancelSignIn = async (): Promise<void> => {
    await window.wave.auth.signInCancel();
    setSignIn({ kind: 'idle' });
  };

  const signOut = async (): Promise<void> => {
    const next = await window.wave.auth.signOut();
    setAuth(next);
    setSignIn({ kind: 'idle' });
  };

  return (
    <section aria-label="Settings" className="max-w-2xl space-y-6">
      <h2 className="text-lg font-medium text-zinc-100">Settings</h2>

      <Field label="Gateway">
        <code className="text-sm text-zinc-300">{settings?.gatewayBase ?? '—'}</code>
      </Field>

      <Field label="Account">
        <AccountControl
          signedIn={auth.signedIn}
          subject={auth.subject}
          expiresInSec={auth.expiresInSec}
          signIn={signIn}
          onStartSignIn={startSignIn}
          onCancelSignIn={cancelSignIn}
          onSignOut={signOut}
        />
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

interface AccountControlProps {
  signedIn: boolean;
  subject: string | null;
  expiresInSec: number | null;
  signIn: SignInUiState;
  onStartSignIn: () => Promise<void>;
  onCancelSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
}

function AccountControl({
  signedIn,
  subject,
  expiresInSec,
  signIn,
  onStartSignIn,
  onCancelSignIn,
  onSignOut,
}: AccountControlProps): React.JSX.Element {
  if (signedIn) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-zinc-200">
          {subject ?? 'signed in'}
          {expiresInSec !== null && (
            <span className="ml-2 text-xs text-zinc-500">
              token refreshes in {Math.floor(expiresInSec / 60)} min
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void onSignOut()}
          className="min-h-11 rounded border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-800"
        >
          Sign out
        </button>
      </div>
    );
  }

  if (signIn.kind === 'pending') {
    const link = signIn.verificationUriComplete ?? signIn.verificationUri;
    return (
      <div className="space-y-3" role="status" aria-live="polite">
        <div className="text-sm text-zinc-300">
          Approve sign-in in the browser window that just opened. If it didn't, go to{' '}
          <a
            href={link}
            className="text-[var(--wave-accent)] underline"
            rel="noopener noreferrer"
          >
            {signIn.verificationUri}
          </a>{' '}
          and enter the code below.
        </div>
        <div className="rounded border border-zinc-700 bg-zinc-900 px-4 py-3 font-mono text-xl tracking-widest text-zinc-100">
          {signIn.userCode}
        </div>
        <button
          type="button"
          onClick={() => void onCancelSignIn()}
          className="min-h-11 rounded border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void onStartSignIn()}
        disabled={signIn.kind === 'starting'}
        className="min-h-11 rounded bg-[var(--wave-accent)] px-4 text-sm font-medium text-zinc-950 disabled:opacity-50"
      >
        {signIn.kind === 'starting' ? 'Contacting gateway…' : 'Sign in with WAVE'}
      </button>
      {signIn.kind === 'error' && (
        <div className="text-xs text-red-400" role="alert">
          {humanizeError(signIn.code)}: {signIn.message}
        </div>
      )}
    </div>
  );
}

function humanizeError(code: string): string {
  switch (code) {
    case 'access_denied': return 'Denied';
    case 'expired_token': return 'Code expired';
    case 'aborted': return 'Cancelled';
    case 'http_error': return 'Gateway unreachable';
    case 'malformed_response': return 'Gateway returned an unexpected response';
    default: return code;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div>{children}</div>
    </div>
  );
}
