import type { ApiError, AuthResponse, LoginBody, SignupBody } from '@chat/shared';

export type AuthResult = { ok: true; data: AuthResponse } | { ok: false; error: string };

// The one copy of the access token in this tab. apiFetch and the socket both read it, so they
// never drift apart. It is set by every successful signup, login and refresh.
let accessToken: string | null = null;
export const getAccessToken = () => accessToken;

// Same origin: the browser sends the refresh cookie and an Origin header on its own.
async function post(path: string, body?: unknown): Promise<AuthResult> {
  try {
    const res = await fetch(`/api/auth/${path}`, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) {
      const data = (await res.json()) as AuthResponse;
      accessToken = data.accessToken;
      return { ok: true, data };
    }
    const err = (await res.json().catch(() => ({ error: 'internal' }))) as ApiError;
    return { ok: false, error: err.error };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export const signup = (body: SignupBody) => post('signup', body);
export const login = (body: LoginBody) => post('login', body);

export async function logout(): Promise<void> {
  accessToken = null;
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
}

/**
 * JSON call to the API with the Bearer token. A 401 refreshes once (shared with any other caller
 * refreshing at the same moment) and retries. Throws an Error whose message is the error code.
 */
export async function apiFetch<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  const call = () =>
    fetch(path, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  let res = await call().catch(() => undefined);
  if (res?.status === 401 && (await refreshSession())) res = await call().catch(() => undefined);
  if (!res) throw new Error('network');
  const data = (await res.json().catch(() => ({ error: 'internal' }))) as T | ApiError;
  if (!res.ok) throw new Error((data as ApiError).error);
  return { status: res.status, data: data as T };
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
