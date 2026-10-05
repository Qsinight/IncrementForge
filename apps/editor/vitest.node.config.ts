import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * 编排与 esbuild 产物相关的测试（**node 环境**）。
 *
 * 为什么单独一个 project：
 * - `vitest.config.ts` 是 jsdom 环境，而 esbuild 在模块加载时断言
 *   `new TextEncoder().encode('') instanceof Uint8Array`——jsdom 的 `TextEncoder`
 *   产出的是**另一个 realm** 的 `Uint8Array`，该断言不成立，esbuild 直接拒绝运行
 *   （它自己也把这条报成“environment is broken”，不是配置错误）。
 * - 因此凡是**需要真的执行 esbuild** 的用例（9.1 的注入物是不是一个可独立运行的 IIFE、
 *   CSS 有没有被打进去）必须跑在 node 环境。
 *
 * 其余 UI/DOM 用例仍在 `vitest.config.ts`（jsdom）里跑。
 */
const workspaceAlias = (dir: string): string => fileURLToPath(new URL(dir, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@iforge/build': workspaceAlias('../../packages/build/src/index.ts'),
      '@iforge/num': workspaceAlias('../../packages/num/src/index.ts'),
      '@iforge/expr': workspaceAlias('../../packages/expr/src/index.ts'),
      '@iforge/model': workspaceAlias('../../packages/model/src/index.ts'),
      '@iforge/runtime': workspaceAlias('../../packages/runtime/src/index.ts'),
      '@iforge/persist': workspaceAlias('../../packages/persist/src/index.ts'),
      '@iforge/ui-kit': workspaceAlias('../../packages/ui-kit/src/index.ts'),
      '@iforge/i18n': workspaceAlias('../../packages/i18n/src/index.ts'),
      '@': workspaceAlias('./src'),
    },
  },
  test: {
    name: 'editor-node',
    include: ['test-node/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
})
