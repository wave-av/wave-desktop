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
  ControlPlaneInfoSchema,
  ControlPlaneRevealResponseSchema,
  CrestResultSchema,
  SessionPublishDescriptorSchema,
  SessionPublishTokenSchema,
  SessionSubscribeTokenSchema,
  type SessionSubscribeToken,
  SessionSourcesResponseSchema,
  type SessionSource,
  type TelemetryEvent,
  type AuthState,
  type ControlPlaneInfo,
  type ControlPlaneRevealResponse,
  type CrestCommand,
  type CrestResult,
  type SessionPublishDescriptor,
  type SessionPublishToken,
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
  controlPlane: {
    /** Non-sensitive metadata — safe to call freely. */
    info: async (): Promise<ControlPlaneInfo> => {
      const raw = await ipcRenderer.invoke(IPC.controlPlaneInfo);
      // Re-validate at the bridge boundary even though main owns the schema:
      // protects the renderer if a future main-side change forgets to update
      // the contract.
      return ControlPlaneInfoSchema.parse(raw);
    },
    /**
     * One-shot reveal of the plaintext key. The renderer is expected to
     * immediately surface it to the user (clipboard / paste-buffer) and
     * NEVER persist it in localStorage or component state beyond a single
     * "copied" toast.
     */
    revealKey: async (): Promise<ControlPlaneRevealResponse> => {
      const raw = await ipcRenderer.invoke(IPC.controlPlaneRevealKey);
      return ControlPlaneRevealResponseSchema.parse(raw);
    },
    /** Rotate the persisted key; returns the new plaintext (same disclaimer as revealKey). */
    regenerateKey: async (): Promise<ControlPlaneRevealResponse> => {
      const raw = await ipcRenderer.invoke(IPC.controlPlaneRegenerateKey);
      return ControlPlaneRevealResponseSchema.parse(raw);
    },
  },
  crest: {
    /** Sends a WAVE Device Control Protocol v1 command through the gateway. */
    control: async (org: string, device: string, command: CrestCommand): Promise<CrestResult> => {
      const raw = await ipcRenderer.invoke(IPC.crestControl, { org, device, command });
      return CrestResultSchema.parse(raw);
    },
    /** Reads current device state (org-scoped state-track subscribe descriptor). */
    state: async (org: string, device: string): Promise<CrestResult> => {
      const raw = await ipcRenderer.invoke(IPC.crestState, { org, device });
      return CrestResultSchema.parse(raw);
    },
  },
  session: {
    /**
     * One-shot WHIP publish descriptor (endpoint + bearer). Hand the result
     * straight to @wave-av/whip-publish's `publish()`; never persist `bearer`.
     * Throws (rejects) when not signed in.
     */
    publishDescriptor: async (): Promise<SessionPublishDescriptor> => {
      const raw = await ipcRenderer.invoke(IPC.sessionPublishDescriptor);
      return SessionPublishDescriptorSchema.parse(raw);
    },
    /**
     * Mint a least-privilege `whip:write`-scoped publish token (#74.b). Flag-
     * gated in main (rejects when the encode bridge is disabled). Hand `key`
     * straight to publish(); never persist it.
     */
    mintPublishToken: async (): Promise<SessionPublishToken> => {
      const raw = await ipcRenderer.invoke(IPC.sessionMintPublishToken);
      return SessionPublishTokenSchema.parse(raw);
    },
    /**
     * Mint a least-privilege `whep:write`-scoped SUBSCRIBE token (#74.d). Flag-
     * gated in main (rejects when the encode bridge is disabled). Hand `key`
     * straight to the WHEP client's startWhep(); never persist it.
     */
    mintSubscribeToken: async (): Promise<SessionSubscribeToken> => {
      const raw = await ipcRenderer.invoke(IPC.sessionMintSubscribeToken);
      return SessionSubscribeTokenSchema.parse(raw);
    },
    /**
     * List this org's discoverable WHEP sources (WHEP-C) via a `whep:read` GET
     * to the gateway. Org-scoped by the gateway; flag-gated in main. Feed a
     * chosen `uid` back as the subscribe `?resource=`. Returns [] when the edge
     * source surface is INERT.
     */
    listSources: async (): Promise<SessionSource[]> => {
      const raw = await ipcRenderer.invoke(IPC.sessionListSources);
      return SessionSourcesResponseSchema.parse({ sources: raw }).sources;
    },
  },
  telemetry: {
    /** Fire-and-forget structured session lifecycle event (#74.c). One-way. */
    emit: (event: TelemetryEvent): void => {
      ipcRenderer.send(IPC.telemetryEmit, event);
    },
  },
  ui: {
    /** Opens the web-always Mesh device-control page in the OS browser. */
    openDeviceControl: (): Promise<void> => ipcRenderer.invoke(IPC.uiOpenDeviceControl),
  },
} as const;

contextBridge.exposeInMainWorld('wave', wave);

export type WaveBridge = typeof wave;

declare global {
  interface Window {
    wave: WaveBridge;
  }
}
