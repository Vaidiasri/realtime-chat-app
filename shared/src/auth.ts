import { z } from 'zod';

// bcrypt reads at most 72 bytes, so the limit is in UTF-8 bytes, not characters.
const passwordBytes = (p: string) => new TextEncoder().encode(p).length;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email').max(254, 'Enter a valid email'));

const password = z
  .string()
  .refine((p) => passwordBytes(p) >= 8 && passwordBytes(p) <= 72, 'Use 8 to 72 characters');

export const signupBody = z.object({
  email,
  password,
  displayName: z.string().trim().min(1, 'Enter your name').max(100, 'Use at most 100 characters'),
});
export type SignupBody = z.infer<typeof signupBody>;

export const loginBody = z.object({ email, password });
export type LoginBody = z.infer<typeof loginBody>;

export const authRefreshPayload = z.object({ token: z.string().min(1).max(4096) });
export type AuthRefreshPayload = z.infer<typeof authRefreshPayload>;
export type AuthRefreshAck = { ok: true } | { ok: false; error: 'unauthorized' };

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
}

export interface AuthResponse {
  accessToken: string;
  user: PublicUser;
}

export interface ApiError {
  error: string;
}
