# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `pr-agent` lane: fork-triggered `/` commands are now refused, and the AI
  call's budget fits inside its step. Three defects, one of them only visible
  once the first was fixed.

  The job-level `if:` refused forks on the `pull_request` arm and could not on
  `issue_comment` — fork status is absent from that payload, so there was never
  an expression to write. A `fork gate` step now asks the pulls endpoint and
  fails closed: only a literal `false` proceeds, so a 404, a rate limit or a
  deleted fork all skip. The lane runs no `actions/checkout`, so fork code was
  never executed and no exfiltration path existed; what this closes is the
  comment claiming forks were already skipped, which was true of one arm only.

  `CONFIG__AI_TIMEOUT` was 600s inside a 360s step, so the runner killed the
  step before pr-agent could reach its own timeout or fall back to a secondary
  model. Now 300s.

  Fixing the first exposed a third: `stamp attempt 2 end` runs under
  `if: always()`, so when attempt 2 never ran the verdict subtracted from zero
  and reported a 1787580408-second attempt as a confident TIMED OUT.

  Contributors on forks are affected: a maintainer's `/review` on a fork PR is
  now declined with a warning rather than silently running.
  (wave-av/wave-foundation-public#73)

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
