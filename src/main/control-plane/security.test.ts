/**
 * Unit tests for the security-header + bearer-parse helpers. These hit the
 * smallest possible surface — no live server — so they run sub-ms and pin
 * the header contract for future maintainers.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { applySecurityHeaders, parseBearer } from './security.ts';

function mockRes(): ServerResponse {
  const headers: Record<string, string> = {};
  return {
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    getHeader: (name: string) => headers[name.toLowerCase()],
    __headers: headers,
  } as unknown as ServerResponse & { __headers: Record<string, string> };
}

describe('applySecurityHeaders', () => {
  it('sets the seven hardening headers', () => {
    const res = mockRes() as ServerResponse & { __headers: Record<string, string> };
    applySecurityHeaders(res);
    expect(res.__headers['x-content-type-options']).toBe('nosniff');
    expect(res.__headers['x-frame-options']).toBe('DENY');
    expect(res.__headers['referrer-policy']).toBe('no-referrer');
    expect(res.__headers['cache-control']).toBe('no-store');
    expect(res.__headers['content-security-policy']).toBe("default-src 'none'");
    expect(res.__headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.__headers['permissions-policy']).toBe('interest-cohort=()');
    expect(res.__headers['access-control-allow-origin']).toBe('null');
    expect(res.__headers['vary']).toBe('Origin');
  });

  it('CSP is the strictest possible default-src none', () => {
    const res = mockRes() as ServerResponse & { __headers: Record<string, string> };
    applySecurityHeaders(res);
    // Locks in that we never relax to default-src 'self' without intent.
    expect(res.__headers['content-security-policy']).not.toContain('self');
    expect(res.__headers['content-security-policy']).not.toContain('unsafe');
  });
});

describe('parseBearer', () => {
  it('returns the token from a well-formed header', () => {
    expect(parseBearer('Bearer abc123')).toBe('abc123');
  });

  it('trims surrounding whitespace', () => {
    expect(parseBearer('  Bearer   abc123  ')).toBe('abc123');
  });

  it('returns null for missing header', () => {
    expect(parseBearer(undefined)).toBeNull();
  });

  it('returns null for array header (Node-quirk — never legitimate here)', () => {
    expect(parseBearer(['Bearer abc'])).toBeNull();
  });

  it('returns null for non-Bearer schemes', () => {
    expect(parseBearer('Basic dXNlcjpwYXNz')).toBeNull();
    expect(parseBearer('Token abc')).toBeNull();
  });

  it('returns null for empty token', () => {
    expect(parseBearer('Bearer ')).toBeNull();
    expect(parseBearer('Bearer    ')).toBeNull();
  });

  it('is case-sensitive on the scheme (RFC 7235 says case-insensitive — we are stricter)', () => {
    // Note: production RFC compliance would accept 'bearer'. We are
    // intentionally stricter because no real client sends lowercase, and
    // the strictness reduces parser surface area.
    expect(parseBearer('bearer abc')).toBeNull();
    vi.unstubAllGlobals();
  });
});
