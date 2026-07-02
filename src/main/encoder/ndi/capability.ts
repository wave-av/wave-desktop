/**
 * NDI capability resolution — fail closed (#157 / #169).
 *
 * The native NDI binding (NDI Advanced SDK via `@wave-av/wave-transports`) is
 * NOT bundled: the SDK binary redistribution is license-gated on #169 (Vizrt).
 * Until that clears AND the transports package ships the native adapter for
 * this platform, there is NO way to open an NDI receiver — and we must never
 * pretend otherwise (no synthetic frames, no silent no-op).
 *
 * `resolveNdiAdapter()` attempts to load the adapter and returns it ONLY when a
 * real, `available` binding is present. Every other path throws
 * `NdiUnavailableError` with an actionable message pointing at #169. Callers
 * (the source controller, IPC handlers) surface that verbatim so the operator
 * sees exactly why NDI is dark and what unblocks it.
 */

import type { NdiTransportAdapter } from './types.js';

export const NDI_UNAVAILABLE_CODE = 'NDI_SDK_NOT_PROVISIONED' as const;

export const NDI_UNAVAILABLE_MESSAGE =
  'NDI SDK binary not provisioned (#169): the NDI Advanced SDK native binding ' +
  'is not bundled in this build. NDI capture stays unavailable until the ' +
  'redistribution license (#169) is resolved and @wave-av/wave-transports ships ' +
  'the native NDI adapter for this platform/arch.';

export class NdiUnavailableError extends Error {
  readonly code = NDI_UNAVAILABLE_CODE;
  constructor(message: string = NDI_UNAVAILABLE_MESSAGE, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NdiUnavailableError';
  }
}

/**
 * How the native adapter is obtained. Injectable so tests can supply a fake
 * adapter (or a loader that throws) WITHOUT the real package being installed.
 * The production default dynamically imports `@wave-av/wave-transports` — which
 * is not a dependency of this build, so the import rejects and we fail closed.
 */
export type NdiAdapterLoader = () => Promise<{ createNdiAdapter?: () => NdiTransportAdapter }>;

const defaultLoader: NdiAdapterLoader = () =>
  // Dynamic, un-analyzable specifier: the package is intentionally absent until
  // #169 clears, so this rejects at runtime and we fall through to fail-closed.
  import(/* @vite-ignore */ '@wave-av/wave-transports/ndi' as string) as ReturnType<NdiAdapterLoader>;

/**
 * Resolve a usable NDI adapter or throw `NdiUnavailableError`. Never returns an
 * adapter whose `available` flag is false, and never returns undefined.
 */
export async function resolveNdiAdapter(
  loader: NdiAdapterLoader = defaultLoader,
): Promise<NdiTransportAdapter> {
  let mod: Awaited<ReturnType<NdiAdapterLoader>>;
  try {
    mod = await loader();
  } catch (cause) {
    // Package missing (the #169 case) or failed to load its native binding.
    throw new NdiUnavailableError(NDI_UNAVAILABLE_MESSAGE, { cause });
  }
  const factory = mod?.createNdiAdapter;
  if (typeof factory !== 'function') {
    throw new NdiUnavailableError(
      `${NDI_UNAVAILABLE_MESSAGE} (loaded module exposes no createNdiAdapter())`,
    );
  }
  const adapter = factory();
  if (!adapter?.available) {
    throw new NdiUnavailableError(
      `${NDI_UNAVAILABLE_MESSAGE} (adapter loaded but reports available=false — ` +
        'native binding missing for this platform/arch)',
    );
  }
  return adapter;
}
