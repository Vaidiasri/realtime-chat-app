import { defineConfig } from 'vitest/config';

// Integration tests run the real services against a real Postgres, in its own database.
const url = process.env.TEST_DATABASE_URL ?? 'postgres://chat:chat@localhost:5432/chat_test';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    globalSetup: ['server/test/global-setup.ts'],
    env: {
      DATABASE_URL: url,
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test-only-access-secret-0123456789abcdef',
    },
    // One database: files run one after another so migrations and counts do not race.
    fileParallelism: false,
  },
});
