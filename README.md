# WAVE Operator Console (wave-desktop)

The WAVE Operator Console — a cross-platform **Electron** desktop app for first/last-mile WAVE
workflows: encode, receive, multiview, and the conferencing bridge.

> **Status: early / scaffolding.** This repository is being set up. The app is not yet generally
> available; interfaces and scope will change. Watch the releases and [CHANGELOG](./CHANGELOG.md).

## What it's for

The Operator Console is the human-facing surface for running WAVE at the edge of a production —
the machine an operator sits in front of to:

- **Encode** local sources and publish them to WAVE.
- **Receive** WAVE streams for monitoring and local output.
- **Multiview** several sources at once.
- Bridge into **conferencing** for remote contribution.

Auth, entitlement, and metering are handled by the WAVE platform (api.wave.online); the desktop app
is a client.

## Develop

Prerequisites and exact commands will be documented here as the app lands. Until then, see
[AGENTS.md](./AGENTS.md) for the contribution contract and the gates every change must pass.

## Links

- WAVE — <https://wave.online>
- Security policy — see the org [SECURITY policy](https://github.com/wave-av/.github/blob/main/SECURITY.md)

## License

See [LICENSE](./LICENSE).
