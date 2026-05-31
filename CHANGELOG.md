# Changelog

All notable changes documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Initial scaffold: Electron 34 + electron-vite + React 19 + TypeScript + Tailwind 4
- Cross-process IPC contract under Zod validation (`src/shared/ipc.ts`)
- Four-tab shell: Encoders / Receivers / Multiview / Settings
- Network-interface enumeration via `node:os` (renderer surface)
- Gateway-JWT sign-in stub (real OAuth flow tracked for Wave 2)
- Foundation chassis: CODEOWNERS, SECRETS.md, foundation-gate workflow,
  .foundation-version pin
- macOS entitlements (camera/mic/network)
- CSP: `default-src 'self'`, gateway-only `connect-src`
