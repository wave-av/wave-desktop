# wave-desktop encoder

Spawns an `ffmpeg` child process per encoder, configured for an **SRT push**
to the WAVE gateway. Layer-0 of the WAVE Protocol Plane (operator console).

## Why ffmpeg + libsrt, not a direct N-API libsrt binding

The original task #173 spec called for "libsrt encoder via N-API child
process." We chose a child-process wrapper around `ffmpeg` instead. Reasoning:

| Concern | N-API libsrt | ffmpeg child process |
|---|---|---|
| Maintenance | Hand-rolled mpegts muxer + codec glue per platform | One battle-tested process, same on all OSes |
| Codec breadth | Implement each codec ourselves | h264 / hevc / av1 today; av2 free once #170 trips |
| Operator install | Native add-on per Electron version + arch matrix | `brew install ffmpeg` (already common) |
| Spawn overhead | ~0 | ~50 ms once per encoder start |
| Debuggability | Black box | `ffmpeg -loglevel info` straight to log |

Spawn overhead is negligible against a multi-minute live stream; we can swap
to N-API later if a real workload calls for it.

## Layout

| File | Role |
|---|---|
| `binary-resolver.ts` | Find ffmpeg on disk (env / `$PATH` / platform defaults) + probe for libsrt |
| `srt-args.ts` | Build the ffmpeg argv — validates host/port/streamKey shape; refuses ndi/dante (needs wave-transports bridge) |
| `stats-parser.ts` | Parse ffmpeg stderr progress lines (`frame=`, `bitrate=`, `time=`) into structured stats |
| `lifecycle.ts` | `EncoderController` — spawn / track / stop child processes; surfaces progress + errors |

## Threat model

| Threat | Mitigation |
|---|---|
| Shell injection via streamKey / host | `spawn()` with array argv (no shell), plus strict regex validation in `buildArgs()` before constructing the SRT URL |
| Resource leak on app quit | `EncoderController.stopAll()` — wired from `before-quit` in main |
| Spawn ENOENT on missing ffmpeg | `binary-resolver.resolve()` returns null → caller surfaces a clear UI error rather than crashing the IPC handler |
| Memory blow-up on long-running stream stderr | `consumeChunk()` resets its buffer on every parsed line; ffmpeg log lines are short |
| Stale state after ffmpeg crash | `exit` handler flips `EncoderStatus.state` to `errored` with the actual exit code/signal |

## Codec support

| Codec | Status | Notes |
|---|---|---|
| h264 | ✅ ready | `libx264`, veryfast / zerolatency |
| hevc | ✅ ready | `libx265`, hvc1 tag for Safari compat |
| av1 | ✅ ready | `libsvtav1`, preset 6 |
| av2 | ⏳ gated | Requires upstream ffmpeg 8.2+ with `--enable-libavm` — see `codec-watch` (foundation #334) |

## Source support

| Source | Status | Notes |
|---|---|---|
| file | ✅ ready | `-re -i <path>` (real-time read) |
| screen | ✅ ready | macOS `avfoundation`, Linux `x11grab`, Windows `gdigrab` |
| camera | ✅ ready | macOS `avfoundation`, Linux `v4l2`, Windows `dshow` |
| ndi | ⏳ deferred | Requires wave-transports protocol bridge (#157) |
| dante | ⏳ deferred | Requires wave-transports DAL container (#159) |

## Wiring (follow-up task)

Wire-in to the existing `IPC.encoderStart` / `encoderStop` / `encoderListStatus`
handlers in `src/main/ipc.ts` follows in a subsequent PR — kept separate so the
controller can be reviewed against its own tests before being plugged into the
live IPC layer.
