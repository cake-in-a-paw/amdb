import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      testTimeout: 20_000,
      // jsdom, but with Vite's server-side transform: the tests run the real API in process (ADR 0004).
      environment: './test/environment.ts',
      include: ['test/**/*.test.{ts,tsx}'],
      setupFiles: ['test/setup.ts'],
    },
  }),
);
