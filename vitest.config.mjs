import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      exclude: ['docs/**', 'views/**', 'scripts/**', 'test/**', 'dist/**', 'eslint.config.js', 'vitest.config.mjs']
    }
  }
});
