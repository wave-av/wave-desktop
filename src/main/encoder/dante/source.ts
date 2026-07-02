/**
 * Dante source controller (#159, GA #74).
 *
 * Wires a LAN-subscribed Dante audio flow into the EXISTING encoder tail — same
 * shape as `../ndi/source.ts` / `../omt/source.ts`, but audio-only:
 *
 *   Dante receiver (native adapter)  ──raw PCM──▶  ffmpeg stdin
 *        │                                             │
 *        └─ decodes RTP audio off the wire             └─ AAC → SRT caller (→ WAVE MESH)
 *
 * The native leaf (opening the receiver) is reached ONLY through
 * `resolveDanteAdapter()`, which fails closed with an actionable #160 error when
 * the binding is absent — so in this build `start()` throws before ffmpeg is ever
 * spawned. No audio is synthesized: if there's no adapter, there's no stream.
 * When the adapter IS present, the first decoded buffer's format drives
 * `buildDanteArgs()`, ffmpeg is spawned with a piped stdin, and every subsequent
 * buffer is written to it. stderr is parsed by the SAME stats-parser the SRT
 * encoder uses, so progress/error surfacing is identical across all sources.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EncoderStartRequest, EncoderStatus } from '@shared/ipc';
import type { SrtTarget } from '../srt-args.js';
import { consumeChunk, type EncoderProgress, type ParseState } from '../stats-parser.js';
import { buildDanteArgs } from './dante-args.js';
import { resolveDanteAdapter, type DanteAdapterLoader } from './capability.js';
import type { DanteReceiver } from './types.js';

/** Injectable seams so the wiring is testable without ffmpeg or the native SDK. */
export interface DanteSourceDeps {
  /** Absolute ffmpeg path (from binary-resolver). */
  ffmpegBinary: string;
  /** How to obtain the Dante adapter; defaults to the fail-closed resolver. */
  resolveAdapter?: (loader?: DanteAdapterLoader) => ReturnType<typeof resolveDanteAdapter>;
  /** child_process.spawn seam (defaults to node's). */
  spawnFn?: typeof spawn;
}

export interface DanteSourceHandle {
  id: string;
  status: EncoderStatus;
  stop(): Promise<void>;
}

export interface DanteStartOptions {
  onLog?: (line: string) => void;
  onProgress?: (p: EncoderProgress) => void;
}

export class DanteSourceController {
  private readonly resolveAdapter: (
    loader?: DanteAdapterLoader,
  ) => ReturnType<typeof resolveDanteAdapter>;
  private readonly spawnFn: typeof spawn;

  constructor(private readonly deps: DanteSourceDeps) {
    this.resolveAdapter = deps.resolveAdapter ?? resolveDanteAdapter;
    this.spawnFn = deps.spawnFn ?? spawn;
  }

  /**
   * Open the Dante flow and start pushing to SRT (→ WAVE MESH). Requires
   * `req.source.kind === 'dante'`. Throws `DanteUnavailableError` (fail-closed)
   * when the native binding is absent — BEFORE spawning ffmpeg.
   */
  async start(
    req: EncoderStartRequest,
    target: SrtTarget,
    opts: DanteStartOptions = {},
  ): Promise<DanteSourceHandle> {
    if (req.source.kind !== 'dante') {
      throw new Error(`DanteSourceController requires a 'dante' source, got '${req.source.kind}'`);
    }
    const { channelId } = req.source;

    // ── capability gate: fail closed if the native binding isn't provisioned ──
    const adapter = await this.resolveAdapter();

    const abort = new AbortController();
    const receiver: DanteReceiver = await adapter.openReceiver(channelId, {
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

    // Pump: read the first buffer to learn the format, spawn ffmpeg dimensioned
    // to it, then stream every buffer (incl. the first) into stdin. Runs detached
    // from start()'s promise, which resolves once the receiver is open.
    const pump = (async () => {
      let started = false;
      for await (const frame of receiver.frames()) {
        if (abort.signal.aborted) break;
        if (!started) {
          const args = buildDanteArgs(frame.format, target);
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
