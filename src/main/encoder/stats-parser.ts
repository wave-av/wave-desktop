/**
 * Parse ffmpeg's stderr progress lines into structured stats.
 *
 * ffmpeg progress lines look like:
 *
 *   frame=  120 fps= 30 q=28.0 size=    2048kB time=00:00:04.00 bitrate=4194.1kbits/s speed=1.0x
 *
 * They emit roughly once a second, overwriting via \r. We parse the latest
 * line into an EncoderProgress object that the rest of main consumes. We do
 * NOT attempt to round-trip the full ffmpeg stats vocabulary — only the
 * subset the wave-desktop renderer surfaces (uptime, bitrate, frame count).
 *
 * Why a parser, not `-progress pipe:1`: pipe:1 gives a stricter machine
 * format but adds a parallel stream the encoder needs to multiplex with
 * stdout. For an MVP wave-desktop encoder, stderr scrape is enough; if we
 * ever need sub-second granularity we can switch.
 */

export interface EncoderProgress {
  /** Frames encoded so far. */
  frames: number;
  /** Frames-per-second (decoder rate). */
  fps: number;
  /** Effective output bitrate, kbps. */
  bitrateKbps: number;
  /** Stream uptime in seconds (parsed from HH:MM:SS.cc). */
  uptimeSec: number;
  /** ffmpeg speed multiplier (1.0 = real-time). */
  speed: number;
}

const FRAME_RE = /frame=\s*(\d+)/;
const FPS_RE = /fps=\s*(\d+(?:\.\d+)?)/;
const BITRATE_RE = /bitrate=\s*(\d+(?:\.\d+)?)kbits\/s/;
const TIME_RE = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/;
const SPEED_RE = /speed=\s*(\d+(?:\.\d+)?)x/;

/**
 * Parse a single ffmpeg stderr progress line. Returns null when the line
 * doesn't contain any progress markers (ffmpeg also prints config / warnings
 * we want to ignore).
 */
export function parseProgressLine(line: string): EncoderProgress | null {
  const frameM = line.match(FRAME_RE);
  if (!frameM) return null;
  const fpsM = line.match(FPS_RE);
  const bitrateM = line.match(BITRATE_RE);
  const timeM = line.match(TIME_RE);
  const speedM = line.match(SPEED_RE);

  const time = timeM
    ? Number(timeM[1]) * 3600 + Number(timeM[2]) * 60 + Number(timeM[3])
    : 0;

  return {
    frames: Number(frameM[1] ?? '0'),
    fps: fpsM ? Number(fpsM[1]) : 0,
    bitrateKbps: bitrateM ? Number(bitrateM[1]) : 0,
    uptimeSec: Math.floor(time),
    speed: speedM ? Number(speedM[1]) : 0,
  };
}

/**
 * Demultiplex a chunk of stderr (which may contain partial lines + \r-style
 * overwrites) into discrete logical lines, returning the latest parsed
 * progress event if any. `state` is the accumulator the caller threads
 * across chunks; pass `{ buf: '' }` at the start.
 */
export interface ParseState {
  buf: string;
}

export function consumeChunk(
  state: ParseState,
  chunk: string | Buffer,
): EncoderProgress | null {
  state.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  // ffmpeg uses \r within a progress line and \n at line boundaries.
  // Normalize \r to \n so each progress write becomes its own line.
  const normalized = state.buf.replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  // Keep the last (possibly partial) line in the buffer for the next chunk.
  state.buf = lines.pop() ?? '';
  // Walk from newest → oldest; first parseable line wins.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    const progress = parseProgressLine(line);
    if (progress) return progress;
  }
  return null;
}
