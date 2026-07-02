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
      // NDI/dante are NOT ffmpeg-native inputs — ffmpeg cannot open a `-i ndi://…`
      // device without an external SDK. They require a transport protocol bridge:
      // a native adapter decodes frames off the wire and pipes RAW frames into
      // ffmpeg via stdin. NDI takes that path through `buildNdiArgs()` (below) +
      // the NDI source controller in `./ndi/`; `buildArgs()` handles only the
      // ffmpeg-native device/file sources. See task #157.
      throw new Error(
        `${source.kind} input requires a transport protocol bridge (not ffmpeg-native); ` +
          `NDI is bridged via buildNdiArgs() + the ndi/ source controller — see task #157`,
      );
  }
}

/** Codec → ffmpeg encoder name + sane defaults. */
export function codecArgs(codec: EncoderStartRequest['codec']): string[] {
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

/**
 * Validate an SrtTarget and build the caller-mode SRT output URL. Shared by
 * `buildArgs()` (ffmpeg-native sources) and `buildNdiArgs()` (stdin-fed NDI
 * source) so BOTH source paths land on the identical, validated SRT tail —
 * the gateway-facing `srt://host:port?streamid=<key>&mode=caller` convention.
 * We never splat an unvalidated host/port/key into the URL: an operator who
 * hand-edits an in-app config file is a small but real injection surface.
 */
export function srtCallerUrl(target: SrtTarget): string {
  if (!validHost(target.host)) {
    throw new Error(`invalid SRT host: ${JSON.stringify(target.host)}`);
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new Error(`invalid SRT port: ${target.port}`);
  }
  if (!VALID_STREAM_KEY.test(target.streamKey)) {
    throw new Error('invalid stream key shape');
  }
  return (
    `srt://${target.host}:${target.port}` +
    `?streamid=${encodeURIComponent(target.streamKey)}` +
    `&mode=caller&latency=120000`
  );
}

export function buildArgs(
  req: EncoderStartRequest,
  target: SrtTarget,
): string[] {
  const srtUrl = srtCallerUrl(target);

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
