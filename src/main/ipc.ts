/**
 * Main-process IPC handler registration.
 *
 * Every channel from src/shared/ipc.ts gets a handler here. We validate
 * every inbound payload with .parse() so a compromised renderer can't push
 * malformed data into the rest of the main process.
 *
 * Today the encoder/auth handlers return stubbed values. Wave-2 wires the
 * gateway OAuth flow + libsrt/NDI/Dante protocol handlers into these.
 */

import { ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { networkInterfaces } from 'node:os';
import {
  IPC,
  type AuthState,
  type EncoderStatus,
  EncoderStartRequestSchema,
  type NetworkInterface,
  type Settings,
  SettingsSchema,
  SignInRequestSchema,
} from '@shared/ipc';

// Stub in-memory state — Wave-2 replaces with electron-store + safeStorage.
let authToken: string | null = null;
const settings: Settings = {
  gatewayBase: 'https://api.wave.online',
  defaultCodec: 'h264',
  preferredInterface: null,
  x402BudgetCapUsd: 10,
};
const encoders = new Map<string, EncoderStatus>();

function authState(): AuthState {
  return { signedIn: authToken !== null, subject: null, expiresInSec: null };
}

function listInterfaces(): NetworkInterface[] {
  const out: NetworkInterface[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      out.push({
        name,
        address: a.address,
        family: a.family as 'IPv4' | 'IPv6',
        internal: a.internal,
      });
    }
  }
  return out;
}

export function registerIpcHandlers(): void {
  // ── auth ─────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.authState, (): AuthState => authState());

  ipcMain.handle(IPC.authSignIn, async (_e: IpcMainInvokeEvent, raw: unknown) => {
    // Wave-2: open device-code OAuth window pointed at req.gatewayBase ||
    // settings.gatewayBase, exchange the device code for a short-lived JWT,
    // then store its encrypted form via safeStorage.
    SignInRequestSchema.parse(raw ?? {});
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure-storage not available; cannot sign in');
    }
    authToken = '<wave-stub-token>';
    return authState();
  });

  ipcMain.handle(IPC.authSignOut, (): AuthState => {
    authToken = null;
    return authState();
  });

  // ── settings ─────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.settingsGet, (): Settings => settings);

  ipcMain.handle(IPC.settingsSet, (_e: IpcMainInvokeEvent, raw: unknown): Settings => {
    const next = SettingsSchema.parse(raw);
    Object.assign(settings, next);
    return settings;
  });

  ipcMain.handle(IPC.settingsListInterfaces, (): NetworkInterface[] => listInterfaces());

  // ── encoders ─────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.encoderStart, (_e: IpcMainInvokeEvent, raw: unknown): EncoderStatus => {
    const req = EncoderStartRequestSchema.parse(raw);
    const id = crypto.randomUUID();
    const status: EncoderStatus = {
      id,
      state: 'connecting',
      bitrateKbps: 0,
      uptimeSec: 0,
      lastError: null,
    };
    // Wave-2: route to the protocol handler matching req.source.kind +
    // req.codec; start a child process / N-API binding; ferry status frames
    // back via webContents.send on a streaming channel.
    void req; // referenced for type-check completeness
    encoders.set(id, status);
    return status;
  });

  ipcMain.handle(IPC.encoderStop, (_e: IpcMainInvokeEvent, id: unknown): boolean => {
    if (typeof id !== 'string') throw new Error('encoder id must be a string');
    return encoders.delete(id);
  });

  ipcMain.handle(IPC.encoderListStatus, (): EncoderStatus[] =>
    Array.from(encoders.values()),
  );
}
