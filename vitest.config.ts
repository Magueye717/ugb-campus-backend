import { defineConfig } from 'vitest/config';

// Integration tests run against the local replica set (localhost:27017) and Redis (localhost:6379):
// each test file gets its own database and Redis key prefix, so files can run in parallel.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
