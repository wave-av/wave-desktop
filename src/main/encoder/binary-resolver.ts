/**
 * Resolve which ffmpeg binary to spawn for the SRT encoder. We never ship
 * ffmpeg in-tree — licensing / size — so we rely on a binary that's either
 * on $PATH, in a known macOS/Linux/Windows location, or explicitly named
 * via the WAVE_FFMPEG env var.
 *
 * Resolution order (first hit wins):
 *
 *   1. process.env.WAVE_FFMPEG   — operator-pinned override (tests, dev)
 *   2. $PATH                     — `which ffmpeg` / `where ffmpeg.exe`
 *   3. /opt/homebrew/bin/ffmpeg  — Apple-Silicon Homebrew default
 *   4. /usr/local/bin/ffmpeg     — Intel Homebrew / Linux package default
 *   5. C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe — Windows Chocolatey
 *
 * `resolve()` returns the absolute path or `null` when nothing matches; it
 * never throws. The caller is expected to surface a clear UI message when
 * no binary is found rather than crashing on spawn ENOENT.
 *
 * After resolving the path, we run `ffmpeg -version` once and parse the
 * output for libsrt presence so the operator sees an actionable error
 * ("your ffmpeg lacks --enable-libsrt") instead of a generic spawn failure
 * mid-stream.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PLATFORM_CANDIDATES: readonly string[] = (() => {
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  }
  if (process.platform === 'linux') {
    return ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  }
  if (process.platform === 'win32') {
    return [
      'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    ];
  }
  return [];
})();

export interface ResolvedBinary {
  path: string;
  /** Major.minor.patch as reported by `-version`. */
  version: string;
  /** True iff `ffmpeg -version` mentions `--enable-libsrt`. */
  hasLibsrt: boolean;
}

export async function pathOnDisk(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Find a usable ffmpeg path. Returns null on miss; never throws. Side-effect-free
 * apart from the `which` shell call when $PATH lookup is attempted.
 */
export async function resolvePath(): Promise<string | null> {
  const override = process.env['WAVE_FFMPEG'];
  if (override && (await pathOnDisk(override))) return override;

  // $PATH lookup via the OS' own `which` / `where`. We deliberately don't
  // walk $PATH ourselves — different shells handle PATHEXT differently on
  // Windows and getting that wrong costs more than spawning a tiny helper.
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(lookup, ['ffmpeg']);
    const first = stdout.split('\n')[0]?.trim();
    if (first && (await pathOnDisk(first))) return first;
  } catch {
    /* not on $PATH; fall through to platform defaults */
  }

  for (const candidate of PLATFORM_CANDIDATES) {
    if (await pathOnDisk(candidate)) return candidate;
  }
  return null;
}

/**
 * Parse `ffmpeg -version` output for the version string + libsrt config flag.
 * Exposed for testing; production callers should use `probe()` below.
 */
export function parseVersionOutput(stdout: string): {
  version: string;
  hasLibsrt: boolean;
} {
  // First line looks like: "ffmpeg version 7.1.1 Copyright (c) ..."
  const versionLine = stdout.split('\n')[0] ?? '';
  const versionMatch = versionLine.match(/version\s+(\S+)/);
  const version = versionMatch?.[1] ?? 'unknown';
  // The configuration line contains `--enable-libsrt` if the build has it.
  // We match anywhere in the output since config may wrap across lines.
  const hasLibsrt = /--enable-libsrt\b/.test(stdout);
  return { version, hasLibsrt };
}

export async function probe(path: string): Promise<ResolvedBinary | null> {
  try {
    const { stdout } = await execFileAsync(path, ['-version'], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    const { version, hasLibsrt } = parseVersionOutput(stdout);
    return { path, version, hasLibsrt };
  } catch {
    return null;
  }
}

/**
 * Convenience: resolve + probe in one call. Returns null when no usable
 * binary is found OR when the found binary failed to report a version.
 */
export async function resolve(): Promise<ResolvedBinary | null> {
  const p = await resolvePath();
  if (!p) return null;
  return probe(p);
}
