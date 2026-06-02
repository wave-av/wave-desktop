/**
 * Minimal JWT decoder — payload claims only, NO signature verification.
 *
 * We never trust this code with auth decisions. The gateway signed the token,
 * the gateway will reject it on the wire if it's been tampered with. We only
 * decode locally to:
 *   - display the subject (operator identity) in the settings panel
 *   - schedule a proactive refresh ~60s before `exp`
 *
 * Using Node's `Buffer.from(..., 'base64url')` to handle the URL-safe alphabet
 * the JWT spec requires. The payload is JSON; anything else is rejected as
 * malformed so a hijacked endpoint can't smuggle non-JSON garbage past us.
 */

export interface JwtPayload {
  sub?: string;
  exp?: number; // seconds since epoch
  iat?: number;
  [k: string]: unknown;
}

export function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('jwt: expected 3 dot-separated segments');
  let json: string;
  try {
    json = Buffer.from(parts[1], 'base64url').toString('utf8');
  } catch {
    throw new Error('jwt: payload base64url decode failed');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('jwt: payload is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('jwt: payload is not a JSON object');
  }
  return parsed as JwtPayload;
}

/**
 * Seconds until expiry, or null if no exp claim or already expired.
 * Use the result for UI display + refresh scheduling, NOT for "should I send this token"
 * (the gateway is authoritative).
 */
export function expiresInSec(token: string): number | null {
  const { exp } = decodeJwtPayload(token);
  if (typeof exp !== 'number') return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = exp - nowSec;
  return remaining > 0 ? remaining : null;
}
