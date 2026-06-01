/**
 * Preload bridge — the only path the renderer has to reach main.
 *
 * `window.wave` is the typed surface; every method is a thin `invoke` wrapper
 * around an IPC channel from src/shared/ipc.ts. No Node globals, no Electron
 * primitives, no `remote` — sandbox-safe by construction.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  SignInEventSchema,
  type AuthState,
  type EncoderStartRequest,
  type EncoderStatus,
  type NetworkInterface,
  type Settings,
  type SignInEvent,
  type SignInRequest,
} from '@shared/ipc';

const wave = {
  auth: {
    state: (): Promise<AuthState> => ipcRenderer.invoke(IPC.authState),
    signIn: (req?: SignInRequest): Promise<AuthState> =>
      ipcRenderer.invoke(IPC.authSignIn, req ?? {}),
    /** Abort an in-flight sign-in (the renderer's "cancel" button). */
    signInCancel: (): Promise<void> => ipcRenderer.invoke(IPC.authSignInCancel),
    signOut: (): Promise<AuthState> => ipcRenderer.invoke(IPC.authSignOut),
    /**
     * Subscribe to sign-in lifecycle events. Returns an unsubscribe function.
     * The renderer NEVER trusts the main payload blindly — every event is
     * re-validated through Zod so a (theoretical) hostile main can't smuggle
     * unexpected shapes past the contextBridge.
     */
    onSignInEvent: (handler: (ev: SignInEvent) => void): (() => void) => {
      const listener = (_e: unknown, raw: unknown): void => {
        const parsed = SignInEventSchema.safeParse(raw);
        if (parsed.success) handler(parsed.data);
      };
      ipcRenderer.on(IPC.authSignInEvent, listener);
      return () => ipcRenderer.removeListener(IPC.authSignInEvent, listener);
    },
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (next: Settings): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, next),
    listInterfaces: (): Promise<NetworkInterface[]> =>
      ipcRenderer.invoke(IPC.settingsListInterfaces),
  },
  encoder: {
    start: (req: EncoderStartRequest): Promise<EncoderStatus> =>
      ipcRenderer.invoke(IPC.encoderStart, req),
    stop: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.encoderStop, id),
    listStatus: (): Promise<EncoderStatus[]> => ipcRenderer.invoke(IPC.encoderListStatus),
  },
} as const;

contextBridge.exposeInMainWorld('wave', wave);

export type WaveBridge = typeof wave;

declare global {
  interface Window {
    wave: WaveBridge;
  }
}
