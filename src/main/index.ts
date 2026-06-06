/**
 * Electron main process entry point.
 *
 * Creates the BrowserWindow, registers IPC handlers, sets up the secure-
 * storage adapter, and brokers the gateway OAuth → JWT flow. The renderer
 * never sees Node — it talks to this process exclusively through the
 * IPC contract in src/shared/ipc.ts.
 */

import { app, BrowserWindow, shell } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { join } from 'node:path';
import { authSnapshot, hydrateAuth, registerIpcHandlers, stopAllEncoders } from './ipc';
import { initControlPlane, type ControlPlaneHandle } from './control-plane/index';
import { registerControlPlaneIpc } from './control-plane/ipc-handlers';
import { readFileSync } from 'node:fs';

const PKG_VERSION = (() => {
  try {
    const json = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      version?: string;
    };
    return json.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

let controlPlane: ControlPlaneHandle | null = null;

const isDev = !app.isPackaged;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'WAVE',
    backgroundColor: '#0a0a0b',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.on('ready-to-show', () => win.show());

  // External links open in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

void app.whenReady().then(async () => {
  electronApp.setAppUserModelId('online.wave.desktop');
  app.on('browser-window-created', (_e, w) => optimizer.watchWindowShortcuts(w));
  registerIpcHandlers();
  // Restore the previous session BEFORE opening the window so first-paint
  // shows the right account state instead of a sign-in CTA that flickers off.
  try {
    await hydrateAuth();
  } catch {
    /* corrupt keychain entry → treated as signed-out by hydrateAuth */
  }

  // Boot the localhost control plane for Bitfocus Companion / vMix / external
  // multiviewer. Bound 127.0.0.1; bearer-token-auth; no impact on the
  // renderer's own surface — the operator only sees it when they open the
  // "Integrations" card in Settings to copy the key for Companion config.
  const bootAt = new Date();
  try {
    controlPlane = await initControlPlane({
      getState: () => {
        const a = authSnapshot();
        return {
          version: PKG_VERSION,
          bootAt,
          signedIn: a.signedIn,
          subject: a.subject,
          expiresInSec: a.expiresInSec,
        };
      },
      sendToRenderer: (channel, payload) => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send(channel, payload);
        }
      },
    });
    registerControlPlaneIpc(controlPlane, bootAt);
  } catch (err) {
    // Don't block app boot — the rest of wave-desktop still works without
    // the control plane (it's only the on-host integration surface).
     
    console.error('[control-plane] failed to start:', err);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Detach but don't await — the OS will reap the socket if we exit before
  // close completes, and we don't want to hang the quit handler.
  void controlPlane?.stop().catch(() => {
    /* best-effort */
  });
  controlPlane = null;
  // Kill any active ffmpeg child processes so we don't leak them past app
  // quit. SIGTERM is synchronous from the child's POV; the controller's
  // exit handler flips status to 'idle' but we don't observe it here.
  stopAllEncoders();
});
