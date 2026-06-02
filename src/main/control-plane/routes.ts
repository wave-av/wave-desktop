/**
 * Route definitions for the control-plane HTTP API. Handlers are pure
 * functions of `(stateGetter, body) → response` to keep them trivially
 * testable; the router wires them to live IncomingMessage / ServerResponse.
 *
 * The state-getter pattern: handlers receive a getter that returns the
 * current main-process state snapshot (auth state, version, boot-time).
 * This decouples the handler unit tests from any singleton; the live
 * server passes a getter that reads from the same `current` cache the
 * IPC layer uses.
 */

import { type Route } from './router.js';
import {
  MonitorConnectRequestSchema,
  type AuthResponse,
  type MonitorConnectRequest,
  type MonitorConnectResponse,
  type MonitorDisconnectResponse,
  type StatusResponse,
} from './types.js';

export interface ControlPlaneState {
  /** wave-desktop semver. */
  version: string;
  /** Instant the server bound the socket. */
  bootAt: Date;
  /** True iff a valid OAuth token is loaded. */
  signedIn: boolean;
  /** JWT sub claim, or null. */
  subject: string | null;
  /** Seconds until JWT expiry, or null. */
  expiresInSec: number | null;
}

export interface MonitorBridge {
  /** Bind a feed slug to the monitor renderer; resolves when ACK'd. */
  connect(slug: string): Promise<void>;
  /** Unbind the active feed; resolves to true if one was bound. */
  disconnect(): Promise<boolean>;
}

export function buildRoutes(
  getState: () => ControlPlaneState,
  monitor: MonitorBridge,
): Route[] {
  return [
    {
      method: 'GET',
      path: '/v1/status',
      handler: (): StatusResponse => {
        const s = getState();
        const uptimeSec = Math.max(0, Math.floor((Date.now() - s.bootAt.getTime()) / 1000));
        return {
          ok: true,
          version: s.version,
          bootAt: s.bootAt.toISOString(),
          uptimeSec,
          signedIn: s.signedIn,
        };
      },
    },
    {
      method: 'GET',
      path: '/v1/auth',
      handler: (): AuthResponse => {
        const s = getState();
        return {
          signedIn: s.signedIn,
          subject: s.subject,
          expiresInSec: s.expiresInSec,
        };
      },
    },
    {
      method: 'POST',
      path: '/v1/monitor/connect',
      bodySchema: MonitorConnectRequestSchema,
      handler: async (_req, _res, ctx): Promise<MonitorConnectResponse> => {
        const body = ctx.body as MonitorConnectRequest;
        await monitor.connect(body.slug);
        return { ok: true, slug: body.slug };
      },
    },
    {
      method: 'POST',
      path: '/v1/monitor/disconnect',
      handler: async (): Promise<MonitorDisconnectResponse> => {
        await monitor.disconnect();
        return { ok: true };
      },
    },
  ];
}
