# wave-desktop

**WAVE Operator Console** — desktop app for the first/last-mile of every WAVE
workflow. Layer 0 of the [WAVE Protocol Plane][plane].

> One app on every broadcast machine. Every signal on your LAN routes through
> WAVE automatically — encoder, receiver, multiview, conferencing bridge.

## What it does

| Tab | Purpose |
|---|---|
| **Encoders** | Pick a source (camera, screen, file, NDI receive, Dante receive, OBS scene) → pick a destination stream key → pick a codec (H.264 / HEVC / AV1 / AV2) → one-click live |
| **Receivers** | Subscribe to any WAVE feed → render to a virtual NDI source, virtual webcam (visible to Zoom/Teams/Meet), local file, or on-screen preview |
| **Multiview** | 4×4 / 9×9 / 16×16 grid with NDI + Dante audio meters. Click a tile to pin as program. Optional push to wave-realtime-edge as WebRTC |
| **Settings** | Gateway sign-in, default codec, preferred network interface, x402 budget cap |

## Why this exists

Today, broadcast engineers manually configure SRT / NDI / RTMP and stitch
their LAN packets to `api.wave.online`. After this app ships, they install
one thing and everything on their LAN finds its way to WAVE — with codec
choice, multiview, and conferencing-app virtual cameras built in.

It's also the **first** "Build on WAVE" app — built entirely on the public
WAVE SDKs, demonstrating that every customer can build their own version.

## Stack

- **Runtime**: Electron 34 + sandbox + contextIsolation + nodeIntegration:false
- **Build**: electron-vite + Vite 6 + electron-builder
- **UI**: React 19 + TypeScript 5.7 + Tailwind 4
- **State**: Zustand (renderer) · process-local state (main)
- **IPC**: typed `window.wave` surface, every channel `.parse()`'d via Zod
- **Storage**: OS secure-storage (`safeStorage`) for tokens / license keys
- **Tests**: Vitest

## Quick start

```sh
git clone https://github.com/wave-av/wave-desktop.git
cd wave-desktop
npm install
npm run dev
```

`npm run dist:mac` produces a `.dmg` for arm64 + x64 (needs Apple developer
secrets in CI; see `SECRETS.md`).

## Architecture

```
┌── renderer (untrusted, CSP-locked) ─────┐
│  React tabs → window.wave.* invokes     │
└──────────────────┬──────────────────────┘
                   │ IPC (Zod-validated)
┌──────────────────▼──────────────────────┐
│  main process                           │
│  · safeStorage (Keychain / DPAPI / etc) │
│  · OAuth device-code flow → gateway JWT │
│  · child encoders (libsrt / NDI / DAL)  │
│  · network-interface enumeration        │
└──────────────────┬──────────────────────┘
                   │ TLS + JWT (Bearer)
                   ▼
           api.wave.online  (Layer 1 — Edge)
```

See [`threat-model.md`](./threat-model.md) for the full trust boundaries.

## License boundary

This repo ships **no vendor-licensed binaries**. `libdal`, `libndi`, NDI
Advanced, `dante_activator` — all fetched at install time on each operator's
machine under their own credentials. See `CONTRIBUTING.md` and `.gitignore`.

## Roadmap

| Wave | Surface | Status |
|---|---|---|
| W1 | This scaffold | shipped |
| W2 | OAuth + safeStorage + first encoder (SRT) | next |
| W3 | Receivers tab (virtual NDI + virtual webcam) | pending |
| W4 | Multiview grid + WebRTC push | pending |
| W5 | OBS plugin (#163, separate repo) | pending |
| W6 | vMix integration (#164) | pending |
| W7 | Zoom / Teams / Meet bridge (#166) | pending |

Full plan: `~/claude-hub/.claude/plans/wave-on-prem-layer/plan.md`.

## License

[MIT](./LICENSE) · Copyright © 2026 WAVE Online LLC.

[plane]: https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md
