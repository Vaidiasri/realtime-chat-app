import type { ApiError, AuthResponse, LoginBody, SignupBody } from '@chat/shared';

export type AuthResult = { ok: true; data: AuthResponse } | { ok: false; error: string };

// Same origin: the browser sends the refresh cookie and an Origin header on its own.
async function post(path: string, body?: unknown): Promise<AuthResult> {
  try {
    const res = await fetch(`/api/auth/${path}`, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return { ok: true, data: (await res.json()) as AuthResponse };
    const err = (await res.json().catch(() => ({ error: 'internal' }))) as ApiError;
    return { ok: false, error: err.error };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export const signup = (body: SignupBody) => post('signup', body);
export const login = (body: LoginBody) => post('login', body);

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
}

let inflight: Promise<AuthResponse | null> | null = null;

/** One refresh at a time per tab: callers racing each other share the same request. */
export function refreshSession(): Promise<AuthResponse | null> {
  inflight ??= post('refresh')
    .then((r) => (r.ok ? r.data : null))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Reads iat and exp without verifying: only used to time the next refresh. */
export function tokenTimes(token: string): { iat: number; exp: number } {
  const part = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(part)) as { iat: number; exp: number };
}
