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
 * - ndi → `-f libndi_newtek -i "<source name>"` (needs a build with
 *   `--enable-libndi_newtek`; capability-probed in binary-resolver so the
 *   caller surfaces a clear "install an NDI-enabled ffmpeg" error).
 * - omt → `-f libomt -i "<HOST (source)>"` (Open Media Transport, the open
 *   NDI successor; needs `--enable-libomt`, probed the same way).
 * - dante → Dante Virtual Soundcard presents an OS audio device; we capture
 *   it per-OS (avfoundation / dshow / alsa). Audio-only.
 *
 * The NDI/OMT source name and Dante device id can contain spaces/parentheses;
 * they're each a single argv element handed to spawn() with no shell, so
 * there's nothing to escape — the string cannot break out of its argument.
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
      // NewTek NDI input device. The filename is the discovery source name
      // (`ffmpeg -f libndi_newtek -find_sources 1 -i dummy` lists them).
      // Cross-platform — the SDK ships for macOS/Linux/Windows.
      return ['-f', 'libndi_newtek', '-i', source.sourceName];
    case 'omt':
      // Open Media Transport input device (ffmpeg 7 + libomt patch set,
      // GalleryUK/FFmpeg-OMT). Filename is the full OMT source, typically
      // `HOST (sourcename)`. Cross-platform like NDI.
      return ['-f', 'libomt', '-i', source.sourceName];
    case 'dante':
      // Dante Virtual Soundcard exposes the Dante channels as a standard OS
      // audio device; we capture that device. Audio-only source (`:` prefix
      // on avfoundation selects "no video, audio device N").
      if (process.platform === 'darwin') {
        return ['-f', 'avfoundation', '-i', `:${source.channelId}`];
      }
      if (process.platform === 'linux') {
        return ['-f', 'alsa', '-i', source.channelId];
      }
      if (process.platform === 'win32') {
        return ['-f', 'dshow', '-i', `audio=${source.channelId}`];
      }
      throw new Error(`dante capture not supported on ${process.platform}`);
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

// Accept DNS hostnames + IPv4 dotted-quads + bracketed IPv6 literals.
// Bracketed IPv6 is the standard URL syntax for SRT/RTSP/HTTP — the SRT
// URL we build expects `srt://[::1]:6000?...` for v6 targets, so the
// validator has to accept that shape.
const VALID_HOST_DNS_OR_V4 = /^[a-zA-Z0-9.-]+$/;
const VALID_HOST_V6 = /^\[[0-9a-fA-F:.]+\]$/;
function validHost(host: string): boolean {
  return VALID_HOST_DNS_OR_V4.test(host) || VALID_HOST_V6.test(host);
}
const VALID_STREAM_KEY = /^[a-zA-Z0-9._-]{8,128}$/;

export function buildArgs(
  req: EncoderStartRequest,
  target: SrtTarget,
): string[] {
  // Validate target shape — we never want to splat unvalidated host:port
  // into an SRT URL because that's a small attack surface for an operator
  // who edits an in-app config file by hand.
  if (!validHost(target.host)) {
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

  // NB: we deliberately do NOT pass `-progress pipe:2`. Despite the name,
  // it emits a multi-line `frame=…\nfps=…\nbitrate=…\nprogress=continue\n`
  // block per tick, which our stats-parser.ts (which expects ffmpeg's
  // single-line interactive stats format) can't parse. We rely on the
  // default stderr stats line (`frame=NNN fps=NN bitrate=…`) instead.
  // Switch to `-progress pipe:2` only if/when stats-parser learns the
  // multi-line key=value format.
  return [
    '-hide_banner',
    '-loglevel', 'info',
    ...inputArgs(req.source),
    ...codecArgs(req.codec),
    '-c:a', 'aac', '-b:a', '128k', // sane audio default; tweak later
    '-f', 'mpegts',
    srtUrl,
  ];
}
