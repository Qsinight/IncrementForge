import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      // 工作区包以源码形式互引（不做构建产物依赖），与 packages/*/package.json 的 exports 一致。
      '@iforge/num': fileURLToPath(new URL('../num/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'expr',
    // `*.bench.ts` 用的是 `bench()` 而非 `it()`，只在 `vitest bench` 下运行
    // （单测里是死代码，混进来只会拖慢套件）。
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/**/*.bench.ts'],
    environment: 'node',
  },
  benchmark: {
    include: ['test/**/*.bench.ts'],
  },
})
