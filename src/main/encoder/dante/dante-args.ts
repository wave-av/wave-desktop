/**
 * Build the ffmpeg argv for a Dante audio source (#159, GA #74).
 *
 * Dante carries AUDIO only, so — unlike NDI/OMT video (rawvideo stdin) — the
 * input side is raw PCM: `-f <s16le|s24le|s32le> -ar <rate> -ac <channels> -i
 * pipe:0`. The native adapter decodes RTP audio into interleaved PCM and pipes it
 * to ffmpeg's stdin; ffmpeg encodes to AAC and muxes mpegts onto the SAME SRT
 * caller tail every other source uses (`srtCallerUrl` from `../srt-args`), which
 * is what puts the audio onto WAVE MESH.
 *
 * There is no video stream here — the emitted argv is audio-only (no `-c:v`).
 * This is an intentional divergence from the video sources, not an omission: a
 * `-c:v` flag with no video input would make ffmpeg error at startup.
 */

import { srtCallerUrl, type SrtTarget } from '../srt-args.js';
import type { DanteAudioFormat, DantePcmFormat } from './types.js';

const VALID_PCM: readonly DantePcmFormat[] = ['s16le', 's24le', 's32le'];

/** ffmpeg rawaudio input flags for the negotiated Dante audio format. */
export function danteInputArgs(format: DanteAudioFormat): string[] {
  const { sampleRate, channels, pcm } = format;
  if (!VALID_PCM.includes(pcm)) {
    throw new Error(`unsupported Dante PCM format: ${pcm}`);
  }
  // Dante flows run 44.1k–192k; anything outside is a misconfigured subscription.
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new Error(`invalid Dante sample rate: ${sampleRate}`);
  }
  // Dante supports up to 64 channels per device; clamp to a sane 1..64.
  if (!Number.isInteger(channels) || channels < 1 || channels > 64) {
    throw new Error(`invalid Dante channel count: ${channels}`);
  }
  return [
    '-f', pcm,
    '-ar', String(sampleRate),
    '-ac', String(channels),
    '-i', 'pipe:0',
  ];
}

/** AAC audio encoder tail — bitrate scales modestly with channel count. */
function audioCodecArgs(channels: number): string[] {
  // 128k stereo baseline; give multichannel more headroom (64k/ch, capped 512k)
  // so a 5.1/atmos-ish Dante flow isn't starved. AAC is the mpegts-friendly
  // default; matches the `-c:a aac -b:a 128k` the SRT encoder already emits.
  const kbps = Math.min(512, Math.max(128, channels * 64));
  return ['-c:a', 'aac', '-b:a', `${kbps}k`];
}

/**
 * Full ffmpeg argv for a Dante push: rawaudio(stdin) → AAC → SRT caller.
 * The `format` comes from the live Dante receiver's first buffer; `target` is
 * the same value every other source uses.
 */
export function buildDanteArgs(format: DanteAudioFormat, target: SrtTarget): string[] {
  const srtUrl = srtCallerUrl(target);
  return [
    '-hide_banner',
    '-loglevel', 'info',
    ...danteInputArgs(format),
    ...audioCodecArgs(format.channels),
    // audio-only: no `-c:v`. mpegts carries the AAC elementary stream.
    '-f', 'mpegts',
    srtUrl,
  ];
}
