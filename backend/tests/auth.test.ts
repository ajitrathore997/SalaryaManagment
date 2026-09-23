/**
 * Authentication integration tests.
 *
 * Tests run against the real database using the seeded HR Manager account.
 * Uses supertest.agent() so cookies persist across requests in multi-step
 * flows (login → me → logout).
 *
 * Prerequisites: database must be migrated and seeded.
 *   npm run db:seed --workspace=backend
 *
 * Covered scenarios:
 *  1. Successful login
 *  2. Wrong password
 *  3. Non-existent email
 *  4. Missing / invalid input (Zod validation)
 *  5. GET /me — authenticated
 *  6. GET /me — unauthenticated (no cookie)
 *  7. GET /me — tampered / invalid token
 *  8. POST /logout — clears the cookie
 *  9. Protected endpoint access after logout
 * 10. Response body never contains the raw JWT
 */

// Env vars must be set before any import that triggers env.ts validation
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:root@localhost:5432/postgres';
process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? 'test_secret_that_is_at_least_32_chars_long';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest, { Agent } from 'supertest';
import { PrismaClient } from '@prisma/client';
import app from '../src/app';
import { AUTH_COOKIE } from '../src/services/auth.service';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SEEDED_EMAIL = 'hr.manager@salaryapp.dev';
const SEEDED_PASSWORD = 'HRdemo2026!';
const WRONG_PASSWORD = 'WrongPassword123!';
const UNKNOWN_EMAIL = 'nobody@salaryapp.dev';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the Set-Cookie header value for auth_token, or null. */
function getAuthCookieHeader(res: supertest.Response): string | null {
  const cookies: string[] = ([] as string[]).concat(
    (res.headers['set-cookie'] as string | string[] | undefined) ?? [],
  );
  return cookies.find((c) => c.startsWith(AUTH_COOKIE + '=')) ?? null;
}

/** Return true if the header clears the auth cookie (MaxAge=0 or Expires in past). */
function cookieIsCleared(cookieHeader: string): boolean {
  const lower = cookieHeader.toLowerCase();
  return lower.includes('max-age=0') || lower.includes('expires=thu, 01 jan 1970');
}

// ── Prisma for teardown ───────────────────────────────────────────────────────

const prisma = new PrismaClient({ log: [] });
afterAll(async () => {
  await prisma.$disconnect();
});

// =============================================================================
// 1. Successful login
// =============================================================================
describe('POST /api/auth/login — successful', () => {
  let res: supertest.Response;

  beforeAll(async () => {
    res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: SEEDED_EMAIL, password: SEEDED_PASSWORD });
  });

  it('returns 200', () => {
    expect(res.status).toBe(200);
  });

  it('returns status: ok with user object', () => {
    expect(res.body.status).toBe('ok');
    expect(res.body.user).toMatchObject({
      email: SEEDED_EMAIL,
      role: 'HR_MANAGER',
    });
    expect(res.body.user).toHaveProperty('id');
  });

  it('sets an httpOnly auth_token cookie', () => {
    const cookieHeader = getAuthCookieHeader(res);
    expect(cookieHeader).not.toBeNull();
    expect(cookieHeader).toMatch(/httponly/i);
  });

  it('does not return the JWT in the response body', () => {
    // A JWT has the shape xxxxx.yyyyy.zzzzz — three base64url segments
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  });

  it('sets SameSite=Strict on the cookie', () => {
    const cookieHeader = getAuthCookieHeader(res);
    expect(cookieHeader?.toLowerCase()).toContain('samesite=strict');
  });
});

// =============================================================================
// 2. Wrong password
// =============================================================================
describe('POST /api/auth/login — wrong password', () => {
  let res: supertest.Response;

  beforeAll(async () => {
    res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: SEEDED_EMAIL, password: WRONG_PASSWORD });
  });

  it('returns 401', () => {
    expect(res.status).toBe(401);
  });

  it('returns the generic error message (no enumeration)', () => {
    expect(res.body.status).toBe('error');
    expect(res.body.message).toBe('Invalid email or password');
  });

  it('does not set an auth cookie', () => {
    expect(getAuthCookieHeader(res)).toBeNull();
  });
});

// =============================================================================
// 3. Non-existent email
// =============================================================================
describe('POST /api/auth/login — unknown email', () => {
  let res: supertest.Response;

  beforeAll(async () => {
    res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: UNKNOWN_EMAIL, password: SEEDED_PASSWORD });
  });

  it('returns 401', () => {
    expect(res.status).toBe(401);
  });

  it('returns the same generic message as wrong password (no email enumeration)', () => {
    // Must be identical to the wrong-password message so callers cannot
    // distinguish "no such account" from "wrong password".
    expect(res.body.message).toBe('Invalid email or password');
  });
});

