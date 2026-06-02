/**
 * Lifecycle wrapper for the control-plane HTTP server.
 *
 *   start()  → bind 127.0.0.1:<port>, return the bound port (which may
 *              differ from the requested one if 0 was passed in tests).
 *   stop()   → graceful close; active sockets are not forcibly destroyed
 *              because the surface is tiny and requests are sub-100ms.
 *
 * Why 127.0.0.1 only:
 *   - The control plane is meant for processes on the same host (Companion,
 *     vMix bridge, multiviewer external control). Binding to all interfaces
 *     would expose operator actions to anyone on the local network, which
 *     is the wrong default — even with Bearer auth, key extraction from
 *     the operator's machine is a stronger threat model than we want to
 *     ship by default. A future v0.2 may add an opt-in LAN bind once we
 *     have mTLS or per-host allowlisting.
 */

import { createServer, type Server } from 'node:http';
import { createRouter, type Route } from './router.js';

export interface ServerHandle {
  /** Actual bound port (useful when caller passes 0). */
  port: number;
  /** Stop the server; resolves once the listener is fully closed. */
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Bearer token clients must present in `Authorization: Bearer …`. */
  apiKey: string;
  /** Port to bind on 127.0.0.1; pass 0 for an OS-assigned ephemeral port. */
  port: number;
  /** Route definitions, typically from `buildRoutes()`. */
  routes: Route[];
}

export const LOOPBACK_HOST = '127.0.0.1';

export async function start(options: StartOptions): Promise<ServerHandle> {
  const handler = createRouter(options.routes, { apiKey: options.apiKey });
  const server: Server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      // Last-resort: handler threw without writing a response.
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'internal error', code: 'INTERNAL' }));
      }
      // Re-surface in dev logs; production logging is wired in by the caller.
      // eslint-disable-next-line no-console
      console.error('[control-plane] unhandled', err);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort =
    typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    port: boundPort,
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
