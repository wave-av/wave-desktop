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
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  close(): void;
}

export interface StartWhepDeps {
  /** Factory for the recvonly peer connection. Defaults to `new RTCPeerConnection()`. */
  createPeer?: () => WhepPeer;
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

/**
 * Resolve the WHEP resource URL from the `Location` response header against the
 * subscribe endpoint's origin. The gateway rewrites Location to a gateway-
 * absolute path (`/v1/whep/resource/<id>`); a relative value is resolved against
 * the endpoint so DELETE targets the same gateway host. Returns null when the
 * header is absent (teardown then falls back to closing the pc only).
 */
export function resolveResourceUrl(endpoint: string, location: string | null): string | null {
  if (!location) return null;
  try {
    return new URL(location, endpoint).toString();
  } catch {
    return null;
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
    deps.createPeer ?? (() => new RTCPeerConnection() as unknown as WhepPeer);

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
  const offerSdp = pc.localDescription?.sdp ?? offer.sdp;
  if (!offerSdp) throw new Error('startWhep: local SDP offer was empty');

  const res = await fetchImpl(target.endpoint, {
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
          await fetchImpl(resourceUrl, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${target.key}` },
          });
        } catch {
          /* best-effort teardown */
        }
      }
      pc.close();
    },
  };
}
