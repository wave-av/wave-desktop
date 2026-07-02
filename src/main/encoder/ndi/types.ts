/**
 * NDI transport adapter boundary (#157).
 *
 * These are the ONLY types the wave-desktop encoder needs to consume NDI. The
 * actual wire implementation — NDI mDNS discovery + the receiver that decodes
 * frames — lives behind a NATIVE binding (the NDI Advanced SDK, redistribution
 * gated by #169) exposed through `@wave-av/wave-transports`. wave-desktop never
 * links the native SDK directly; it depends only on this interface, and the
 * capability layer (`./capability.ts`) resolves a concrete adapter at runtime
 * or fails closed.
 *
 * This is the seam that keeps the native, license-gated leaf swappable: the
 * source controller, the ffmpeg arg builder, and the tests all speak `types.ts`
 * and know nothing about how frames actually come off the wire.
 */

/** Raw pixel layouts NDI can deliver, expressed as their FourCC. */
export type NdiFourCC = 'UYVY' | 'BGRA' | 'BGRX' | 'RGBA' | 'RGBX';

export interface NdiVideoFormat {
  width: number;
  height: number;
  /** Frame rate as an exact rational (e.g. 30000/1001 for 29.97). */
  frameRateN: number;
  frameRateD: number;
  fourCC: NdiFourCC;
}

/**
 * One decoded video frame. `data` is the raw pixel buffer in `format.fourCC`
 * layout — exactly what ffmpeg's `-f rawvideo` input expects, so it can be
 * written straight to the encoder's stdin with no re-copy.
 */
export interface NdiVideoFrame {
  format: NdiVideoFormat;
  data: Buffer;
  /** Source timestamp in 100-ns units (NDI native), for A/V sync later. */
  timestamp100ns: bigint;
}

/** A source as advertised on the LAN. */
export interface NdiSourceRef {
  /** Human-facing name, e.g. "STUDIO-PC (Cam 1)". Matches EncoderSource.sourceName. */
  name: string;
  /** Optional resolved URL/address (ip:port) — diagnostics only. */
  urlAddress?: string;
}

export type NdiBandwidth = 'highest' | 'lowest';

export interface NdiOpenOptions {
  bandwidth: NdiBandwidth;
  /** Abort discovery/receive when signalled (wired to encoder stop()). */
  signal?: AbortSignal;
}

/**
 * A live receiver bound to one NDI source. `frames()` yields decoded video
 * frames until the receiver is closed or the signal aborts. The first frame
 * carries the negotiated `format`; callers read it to build the ffmpeg argv.
 */
export interface NdiReceiver {
  readonly sourceName: string;
  frames(): AsyncIterable<NdiVideoFrame>;
  close(): Promise<void>;
}

/**
 * The capability surface wave-desktop consumes. A concrete implementation is
 * provided by the native binding; when the binding is absent this interface is
 * never instantiated — `resolveNdiAdapter()` throws first.
 */
export interface NdiTransportAdapter {
  /** True only when the native SDK binding actually loaded on this machine. */
  readonly available: boolean;
  discover(timeoutMs?: number): Promise<NdiSourceRef[]>;
  openReceiver(sourceName: string, opts: NdiOpenOptions): Promise<NdiReceiver>;
}
