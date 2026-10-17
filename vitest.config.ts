import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Integration tests talk to a real local Postgres. They are opt-in via
    // DATABASE_URL_TEST so `npm test` still passes on a machine without one.
    env: { TZ: 'UTC' },
    // DB test files each reset the shared test database, so they must not overlap.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
    },
  },
});
