import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import type { AuthResponse, LoginBody, PublicUser, SignupBody } from '@chat/shared';
import { config } from '../../config.js';
import { AppError } from '../../errors.js';
import * as q from './queries.js';

const BCRYPT_COST = 12;
const accessKey = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
// Unknown emails compare against this, so both login failures cost one bcrypt compare.
const dummyHash = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

export interface AccessClaims {
  userId: string;
  sid: string;
  exp: number;
}

/** A successful auth: the body to send plus the raw refresh token for the cookie, if a new one. */
export interface Issued {
  body: AuthResponse;
  refreshToken?: string;
}

export type RefreshResult = { ok: true; issued: Issued } | { ok: false; revokedSessionId?: string };

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');
const newRefreshToken = () => randomBytes(32).toString('base64url');
const refreshExpiry = () => new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
const isCookieToken = (raw: unknown): raw is string =>
  typeof raw === 'string' && raw.length > 0 && raw.length <= 256;

const toPublic = (u: { id: string; email: string; display_name: string }): PublicUser => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
});

const signAccessToken = (userId: string, sid: string) => {
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('chat')
    .setAudience('chat')
    .setIssuedAt(iat)
    .setExpirationTime(iat + config.ACCESS_TOKEN_TTL_SECONDS)
    .sign(accessKey);
};

/** Verifies signature, algorithm, issuer, audience and expiry. Shared by sockets and REST. */
export async function verifyAccessToken(token: unknown): Promise<AccessClaims> {
  if (typeof token !== 'string') throw new AppError('unauthorized', 401);
  try {
    const { payload } = await jwtVerify(token, accessKey, {
      algorithms: ['HS256'],
      issuer: 'chat',
      audience: 'chat',
    });
    const { sub, sid, exp } = payload;
    if (typeof sub !== 'string' || typeof sid !== 'string' || typeof exp !== 'number') {
      throw new Error('missing claims');
    }
    return { userId: sub, sid, exp };
  } catch {
    throw new AppError('unauthorized', 401);
  }
}

/** Sockets also require the session to be live, so a copied token dies with its session. */
export async function verifySocketToken(token: unknown): Promise<AccessClaims> {
  const claims = await verifyAccessToken(token);
  if (!(await q.isSessionLive(claims.sid))) throw new AppError('unauthorized', 401);
  return claims;
}

/** `auth:refresh`: the new token must belong to the same user and session as the socket. */
export async function verifySocketRefresh(
  current: { userId: string; sid: string },
  token: unknown,
): Promise<AccessClaims> {
  const claims = await verifySocketToken(token);
  if (claims.userId !== current.userId || claims.sid !== current.sid) {
    throw new AppError('unauthorized', 401);
  }
  return claims;
}

async function startSession(user: PublicUser): Promise<Issued> {
  const sid = randomUUID();
  const refreshToken = newRefreshToken();
  await q.insertRefreshToken(user.id, sid, hashToken(refreshToken), refreshExpiry());
  return { body: { accessToken: await signAccessToken(user.id, sid), user }, refreshToken };
}

async function issueFor(userId: string, sid: string, refreshToken?: string): Promise<Issued> {
  const user = await q.findUserById(userId);
  if (!user) throw new AppError('invalid_refresh', 401);
  const accessToken = await signAccessToken(userId, sid);
  return { body: { accessToken, user: toPublic(user) }, refreshToken };
}

export async function signup(input: SignupBody): Promise<Issued> {
  const hash = await bcrypt.hash(input.password, BCRYPT_COST);
  const row = await q.insertUser(input.email, hash, input.displayName);
  if (!row) throw new AppError('email_taken', 409);
  return startSession(toPublic(row));
}

export async function login(input: LoginBody): Promise<Issued> {
  const row = await q.findUserByEmail(input.email);
  const ok = await bcrypt.compare(input.password, row?.password_hash ?? dummyHash);
  if (!row || !ok) throw new AppError('invalid_credentials', 401);
  return startSession(toPublic(row));
}

export async function refresh(raw: unknown): Promise<RefreshResult> {
  if (!isCookieToken(raw)) return { ok: false };
  const hash = hashToken(raw);
  const next = newRefreshToken();
  const rotated = await q.rotateRefreshToken(hash, hashToken(next), refreshExpiry());
  if (rotated) return { ok: true, issued: await issueFor(rotated.userId, rotated.sessionId, next) };

  const row = await q.findRefreshToken(hash);
  if (!row?.replaced_by) return { ok: false };
  // Grace: another tab won the race moments ago and already holds the new cookie.
  if (row.in_grace && (await q.isSessionLive(row.session_id))) {
    return { ok: true, issued: await issueFor(row.user_id, row.session_id) };
  }
  // Reuse of a rotated token: assume it was stolen and end that whole session.
  await q.revokeSession(row.session_id);
  return { ok: false, revokedSessionId: row.session_id };
}

/** Returns the revoked session id, or undefined when the cookie matched nothing. */
export async function logout(raw: unknown): Promise<string | undefined> {
  if (!isCookieToken(raw)) return undefined;
  const row = await q.findRefreshToken(hashToken(raw));
  if (!row) return undefined;
  await q.revokeSession(row.session_id);
  return row.session_id;
}
