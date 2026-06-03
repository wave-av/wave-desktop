/**
 * IPC bridge for the Settings UI to inspect / reveal / rotate the
 * control-plane API key.
 *
 * Three channels:
 *   - `controlPlaneInfo`         → public metadata only (port, hasKey, startedAt)
 *   - `controlPlaneRevealKey`    → plaintext key (renderer copies to clipboard)
 *   - `controlPlaneRegenerateKey`→ rotate + return new plaintext
 *
 * The reveal channel ONLY returns plaintext when the renderer calls it
 * explicitly — there's no auto-emission, no inclusion in info(), and no
 * persistence on the renderer side (the preload re-validates the shape so
 * a future bug can't slip plaintext into the info channel).
 */

import { ipcMain } from 'electron';
import {
  IPC,
  ControlPlaneInfoSchema,
  ControlPlaneRevealResponseSchema,
  type ControlPlaneInfo,
  type ControlPlaneRevealResponse,
} from '@shared/ipc';
import type { ControlPlaneHandle } from './index.js';

export function registerControlPlaneIpc(
  handle: ControlPlaneHandle,
  bootAt: Date,
): void {
  ipcMain.handle(IPC.controlPlaneInfo, (): ControlPlaneInfo => {
    const out: ControlPlaneInfo = {
      port: handle.port,
      hasKey: handle.apiKey.length === 64,
      startedAt: bootAt.toISOString(),
    };
    // Validate the response before shipping — defends against a future
    // schema change that forgets to drop a now-disallowed field.
    return ControlPlaneInfoSchema.parse(out);
  });

  ipcMain.handle(IPC.controlPlaneRevealKey, (): ControlPlaneRevealResponse => {
    const out = { apiKey: handle.apiKey };
    return ControlPlaneRevealResponseSchema.parse(out);
  });

  ipcMain.handle(
    IPC.controlPlaneRegenerateKey,
    async (): Promise<ControlPlaneRevealResponse> => {
      const next = await handle.rotate();
      return ControlPlaneRevealResponseSchema.parse({ apiKey: next });
    },
  );
}