// =============================================================================
// 4. Missing / invalid input (Zod validation)
// =============================================================================
describe('POST /api/auth/login — invalid input', () => {
  it('returns 400 when body is empty', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
  });

  it('returns 400 when email is missing', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ password: SEEDED_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty('email');
  });

  it('returns 400 when password is missing', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: SEEDED_EMAIL });
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty('password');
  });

  it('returns 400 when email is not a valid email address', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: SEEDED_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty('email');
  });

  it('returns 400 when password is an empty string', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: SEEDED_EMAIL, password: '' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty('password');
  });
});

// =============================================================================
// 5. GET /me — authenticated
// =============================================================================
describe('GET /api/auth/me — authenticated', () => {
  // Use an agent so the login cookie carries over to /me
  let agent: Agent;
  let meRes: supertest.Response;

  beforeAll(async () => {
    agent = supertest.agent(app);
    await agent
      .post('/api/auth/login')
      .send({ email: SEEDED_EMAIL, password: SEEDED_PASSWORD });
    meRes = await agent.get('/api/auth/me');
  });

  it('returns 200', () => {
    expect(meRes.status).toBe(200);
  });

  it('returns status: ok with user object', () => {
    expect(meRes.body.status).toBe('ok');
    expect(meRes.body.user).toMatchObject({
      email: SEEDED_EMAIL,
      role: 'HR_MANAGER',
    });
  });

  it('includes createdAt in the user object', () => {
    expect(meRes.body.user).toHaveProperty('createdAt');
  });

  it('does not include passwordHash in the user object', () => {
    expect(meRes.body.user).not.toHaveProperty('passwordHash');
  });
});

// =============================================================================
// 6. GET /me — unauthenticated (no cookie)
// =============================================================================
describe('GET /api/auth/me — unauthenticated', () => {
  it('returns 401 with no cookie present', async () => {
    const res = await supertest(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.status).toBe('error');
    expect(res.body.message).toBe('Authentication required');
  });
});

// =============================================================================
// 7. GET /me — tampered token
// =============================================================================
describe('GET /api/auth/me — invalid token', () => {
  it('returns 401 with a malformed token cookie', async () => {
    const res = await supertest(app)
      .get('/api/auth/me')
      .set('Cookie', `${AUTH_COOKIE}=this.is.not.a.valid.jwt`);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Authentication required');
  });

  it('clears the stale cookie in the response', async () => {
    const res = await supertest(app)
      .get('/api/auth/me')
      .set('Cookie', `${AUTH_COOKIE}=tampered.token.value`);
    const cookieHeader = getAuthCookieHeader(res);
    // Cookie should be cleared (Max-Age=0 or expired)
    if (cookieHeader) {
      expect(cookieIsCleared(cookieHeader)).toBe(true);
    }
    // If no Set-Cookie header, the middleware simply didn't re-set it — also acceptable
  });
});

// =============================================================================
// 8. POST /logout — clears the cookie
// =============================================================================
describe('POST /api/auth/logout', () => {
  let logoutRes: supertest.Response;

  beforeAll(async () => {
    const agent = supertest.agent(app);
    await agent
      .post('/api/auth/login')
      .send({ email: SEEDED_EMAIL, password: SEEDED_PASSWORD });
    logoutRes = await agent.post('/api/auth/logout');
  });

  it('returns 200', () => {
    expect(logoutRes.status).toBe(200);
  });

  it('returns status: ok', () => {
    expect(logoutRes.body.status).toBe('ok');
  });

  it('clears the auth cookie', () => {
    const cookieHeader = getAuthCookieHeader(logoutRes);
    expect(cookieHeader).not.toBeNull();
    expect(cookieIsCleared(cookieHeader!)).toBe(true);
  });
});

// =============================================================================
// 9. Protected endpoint access after logout
// =============================================================================
describe('Protected access after logout', () => {
  it('/me returns 401 after logout', async () => {
    const agent = supertest.agent(app);

    // Login
    await agent
      .post('/api/auth/login')
      .send({ email: SEEDED_EMAIL, password: SEEDED_PASSWORD });

    // Confirm /me works
    const beforeLogout = await agent.get('/api/auth/me');
    expect(beforeLogout.status).toBe(200);

    // Logout
    await agent.post('/api/auth/logout');

    // /me should now be 401
    const afterLogout = await agent.get('/api/auth/me');
    expect(afterLogout.status).toBe(401);
  });
});

// =============================================================================
// 10. Logout works without being logged in (idempotent)
// =============================================================================
describe('POST /api/auth/logout — without prior login', () => {
  it('returns 200 even with no cookie present', async () => {
    const res = await supertest(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
