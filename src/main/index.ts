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
import { hydrateAuth, registerIpcHandlers } from './ipc';

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
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
