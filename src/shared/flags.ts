/**
 * Feature flags for wave-desktop.
 *
 * No prior flag convention existed in this repo; this module introduces one.
 * Flags are read from environment variables at process start and are
 * DEFAULT-OFF — an unset (or anything other than an explicit truthy token)
 * value leaves the feature inert. This lets us land in-progress capabilities
 * (like the #74.b WebCodecs encode bridge) on `main` behind a hard gate that
 * nothing flips without an explicit operator opt-in.
 *
 * Truthy tokens (case-insensitive): `1`, `true`, `on`, `yes`.
 *
 * Both main and renderer read the SAME env var. In the renderer, electron-vite
 * inlines `import.meta.env.*` at build time; in main we read `process.env`.
 * `readFlag()` checks both sources so a single call site works in either
 * process without branching on which one it's running in.
 */

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

/**
 * The WebCodecs encode→WHIP-publish bridge (#74.b). OFF by default: with this
 * unset the Session view stays at the #47 session-core behavior (open capture,
 * report readiness) and NEVER encodes or publishes bytes.
 */
export const ENCODE_BRIDGE_FLAG = 'WAVE_ENABLE_ENCODE_BRIDGE';

function isTruthy(raw: string | undefined): boolean {
  return raw != null && TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Resolve a flag from either the main-process `process.env` or the renderer's
 * build-time `import.meta.env`. Vite exposes only `VITE_`-prefixed vars to the
 * renderer, so the renderer form is `import.meta.env.VITE_<NAME>`; main reads
 * the bare `<NAME>`. We accept both so one function serves both processes.
 */
export function readFlag(name: string): boolean {
  // Main process (Node): bare env var.
  if (typeof process !== 'undefined' && process.env && isTruthy(process.env[name])) {
    return true;
  }
  // Renderer (Vite): VITE_-prefixed, inlined into import.meta.env.
  const viteEnv: Record<string, string | undefined> | undefined = (
    import.meta as unknown as { env?: Record<string, string | undefined> }
  ).env;
  if (viteEnv && isTruthy(viteEnv[`VITE_${name}`])) {
    return true;
  }
  return false;
}

/** True only when the encode-bridge feature has been explicitly enabled. */
export function isEncodeBridgeEnabled(): boolean {
  return readFlag(ENCODE_BRIDGE_FLAG);
}
