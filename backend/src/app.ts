import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { env } from './config/env';
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';

const app = express();

// ── Security & parsing middleware ────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true, // required for httpOnly cookie auth
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Rate limiting — login endpoint ───────────────────────────────────────────
// Applied only to /api/auth to limit brute-force attacks on login.
// 10 requests per 15 minutes per IP. In-memory store is sufficient for a
// single-process deployment at 10 k-employee scale.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,  // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,
  skipSuccessfulRequests: false, // count all attempts, not just failures
  message: { status: 'error', message: 'Too many requests, please try again later' },
  // Skip rate limiting in test environment so tests don't collide
  skip: () => env.NODE_ENV === 'test',
});

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/health', healthRouter);
app.use('/api/auth', authLimiter, authRouter);

// ── Error handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

export default app;
