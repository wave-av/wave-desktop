/**
 * Tiny router for the control-plane HTTP server. We hand-roll instead of
 * pulling Express because the surface is small (~5 endpoints) and avoiding
 * the dependency chain keeps the threat model legible.
 *
 * Routes are registered as `{method, path, handler}`. Path matching is
 * literal — no wildcards or params today; if we add `/monitor/:id` later
 * we'll switch to a real matcher rather than regex-bolting onto this one.
 *
 * Middleware shape: every route gets `(req, res, ctx)` where `ctx` carries
 * already-parsed metadata (matched route, request body for POST, etc.).
 * Auth check happens BEFORE body parsing — no point validating a payload
 * we'll reject anyway.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { applySecurityHeaders, parseBearer } from './security.js';
import { safeEqual } from './api-key.js';
import { ErrorResponseSchema, type ErrorResponse } from './types.js';

export interface RouteContext {
  /** JSON body for POST routes; undefined for GET. Parsed before dispatch. */
  body?: unknown;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => Promise<unknown> | unknown;

export interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  handler: RouteHandler;
  /** When set, validate the request body with this schema before invoking. */
  bodySchema?: z.ZodTypeAny;
}

export interface RouterOptions {
  /** Bearer token to compare against `Authorization: Bearer …`. */
  apiKey: string;
  /** Max JSON body bytes — defaults to 32 KiB; control-plane payloads are tiny. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 32 * 1024;

export function createRouter(routes: Route[], options: RouterOptions) {
  const byKey = new Map<string, Route>();
  for (const r of routes) byKey.set(`${r.method} ${r.path}`, r);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applySecurityHeaders(res);

    // Strip query + normalize trailing slash for matching.
    const url = req.url ?? '/';
    const pathOnly = (url.split('?')[0] ?? '/').replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();
    const key = `${method} ${pathOnly}`;

    const route = byKey.get(key);
    if (!route) {
      return writeError(res, 404, { error: 'not found', code: 'NOT_FOUND' });
    }

    // Auth — constant-time bearer compare. Failure mode is identical for
    // missing header / wrong scheme / wrong token to avoid leaking which
    // failure occurred.
    const presented = parseBearer(req.headers.authorization);
    if (!presented || !safeEqual(options.apiKey, presented)) {
      return writeError(res, 401, {
        error: 'authentication required',
        code: 'AUTH_REQUIRED',
      });
    }

    // Body parse + schema validation (POST/DELETE only).
    let body: unknown;
    if (method === 'POST' || method === 'DELETE') {
      try {
        body = await readJsonBody(req, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      } catch (err) {
        return writeError(res, 400, {
          error: err instanceof Error ? err.message : 'invalid body',
          code: 'BAD_REQUEST',
        });
      }
      if (route.bodySchema) {
        const parsed = route.bodySchema.safeParse(body);
        if (!parsed.success) {
          return writeError(res, 400, {
            error: parsed.error.issues.map((i) => i.message).join('; '),
            code: 'BAD_REQUEST',
          });
        }
        body = parsed.data;
      }
    }

    try {
      const result = await route.handler(req, res, { body });
      if (!res.writableEnded) {
        writeJson(res, 200, result ?? { ok: true });
      }
    } catch (err) {
      // Handlers are expected to throw on unexpected error only; expected
      // protocol errors should `res.statusCode = 4xx` + return a body.
      // We deliberately do NOT echo `err.message` to the client — that
      // leaks internal implementation details. The error is preserved in
      // server-side logs only.
       
      console.error('[control-plane] handler threw', err);
      if (!res.headersSent && !res.writableEnded) {
        writeError(res, 500, { error: 'internal error', code: 'INTERNAL' });
      }
    }
  };
}

async function readJsonBody(req: IncomingMessage, max: number): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    let total = 0;
    let aborted = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > max) {
        // We can't call req.destroy() — that tears down the socket the
        // response shares, so the client gets a TCP RST instead of our
        // 400 envelope. Drain instead: stop accumulating + stop emitting
        // 'data' events while keeping the socket alive for writeError().
        aborted = true;
        req.removeAllListeners('data');
        req.resume();
        reject(new Error(`body exceeds ${max} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error(`malformed JSON: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function writeError(res: ServerResponse, status: number, body: ErrorResponse): void {
  // Validate our own error shape before writing — refuses to ship a malformed
  // error response, which protects clients relying on `ErrorResponseSchema`.
  ErrorResponseSchema.parse(body);
  writeJson(res, status, body);
}
