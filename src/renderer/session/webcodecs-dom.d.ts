/**
 * `MediaStreamTrackProcessor` (Insertable Streams for MediaStreamTrack) is a
 * Chromium API not yet present in TypeScript's DOM lib. The renderer runs in
 * Electron/Chromium where it exists at runtime; declare the minimal surface the
 * encode bridge uses (#74.b) so `tsc` resolves it.
 */

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
}

declare class MediaStreamTrackProcessor<T = VideoFrame | AudioData> {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<T>;
}
