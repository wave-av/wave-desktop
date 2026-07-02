/**
 * Build the ffmpeg argv for an NDI source (#157).
 *
 * Unlike file/screen/camera (ffmpeg-native devices handled by `buildArgs()`),
 * NDI frames are decoded by the native adapter and piped into ffmpeg's STDIN
 * as raw video. So the input side is `-f rawvideo … -i pipe:0`, dimensioned
 * from the NDI receiver's negotiated `NdiVideoFormat`. Everything downstream —
 * the H.264/HEVC/AV1 encoder and the SRT caller URL — is the EXACT same tail
 * every other source uses (`codecArgs` + `srtCallerUrl` from `../srt-args`).
 *
 * Audio: NDI carries audio on a separate frame stream. This first cut is
 * VIDEO-ONLY over the single stdin pipe (no `-c:a`); interleaving NDI audio
 * into a second pipe + `-map` is a tracked follow-up (see task #157 notes and
 * the encoder README). We intentionally do NOT emit an audio codec flag with
 * no audio input, which would make ffmpeg error at startup.
 */

import type { EncoderStartRequest } from '@shared/ipc';
import { codecArgs, srtCallerUrl, type SrtTarget } from '../srt-args.js';
import type { NdiFourCC, NdiVideoFormat } from './types.js';

/** NDI FourCC → ffmpeg rawvideo `-pixel_format`. */
const PIX_FMT: Record<NdiFourCC, string> = {
  UYVY: 'uyvy422',
  BGRA: 'bgra',
  BGRX: 'bgr0',
  RGBA: 'rgba',
  RGBX: 'rgb0',
};

function pixelFormat(fourCC: NdiFourCC): string {
  const ff = PIX_FMT[fourCC];
  if (!ff) throw new Error(`unsupported NDI pixel format: ${fourCC}`);
  return ff;
}

/** ffmpeg rawvideo input flags for the negotiated NDI video format. */
export function ndiInputArgs(format: NdiVideoFormat): string[] {
  const { width, height, frameRateN, frameRateD } = format;
  if (!Number.isInteger(width) || width < 2 || width > 16384) {
    throw new Error(`invalid NDI frame width: ${width}`);
  }
  if (!Number.isInteger(height) || height < 2 || height > 16384) {
    throw new Error(`invalid NDI frame height: ${height}`);
  }
  if (!Number.isInteger(frameRateN) || frameRateN < 1 || !Number.isInteger(frameRateD) || frameRateD < 1) {
    throw new Error(`invalid NDI frame rate: ${frameRateN}/${frameRateD}`);
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
 * Full ffmpeg argv for an NDI push: rawvideo(stdin) → encoder → SRT caller.
 * The `format` comes from the live NDI receiver's first frame; `codec` and
 * `target` are the same values every other source uses.
 */
export function buildNdiArgs(
  format: NdiVideoFormat,
  codec: EncoderStartRequest['codec'],
  target: SrtTarget,
): string[] {
  const srtUrl = srtCallerUrl(target);
  return [
    '-hide_banner',
    '-loglevel', 'info',
    ...ndiInputArgs(format),
    ...codecArgs(codec),
    // video-only for now (see file header): mux NDI audio in a follow-up.
    '-f', 'mpegts',
    srtUrl,
  ];
}
