# wave-desktop control plane

Localhost HTTP API for on-host integrations (Bitfocus Companion, vMix
bridge, multiviewer external control). Binds 127.0.0.1 only; clients
authenticate with a Bearer token generated lazily on first launch and
persisted via Electron `safeStorage`.

This is the unblocker for `companion-module-wave` v0.2 actions —
Companion runs in its own Node.js process outside the Electron sandbox,
so it needs a network-addressable surface (IPC alone is unreachable).

## Endpoints (v1)

| Method | Path | Auth | What it does |
|---|---|---|---|
| `GET`  | `/v1/status`                | Bearer | Liveness, version, uptime, signedIn |
| `GET`  | `/v1/auth`                  | Bearer | Sanitized auth state (no token) |
| `POST` | `/v1/monitor/connect`       | Bearer | Bind a feed slug to the monitor renderer |
| `POST` | `/v1/monitor/disconnect`    | Bearer | Unbind the active feed |

Every response carries the same hardening header set (see
[`security.ts`](./security.ts)): strict CSP, no caching, `Origin: null`
CORS deny.

## Threat model

| Threat | Mitigation |
|---|---|
| LAN attacker reaches the operator's machine | Bind `127.0.0.1` only — server is unreachable off-host |
| Browser at `http://127.0.0.1:31415` | `default-src 'none'` CSP + `Origin: null` deny + `Content-Type: application/json` only |
| Local malicious process steals the API key | `safeStorage` (Keychain / DPAPI / libsecret); plaintext never on disk |
| Timing side-channel on key compare | `crypto.timingSafeEqual` via `safeEqual()` |
| Oversized POST (DoS / memory spike) | 32 KiB hard cap in `readJsonBody()` |
| Authorization scheme confusion | Strict `Bearer ` prefix (case-sensitive); 401 on any other scheme |
| Stack-trace leak via 500s | Handler errors return `{error,code:INTERNAL}` only — no stack frames |
| Schema injection via untrusted body | Zod `.parse()` at the router boundary; handlers receive validated types |

## What this does NOT cover

- **No LAN bind** — a future opt-in mode for trusted operator networks
  will require mTLS or per-host allowlisting first. Don't relax the
  loopback default without that.
- **No rate limiting** — sub-millisecond latency and single-trusted-client
  expectations make this unnecessary today; revisit if we expose more
  privileged actions.
- **No request signing / nonces** — Bearer auth over loopback is
  sufficient; signing only matters when the channel itself is untrusted.

## Wiring (main process)

```ts
import { loadOrCreate } from './control-plane/api-key';
import { start } from './control-plane/server';
import { buildRoutes } from './control-plane/routes';

const apiKey = await loadOrCreate();
const handle = await start({
  apiKey,
  port: 31415,
  routes: buildRoutes(getState, monitorBridge),
});

app.on('before-quit', () => { void handle.stop(); });
```

The renderer surfaces the API key once in the settings panel (with a
"copy" button) so the operator can paste it into Companion config.

## Related

- `companion-module-wave` (registry-grounded scaffold, v0.2 actions land
  against this surface).
- `frameworks/platform-registry` — this surface is registered in
  wave-desktop's `capabilities.json` once the PR lands.
