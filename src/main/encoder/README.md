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
| `srt-args.ts` | Build the ffmpeg argv — validates host/port/streamKey shape; refuses ndi/dante (needs a transport bridge) |
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
| ndi | 🟡 scaffolded (#157) | Client-side LAN capture. Wiring complete (`ndi/`): schema, `buildNdiArgs` (rawvideo stdin → shared encoder+SRT tail), `NdiSourceController`. Native leaf **fails closed** — `resolveNdiAdapter()` throws "NDI SDK binary not provisioned (#169)" until the redistribution license (#169/Vizrt) clears and `@wave-av/wave-transports` ships the native adapter. No synthetic frames. |
| dante | ⏳ deferred | Requires a transport DAL container (#159) |

### NDI capture path (`ndi/`, #157)

NDI is a link-local (mDNS) protocol, so capture MUST run on the operator's
machine — the cloud can never see the source. NDI slots in as a **new source
feeding the existing SRT egress rail**, not a new rail:

```
NDI source (LAN) ─▶ native adapter ─▶ raw frames ─▶ ffmpeg stdin (-f rawvideo -i pipe:0)
                    (@wave-av/wave-transports,        │
                     NDI Advanced SDK, #169-gated)    ▼
                                             H.264/HEVC/AV1  ─▶  SRT caller
                                             (codecArgs, shared)   (srtCallerUrl, shared)
```

| File | Role |
|---|---|
| `ndi/types.ts` | The transport-adapter boundary — the only NDI types wave-desktop consumes. Keeps the native, license-gated leaf swappable. |
| `ndi/ndi-args.ts` | `buildNdiArgs(format, codec, target)` — rawvideo-from-stdin input dimensioned to the NDI frame, then the SAME `codecArgs` + `srtCallerUrl` tail as every other source. |
| `ndi/capability.ts` | `resolveNdiAdapter()` — loads the native adapter or **fails closed** with an actionable #169 error. Injectable loader for tests. |
| `ndi/source.ts` | `NdiSourceController` — capability-gates, opens the receiver, spawns ffmpeg dimensioned to the first frame, pumps decoded frames into stdin. |

## Wiring (follow-up task)

Wire-in to the existing `IPC.encoderStart` / `encoderStop` / `encoderListStatus`
handlers in `src/main/ipc.ts` follows in a subsequent PR — kept separate so the
controller can be reviewed against its own tests before being plugged into the
live IPC layer.
