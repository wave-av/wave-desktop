/**
 * WHEP client (#74.d) — the RECEIVE counterpart to the WHIP publish path.
 *
 * WHEP (WebRTC-HTTP Egress Protocol, draft-murillo-whep-03) is the egress
 * sibling of WHIP: a viewer POSTs an SDP OFFER to the gateway's
 * `/v1/whep/subscribe` endpoint with a scoped Bearer token, the server replies
 * `201 Created` + an SDP ANSWER + a `Location:` header naming the WHEP resource,
 * and the client applies the answer to a `recvonly` RTCPeerConnection. Teardown
 * is `DELETE <resource>`.
 *
 * The gateway is a REVERSE PROXY, not a token minter — the client talks ONLY to
 * `api.wave.online/v1/whep/*` (never an edge URL). The `Location` the gateway
 * returns is already rewritten to a gateway-absolute `/v1/whep/resource/<id>`
 * path (see the WAVE gateway's `rewriteWhepLocation` route helper), so PATCH-trickle /
 * DELETE-teardown stay on the metered control plane.
 *
 * Mirrors the publish side's conventions: `RTCPeerConnection` + `fetch` are
 * INJECTED (default to the renderer globals) so the SDP/offer→answer/teardown
 * plumbing is unit-testable without a real WebRTC stack. Receivers.tsx wires the
 * real globals.
 */

/** The minted, least-privilege WHEP subscribe target. */
export interface WhepSubscribeTarget {
  /** Gateway WHEP subscribe endpoint, e.g. `https://api.wave.online/v1/whep/subscribe`. */
  endpoint: string;
  /** Short-lived `whep:write`-scoped token (Bearer). Never persisted. */
  key: string;
}

/** A minimal `fetch` shape — just what the WHEP handshake needs. */
export type FetchFn = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    /** Abort signal so a stalled POST/DELETE can be cancelled on timeout. */
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** The subset of `RTCPeerConnection` the WHEP handshake drives. */
export interface WhepPeer {
  addTransceiver(kind: string, init: { direction: RTCRtpTransceiverDirection }): void;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  readonly localDescription: { sdp?: string } | null;
  /** Gathering state — drives the non-trickle wait. Absent on test mocks (→ no wait). */
  readonly iceGatheringState?: RTCIceGatheringState;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  close(): void;
}

export interface StartWhepDeps {
  /** Factory for the recvonly peer connection. Defaults to `new RTCPeerConnection({ iceServers })`. */
  createPeer?: () => WhepPeer;
  /**
   * ICE servers for the default peer. Defaults to public STUN so a viewer behind
   * NAT can discover its server-reflexive candidate. Inject WAVE's own TURN here
   * for restrictive (symmetric-NAT / UDP-blocked) networks.
   */
  iceServers?: RTCIceServer[];
  /** HTTP transport. Defaults to the global `fetch`. */
  fetchImpl?: FetchFn;
  /** Called with the incoming `MediaStream` once a track arrives (attach to <video>). */
  onStream?: (stream: MediaStream) => void;
  /** Called with connection-state transitions (observability / UI). */
  onState?: (state: string) => void;
}

/** A live WHEP subscription — call `stop()` to DELETE the resource + close the pc. */
export interface WhepSession {
  /** The gateway-absolute resource URL (from the `Location` header), or null if absent. */
  readonly resourceUrl: string | null;
  stop(): Promise<void>;
}

const SDP_CONTENT_TYPE = 'application/sdp';

/** How long a WHEP POST-subscribe / DELETE-teardown may stall before aborting. */
const WHEP_FETCH_TIMEOUT_MS = 30_000;

/**
 * Default STUN so a viewer behind NAT discovers its server-reflexive candidate —
 * without it the offer carries only host (LAN) candidates and a cloud SFU on a
 * different network has no path to send media. Injectable via
 * `StartWhepDeps.iceServers` (swap in WAVE's own TURN for symmetric-NAT /
 * UDP-blocked networks); this public-STUN default covers the common case.
 */
const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/**
 * Bound on the pre-POST ICE-gathering wait. WHEP here is NON-trickle (a single
 * POST), so the offer must carry its candidates — but a slow/hung STUN RTT must
 * not stall playback forever, so on timeout we POST whatever gathered so far.
 */
const WHEP_ICE_GATHERING_TIMEOUT_MS = 3_000;

/**
 * Resolve the WHEP resource URL from the `Location` response header against the
 * subscribe endpoint's origin. The gateway rewrites Location to a gateway-
 * absolute path (`/v1/whep/resource/<id>`); a relative value is resolved against
 * the endpoint so DELETE targets the same gateway host.
 *
 * SAME-ORIGIN CONSTRAINT: `resourceUrl` is later used as the DELETE target
 * carrying the scoped Bearer, so a malformed/hostile absolute `Location` at a
 * DIFFERENT origin must never be honored (it would leak the token to an
 * unintended host). Any cross-origin result is rejected → null. Returns null
 * when the header is absent or invalid (teardown then closes the pc only).
 */
