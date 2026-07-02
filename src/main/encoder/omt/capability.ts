/**
 * OMT capability resolution — fail closed (#158 / #168).
 *
 * The native OMT binding (`libomt` via `@wave-av/wave-transports`) is NOT
 * bundled: the native library ships per-platform/arch and is provisioned on the
 * transports-package roll (#168). Until that lands there is NO way to open an OMT
 * receiver — and we must never pretend otherwise (no synthetic frames, no silent
 * no-op).
 *
 * `resolveOmtAdapter()` attempts to load the adapter and returns it ONLY when a
 * real, `available` binding is present. Every other path throws
 * `OmtUnavailableError` with an actionable message pointing at #168. Callers (the
 * source controller, IPC handlers) surface that verbatim so the operator sees
 * exactly why OMT is dark and what unblocks it.
 */

import type { OmtTransportAdapter } from './types.js';

export const OMT_UNAVAILABLE_CODE = 'OMT_NATIVE_NOT_PROVISIONED' as const;

export const OMT_UNAVAILABLE_MESSAGE =
  'OMT native binding not provisioned (#168): the libomt native adapter is not ' +
  'bundled in this build. OMT capture stays unavailable until ' +
  '@wave-av/wave-transports ships the native OMT adapter for this platform/arch.';

export class OmtUnavailableError extends Error {
  readonly code = OMT_UNAVAILABLE_CODE;
  constructor(message: string = OMT_UNAVAILABLE_MESSAGE, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OmtUnavailableError';
  }
}

/**
 * How the native adapter is obtained. Injectable so tests can supply a fake
 * adapter (or a loader that throws) WITHOUT the real package being installed.
 * The production default dynamically imports `@wave-av/wave-transports` — which
 * is not a dependency of this build, so the import rejects and we fail closed.
 */
export type OmtAdapterLoader = () => Promise<{ createOmtAdapter?: () => OmtTransportAdapter }>;

const defaultLoader: OmtAdapterLoader = () =>
  // Dynamic, un-analyzable specifier: the package is intentionally absent until
  // #168 lands, so this rejects at runtime and we fall through to fail-closed.
  import(/* @vite-ignore */ '@wave-av/wave-transports/omt' as string) as ReturnType<OmtAdapterLoader>;

/**
 * Resolve a usable OMT adapter or throw `OmtUnavailableError`. Never returns an
 * adapter whose `available` flag is false, and never returns undefined.
 */
export async function resolveOmtAdapter(
  loader: OmtAdapterLoader = defaultLoader,
): Promise<OmtTransportAdapter> {
  let mod: Awaited<ReturnType<OmtAdapterLoader>>;
  try {
    mod = await loader();
  } catch (cause) {
    // Package missing (the #168 case) or failed to load its native binding.
    throw new OmtUnavailableError(OMT_UNAVAILABLE_MESSAGE, { cause });
  }
  const factory = mod?.createOmtAdapter;
  if (typeof factory !== 'function') {
    throw new OmtUnavailableError(
      `${OMT_UNAVAILABLE_MESSAGE} (loaded module exposes no createOmtAdapter())`,
    );
  }
  const adapter = factory();
  if (!adapter?.available) {
    throw new OmtUnavailableError(
      `${OMT_UNAVAILABLE_MESSAGE} (adapter loaded but reports available=false — ` +
        'native binding missing for this platform/arch)',
    );
  }
  return adapter;
}
