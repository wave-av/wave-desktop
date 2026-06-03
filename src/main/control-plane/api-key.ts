/**
 * Control-plane API key — local-only Bearer token for Companion / vMix /
 * multiviewer to authenticate against the localhost HTTP control plane.
 *
 * Generated lazily on first launch via `crypto.randomBytes(32)` (256-bit
 * entropy, hex-encoded → 64 chars). Persisted alongside the OAuth refresh
 * token via Electron `safeStorage` so it survives restarts on the same
 * machine but never leaves it. The renderer is the only surface that can
 * read the plaintext key (via an explicit IPC call shown to the operator
 * once in the settings panel so they can paste it into Companion config).
 *
 * Rotation: `regenerate()` mints a new key and atomically replaces the
 * on-disk blob. Any in-flight Companion connection using the previous key
 * will get a 401 on the next request.
 *
 * Why a separate file from `auth/token-store.ts`: the OAuth token grants
 * access to the cloud gateway; this key grants access to localhost-bound
 * operator actions. Different threat model, different blast radius.
 */

import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

const FILENAME = 'control-plane.key';
const KEY_BYTES = 32; // 256-bit
const KEY_HEX_CHARS = KEY_BYTES * 2;

function path(): string {
  return join(app.getPath('userData'), FILENAME);
}

function generate(): string {
  return randomBytes(KEY_BYTES).toString('hex');
}

async function persist(key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage: OS secure-storage not available');
  }
  const cipher = safeStorage.encryptString(key);
  const file = path();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, cipher, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * Read the persisted key, or mint+persist a new one on first launch.
 * Returns the plaintext key; cache the result in memory rather than hitting
 * safeStorage on every request.
 */
export async function loadOrCreate(): Promise<string> {
  try {
    const cipher = await fs.readFile(path());
    if (safeStorage.isEncryptionAvailable()) {
      const plain = safeStorage.decryptString(cipher);
      if (plain.length === KEY_HEX_CHARS) return plain;
    }
    // Fall through to regenerate on unreadable / wrong-length / no encryption.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Re-throw anything that isn't "file doesn't exist yet" so we don't
      // silently overwrite a key the user might be debugging.
      throw err;
    }
  }
  const fresh = generate();
  await persist(fresh);
  return fresh;
}

export async function regenerate(): Promise<string> {
  const fresh = generate();
  await persist(fresh);
  return fresh;
}

/**
 * Constant-time compare to avoid timing side-channels on key checks.
 *
 * We compare BUFFER lengths after UTF-8 encoding, not JS string lengths.
 * String `.length` returns code units, not bytes — `'🔑'.length === 2`
 * but `Buffer.from('🔑').length === 4`. Two strings of equal `.length`
 * but unequal byte-length would crash `timingSafeEqual` with
 * `RangeError: Input buffers must have the same byte length`, turning a
 * legitimate auth failure into a 500. Returns false on byte-length
 * mismatch (lengths leak less than per-byte timing would).
 */
export function safeEqual(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
