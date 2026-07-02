# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **NDI capture source scaffold (#157).** Client-side NDI ingest wired into the
  existing ffmpeg + SRT egress rail as a new source. `src/main/encoder/ndi/`:
  typed adapter boundary (`types.ts`), `buildNdiArgs` (rawvideo-from-stdin →
  shared encoder + SRT caller tail), a fail-closed capability gate
  (`resolveNdiAdapter`), and `NdiSourceController` (opens receiver → pumps
  decoded frames into ffmpeg stdin). `EncoderSource` `ndi` now carries a typed
  `bandwidth` (`highest`/`lowest`). The native NDI binding is **not bundled** —
  capture fails closed with an actionable "NDI SDK binary not provisioned
  (#169)" error until the redistribution license (#169) is resolved and
  `@wave-av/wave-transports` ships the native adapter. No synthetic frames.

## [0.3.0] — control-plane HTTP API

### Added
- `src/main/control-plane/` — localhost HTTP API for on-host integrations
  (Bitfocus Companion, vMix bridge, multiviewer external control). Binds
  `127.0.0.1` only; Bearer-token auth from a `safeStorage`-persisted API
  key generated lazily on first launch.
- `GET /v1/status` — version, uptime, signedIn.
- `GET /v1/auth` — sanitized auth state (no token surface to clients).
- `POST /v1/monitor/connect {slug}` + `POST /v1/monitor/disconnect` —
  wire feeds into the monitor renderer from external controllers.
- Hardening header set per response (`default-src 'none'` CSP, `Origin:
  null` deny, `X-Frame-Options: DENY`, no caching).
- `capabilities.json` updated to register the new control-plane API in
  the platform-registry.
- 26 vitest cases covering the live HTTP path (auth, schema validation,
  body size limit, error envelopes, security headers).

### Why
Closes the gap that blocked `companion-module-wave` v0.2 actions — the
Companion module runs in its own Node.js process outside the Electron
sandbox, so IPC alone is unreachable. With this control plane in place,
Companion / vMix / external multiviewer can drive operator actions
without ad-hoc surface per integration.

## [0.2.0]

### Added
- Initial scaffold: Electron 34 + electron-vite + React 19 + TypeScript + Tailwind 4
- Cross-process IPC contract under Zod validation (`src/shared/ipc.ts`)
- Four-tab shell: Encoders / Receivers / Multiview / Settings
- Network-interface enumeration via `node:os` (renderer surface)
- Gateway-JWT sign-in stub (real OAuth flow tracked for Wave 2)
- Foundation chassis: CODEOWNERS, SECRETS.md, foundation-gate workflow,
  `.foundation-version` pin
- macOS entitlements (camera/mic/network)
- CSP: `default-src 'self'`, gateway-only `connect-src`
- AGENTS.md governance contract (inherits the org default + repo-governance standard)
