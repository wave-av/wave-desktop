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
 * output for the input/output libraries we depend on (`libsrt` for the push,
 * `libndi_newtek` for NDI capture, `libomt` for Open Media Transport capture)
 * so the operator sees an actionable error ("your ffmpeg lacks
 * --enable-libndi_newtek") instead of a generic spawn failure mid-stream.
 * Stock Homebrew/apt/Chocolatey ffmpeg carries libsrt but NOT the NDI/OMT
 * devices — those need an SDK-enabled custom build.
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
  /**
   * True iff the build has the NewTek NDI input device
   * (`--enable-libndi_newtek`). Stock Homebrew/apt/Chocolatey ffmpeg lacks
   * it — the operator needs an NDI-SDK-enabled build for `kind: 'ndi'`.
   */
  hasNdi: boolean;
  /**
   * True iff the build has the Open Media Transport input device
   * (`--enable-libomt`). Landed in ffmpeg 7 via the OMT patch set; not in
   * any stock package yet — needs the GalleryUK/FFmpeg-OMT build for
   * `kind: 'omt'`.
   */
  hasOmt: boolean;
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
  hasNdi: boolean;
  hasOmt: boolean;
} {
  // First line looks like: "ffmpeg version 7.1.1 Copyright (c) ..."
  const versionLine = stdout.split('\n')[0] ?? '';
  const versionMatch = versionLine.match(/version\s+(\S+)/);
  const version = versionMatch?.[1] ?? 'unknown';
  return {
    version,
    // The configuration line contains the `--enable-<lib>` flag if the build
    // has it. We match anywhere in the output since config may wrap across
    // lines, and anchor on `--enable-` so a bare mention of the lib name in a
    // comment doesn't false-positive.
    hasLibsrt: hasConfigFlag(stdout, 'libsrt'),
    hasNdi: hasConfigFlag(stdout, 'libndi_newtek'),
    hasOmt: hasConfigFlag(stdout, 'libomt'),
  };
}

/**
 * True iff `ffmpeg -version` was configured with `--enable-<lib>`. Matches the
 * flag itself (optionally a `-suffix`ed variant like `--enable-libsrt-static`),
 * never a bare mention of the lib name in prose. Exported for reuse/testing.
 */
export function hasConfigFlag(stdout: string, lib: string): boolean {
  // Escape regex metacharacters in the lib token defensively; our callers pass
  // literals today but this keeps the helper safe if that ever changes.
  const escaped = lib.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`--enable-${escaped}\\b`).test(stdout);
}

export async function probe(path: string): Promise<ResolvedBinary | null> {
  try {
    const { stdout } = await execFileAsync(path, ['-version'], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    const { version, hasLibsrt, hasNdi, hasOmt } = parseVersionOutput(stdout);
    return { path, version, hasLibsrt, hasNdi, hasOmt };
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

/**
 * Capability probes for the pro-AV network sources. Each returns:
 *   - true  → the resolved ffmpeg has the input device; capture can proceed
 *   - false → ffmpeg is present but lacks the device (surface an install hint)
 *   - null  → no usable ffmpeg at all (surface the missing-binary error first)
 *
 * Callers gate the `ndi` / `omt` encoder start on these so the operator gets
 * "install an NDI-enabled ffmpeg build" rather than a mid-stream spawn error.
 * Mirrors how the SRT path relies on `resolve().hasLibsrt`.
 */
export async function probeNdi(): Promise<boolean | null> {
  const bin = await resolve();
  return bin ? bin.hasNdi : null;
}

export async function probeOmt(): Promise<boolean | null> {
  const bin = await resolve();
  return bin ? bin.hasOmt : null;
}
