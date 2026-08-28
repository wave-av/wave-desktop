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
  ControlPlaneInfo,
  ControlPlaneRevealResponse,
  CrestCommand,
  CrestResult,
  EncoderStartRequest,
  EncoderStatus,
  NetworkInterface,
  SessionPublishDescriptor,
  SessionPublishToken,
  SessionSubscribeToken,
  SessionSource,
  TelemetryEvent,
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
  controlPlane: {
    info(): Promise<ControlPlaneInfo>;
    /** One-shot reveal — see preload doc + Settings.tsx for handling rules. */
    revealKey(): Promise<ControlPlaneRevealResponse>;
    regenerateKey(): Promise<ControlPlaneRevealResponse>;
  };
  crest: {
    control(org: string, device: string, command: CrestCommand): Promise<CrestResult>;
    state(org: string, device: string): Promise<CrestResult>;
  };
  session: {
    /** One-shot WHIP publish descriptor; never persist `bearer`. */
    publishDescriptor(): Promise<SessionPublishDescriptor>;
    /** Mint a least-privilege whip:write-scoped publish token (#74.b, flag-gated). */
    mintPublishToken(): Promise<SessionPublishToken>;
    /** Mint a least-privilege whep:write-scoped subscribe token (#74.d, flag-gated). */
    mintSubscribeToken(): Promise<SessionSubscribeToken>;
    /** List this org's discoverable WHEP sources (WHEP-C, whep:read, flag-gated). [] when INERT. */
    listSources(): Promise<SessionSource[]>;
  };
  telemetry: {
    /** Fire-and-forget structured session lifecycle event (#74.c). */
    emit(event: TelemetryEvent): void;
  };
  ui: {
    openDeviceControl(): Promise<void>;
  };
}

declare global {
  interface Window {
    wave: WaveBridge;
  }
}
