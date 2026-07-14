/**
 * WebCodecs encode bridge (#74.b) — the desktop leg of the WHIP publish path.
 *
 * Session-core (#47) proved the control path: enumerate devices, mint a WHIP
 * descriptor, open capture. This module is the ENCODE half: it takes the
 * captured `MediaStreamTrack`s, drives them through WebCodecs
 * `VideoEncoder` / `AudioEncoder`, and surfaces the resulting
 * `Encoded{Video,Audio}Chunk`s as `ReadableStream`s — exactly the
 * `EncodedChunkSource` shape `@wave-av/whip-publish`'s `publish()` consumes
 * (a leg's `WhipSource.video` / `.audio`).
 *
 * GPU/codec-agnostic by design: we feed the SAME encoded-chunk contract a
 * browser publisher feeds, so the gateway/edge sees one code path. AV1 is
 * preferred for video and Opus for audio; both are feature-detected against
 * `VideoEncoder.isConfigSupported` / `AudioEncoder.isConfigSupported` and fall
 * back down a ranked ladder when the platform can't encode them.
 *
 * INERT by construction: nothing here starts on import. `startEncodeBridge()`
 * only runs when the Session view invokes it, which itself is gated behind the
 * OFF-by-default encode-bridge feature flag (see `@shared/flags`).
 *
 * Kept free of any hard `@wave-av/whip-publish` import so it unit-tests without
 * the Encoded Transform API / a WebRTC polyfill: `publish()` is injected by the
 * caller (Session.tsx passes the real import).
 */

/** Ranked video codec ladder — AV1 first, then HEVC, then H.264 (universal fallback). */
export const VIDEO_CODEC_LADDER = [
  { codec: 'av01.0.08M.08', label: 'av1' },
  { codec: 'hvc1.1.6.L93.B0', label: 'hevc' },
  { codec: 'avc1.42E01F', label: 'h264' },
] as const;

/** Ranked audio codec ladder — Opus first, then AAC-LC. */
export const AUDIO_CODEC_LADDER = [
  { codec: 'opus', label: 'opus' },
  { codec: 'mp4a.40.2', label: 'aac' },
] as const;

export interface VideoEncodeConfig {
  codec: string;
  label: string;
  width: number;
  height: number;
  framerate: number;
  bitrate: number;
}

export interface AudioEncodeConfig {
  codec: string;
  label: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
}

/** Reasonable 1080p30 default; the caller may override from track settings. */
const DEFAULT_VIDEO = { width: 1920, height: 1080, framerate: 30, bitrate: 4_000_000 };
const DEFAULT_AUDIO = { sampleRate: 48_000, numberOfChannels: 2, bitrate: 128_000 };

/**
 * Minimal structural view of the static `isConfigSupported` probe both WebCodecs
 * encoders expose. Injectable so tests drive selection without a real codec stack.
 */
export interface ConfigProbe<C> {
  isConfigSupported(config: C): Promise<{ supported?: boolean }>;
}

/**
 * Pick the highest-ranked video codec the platform can actually encode at the
 * requested geometry. Walks {@link VIDEO_CODEC_LADDER} and returns the first
 * `supported` config. Throws only if NONE are supported (H.264 baseline should
 * always be — a throw means a broken/misconfigured WebCodecs stack).
 */
export async function selectVideoConfig(
  probe: Pick<ConfigProbe<VideoEncoderConfig>, 'isConfigSupported'>,
  opts: Partial<typeof DEFAULT_VIDEO> = {},
): Promise<VideoEncodeConfig> {
  const geom = { ...DEFAULT_VIDEO, ...opts };
  for (const { codec, label } of VIDEO_CODEC_LADDER) {
    const config: VideoEncoderConfig = {
      codec,
      width: geom.width,
      height: geom.height,
      framerate: geom.framerate,
      bitrate: geom.bitrate,
    };
    const res = await probe.isConfigSupported(config);
    if (res.supported) return { ...geom, codec, label };
  }
  throw new Error('encode-bridge: no supported video codec (H.264 baseline expected)');
}

