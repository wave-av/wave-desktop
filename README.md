# wave-desktop

**WAVE Operator Console** — desktop app for the first/last-mile of every WAVE
workflow. Layer 0 of the [WAVE Protocol Plane][plane].

> **Status: working build, alpha.** The app runs — OAuth device-code sign-in,
> safeStorage-backed token vault, SRT encoder lifecycle, WHEP subscribe +
> WHIP publish sessions (the encode→publish bridge is opt-in via the
> `WAVE_ENABLE_ENCODE_BRIDGE` flag, or `VITE_WAVE_ENABLE_ENCODE_BRIDGE` for
> the renderer build; default off), and a loopback
> control-plane HTTP API (v0.3.0) are all shipped and covered by a vitest
> suite. Interfaces still evolve. Watch the
> [releases](https://github.com/wave-av/wave-desktop/releases) + [CHANGELOG](./CHANGELOG.md).

> One app on every broadcast machine. Every signal on your LAN routes through
> WAVE automatically — encoder, receiver, multiview, conferencing bridge.

## What it does

| Tab | Purpose |
|---|---|
| **Encoders** | Pick a source (camera, screen, file, NDI receive, Dante receive, OBS scene) → pick a destination stream key → pick a codec (H.264 / HEVC / AV1 / AV2) → one-click live |
| **Receivers** | Subscribe to any WAVE feed → render to a virtual NDI source, virtual webcam (visible to Zoom/Teams/Meet), local file, or on-screen preview |
| **Multiview** | *(planned — W5)* 4×4 / 9×9 / 16×16 grid with NDI + Dante audio meters. Click a tile to pin as program. Optional push to wave-realtime-edge as WebRTC |
| **Settings** | Gateway sign-in, default codec, preferred network interface, x402 budget cap |

Auth, entitlement, and metering are handled by the WAVE platform
(`api.wave.online`); the desktop app is a thin client.

## Why this exists

Today, broadcast engineers manually configure SRT / NDI / RTMP and stitch
their LAN packets to `api.wave.online`. With this app, they install one thing
and everything on their LAN finds its way to WAVE — with codec choice,
multiview, and conferencing-app virtual cameras built in.

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

## Develop

See [AGENTS.md](./AGENTS.md) for the contribution contract + the gates every
change must pass.

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
| W1 | Shell + IPC contract + four-tab UI | shipped (0.2.0) |
| W2 | OAuth device-code + safeStorage + SRT encoder | shipped |
| W3 | WHEP subscribe + WHIP publish session surface | shipped |
| W4 | Loopback control-plane HTTP API (Companion / vMix / multiviewer) | shipped (0.3.0) |
| W5 | Multiview grid + WebRTC push | next |
| W6 | OBS plugin (#163, separate repo) | pending |
| W7 | vMix integration (#164) | pending |
| W8 | Zoom / Teams / Meet bridge (#166) | pending |

Full plan: `~/claude-hub/.claude/plans/wave-on-prem-layer/plan.md`.

## Links

- WAVE — <https://wave.online>
- Security policy — see the org [SECURITY policy](https://github.com/wave-av/.github/blob/main/SECURITY.md) (`security@wave.online`)

## License

[Apache-2.0](./LICENSE) · Copyright © 2026 WAVE Online LLC.

[plane]: https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md
