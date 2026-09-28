import type { Request, RequestHandler } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';
import type { z } from 'zod';
import { AppError } from './errors.js';
import { verifyAccessToken } from './modules/auth/service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; sid: string };
    }
  }
}

// The error body never carries zod detail; the client runs the same schema for field errors.
export const parse = <T extends z.ZodType>(
  schema: T,
  input: unknown,
  error = new AppError('invalid_input', 400),
): z.infer<T> => {
  const result = schema.safeParse(input);
  if (!result.success) throw error;
  return result.data;
};

// ponytail: in memory store, resets on restart and is per instance; use a shared store to scale out.
export const limited = (limit: number, windowMs: number, extra: Partial<Options> = {}) =>
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

/** Bearer access token only. The caller's identity comes from here, never from the request body. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
  const claims = await verifyAccessToken(token);
  req.user = { id: claims.userId, sid: claims.sid };
  next();
};

/** The authenticated user, for routes mounted behind `requireAuth`. */
export const userOf = (req: Request) => {
  if (!req.user) throw new AppError('unauthorized', 401);
  return req.user;
};
