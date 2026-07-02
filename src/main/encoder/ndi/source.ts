/**
 * NDI source controller (#157).
 *
 * Wires a LAN-discovered NDI source into the EXISTING encoder tail:
 *
 *   NDI receiver (native adapter)  ──raw frames──▶  ffmpeg stdin
 *        │                                              │
 *        └─ decodes UYVY/BGRA off the wire              └─ H.264/HEVC/AV1 → SRT caller
 *                                                          (srt://ingest.wave.online:6000)
 *
 * The native, license-gated leaf (opening the receiver) is reached ONLY through
 * `resolveNdiAdapter()`, which fails closed with an actionable #169 error when
 * the binding is absent — so in this build `start()` throws before ffmpeg is
 * ever spawned. No frames are synthesized: if there's no adapter, there's no
 * stream. When the adapter IS present, the first decoded frame's format drives
 * `buildNdiArgs()`, ffmpeg is spawned with a piped stdin, and every subsequent
 * frame is written to it. stderr is parsed by the SAME stats-parser the SRT
 * encoder uses, so progress/error surfacing is identical across all sources.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EncoderStartRequest, EncoderStatus } from '@shared/ipc';
import type { SrtTarget } from '../srt-args.js';
import { consumeChunk, type EncoderProgress, type ParseState } from '../stats-parser.js';
import { buildNdiArgs } from './ndi-args.js';
import { resolveNdiAdapter, type NdiAdapterLoader } from './capability.js';
import type { NdiReceiver } from './types.js';

/** Injectable seams so the wiring is testable without ffmpeg or the native SDK. */
export interface NdiSourceDeps {
  /** Absolute ffmpeg path (from binary-resolver). */
  ffmpegBinary: string;
  /** How to obtain the NDI adapter; defaults to the fail-closed resolver. */
  resolveAdapter?: (loader?: NdiAdapterLoader) => ReturnType<typeof resolveNdiAdapter>;
  /** child_process.spawn seam (defaults to node's). */
  spawnFn?: typeof spawn;
}

export interface NdiSourceHandle {
  id: string;
  status: EncoderStatus;
  stop(): Promise<void>;
}

export interface NdiStartOptions {
  onLog?: (line: string) => void;
  onProgress?: (p: EncoderProgress) => void;
}

export class NdiSourceController {
  private readonly resolveAdapter: (loader?: NdiAdapterLoader) => ReturnType<typeof resolveNdiAdapter>;
  private readonly spawnFn: typeof spawn;

  constructor(private readonly deps: NdiSourceDeps) {
    this.resolveAdapter = deps.resolveAdapter ?? resolveNdiAdapter;
    this.spawnFn = deps.spawnFn ?? spawn;
  }

  /**
   * Open the NDI source and start pushing to SRT. Requires `req.source.kind ===
   * 'ndi'`. Throws `NdiUnavailableError` (fail-closed) when the native binding
   * is absent — BEFORE spawning ffmpeg.
   */
  async start(
    req: EncoderStartRequest,
    target: SrtTarget,
    opts: NdiStartOptions = {},
  ): Promise<NdiSourceHandle> {
    if (req.source.kind !== 'ndi') {
      throw new Error(`NdiSourceController requires an 'ndi' source, got '${req.source.kind}'`);
    }
    const { sourceName, bandwidth } = req.source;

    // ── capability gate: fail closed if the native binding isn't provisioned ──
    const adapter = await this.resolveAdapter();

    const abort = new AbortController();
    const receiver: NdiReceiver = await adapter.openReceiver(sourceName, {
      bandwidth,
      signal: abort.signal,
    });

    const id = randomUUID();
    const status: EncoderStatus = {
      id,
      state: 'connecting',
      bitrateKbps: 0,
      uptimeSec: 0,
      lastError: null,
    };

    let child: ChildProcess | null = null;
    const parseState: ParseState = { buf: '' };

    // Pump: read the first frame to learn the format, spawn ffmpeg dimensioned
    // to it, then stream every frame (incl. the first) into stdin. Runs
    // detached from start()'s promise, which resolves once the receiver is open.
    const pump = (async () => {
      let started = false;
      for await (const frame of receiver.frames()) {
        if (abort.signal.aborted) break;
        if (!started) {
          const args = buildNdiArgs(frame.format, req.codec, target);
          child = this.spawnFn(this.deps.ffmpegBinary, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          child.stderr?.on('data', (chunk: Buffer) => {
            for (const line of chunk.toString('utf8').replace(/\r/g, '\n').split('\n')) {
              if (line.length > 0) opts.onLog?.(line);
            }
            const next = consumeChunk(parseState, chunk);
            if (next) {
              status.state = 'live';
              status.bitrateKbps = next.bitrateKbps;
              status.uptimeSec = next.uptimeSec;
              opts.onProgress?.(next);
            }
          });
          child.on('exit', () => {
            abort.abort();
          });
          started = true;
        }
        // Backpressure-aware write; drop nothing, never fabricate.
        child?.stdin?.write(frame.data);
      }
      child?.stdin?.end();
    })();
    // Surface pump failures via status rather than an unhandled rejection.
    void pump.catch((err: unknown) => {
      status.state = 'errored';
      status.lastError = err instanceof Error ? err.message : String(err);
      abort.abort();
    });

    return {
      id,
      status,
      stop: async () => {
        abort.abort();
        child?.kill('SIGTERM');
        await receiver.close();
      },
    };
  }
}
