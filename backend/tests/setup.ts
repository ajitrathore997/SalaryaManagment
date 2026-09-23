/**
 * Global test setup — loaded by Vitest before any test file runs.
 *
 * Responsibility: ensure environment variables are available to every test.
 * The health tests override DATABASE_URL with a dummy value (they never
 * touch the DB).  Database integration tests rely on the real .env value.
 * dotenv.config() is a no-op when a variable is already set in the process
 * environment, so this is safe to call unconditionally.
 */
import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../.env') });
