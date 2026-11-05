import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // DB tests share one database; run their files one at a time.
    fileParallelism: false,
    testTimeout: 20000
  }
});
