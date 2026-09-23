import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

// ── Legacy shape (auth routes) ────────────────────────────────────────────────
// { status: 'error', message: '...' }
export interface AppError extends Error {
  statusCode?: number;
}

// ── Structured shape (employee + future routes) ───────────────────────────────
// { error: { code: '...', message: '...', details: {} } }
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  // ── Factory helpers ─────────────────────────────────────────────────────────

  static notFound(resource: string, id?: string): ApiError {
    return new ApiError(
      404,
      'NOT_FOUND',
      id ? `${resource} with id '${id}' not found` : `${resource} not found`,
    );
  }

  static badRequest(message: string, details: Record<string, unknown> = {}): ApiError {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(): ApiError {
    return new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  static forbidden(): ApiError {
    return new ApiError(403, 'FORBIDDEN', 'Forbidden');
  }
}

// ── Central handler ───────────────────────────────────────────────────────────

export function errorHandler(
  err: AppError | ApiError | ZodError | Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Structured ApiError — used by employee and future routes
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // Zod validation error — return per-field errors
  if (err instanceof ZodError) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: err.flatten().fieldErrors,
    });
    return;
  }

  // Legacy AppError (auth routes) — { status: 'error', message }
  const appErr = err as AppError;
  const statusCode = appErr.statusCode ?? 500;
  const message = statusCode === 500 ? 'Internal server error' : appErr.message;

  if (statusCode === 500) {
    console.error('Unhandled error:', err);
  }

  res.status(statusCode).json({ status: 'error', message });
}
