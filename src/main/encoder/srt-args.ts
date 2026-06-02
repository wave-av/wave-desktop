/**
 * Build ffmpeg argv for an SRT push from a wave-desktop EncoderSource.
 *
 * The output URL is always `srt://<host>:<port>?streamid=<key>&mode=caller`
 * — that's the gateway-facing convention. The streamid is the wave-desktop
 * stream key (gateway maps it to the operator's account + slug).
 *
 * Every argv string is constructed from a small, validated input set; no
 * user input ever interpolates directly into a string-with-spaces that
 * `spawn()` could splatter wrong. (`spawn()` with an array argv is shell-
 * injection-safe by construction, but we still want callers to be able to
 * audit the final argv.)
 *
 * Why ffmpeg + libsrt (not direct N-API to libsrt): ffmpeg is the
 * battle-tested encode path for every codec we support (h264 / hevc / av1
 * / soon av2), it's already on every operator's machine via Homebrew /
 * apt / Chocolatey, and we'd otherwise be hand-rolling an mpegts muxer.
 * The N-API binding was the original scope of #173; the child-process
 * approach gets us the same functional outcome with no compile-toolchain
 * dependency on the operator's machine. We can swap to N-API later if
 * the spawn overhead becomes a real issue.
 */

import type { EncoderStartRequest, EncoderSource } from '@shared/ipc';

export interface SrtTarget {
  /** Hostname or IP of the WAVE ingest endpoint. */
  host: string;
  /** UDP port; SRT ingest defaults to 6000-range. */
  port: number;
  /** Stream key the gateway maps to an account + slug. */
  streamKey: string;
}

/**
 * Map an EncoderSource to ffmpeg input-side flags.
 * - screen → `-f avfoundation -i 1` (macOS) / similar per-OS device names
 * - camera → `-f avfoundation -i <id>`
 * - file → `-i <path>`
 * - ndi / dante → not yet supported by ffmpeg upstream without external libs;
 *   we throw so the caller surfaces a clear error rather than passing garbage
 *   to spawn.
 */
function inputArgs(source: EncoderSource): string[] {
  switch (source.kind) {
    case 'file':
      return ['-re', '-i', source.path];
    case 'screen':
      if (process.platform === 'darwin') {
        return ['-f', 'avfoundation', '-i', `${source.displayId}:none`];
      }
      if (process.platform === 'linux') {
        return ['-f', 'x11grab', '-i', source.displayId];
      }
      if (process.platform === 'win32') {
        return ['-f', 'gdigrab', '-i', source.displayId];
      }
      throw new Error(`screen capture not supported on ${process.platform}`);
    case 'camera':
      if (process.platform === 'darwin') {
        return ['-f', 'avfoundation', '-framerate', '30', '-i', `${source.deviceId}:none`];
      }
      if (process.platform === 'linux') {
        return ['-f', 'v4l2', '-i', source.deviceId];
      }
      if (process.platform === 'win32') {
        return ['-f', 'dshow', '-i', `video=${source.deviceId}`];
      }
      throw new Error(`camera capture not supported on ${process.platform}`);
    case 'ndi':
    case 'dante':
      throw new Error(
        `${source.kind} input requires a wave-transports protocol bridge (not ffmpeg-native); see task #157`,
      );
  }
}

/** Codec → ffmpeg encoder name + sane defaults. */
function codecArgs(codec: EncoderStartRequest['codec']): string[] {
  switch (codec) {
    case 'h264':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p'];
    case 'hevc':
      return ['-c:v', 'libx265', '-preset', 'veryfast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'];
    case 'av1':
      return ['-c:v', 'libsvtav1', '-preset', '6', '-pix_fmt', 'yuv420p'];
    case 'av2':
      // Upstream-gated on the codec-watch trip (task #170). Until then this
      // intentionally throws so we don't ship a half-implemented codec path.
      throw new Error('av2 encode requires upstream ffmpeg 8.2+/libavm (see codec-watch sticky)');
  }
}

const VALID_HOST = /^[a-zA-Z0-9.-]+$/;
const VALID_STREAM_KEY = /^[a-zA-Z0-9._-]{8,128}$/;

export function buildArgs(
  req: EncoderStartRequest,
  target: SrtTarget,
): string[] {
  // Validate target shape — we never want to splat unvalidated host:port
  // into an SRT URL because that's a small attack surface for an operator
  // who edits an in-app config file by hand.
  if (!VALID_HOST.test(target.host)) {
    throw new Error(`invalid SRT host: ${JSON.stringify(target.host)}`);
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new Error(`invalid SRT port: ${target.port}`);
  }
  if (!VALID_STREAM_KEY.test(target.streamKey)) {
    throw new Error('invalid stream key shape');
  }

  const srtUrl =
    `srt://${target.host}:${target.port}` +
    `?streamid=${encodeURIComponent(target.streamKey)}` +
    `&mode=caller&latency=120000`;

  return [
    '-hide_banner',
    '-nostats', // we print our own; ffmpeg's interactive stats churn the log
    '-loglevel', 'info',
    '-progress', 'pipe:2', // emit machine-readable progress on stderr
    ...inputArgs(req.source),
    ...codecArgs(req.codec),
    '-c:a', 'aac', '-b:a', '128k', // sane audio default; tweak later
    '-f', 'mpegts',
    srtUrl,
  ];
}