/** Pick the highest-ranked supported audio codec (Opus → AAC). */
export async function selectAudioConfig(
  probe: Pick<ConfigProbe<AudioEncoderConfig>, 'isConfigSupported'>,
  opts: Partial<typeof DEFAULT_AUDIO> = {},
): Promise<AudioEncodeConfig> {
  const base = { ...DEFAULT_AUDIO, ...opts };
  for (const { codec, label } of AUDIO_CODEC_LADDER) {
    const config: AudioEncoderConfig = {
      codec,
      sampleRate: base.sampleRate,
      numberOfChannels: base.numberOfChannels,
      bitrate: base.bitrate,
    };
    const res = await probe.isConfigSupported(config);
    if (res.supported) return { ...base, codec, label };
  }
  throw new Error('encode-bridge: no supported audio codec (Opus/AAC expected)');
}

/**
 * Drive a video `MediaStreamTrack` through a `VideoEncoder`, emitting a
 * `ReadableStream<EncodedVideoChunk>` (one of the two `WhipSource` feeds).
 *
 * Uses `MediaStreamTrackProcessor` to pull `VideoFrame`s off the track and
 * `VideoEncoder` to compress them. The returned stream's `cancel()` tears the
 * whole pipeline down (encoder flush+close, reader release) so a stopped
 * session leaks neither an encoder nor a frame reader.
 */
export function encodeVideoTrack(
  track: MediaStreamTrack,
  config: VideoEncodeConfig,
): ReadableStream<EncodedVideoChunk> {
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  let encoder: VideoEncoder | null = null;

  return new ReadableStream<EncodedVideoChunk>({
    start(controller): void {
      encoder = new VideoEncoder({
        output: (chunk) => controller.enqueue(chunk),
        error: (err) => controller.error(err),
      });
      encoder.configure({
        codec: config.codec,
        width: config.width,
        height: config.height,
        framerate: config.framerate,
        bitrate: config.bitrate,
        // Prefer realtime latency (per-frame output) over quality buffering.
        latencyMode: 'realtime',
      });
      void pumpFrames(reader, encoder, controller);
    },
    async cancel(): Promise<void> {
      await teardownVideo(reader, encoder);
    },
  });
}

/** Symmetric audio leg: `AudioData` → `AudioEncoder` → `ReadableStream<EncodedAudioChunk>`. */
export function encodeAudioTrack(
  track: MediaStreamTrack,
  config: AudioEncodeConfig,
): ReadableStream<EncodedAudioChunk> {
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  let encoder: AudioEncoder | null = null;

  return new ReadableStream<EncodedAudioChunk>({
    start(controller): void {
      encoder = new AudioEncoder({
        output: (chunk) => controller.enqueue(chunk),
        error: (err) => controller.error(err),
      });
      encoder.configure({
        codec: config.codec,
        sampleRate: config.sampleRate,
        numberOfChannels: config.numberOfChannels,
        bitrate: config.bitrate,
      });
      void pumpAudio(reader, encoder, controller);
    },
    async cancel(): Promise<void> {
      await teardownAudio(reader, encoder);
    },
  });
}

// ── internals ────────────────────────────────────────────────────────────────

async function pumpFrames(
  reader: ReadableStreamDefaultReader<VideoFrame>,
  encoder: VideoEncoder,
  controller: ReadableStreamDefaultController<EncodedVideoChunk>,
): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Backpressure: don't let the encode queue grow unbounded if the SFU stalls.
      if (encoder.encodeQueueSize <= 30) encoder.encode(value);
      value.close();
    }
    await encoder.flush();
    controller.close();
  } catch (err) {
    controller.error(err);
  }
}

async function pumpAudio(
  reader: ReadableStreamDefaultReader<AudioData>,
  encoder: AudioEncoder,
  controller: ReadableStreamDefaultController<EncodedAudioChunk>,
): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      encoder.encode(value);
      value.close();
    }
    await encoder.flush();
    controller.close();
  } catch (err) {
    controller.error(err);
  }
}

async function teardownVideo(
  reader: ReadableStreamDefaultReader<VideoFrame>,
  encoder: VideoEncoder | null,
): Promise<void> {
  await reader.cancel().catch(() => {});
  if (encoder && encoder.state !== 'closed') encoder.close();
}

async function teardownAudio(
  reader: ReadableStreamDefaultReader<AudioData>,
  encoder: AudioEncoder | null,
): Promise<void> {
  await reader.cancel().catch(() => {});
  if (encoder && encoder.state !== 'closed') encoder.close();
}
