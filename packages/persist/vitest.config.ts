import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      // 工作区包以源码形式互引（不做构建产物依赖），与 packages/*/package.json 的 exports 一致。
      '@iforge/num': fileURLToPath(new URL('../num/src/index.ts', import.meta.url)),
      '@iforge/expr': fileURLToPath(new URL('../expr/src/index.ts', import.meta.url)),
      '@iforge/model': fileURLToPath(new URL('../model/src/index.ts', import.meta.url)),
      '@iforge/runtime': fileURLToPath(new URL('../runtime/src/index.ts', import.meta.url)),
      '@iforge/ui-kit': fileURLToPath(new URL('../ui-kit/src/index.ts', import.meta.url)),
      '@iforge/i18n': fileURLToPath(new URL('../i18n/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'persist',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // 13 第 6 条的文件大小校验与 10.1 的 IndexedDB 都需要浏览器环境（jsdom 提供 DOM，
    // `fake-indexeddb` 提供 IndexedDB），jsdom 本身不带 IndexedDB。
    environment: 'jsdom',
  },
})
