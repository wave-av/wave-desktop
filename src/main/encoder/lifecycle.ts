/**
 * Encoder process lifecycle — spawn / track / stop ffmpeg child processes
 * for SRT pushes. One process per encoder id; the id is what the renderer
 * gets back from EncoderStartResponse so it can later stop or query stats.
 *
 * This is the runtime adapter the existing IPC handler in src/main/ipc.ts
 * is going to call once #173 lands. We deliberately keep this file pure
 * (no `electron` import) so the unit tests can exercise it without booting
 * the main process.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EncoderStartRequest, EncoderStatus } from '@shared/ipc';
import { buildArgs, type SrtTarget } from './srt-args.js';
import { consumeChunk, type EncoderProgress, type ParseState } from './stats-parser.js';

export interface EncoderRecord {
  id: string;
  status: EncoderStatus;
  /** Last progress line we parsed; null until the encoder hits the first frame. */
  lastProgress: EncoderProgress | null;
  /** Underlying ffmpeg child process — null after stop(). */
  child: ChildProcess | null;
  /**
   * Set true when stop() is called. The exit handler reads this to
   * distinguish "user asked us to stop" (→ idle) from "ffmpeg crashed
   * with no warning" (→ errored). Inferring intent from `signal ===
   * 'SIGTERM' || code === 0` was unreliable: a clean ffmpeg exit code 0
   * during a live stream IS an error (something dropped the input);
   * conversely a stop() on a process that hadn't sent its first frame
   * can produce code 1 + null signal.
   */
  stoppingByUser: boolean;
}

export interface SpawnOptions {
  /** Absolute path to the ffmpeg binary. */
  binary: string;
  /** Encoder request from the renderer. */
  request: EncoderStartRequest;
  /** SRT target details (gateway host/port + stream key). */
  target: SrtTarget;
  /** Optional sink for stderr/log lines (defaults to no-op). */
  onLog?: (line: string) => void;
  /** Optional sink for progress events (defaults to no-op). */
  onProgress?: (progress: EncoderProgress) => void;
}

/**
 * Lifecycle controller. One instance per app; threads the encoder map
 * through start/stop/list so the existing IPC handler can drop the
 * stub Map<id, EncoderStatus> and call us instead.
 */
export class EncoderController {
  private readonly records = new Map<string, EncoderRecord>();

  /** Spawn an encoder; resolves with the live id once the process has booted. */
  start(opts: SpawnOptions): EncoderRecord {
    const id = randomUUID();
    const args = buildArgs(opts.request, opts.target);

    const child = spawn(opts.binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const record: EncoderRecord = {
      id,
      status: {
        id,
        state: 'connecting',
        bitrateKbps: 0,
        uptimeSec: 0,
        lastError: null,
      },
      lastProgress: null,
      child,
      stoppingByUser: false,
    };
    this.records.set(id, record);

    const parseState: ParseState = { buf: '' };
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // Surface log lines (after stripping \r overwrites).
      for (const line of text.replace(/\r/g, '\n').split('\n')) {
        if (line.length > 0) opts.onLog?.(line);
      }
      // Then try to update progress.
      const next = consumeChunk(parseState, chunk);
      if (next) {
        record.lastProgress = next;
        record.status = {
          ...record.status,
          state: 'live',
          bitrateKbps: next.bitrateKbps,
          uptimeSec: next.uptimeSec,
        };
        opts.onProgress?.(next);
      }
    });

    child.on('error', (err) => {
      record.status = {
        ...record.status,
        state: 'errored',
        lastError: err.message,
      };
      record.child = null;
    });

    child.on('exit', (code, signal) => {
      record.child = null;
      // Intent over inference: a user-initiated stop() flips
      // stoppingByUser to true BEFORE sending SIGTERM. Any other exit
      // path — clean (code 0) during a live stream, SIGKILL from the
      // OOM killer, ffmpeg's own non-zero codes — is an error from the
      // operator's POV. Pre-fix, we keyed off `signal === 'SIGTERM' ||
      // code === 0`, which mis-classified both "ffmpeg ended its input
      // cleanly mid-stream" (looked idle, actually data loss) and
      // "stop() arrived before first frame" (looked errored, actually
      // intentional).
      if (record.stoppingByUser) {
        record.status = { ...record.status, state: 'idle' };
      } else {
        record.status = {
          ...record.status,
          state: 'errored',
          lastError: `ffmpeg exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
        };
      }
    });

    return record;
  }

  /** Stop an encoder by id; returns true iff a process was running. */
  stop(id: string): boolean {
    const rec = this.records.get(id);
    if (!rec || !rec.child) return false;
    rec.stoppingByUser = true;
    rec.child.kill('SIGTERM');
    // Status flips to 'idle' once the exit handler fires; the record is
    // then evicted from the map on the next list()/size() call (we keep
    // the entry around briefly so a follow-up listStatus right after
    // stop() can still report the last-known state).
    return true;
  }

  /**
   * Returns the active encoder set, evicting any records whose child has
   * already exited. Pre-fix, stopped encoders accumulated in the map
   * forever — listStatus returned stale 'idle'/'errored' entries and
   * memory grew unboundedly across long sessions.
   */
  list(): EncoderStatus[] {
    this.evictTerminated();
    return Array.from(this.records.values()).map((r) => r.status);
  }

  private evictTerminated(): void {
    for (const [id, rec] of this.records) {
      if (rec.child === null) this.records.delete(id);
    }
  }

  get(id: string): EncoderRecord | undefined {
    return this.records.get(id);
  }

  /** For tests: number of records currently tracked. */
  size(): number {
    return this.records.size;
  }

  /** For tests / before-quit: stop everything. */
  stopAll(): void {
    for (const id of this.records.keys()) this.stop(id);
  }
}
