import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import app from '../src/app';

// Set minimal required env vars for tests so env.ts validation passes
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test_secret_that_is_at_least_32_chars_long';

const request = supertest(app);

describe('GET /api/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('salary-management-api');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('uptime');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request.get('/api/unknown-route');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
  });
});
