import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Load .env before any test file — database tests need DATABASE_URL
    setupFiles: ['tests/setup.ts'],
    // Database integration tests can be slow (seed re-run, bcrypt, network)
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
