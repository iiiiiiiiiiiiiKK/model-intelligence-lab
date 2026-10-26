/**
 * Authentication routes.
 *
 * Deliberately small: one shared password, one cookie. There are no accounts,
 * because there is no notion of separate users — the instance belongs to one
 * operator. Adding user management here would imply isolation guarantees the
 * storage layer does not provide.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  authRequired,
  checkAccessToken,
  clearSessionCookie,
  createSession,
  isAuthenticated,
  sessionCookie,
} from '../auth';

export const authRouter = Router();

/**
 * Login attempts are limited much more tightly than the rest of the API: the
 * password is human-chosen, so an unthrottled endpoint would be offline-crackable
 * through the network. In-memory is sufficient because the app is single-instance
 * by design (SQLite).
 */
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(req: Request): string {
  // `trust proxy` is enabled, so req.ip already reflects X-Forwarded-For when the
  // app is behind a proxy. Falling back to the socket address keeps it correct
  // when it is not.
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function checkAttempts(req: Request): { allowed: boolean; retryAfterSeconds: number } {
  const key = clientKey(req);
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Clears the attempt counter; used on success and by tests. */
export function resetLoginAttempts(): void {
  attempts.clear();
}

/**
 * Whether the client must sign in.
 *
 * `authenticated` reports the current session, and `required` reports whether a
 * token is configured at all — the UI uses the pair to decide between "no gate",
 * "show login" and "already inside".
 */
authRouter.get('/auth/status', (req: Request, res: Response) => {
  res.json({
    required: authRequired(),
    authenticated: isAuthenticated(req),
  });
});

const loginSchema = z.object({
  token: z.string().min(1, 'Access token is required').max(4096),
});

authRouter.post('/auth/login', (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!authRequired()) {
      res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'This instance has no access token configured, so there is nothing to sign in to.',
          retryable: false,
        },
      });
      return;
    }

    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Invalid login payload',
          details: parsed.error.flatten(),
          retryable: false,
        },
      });
      return;
    }

    const { allowed, retryAfterSeconds } = checkAttempts(req);
    if (!allowed) {
      res.setHeader('retry-after', String(retryAfterSeconds));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: `Too many sign-in attempts. Try again in ${retryAfterSeconds} seconds.`,
          retryable: true,
        },
      });
      return;
    }

    if (!checkAccessToken(parsed.data.token)) {
      // Deliberately identical for "wrong token" and any other failure: telling a
      // prober which part was wrong is free information.
      res.status(401).json({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'That access token is not correct.',
          retryable: false,
        },
      });
      return;
    }

    resetLoginAttempts();
    const value = createSession();
    res.setHeader('set-cookie', sessionCookie(value));
    res.json({ authenticated: true });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/auth/logout', (_req: Request, res: Response) => {
  res.setHeader('set-cookie', clearSessionCookie());
  res.json({ authenticated: false });
});
