/**
 * OMT (Open Media Transport) transport adapter boundary (#158, GA #74).
 *
 * OMT is the open, royalty-free replacement for NDI (libomt / the vizrt-adjacent
 * open spec). Like NDI it is a link-local, LAN mDNS video transport the cloud can
 * never see — so capture is CLIENT-SIDE, on the operator's machine.
 *
 * These are the ONLY types the wave-desktop encoder needs to consume OMT. The
 * actual wire implementation — OMT discovery + the receiver that decodes frames —
 * lives behind a NATIVE binding (`libomt`, exposed through
 * `@wave-av/wave-transports`). wave-desktop never links the native library
 * directly; it depends only on this interface, and the capability layer
 * (`./capability.ts`) resolves a concrete adapter at runtime or fails closed.
 *
 * The shape deliberately mirrors `../ndi/types.ts`: OMT and NDI are the same
 * *class* of source (LAN video, decoded natively, raw frames piped to ffmpeg),
 * so they share the encoder + SRT tail. Keeping the two type modules parallel
 * (rather than a shared generic) keeps each native leaf independently swappable
 * and each protocol's quirks documented where they live.
 */

/** Raw pixel layouts OMT can deliver, expressed as their FourCC. */
export type OmtFourCC = 'UYVY' | 'BGRA' | 'BGRX' | 'RGBA' | 'RGBX' | 'NV12';

export interface OmtVideoFormat {
  width: number;
  height: number;
  /** Frame rate as an exact rational (e.g. 30000/1001 for 29.97). */
  frameRateN: number;
  frameRateD: number;
  fourCC: OmtFourCC;
}

/**
 * One decoded video frame. `data` is the raw pixel buffer in `format.fourCC`
 * layout — exactly what ffmpeg's `-f rawvideo` input expects, so it can be
 * written straight to the encoder's stdin with no re-copy.
 */
export interface OmtVideoFrame {
  format: OmtVideoFormat;
  data: Buffer;
  /** Source timestamp in 100-ns units, for A/V sync later. */
  timestamp100ns: bigint;
}

/** A source as advertised on the LAN. */
export interface OmtSourceRef {
  /** Human-facing name, e.g. "STUDIO-PC (Program)". Matches EncoderSource.sourceName. */
  name: string;
  /** Optional resolved URL/address (ip:port) — diagnostics only. */
  urlAddress?: string;
}

/**
 * OMT receiver quality mode. `full` = the primary high-quality stream;
 * `preview` = the low-bitrate proxy stream (for multiview/monitoring). Mirrors
 * NDI's highest/lowest bandwidth split but keeps OMT's own vocabulary.
 */
export type OmtQuality = 'full' | 'preview';

export interface OmtOpenOptions {
  quality: OmtQuality;
  /** Abort discovery/receive when signalled (wired to encoder stop()). */
  signal?: AbortSignal;
}

/**
 * A live receiver bound to one OMT source. `frames()` yields decoded video
 * frames until the receiver is closed or the signal aborts. The first frame
 * carries the negotiated `format`; callers read it to build the ffmpeg argv.
 */
export interface OmtReceiver {
  readonly sourceName: string;
  frames(): AsyncIterable<OmtVideoFrame>;
  close(): Promise<void>;
}

/**
 * The capability surface wave-desktop consumes. A concrete implementation is
 * provided by the native binding; when the binding is absent this interface is
 * never instantiated — `resolveOmtAdapter()` throws first.
 */
export interface OmtTransportAdapter {
  /** True only when the native OMT binding actually loaded on this machine. */
  readonly available: boolean;
  discover(timeoutMs?: number): Promise<OmtSourceRef[]>;
  openReceiver(sourceName: string, opts: OmtOpenOptions): Promise<OmtReceiver>;
}
