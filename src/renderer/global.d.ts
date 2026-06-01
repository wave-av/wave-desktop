/// <reference types="vite/client" />

/**
 * Renderer-side type for the `window.wave` bridge exposed by preload.
 * Mirrors the typed shape from src/preload/index.ts. The preload-side
 * declaration lives in a separate process and is not visible to the
 * renderer compilation, so we restate the type here against the IPC
 * contract — keep this in sync if you add channels.
 */

import type {
  AuthState,
  EncoderStartRequest,
  EncoderStatus,
  NetworkInterface,
  Settings,
  SignInEvent,
  SignInRequest,
} from '@shared/ipc';

interface WaveBridge {
  auth: {
    state(): Promise<AuthState>;
    signIn(req?: SignInRequest): Promise<AuthState>;
    signInCancel(): Promise<void>;
    signOut(): Promise<AuthState>;
    /** Subscribe to sign-in lifecycle events; returns unsubscribe fn. */
    onSignInEvent(handler: (ev: SignInEvent) => void): () => void;
  };
  settings: {
    get(): Promise<Settings>;
    set(next: Settings): Promise<Settings>;
    listInterfaces(): Promise<NetworkInterface[]>;
  };
  encoder: {
    start(req: EncoderStartRequest): Promise<EncoderStatus>;
    stop(id: string): Promise<boolean>;
    listStatus(): Promise<EncoderStatus[]>;
  };
}

declare global {
  interface Window {
    wave: WaveBridge;
  }
}
