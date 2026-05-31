# wave-desktop threat model

## Scope

Electron desktop app installed on broadcast operators' machines. Brokers
their local audio/video sources into the WAVE gateway and renders WAVE feeds
back to the LAN.

## Trust boundaries

```
┌── operator's machine ──────────────────────────────────────────┐
│   ┌── renderer (Chromium) ──────┐    ┌── main (Node + n-api) ─┐│
│   │  React UI                   │◄──►│ IPC (Zod-validated)    ││
│   │  no Node, no Electron API   │    │ safeStorage            ││
│   │  no filesystem              │    │ child encoders         ││
│   └──── CSP-locked: api.wave.   │    │ libsrt / NDI / DAL     ││
│         online + 'self' only ───┘    └────────┬───────────────┘│
│                                               │ TLS+JWT         │
└───────────────────────────────────────────────┼────────────────┘
                                                ▼
                                  api.wave.online (Layer 1 Edge)
```

| Boundary | Trust direction | Defense |
|---|---|---|
| renderer → main | renderer untrusted | every IPC payload `.parse()`'d via Zod; channel allowlist via `IPC` const |
| renderer → network | renderer untrusted | CSP `connect-src 'self' https://api.wave.online`; no `<iframe>`/`<webview>` |
| main → OS secret store | main trusted | safeStorage; raw plaintext never returned to renderer |
| main → child encoder | main trusted | child processes spawn with absolute paths only; argv is `Zod`-shaped |
| installer → operator FS | installer trusted at install time | signed installer (CSC); user-confirmation on launch |
| update channel | high-impact attack surface | `electron-updater` with TUF-style signature verification (Wave 2) |

## Threat enumeration (STRIDE)

| Threat | Mitigation |
|---|---|
| **S** Spoofed gateway endpoint via DNS hijack | TLS pinning of `api.wave.online` cert chain (Wave 2 enhancement); CSP + JWT issuer-claim check on every response |
| **T** Tampered renderer bundle (Chromium memory corruption) | sandbox + contextIsolation + nodeIntegration:false; no remote module; CSP forbids inline + remote scripts |
| **R** Operator denies signing in / running encoder | All IPC actions emit a Sentry breadcrumb tagged with the local user (no PII) |
| **I** Information leak: JWT to disk in cleartext | safeStorage encrypts; raw token never logged; renderer cannot read |
| **D** DoS via malformed IPC payload (renderer compromise) | Zod `.parse()` throws fast; main wraps each handler; bad payloads counted as a metric |
| **E** Elevation via Electron preload bypass | preload exposes a typed surface only; no remote-module; no `nodeIntegrationInSubFrames` |

## Out-of-scope (today)

- Physical access to the operator's machine (file-system attack against
  safeStorage's underlying keystore) — mitigated only by OS-level disk
  encryption.
- License-binary integrity (DAL / NDI Library) — `wave-agent` will be the
  per-machine daemon that fetches + verifies these at install time; the
  desktop app calls into wave-agent rather than vendoring.

## Process

- Threat model is reviewed at every major version bump
- Sentry + structured logs ship every IPC error class for traffic analysis
- New IPC channels MUST update this doc in the same PR
