/**
 * Dante audio transport adapter boundary (#159, GA #74).
 *
 * Dante (Audinate) is a proprietary low-latency AUDIO-over-IP transport. Unlike
 * NDI/OMT (video), Dante carries multichannel PCM audio only — so the encoder
 * path is audio-only (raw PCM stdin → AAC → SRT), NOT the rawvideo path.
 *
 * Dante is discovered/subscribed on the LAN, so capture is CLIENT-SIDE on the
 * operator's machine. These are the ONLY types wave-desktop needs to consume
 * Dante. The actual wire implementation — Dante Domain Manager / the Audinate
 * SDK receiver that decodes RTP audio into PCM — lives behind a NATIVE binding
 * exposed through `@wave-av/wave-transports`. wave-desktop never links the native
 * SDK directly; it depends only on this interface, and the capability layer
 * (`./capability.ts`) resolves a concrete adapter at runtime or fails closed.
 *
 * Parallel in shape to `../ndi/types.ts` / `../omt/types.ts` so all three
 * transports read the same way, but audio-typed (sample rate / channels / bit
 * depth) instead of video-typed (width / height / fourCC).
 */

/** PCM sample formats Dante can deliver, expressed for the ffmpeg rawaudio input. */
export type DantePcmFormat = 's16le' | 's24le' | 's32le';

export interface DanteAudioFormat {
  /** Sample rate in Hz (Dante flows are typically 48000 or 96000). */
  sampleRate: number;
  /** Channel count in the subscribed flow (mono=1, stereo=2, up to 64). */
  channels: number;
  /** PCM sample layout — maps directly to ffmpeg's `-f <fmt>`. */
  pcm: DantePcmFormat;
}

/**
 * One decoded audio buffer. `data` is interleaved PCM in `format.pcm` layout —
 * exactly what ffmpeg's rawaudio input expects, so it can be written straight to
 * the encoder's stdin with no re-copy.
 */
export interface DanteAudioFrame {
  format: DanteAudioFormat;
  data: Buffer;
  /** Source timestamp in 100-ns units, for A/V sync later. */
  timestamp100ns: bigint;
}

/** A Dante flow/channel as advertised on the LAN. */
export interface DanteChannelRef {
  /** Channel/flow id, e.g. "MixerA@stagebox-01". Matches EncoderSource.channelId. */
  channelId: string;
  /** Optional human label — diagnostics only. */
  label?: string;
}

export interface DanteOpenOptions {
  /** Abort discovery/receive when signalled (wired to encoder stop()). */
  signal?: AbortSignal;
}

/**
 * A live receiver bound to one Dante flow. `frames()` yields decoded PCM audio
 * buffers until the receiver is closed or the signal aborts. The first buffer
 * carries the negotiated `format`; callers read it to build the ffmpeg argv.
 */
export interface DanteReceiver {
  readonly channelId: string;
  frames(): AsyncIterable<DanteAudioFrame>;
  close(): Promise<void>;
}

/**
 * The capability surface wave-desktop consumes. A concrete implementation is
 * provided by the native binding; when the binding is absent this interface is
 * never instantiated — `resolveDanteAdapter()` throws first.
 */
export interface DanteTransportAdapter {
  /** True only when the native Dante SDK binding actually loaded on this machine. */
  readonly available: boolean;
  discover(timeoutMs?: number): Promise<DanteChannelRef[]>;
  openReceiver(channelId: string, opts: DanteOpenOptions): Promise<DanteReceiver>;
}
