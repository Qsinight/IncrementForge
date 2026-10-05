import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// `docs:check` 的独立配置：14.3 的文档交叉校验以 vitest 运行（断言即阻断条件），
// 因此它需要与各包相同的源码别名，否则 `@iforge/*` 的 TS 源码无法解析。
export default defineConfig({
  resolve: {
    alias: {
      '@iforge/num': fileURLToPath(new URL('../packages/num/src/index.ts', import.meta.url)),
      '@iforge/expr': fileURLToPath(new URL('../packages/expr/src/index.ts', import.meta.url)),
      '@iforge/model': fileURLToPath(new URL('../packages/model/src/index.ts', import.meta.url)),
      '@iforge/runtime': fileURLToPath(new URL('../packages/runtime/src/index.ts', import.meta.url)),
      '@iforge/ui-kit': fileURLToPath(new URL('../packages/ui-kit/src/index.ts', import.meta.url)),
      '@iforge/i18n': fileURLToPath(new URL('../packages/i18n/src/index.ts', import.meta.url)),
      '@iforge/persist': fileURLToPath(new URL('../packages/persist/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'docs-check',
    // `root` 指向 tools/，`include` 才能命中该目录下的用例（否则相对仓库根解析不到）。
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['docs-check.test.ts'],
    environment: 'node',
  },
})
