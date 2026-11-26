import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Tests in test/live call the model. They run only with MISSION_AGENT_LIVE=1.
    exclude: process.env.MISSION_AGENT_LIVE ? ['node_modules/**'] : ['node_modules/**', 'test/live/**'],
    testTimeout: process.env.MISSION_AGENT_LIVE ? 180_000 : 10_000,
  },
});