export function resolveResourceUrl(endpoint: string, location: string | null): string | null {
  if (!location) return null;
  try {
    const base = new URL(endpoint);
    const resolved = new URL(location, base);
    // Never follow a Location that points off the gateway origin.
    if (resolved.origin !== base.origin) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Bake the chosen source uid into the WHEP subscribe endpoint as `?resource=`
 * (WHEP-C). The edge REQUIRES `?resource=<liveInputUid>` — a bare subscribe
 * 400s — and the minted token endpoint carries no query string, so the resource
 * is threaded in here. The uid is URL-encoded; an existing query (defensive —
 * the mint endpoint has none today) is preserved with `&`.
 */
export function buildSubscribeEndpoint(endpoint: string, resource: string): string {
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}resource=${encodeURIComponent(resource)}`;
}

/**
 * Resolve once ICE gathering completes (so the non-trickle offer carries its
 * candidates) or after `timeoutMs`, whichever comes first. Peers that report no
 * gathering state — e.g. unit-test mocks — resolve immediately (no wait).
 */
function waitForIceGathering(pc: WhepPeer, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === undefined || pc.iceGatheringState === 'complete') {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') finish();
    });
  });
}

/** A `fetch` with an abort-on-timeout guard so a stalled hop can't hang forever. */
async function fetchWithTimeout(
  fetchImpl: FetchFn,
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<Awaited<ReturnType<FetchFn>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHEP_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open a WHEP subscription and stream the remote media to `onStream`.
 *
 * 1. Build a `recvonly` peer with audio+video transceivers.
 * 2. `createOffer` → `setLocalDescription`.
 * 3. POST the offer SDP to the WHEP endpoint with the scoped Bearer (`application/sdp`).
 * 4. On `201`, read `Location` (resource URL) + apply the answer SDP.
 * 5. Return a handle whose `stop()` DELETEs the resource and closes the pc.
 *
 * @throws on a non-2xx subscribe, a missing/empty answer body, or a WHEP-
 * unconfigured gateway (`503` — surfaced verbatim so the UI can say so).
 */
export async function startWhep(
  target: WhepSubscribeTarget,
  deps: StartWhepDeps = {},
): Promise<WhepSession> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchFn);
  const createPeer =
    deps.createPeer ??
    (() =>
      new RTCPeerConnection({
        iceServers: (deps.iceServers ?? DEFAULT_ICE_SERVERS) as RTCIceServer[],
      }) as unknown as WhepPeer);

  const pc = createPeer();
  // recvonly: we only ever RECEIVE media on a WHEP subscribe.
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  if (deps.onStream) {
    pc.addEventListener('track', (ev: unknown) => {
      const streams = (ev as RTCTrackEvent).streams;
      if (streams && streams[0]) deps.onStream?.(streams[0]);
    });
  }
  if (deps.onState) {
    pc.addEventListener('connectionstatechange', () => {
      const state = (pc as unknown as { connectionState?: string }).connectionState;
      if (state) deps.onState?.(state);
    });
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // WHEP here is non-trickle: the single POST must carry ICE candidates, so wait
  // (bounded) for gathering to finish before reading the local SDP.
  await waitForIceGathering(pc, WHEP_ICE_GATHERING_TIMEOUT_MS);
  const offerSdp = pc.localDescription?.sdp ?? offer.sdp;
  if (!offerSdp) throw new Error('startWhep: local SDP offer was empty');

  const res = await fetchWithTimeout(fetchImpl, target.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${target.key}`,
      'content-type': SDP_CONTENT_TYPE,
      accept: SDP_CONTENT_TYPE,
    },
    body: offerSdp,
  });

  const answerSdp = await res.text();
  if (!res.ok) {
    pc.close();
    // 503 = WHEP edge not configured (gateway INERT); surface the status honestly.
    throw new Error(
      res.status === 503
        ? 'WHEP not available — the gateway egress is not configured (503)'
        : `WHEP subscribe failed (${res.status})${answerSdp ? `: ${answerSdp.slice(0, 200)}` : ''}`,
    );
  }
  if (!answerSdp.trim()) {
    pc.close();
    throw new Error('WHEP subscribe returned an empty SDP answer');
  }

  const resourceUrl = resolveResourceUrl(target.endpoint, res.headers.get('location'));
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  let stopped = false;
  return {
    resourceUrl,
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      // WHEP teardown: DELETE the resource so the gateway meters the egress
      // session end. Best-effort — a failed DELETE must not prevent the local
      // pc from closing (the edge reaps orphaned sessions on ICE timeout).
      if (resourceUrl) {
        try {
          await fetchWithTimeout(fetchImpl, resourceUrl, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${target.key}` },
          });
        } catch {
          /* best-effort teardown (incl. abort-on-timeout) */
        }
      }
      pc.close();
    },
  };
}
