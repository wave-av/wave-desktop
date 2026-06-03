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
 *
 * Concurrency model:
 *   - `rotate()` is serialized via a single-slot mutex. Concurrent callers
 *     await the in-flight rotation rather than racing the server restart.
 *   - Rotation is atomic in the sense that we don't persist the new key
 *     unless the new server successfully bound the listener. On failure we
 *     try to restart the OLD key; if both restarts fail we propagate the
 *     error AND leave the handle's `apiKey` matching the on-disk state.
 *   - The monitor bridge wraps sendToRenderer in try/catch so a thrown
 *     renderer-broadcast doesn't fail the HTTP response (Companion only
 *     cares about the wire ACK; renderer dispatch is fire-and-forget).
 */

import { generate, loadOrCreate, persist } from './api-key.js';
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
  // soon as the dispatch is queued. A try/catch wraps the dispatch so a
  // sendToRenderer that throws (e.g. all BrowserWindows destroyed during
  // shutdown) does NOT fail the HTTP request: Companion correctly sees the
  // wire-level ACK, and renderer-side errors surface in the main-process
  // log.
  const safeSend = (channel: string, payload: unknown): void => {
    try {
      opts.sendToRenderer(channel, payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[control-plane] renderer dispatch failed', channel, err);
    }
  };

  const monitor: MonitorBridge = {
    async connect(slug: string): Promise<void> {
      safeSend(CONTROL_PLANE_RENDERER_CHANNELS.monitorConnect, { slug });
    },
    async disconnect(): Promise<boolean> {
      safeSend(CONTROL_PLANE_RENDERER_CHANNELS.monitorDisconnect, {});
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

  // Single-slot mutex for rotate(). Concurrent callers attach to the same
  // promise rather than racing the stop/start.
  let rotateInflight: Promise<string> | null = null;

  async function performRotate(): Promise<string> {
    // Generate the new key in memory only — we do NOT persist until the
    // new server has bound successfully. That keeps the on-disk key in
    // sync with the live listener even if startServer() throws.
    const candidate = generate();

    await server.stop();

    try {
      server = await startServer(candidate);
    } catch (startErr) {
      // New server failed to bind — try to come back online with the OLD
      // key so the operator keeps a working control plane. If that also
      // fails, surface the original error AND leave the on-disk key
      // unchanged (matching whatever state the operator last observed).
      try {
        server = await startServer(currentKey);
      } catch (rollbackErr) {
        // eslint-disable-next-line no-console
        console.error(
          '[control-plane] rotate restart failed AND old-key recovery failed',
          { startErr, rollbackErr },
        );
        throw startErr;
      }
      throw startErr;
    }

    // New server is live on the candidate key — now persist. If THIS
    // throws, the live listener already accepts the new key, so we
    // commit the in-memory state too (currentKey ← candidate) and
    // surface the persistence error to the caller. The next launch will
    // start with the old key from disk; the operator sees a clear error
    // immediately.
    await persist(candidate);
    currentKey = candidate;
    return candidate;
  }

  return {
    get port(): number {
      return server.port;
    },
    get apiKey(): string {
      return currentKey;
    },
    async rotate(): Promise<string> {
      if (rotateInflight) return rotateInflight;
      rotateInflight = performRotate().finally(() => {
        rotateInflight = null;
      });
      return rotateInflight;
    },
    async stop(): Promise<void> {
      await server.stop();
    },
  };
}
