/**
 * Derive an SRT target (host/port/streamKey) from the gateway-base URL.
 *
 * Lives next to the encoder rather than in ipc.ts so it stays independent
 * of the IPC layer's dependency graph — the vitest runner doesn't pick up
 * the `@shared/` alias from main/ipc.ts when transitively imported, so we
 * keep this helper isolated.
 *
 * Convention: WAVE's HTTP API lives at api.<env>.wave.online, SRT ingest
 * at ingest.<env>.wave.online. We rewrite the api. prefix → ingest. so a
 * single setting (`gatewayBase`) drives both surfaces.
 */

import type { SrtTarget } from './srt-args.js';

const FALLBACK_HOST = 'ingest.wave.online';

export const DEFAULT_SRT_PORT = 6000;

export function deriveSrtTarget(gatewayBase: string, streamKey: string): SrtTarget {
  let host = FALLBACK_HOST;
  try {
    host = new URL(gatewayBase).host.replace(/^api\./, 'ingest.');
  } catch {
    /* fallback to default — malformed gatewayBase */
  }
  return { host, port: DEFAULT_SRT_PORT, streamKey };
}
