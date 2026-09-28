import express from 'express';
import type { CookieOptions, RequestHandler, Response } from 'express';
import { rateLimit, ipKeyGenerator, type Options } from 'express-rate-limit';
import { loginBody, signupBody } from '@chat/shared';
import type { z } from 'zod';
import { config } from '../../config.js';
import { AppError } from '../../errors.js';
import type { AppServer } from '../../io.js';
import * as auth from './service.js';

const COOKIE = 'refresh_token';
const cookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  path: '/api/auth',
  secure: config.NODE_ENV === 'production',
};

// The 400 body never carries zod detail; the client runs the same schema for field errors.
const parse = <T extends z.ZodType>(schema: T, body: unknown): z.infer<T> => {
  const result = schema.safeParse(body);
  if (!result.success) throw new AppError('invalid_input', 400);
  return result.data;
};

const send = (res: Response, status: number, issued: auth.Issued) => {
  if (issued.refreshToken) {
    res.cookie(COOKIE, issued.refreshToken, {
      ...cookieOptions,
      maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    });
  }
  res.status(status).json(issued.body);
};

const cookieOf = (req: express.Request): unknown =>
  (req.cookies as Record<string, unknown>)[COOKIE];

// CSRF guard for the two cookie endpoints. Runs before any cookie lookup.
// In dev this relies on the Vite proxy keeping the Host header (changeOrigin off).
const sameOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.get('origin');
  const ok =
    origin !== undefined && URL.canParse(origin) && new URL(origin).host === req.get('host');
  next(ok ? undefined : new AppError('bad_origin', 403));
};

// ponytail: in memory store, resets on restart and is per instance; use a shared store to scale out.
const limited = (limit: number, windowMs: number, extra: Partial<Options> = {}) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'rate_limited' });
    },
    ...extra,
  });

// Only failures count, keyed by IP plus email, so one attacker cannot lock out every account.
const loginLimit = limited(10, 15 * 60_000, {
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    const key = typeof email === 'string' ? email.trim().toLowerCase() : '';
    return `${ipKeyGenerator(req.ip ?? '')}|${key}`;
  },
});
const signupLimit = limited(5, 60 * 60_000);

export function authRouter(io: AppServer): express.Router {
  const router = express.Router();

  router.post('/signup', signupLimit, async (req, res) => {
    send(res, 201, await auth.signup(parse(signupBody, req.body)));
  });

  router.post('/login', loginLimit, async (req, res) => {
    send(res, 200, await auth.login(parse(loginBody, req.body)));
  });

  router.post('/refresh', sameOrigin, async (req, res) => {
    const result = await auth.refresh(cookieOf(req));
    if (result.ok) return send(res, 200, result.issued);
    if (result.revokedSessionId)
      io.in(`session:${result.revokedSessionId}`).disconnectSockets(true);
    res.clearCookie(COOKIE, cookieOptions);
    throw new AppError('invalid_refresh', 401);
  });

  router.post('/logout', sameOrigin, async (req, res) => {
    const sid = await auth.logout(cookieOf(req));
    if (sid) io.in(`session:${sid}`).disconnectSockets(true);
    res.clearCookie(COOKIE, cookieOptions);
    res.status(204).end();
  });

  return router;
}
