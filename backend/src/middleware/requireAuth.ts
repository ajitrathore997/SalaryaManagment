/**
 * requireAuth middleware.
 *
 * Reads the JWT from the httpOnly cookie, verifies it, and attaches the
 * decoded payload to `req.user`. Calls next() on success, returns 401 on
 * failure.  Never exposes token details in error messages.
 */

import { Request, Response, NextFunction } from 'express';
import { AUTH_COOKIE, verifyToken, JwtPayload } from '../services/auth.service';

// Extend Express Request so downstream handlers have req.user typed
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token: string | undefined = req.cookies[AUTH_COOKIE] as string | undefined;

  if (!token) {
    res.status(401).json({ status: 'error', message: 'Authentication required' });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    // Token is present but invalid or expired — clear the stale cookie
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    res.status(401).json({ status: 'error', message: 'Authentication required' });
    return;
  }

  req.user = payload;
  next();
}

/**
 * requireRole — compose after requireAuth to enforce a specific role.
 * Usage: router.get('/protected', requireAuth, requireRole('HR_MANAGER'), handler)
 */
export function requireRole(role: string) {
  return function roleGuard(req: Request, res: Response, next: NextFunction): void {
    if (req.user?.role !== role) {
      res.status(403).json({ status: 'error', message: 'Forbidden' });
      return;
    }
    next();
  };
}
