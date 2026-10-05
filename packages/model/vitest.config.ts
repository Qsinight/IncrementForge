import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      // 工作区包以源码形式互引（不做构建产物依赖），与 packages/*/package.json 的 exports 一致。
      '@iforge/num': fileURLToPath(new URL('../num/src/index.ts', import.meta.url)),
      '@iforge/expr': fileURLToPath(new URL('../expr/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'model',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
})
