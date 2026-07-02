/**
 * Build the ffmpeg argv for an OMT source (#158, GA #74).
 *
 * OMT frames are decoded by the native adapter and piped into ffmpeg's STDIN as
 * raw video — identical to the NDI path (`../ndi/ndi-args.ts`). The input side is
 * `-f rawvideo … -i pipe:0`, dimensioned from the OMT receiver's negotiated
 * `OmtVideoFormat`. Everything downstream — the H.264/HEVC/AV1 encoder and the
 * SRT caller URL — is the EXACT same tail every other source uses (`codecArgs` +
 * `srtCallerUrl` from `../srt-args`), which is what puts the frames onto WAVE MESH.
 *
 * Audio: OMT carries audio on a separate frame stream. This first cut is
 * VIDEO-ONLY over the single stdin pipe (no `-c:a`); interleaving OMT audio into
 * a second pipe + `-map` is a tracked follow-up. We intentionally do NOT emit an
 * audio codec flag with no audio input, which would make ffmpeg error at startup.
 */

import type { EncoderStartRequest } from '@shared/ipc';
import { codecArgs, srtCallerUrl, type SrtTarget } from '../srt-args.js';
import type { OmtFourCC, OmtVideoFormat } from './types.js';

/** OMT FourCC → ffmpeg rawvideo `-pixel_format`. */
const PIX_FMT: Record<OmtFourCC, string> = {
  UYVY: 'uyvy422',
  BGRA: 'bgra',
  BGRX: 'bgr0',
  RGBA: 'rgba',
  RGBX: 'rgb0',
  NV12: 'nv12',
};

function pixelFormat(fourCC: OmtFourCC): string {
  const ff = PIX_FMT[fourCC];
  if (!ff) throw new Error(`unsupported OMT pixel format: ${fourCC}`);
  return ff;
}

/** ffmpeg rawvideo input flags for the negotiated OMT video format. */
export function omtInputArgs(format: OmtVideoFormat): string[] {
  const { width, height, frameRateN, frameRateD } = format;
  if (!Number.isInteger(width) || width < 2 || width > 16384) {
    throw new Error(`invalid OMT frame width: ${width}`);
  }
  if (!Number.isInteger(height) || height < 2 || height > 16384) {
    throw new Error(`invalid OMT frame height: ${height}`);
  }
  if (
    !Number.isInteger(frameRateN) ||
    frameRateN < 1 ||
    !Number.isInteger(frameRateD) ||
    frameRateD < 1
  ) {
    throw new Error(`invalid OMT frame rate: ${frameRateN}/${frameRateD}`);
  }
  return [
    '-f', 'rawvideo',
    '-pixel_format', pixelFormat(format.fourCC),
    '-video_size', `${width}x${height}`,
    '-framerate', `${frameRateN}/${frameRateD}`,
    '-i', 'pipe:0',
  ];
}

/**
 * Full ffmpeg argv for an OMT push: rawvideo(stdin) → encoder → SRT caller.
 * The `format` comes from the live OMT receiver's first frame; `codec` and
 * `target` are the same values every other source uses.
 */
export function buildOmtArgs(
  format: OmtVideoFormat,
  codec: EncoderStartRequest['codec'],
  target: SrtTarget,
): string[] {
  const srtUrl = srtCallerUrl(target);
  return [
    '-hide_banner',
    '-loglevel', 'info',
    ...omtInputArgs(format),
    ...codecArgs(codec),
    // video-only for now (see file header): mux OMT audio in a follow-up.
    '-f', 'mpegts',
    srtUrl,
  ];
}
