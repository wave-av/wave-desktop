/**
 * JWT decode tests — payload extraction only (we never verify signatures here).
 * Uses a hand-crafted token: header.payload.signature with base64url-encoded JSON.
 */

import { describe, expect, it } from 'vitest';
import { decodeJwtPayload, expiresInSec } from './jwt';

function jwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature-not-checked`;
}

describe('decodeJwtPayload', () => {
  it('returns sub + exp claims', () => {
    const tok = jwt({ sub: 'user-123', exp: 1_800_000_000 });
    expect(decodeJwtPayload(tok)).toEqual({ sub: 'user-123', exp: 1_800_000_000 });
  });

  it('rejects malformed tokens (wrong segment count)', () => {
    expect(() => decodeJwtPayload('one.two')).toThrow(/3 dot-separated segments/);
  });

  it('rejects non-JSON payload', () => {
    const bad = `aa.${Buffer.from('not json', 'utf8').toString('base64url')}.sig`;
    expect(() => decodeJwtPayload(bad)).toThrow(/not JSON/);
  });

  it('rejects JSON that is not an object (e.g. string literal)', () => {
    const bad = `aa.${Buffer.from('"hello"', 'utf8').toString('base64url')}.sig`;
    expect(() => decodeJwtPayload(bad)).toThrow(/not a JSON object/);
  });
});

describe('expiresInSec', () => {
  it('returns positive remaining seconds when exp is in the future', () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    expect(expiresInSec(jwt({ exp }))).toBeGreaterThan(290);
  });

  it('returns null when already expired', () => {
    const exp = Math.floor(Date.now() / 1000) - 1;
    expect(expiresInSec(jwt({ exp }))).toBeNull();
  });

  it('returns null when no exp claim', () => {
    expect(expiresInSec(jwt({ sub: 'u' }))).toBeNull();
  });
});
