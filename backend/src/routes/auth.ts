/**
 * Auth routes: POST /login  ·  GET /me  ·  POST /logout
 *
 * Mounted at /api/auth in app.ts.
 * Rate limiting is applied at the mount point, not here, so the limiter
 * can be configured independently per environment.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { loginSchema } from '../schemas/auth.schema';
import {
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
} from '../services/auth.service';
import { requireAuth, requireRole } from '../middleware/requireAuth';
import { prisma } from '../config/prisma';
import { AppError } from '../middleware/errorHandler';

const router = Router();

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post(
  '/login',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // 1. Validate input — throws ZodError which the central handler formats
      const { email, password } = loginSchema.parse(req.body);

      // 2. Look up user — use a generic error message to prevent email
      //    enumeration. Do NOT distinguish "no such user" from "wrong password".
      const user = await prisma.user.findUnique({ where: { email } });

      const GENERIC_ERROR = 'Invalid email or password';

      if (!user) {
        // Run a dummy compare to maintain constant-time behaviour and prevent
        // timing-based email enumeration attacks.
        await verifyPassword(password, '$2b$12$dummyhashplaceholderXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
        const err = new Error(GENERIC_ERROR) as AppError;
        err.statusCode = 401;
        return void next(err);
      }

      const passwordMatch = await verifyPassword(password, user.passwordHash);
      if (!passwordMatch) {
        const err = new Error(GENERIC_ERROR) as AppError;
        err.statusCode = 401;
        return void next(err);
      }

      // 3. Sign JWT and set httpOnly cookie
      const token = signToken({ sub: user.id, email: user.email, role: user.role });
      setAuthCookie(res, token);

      // 4. Return user info — never include the token in the response body
      res.status(200).json({
        status: 'ok',
        user: { id: user.id, email: user.email, role: user.role },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

router.get(
  '/me',
  requireAuth,
  requireRole('HR_MANAGER'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // req.user is guaranteed by requireAuth
      const user = await prisma.user.findUnique({
        where: { id: req.user!.sub },
        select: { id: true, email: true, role: true, createdAt: true },
      });

      if (!user) {
        // Token valid but user was deleted — treat as unauthenticated
        clearAuthCookie(res);
        const err = new Error('Authentication required') as AppError;
        err.statusCode = 401;
        return void next(err);
      }

      res.status(200).json({ status: 'ok', user });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

router.post('/logout', (_req: Request, res: Response): void => {
  // Clear the cookie regardless of whether a valid token exists.
  // No DB interaction needed — JWT is stateless.
  clearAuthCookie(res);
  res.status(200).json({ status: 'ok', message: 'Logged out' });
});

export default router;
