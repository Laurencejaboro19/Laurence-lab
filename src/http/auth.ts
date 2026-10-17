/**
 * Internal API authentication.
 *
 * Every client of the internal API (the Telegram adapters, the admin bot, the
 * job runner, a future dashboard) presents a signed bearer token. Tokens are
 * minted by our own code with INTERNAL_API_SECRET — there is no third party.
 *
 * Three kinds of token:
 *   adapter  a chat adapter acting for customers. It names the customer it is
 *            handling per request in the X-Customer-Id header; the core's IDOR
 *            guard then scopes every read/write to that customer.
 *   staff    a staff member (id + role baked into the token by the admin bot
 *            after the Telegram-id allowlist check). Short-lived.
 *   system   background jobs and operators.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256). Verified in
 * constant time. No external JWT library: 40 lines are easier to audit.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Actor, StaffRole } from '../core/ports/index.js';

export type TokenKind = 'adapter' | 'staff' | 'system';

export interface TokenClaims {
  kind: TokenKind;
  /** Human label for logs/audit: "telegram-customer", "admin-bot", "reconcile-job" */
  client: string;
  staffId?: string;
  staffRole?: StaffRole;
  /** Unix seconds. */
  exp: number;
}

const b64 = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');
const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

export function mintToken(
  secret: string,
  claims: Omit<TokenClaims, 'exp'> & { ttlSeconds: number },
): string {
  const { ttlSeconds, ...rest } = claims;
  const payload: TokenClaims = { ...rest, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = b64(JSON.stringify(payload));
  return `${encoded}.${sign(secret, encoded)}`;
}

export function verifyToken(secret: string, token: string, now = Date.now()): TokenClaims | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'utf8');
  const expected = Buffer.from(sign(secret, encoded), 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) return null;
  if (!['adapter', 'staff', 'system'].includes(claims.kind)) return null;
  if (claims.kind === 'staff' && (!claims.staffId || !claims.staffRole)) return null;
  return claims;
}

/** Build the core Actor for a request from its token (+ customer header for adapters). */
export function actorFrom(
  claims: TokenClaims,
  customerIdHeader: string | undefined,
  requestId: string,
): Actor | null {
  switch (claims.kind) {
    case 'adapter':
      if (!customerIdHeader) return null;
      return { type: 'customer', id: customerIdHeader, requestId };
    case 'staff':
      return {
        type: 'staff',
        id: claims.staffId!,
        role: claims.staffRole!,
        requestId,
      };
    case 'system':
      return { type: 'system', id: claims.client, requestId };
  }
}
