/**
 * Authentication service.
 *
 * Encapsulates all auth business logic:
 *   - password verification via bcrypt
 *   - JWT sign / verify
 *   - httpOnly cookie helpers
 *
 * No Express types here — keeps the service independently testable.
 */

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Response } from 'express';
import { env } from '../config/env';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string;   // user id
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

// ── Cookie ────────────────────────────────────────────────────────────────────

export const AUTH_COOKIE = 'auth_token';

/**
 * Cookie options shared between set and clear operations.
 * `secure` is true only in production so local dev works over http.
 */
function cookieOptions(overrides: { maxAge?: number } = {}): Record<string, unknown> {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
    ...overrides,
  };
}

/** Write the JWT as an httpOnly cookie on the response. */
export function setAuthCookie(res: Response, token: string): void {
  // maxAge in milliseconds — parse JWT_EXPIRES_IN (e.g. "7d") to ms
  const maxAgeMs = parseDurationToMs(env.JWT_EXPIRES_IN);
  res.cookie(AUTH_COOKIE, token, cookieOptions({ maxAge: maxAgeMs }));
}

/** Clear the auth cookie (used on logout). */
export function clearAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE, cookieOptions());
}

// ── JWT ───────────────────────────────────────────────────────────────────────

/** Sign a JWT for the given user. */
export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Verify a JWT string and return its decoded payload.
 * Returns null if the token is missing, malformed, or expired.
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

// ── Password ──────────────────────────────────────────────────────────────────

/** Compare a plaintext password against a bcrypt hash. */
export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Parse a simple duration string into milliseconds.
 * Supports: Xs (seconds), Xm (minutes), Xh (hours), Xd (days).
 * Falls back to 7 days for unrecognised formats.
 */
function parseDurationToMs(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return value * 1_000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default:  return 7 * 24 * 60 * 60 * 1000;
  }
}
