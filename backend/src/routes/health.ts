import { Router, Request, Response } from 'express';

const router = Router();

/**
 * GET /api/health
 * Returns service health status and basic metadata.
 */
router.get('/', (_req: Request, res: Response): void => {
  res.status(200).json({
    status: 'ok',
    service: 'salary-management-api',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV ?? 'unknown',
  });
});

export default router;
