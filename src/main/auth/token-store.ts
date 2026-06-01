/**
 * Encrypted token persistence using Electron's safeStorage.
 *
 *   macOS  → Keychain
 *   Win    → DPAPI (per-user)
 *   Linux  → libsecret (when available); otherwise safeStorage falls back to
 *            plaintext-equivalent which we explicitly REJECT here. The user gets
 *            "OS secure-storage not available" rather than a false sense of safety.
 *
 * On disk: a single binary file under app.getPath('userData') / 'auth.bin'. The
 * contents are the safeStorage-encrypted blob — no JSON envelope, no metadata,
 * no separator that could carry plaintext context next to the ciphertext.
 *
 * Lifecycle:
 *   write(token) → encryptString → atomic write (tmp + rename)
 *   read()       → readFile → decryptString  (returns null on missing / corrupt)
 *   clear()      → unlink, swallow ENOENT (idempotent — used by sign-out)
 */

import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const FILENAME = 'auth.bin';

function path(): string {
  return join(app.getPath('userData'), FILENAME);
}

export function isAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export async function writeToken(token: string): Promise<void> {
  if (!isAvailable()) {
    throw new Error('safeStorage: OS secure-storage not available');
  }
  const cipher = safeStorage.encryptString(token);
  const file = path();
  const tmp = `${file}.tmp`;
  // Write to a sibling tempfile then rename — atomic on POSIX + Win NTFS.
  await fs.writeFile(tmp, cipher, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function readToken(): Promise<string | null> {
  if (!isAvailable()) return null;
  let cipher: Buffer;
  try {
    cipher = await fs.readFile(path());
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return safeStorage.decryptString(cipher);
  } catch {
    // Cipher present but undecryptable — usually means the user's login keychain
    // was rotated (e.g. password reset). Behave like signed-out + clear the file.
    await clearToken();
    return null;
  }
}

export async function clearToken(): Promise<void> {
  try {
    await fs.unlink(path());
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }
}
