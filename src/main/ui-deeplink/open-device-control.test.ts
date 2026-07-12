/**
 * Deep-link IPC handler (E-CONTROL #78b) — asserts the `ui:openDeviceControl`
 * channel opens exactly the fixed DEVICE_CONTROL_URL via shell.openExternal,
 * never a renderer-supplied value.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (event: unknown, payload?: unknown) => unknown;

const { openExternal, handlers } = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => {}),
  handlers: new Map<string, Handler>(),
}));

vi.mock('electron', () => ({
  shell: { openExternal },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { IPC } from '@shared/ipc';
import { DEVICE_CONTROL_URL } from '@shared/urls';
import { registerIpcHandlers } from '../ipc';

describe('ui:openDeviceControl', () => {
  beforeEach(() => {
    handlers.clear();
    openExternal.mockClear();
    registerIpcHandlers();
  });

  it('opens the fixed DEVICE_CONTROL_URL, not a caller-supplied value', async () => {
    const handler = handlers.get(IPC.uiOpenDeviceControl);
    expect(handler).toBeDefined();
    await handler?.({}, 'https://evil.example/');
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(DEVICE_CONTROL_URL);
  });
});
