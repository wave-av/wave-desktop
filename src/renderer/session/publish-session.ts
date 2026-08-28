/**
 * Publish-session orchestrator (#74.b) — ties the encode bridge to WHIP publish.
 *
 * Given a captured `MediaStream` and a minted least-privilege WHIP descriptor
 * ({ endpoint, key }), this:
 *   1. selects the best supported video + audio codec (AV1/Opus preferred);
 *   2. wraps each track in a WebCodecs encoder → `EncodedChunkSource`;
 *   3. hands the pair to `@wave-av/whip-publish`'s `publish()` as a `WhipSource`.
 *
 * `publish` + the encoder-config probes are INJECTED (not imported) so this is
 * unit-testable without WebRTC / the Encoded Transform API. Session.tsx wires
 * the real `publish` from `@wave-av/whip-publish` and the real
 * `VideoEncoder` / `AudioEncoder` static probes.
 */

import {
  selectVideoConfig,
  selectAudioConfig,
  encodeVideoTrack,
  encodeAudioTrack,
  type ConfigProbe,
} from './encode-bridge';

/** The minted, least-privilege WHIP publish target handed to `publish()`. */
export interface WhipPublishTarget {
  /** Gateway WHIP endpoint, e.g. `https://api.wave.online/v1/whip/publish`. */
  endpoint: string;
  /** Short-lived `whip:write`-scoped token (Bearer). Never persisted. */
  key: string;
}

/** The `WhipSource` shape `publish()` consumes (a subset of the package's type). */
export interface EncodedWhipSource {
  video?: ReadableStream<EncodedVideoChunk>;
  audio?: ReadableStream<EncodedAudioChunk>;
}

/** Minimal shape of a live `publish()` session (mirrors `WhipSession.stop()`). */
export interface PublishHandle {
  stop(): Promise<void>;
}

/** The injected `publish()` — signature-compatible with `@wave-av/whip-publish`. */
export type PublishFn = (opts: {
  endpoint: string;
  key: string;
  source: EncodedWhipSource;
  onState?: (state: string) => void;
}) => Promise<PublishHandle>;

export interface StartPublishDeps {
  publish: PublishFn;
  /** WebCodecs static probes; default to the real globals in the renderer. */
  videoProbe?: Pick<ConfigProbe<VideoEncoderConfig>, 'isConfigSupported'>;
  audioProbe?: Pick<ConfigProbe<AudioEncoderConfig>, 'isConfigSupported'>;
  onState?: (state: string) => void;
}

export interface StartPublishResult extends PublishHandle {
  /** The negotiated codec labels — surfaced to the UI for observability. */
  videoCodec: string | null;
  audioCodec: string | null;
}

/**
 * Encode a captured `MediaStream` and publish it over WHIP.
 *
 * Selects codecs, builds the encoded-chunk sources for whatever kinds the
 * stream carries (video-only / audio-only / both), and calls the injected
 * `publish()`. Returns the live session handle plus the chosen codecs.
 *
 * @throws if the stream has neither a video nor an audio track, or if codec
 * selection fails (no supported encoder — a broken WebCodecs stack).
 */
export async function startPublish(
  stream: MediaStream,
  target: WhipPublishTarget,
  deps: StartPublishDeps,
): Promise<StartPublishResult> {
  const videoTrack = stream.getVideoTracks()[0] ?? null;
  const audioTrack = stream.getAudioTracks()[0] ?? null;
  if (!videoTrack && !audioTrack) {
    throw new Error('startPublish: stream has neither a video nor an audio track');
  }

  const videoProbe = deps.videoProbe ?? (VideoEncoder as unknown as ConfigProbe<VideoEncoderConfig>);
  const audioProbe = deps.audioProbe ?? (AudioEncoder as unknown as ConfigProbe<AudioEncoderConfig>);

  const source: EncodedWhipSource = {};
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;

  if (videoTrack) {
    const settings = videoTrack.getSettings();
    const cfg = await selectVideoConfig(videoProbe, {
      width: settings.width,
      height: settings.height,
      framerate: settings.frameRate ? Math.round(settings.frameRate) : undefined,
    });
    source.video = encodeVideoTrack(videoTrack, cfg);
    videoCodec = cfg.label;
  }
  if (audioTrack) {
    const settings = audioTrack.getSettings();
    const cfg = await selectAudioConfig(audioProbe, {
      sampleRate: settings.sampleRate,
      numberOfChannels: settings.channelCount,
    });
    source.audio = encodeAudioTrack(audioTrack, cfg);
    audioCodec = cfg.label;
  }

  const session = await deps.publish({
    endpoint: target.endpoint,
    key: target.key,
    source,
    onState: deps.onState,
  });

  return {
    videoCodec,
    audioCodec,
    stop: async (): Promise<void> => {
      await session.stop();
      // Encoder ReadableStreams cancel via publish()'s teardown of the pc senders;
      // also stop the raw tracks so the OS capture indicator clears.
      videoTrack?.stop();
      audioTrack?.stop();
    },
  };
}
