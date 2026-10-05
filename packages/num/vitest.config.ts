import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'num',
    // `*.bench.ts` 用 `bench()` 而非 `it()`，只在 `vitest bench` 下运行。
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/**/*.bench.ts'],
    environment: 'node',
  },
  benchmark: {
    include: ['test/**/*.bench.ts'],
  },
})
