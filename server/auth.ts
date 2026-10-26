/**
 * Optional access control.
 *
 * This app has no multi-user model: it is a single-tenant, self-hosted tool
 * holding one operator's provider API keys. The only thing it needs is a gate in
 * front of the whole surface, so that exposing the port publicly does not hand
 * someone else your encrypted credentials, your run history and a way to spend
 * your provider budget.
 *
 * The design follows from that:
 *
 *  - One shared password (`MODEL_LAB_ACCESS_TOKEN`), compared in constant time.
 *  - Sessions are stateless: an HMAC-signed `expiry.signature` cookie. No session
 *    table, nothing to garbage-collect, and a restart does not log everyone out
 *    as long as the signing secret is stable.
 *  - The signing secret is derived from the master key, so a session cannot be
 *    forged by anyone who merely knows the password, and rotating the master key
 *    invalidates every existing session.
 *  - When the app is exposed beyond loopback, `bootstrap()` refuses to start
 *    without a token unless the operator explicitly opts into anonymity. An
 *    internet-facing instance with no gate would be a credential-leak bug, not a
 *    configuration choice.
 *  - Shared public reports stay readable without a session: they are already
 *    protected by an unguessable `publicId` and, for private ones, a separate
 *    access token. Requiring a login there would silently break sharing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from './config';
import { getMasterKey } from './security/secrets';

/** Name of the session cookie. */
export const SESSION_COOKIE = 'model_lab_session';

/** How long a login lasts. Long enough to be usable, short enough to expire. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Routes reachable without a session.
 *
 * `/api/health` stays open so an uptime monitor and the app's own status dot work
 * before login; it reports only liveness and which providers have credentials,
 * never the credentials themselves.
 */
const PUBLIC_EXACT = new Set(['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/logout']);

/**
 * Public reports are protected by their own unguessable ids and tokens.
 *
 * Only a *single* report and its export are reachable anonymously. The list
 * endpoint (`/api/reports`) deliberately does not match: it enumerates everything
 * the instance knows about, so it stays behind the gate.
 */
const PUBLIC_REPORT_READ = /^\/api\/reports\/[^/]+(\/(export))?$/;

/**
 * True when an access token is configured, i.e. the gate is active.
 * An empty string is treated as "not configured" so `MODEL_LAB_ACCESS_TOKEN=`
 * in an `.env` file does not accidentally lock the operator out.
 */
export function authRequired(): boolean {
  return env.MODEL_LAB_ACCESS_TOKEN.trim().length > 0;
}

function accessToken(): string {
  return env.MODEL_LAB_ACCESS_TOKEN.trim();
}

/** HMAC key for session signatures, derived so it is never the raw master key. */
function sessionKey(): Buffer {
  return createHmac('sha256', getMasterKey()).update('model-lab/session/v1').digest();
}

function sign(payload: string): string {
  return createHmac('sha256', sessionKey()).update(payload).digest('base64url');
}

/** Creates a session value: `<expiresAtMs>.<signature>`. */
export function createSession(now = Date.now()): string {
  const expiry = String(now + SESSION_TTL_MS);
  return `${expiry}.${sign(expiry)}`;
}

/** Verifies a session value. Returns the expiry when valid, null otherwise. */
export function verifySession(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return null;

  const expiryPart = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!/^\d+$/.test(expiryPart) || signature.length === 0) return null;

  const expected = sign(expiryPart);
  // Compare as buffers of equal length; timingSafeEqual throws on a length mismatch.
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length) return null;
  if (!timingSafeEqual(given, wanted)) return null;

  const expiry = Number(expiryPart);
  if (!Number.isFinite(expiry) || expiry <= now) return null;
  return expiry;
}

/** Constant-time password check that does not leak the length of the configured token. */
export function checkAccessToken(candidate: string): boolean {
  const expected = accessToken();
  if (expected.length === 0) return false;
  if (candidate.length === 0) return false;
  // Hash both sides to a fixed 32 bytes first, so the comparison takes the same
  // time regardless of how much of the real token the guess happened to match or
  // how long the two strings are. A plain `===` here would leak both.
  const givenHash = createHmac('sha256', 'model-lab/compare/v1').update(candidate).digest();
  const expectedHash = createHmac('sha256', 'model-lab/compare/v1').update(expected).digest();
  return timingSafeEqual(givenHash, expectedHash);
}

/** Reads a cookie from the raw header without pulling in cookie-parser. */
export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== SESSION_COOKIE) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

/** True when this request may proceed without a session. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname);
}

/** True when the request carries a valid session. */
export function isAuthenticated(req: Request, now = Date.now()): boolean {
  if (!authRequired()) return true;
  return verifySession(readSessionCookie(req), now) !== null;
}

/**
 * Gate for `/api`. Returns 401 with a stable code the client maps to the login
 * screen, rather than a generic FORBIDDEN that would look like a permissions bug.
 */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!authRequired()) return next();

  // This middleware is mounted at `/api`, so Express has already stripped the
  // prefix from `req.path` and `req.url`. `req.baseUrl` plus `req.path` is the
  // only reliable way to see the real route.
  const pathname = `${req.baseUrl}${req.path}`;
  if (isPublicPath(pathname)) return next();
  if (isAuthenticated(req)) return next();

  // Reads of a shared report are allowed through without a session: the link is
  // the credential. Writes to a report still require one.
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (isRead && PUBLIC_REPORT_READ.test(pathname)) return next();

  res.status(401).json({
    error: {
      code: 'UNAUTHENTICATED',
      message: 'This instance requires an access token. Sign in to continue.',
      retryable: false,
    },
  });
}

/**
 * Refuses a configuration that would expose an unauthenticated instance.
 *
 * Called from `bootstrap()`. Loopback-only binds are allowed anonymously, because
 * that is the documented single-machine development setup.
 */
export function assertSafeExposure(): void {
  if (authRequired()) return;
  if (env.MODEL_LAB_ALLOW_ANONYMOUS) return;

  const isLoopback = env.HOST === '127.0.0.1' || env.HOST === 'localhost' || env.HOST === '::1';
  if (isLoopback) return;

  throw new Error(
    [
      'Refusing to start without access control.',
      '',
      `HOST is "${env.HOST}", which is reachable beyond this machine, but no`,
      'MODEL_LAB_ACCESS_TOKEN is set. This instance stores provider API keys and',
      'can spend your provider budget, so it must not be exposed unauthenticated.',
      '',
      'Set a token:',
      '  MODEL_LAB_ACCESS_TOKEN=<a long random string>',
      '',
      'Generate one with:',
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      '',
      'If you really do want an open instance (for example behind an authenticating',
      'reverse proxy you trust), set MODEL_LAB_ALLOW_ANONYMOUS=true.',
    ].join('\n'),
  );
}

/** Cookie attributes for the session. `secure` is set whenever TLS is implied. */
export function sessionCookie(value: string, maxAgeMs = SESSION_TTL_MS): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (env.MODEL_LAB_COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

/** Clears the session cookie. */
export function clearSessionCookie(): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (env.MODEL_LAB_COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

export { SESSION_TTL_MS };
