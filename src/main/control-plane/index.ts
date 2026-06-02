/**
 * Control-plane orchestration entrypoint.
 *
 * Glue between the lifecycle (api-key + server + routes + monitor bridge) and
 * the Electron main process. Exposes a single object the rest of main calls:
 *
 *   const cp = await initControlPlane({ getState, sendToRenderer });
 *   …
 *   await cp.stop();
 *
 * The caller wires `getState` to whatever main-process surface owns auth +
 * version cache, and `sendToRenderer` to a function that broadcasts an
 * arbitrary IPC channel to every BrowserWindow.
 *
 * Why this lives in `control-plane/index.ts` (not `server.ts`): server.ts is
 * a thin lifecycle for a generic HTTP server; this file adds the wiring that
 * only makes sense in the Electron context (key persistence, monitor bridge
 * via IPC). Keeping them separate keeps server.ts re-usable in tests.
 */

import { loadOrCreate, regenerate } from './api-key.js';
import { buildRoutes, type ControlPlaneState, type MonitorBridge } from './routes.js';
import { start, type ServerHandle } from './server.js';

export interface InitOptions {
  /** Snapshot accessor — called on every request, must be cheap. */
  getState: () => ControlPlaneState;
  /** Broadcast helper: `(channel, payload)` → every renderer. */
  sendToRenderer: (channel: string, payload: unknown) => void;
  /** TCP port; defaults to 31415 (matches companion-module-wave config). */
  port?: number;
}

export interface ControlPlaneHandle {
  /** Bound port (may change after rotate). */
  readonly port: number;
  /** Plaintext API key — never crosses IPC except via revealKey(). */
  readonly apiKey: string;
  /** Rotate the persisted key and return the new plaintext. */
  rotate(): Promise<string>;
  /** Stop the HTTP server; resolves when the listener has closed. */
  stop(): Promise<void>;
}

export const DEFAULT_PORT = 31415;

/** IPC channels broadcast by the bridge — kept here as a single source. */
export const CONTROL_PLANE_RENDERER_CHANNELS = {
  /** A monitor connect arrived from the wire; renderer should bind the feed. */
  monitorConnect: 'wave:control-plane:monitor-connect',
  /** A monitor disconnect arrived; renderer should unbind. */
  monitorDisconnect: 'wave:control-plane:monitor-disconnect',
} as const;

export async function initControlPlane(opts: InitOptions): Promise<ControlPlaneHandle> {
  let currentKey = await loadOrCreate();

  // The bridge forwards control-plane requests to the renderer over IPC.
  // It does NOT block on the renderer's response — Companion gets an ACK as
  // soon as the dispatch is queued. Renderer-side errors surface via the
  // existing IPC error stream, not the HTTP response, because Companion
  // doesn't care about per-window outcomes.
  const monitor: MonitorBridge = {
    async connect(slug: string): Promise<void> {
      opts.sendToRenderer(CONTROL_PLANE_RENDERER_CHANNELS.monitorConnect, { slug });
    },
    async disconnect(): Promise<boolean> {
      opts.sendToRenderer(CONTROL_PLANE_RENDERER_CHANNELS.monitorDisconnect, {});
      return true;
    },
  };

  const startServer = (key: string): Promise<ServerHandle> =>
    start({
      apiKey: key,
      port: opts.port ?? DEFAULT_PORT,
      routes: buildRoutes(opts.getState, monitor),
    });

  let server = await startServer(currentKey);

  return {
    get port(): number {
      return server.port;
    },
    get apiKey(): string {
      return currentKey;
    },
    async rotate(): Promise<string> {
      currentKey = await regenerate();
      // Rotation requires restarting the router so the new key is in effect.
      // We close + relist on the same port; in-flight requests with the old
      // key (if any) will complete on the old socket.
      await server.stop();
      server = await startServer(currentKey);
      return currentKey;
    },
    async stop(): Promise<void> {
      await server.stop();
    },
  };
}
