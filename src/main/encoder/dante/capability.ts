/**
 * Dante capability resolution — fail closed (#159 / #160).
 *
 * The native Dante binding (Audinate SDK via `@wave-av/wave-transports`) is NOT
 * bundled: the Dante SDK redistribution is license-gated (#160, Audinate) and the
 * native receiver ships per-platform/arch. Until that clears AND the transports
 * package ships the native adapter there is NO way to open a Dante receiver — and
 * we must never pretend otherwise (no synthetic audio, no silent no-op).
 *
 * `resolveDanteAdapter()` attempts to load the adapter and returns it ONLY when a
 * real, `available` binding is present. Every other path throws
 * `DanteUnavailableError` with an actionable message pointing at #160. Callers
 * (the source controller, IPC handlers) surface that verbatim so the operator
 * sees exactly why Dante is dark and what unblocks it.
 */

import type { DanteTransportAdapter } from './types.js';

export const DANTE_UNAVAILABLE_CODE = 'DANTE_SDK_NOT_PROVISIONED' as const;

export const DANTE_UNAVAILABLE_MESSAGE =
  'Dante SDK not provisioned (#160): the Audinate Dante SDK native binding is not ' +
  'bundled in this build. Dante capture stays unavailable until the redistribution ' +
  'license (#160) is resolved and @wave-av/wave-transports ships the native Dante ' +
  'adapter for this platform/arch.';

export class DanteUnavailableError extends Error {
  readonly code = DANTE_UNAVAILABLE_CODE;
  constructor(message: string = DANTE_UNAVAILABLE_MESSAGE, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DanteUnavailableError';
  }
}

/**
 * How the native adapter is obtained. Injectable so tests can supply a fake
 * adapter (or a loader that throws) WITHOUT the real package being installed.
 * The production default dynamically imports `@wave-av/wave-transports` — which
 * is not a dependency of this build, so the import rejects and we fail closed.
 */
export type DanteAdapterLoader = () => Promise<{ createDanteAdapter?: () => DanteTransportAdapter }>;

const defaultLoader: DanteAdapterLoader = () =>
  // Dynamic, un-analyzable specifier: the package is intentionally absent until
  // #160 clears, so this rejects at runtime and we fall through to fail-closed.
  import(/* @vite-ignore */ '@wave-av/wave-transports/dante' as string) as ReturnType<DanteAdapterLoader>;

/**
 * Resolve a usable Dante adapter or throw `DanteUnavailableError`. Never returns
 * an adapter whose `available` flag is false, and never returns undefined.
 */
export async function resolveDanteAdapter(
  loader: DanteAdapterLoader = defaultLoader,
): Promise<DanteTransportAdapter> {
  let mod: Awaited<ReturnType<DanteAdapterLoader>>;
  try {
    mod = await loader();
  } catch (cause) {
    // Package missing (the #160 case) or failed to load its native binding.
    throw new DanteUnavailableError(DANTE_UNAVAILABLE_MESSAGE, { cause });
  }
  const factory = mod?.createDanteAdapter;
  if (typeof factory !== 'function') {
    throw new DanteUnavailableError(
      `${DANTE_UNAVAILABLE_MESSAGE} (loaded module exposes no createDanteAdapter())`,
    );
  }
  const adapter = factory();
  if (!adapter?.available) {
    throw new DanteUnavailableError(
      `${DANTE_UNAVAILABLE_MESSAGE} (adapter loaded but reports available=false — ` +
        'native binding missing for this platform/arch)',
    );
  }
  return adapter;
}
