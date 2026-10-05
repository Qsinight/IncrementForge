import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * `build` 的单测跑在 **node** 环境（不是 jsdom）。
 *
 * 原因与 M4 的 `apps/editor/vitest.node.config.ts` 相同：`bundle.ts` 会真的调 esbuild，
 * 而 esbuild 在 jsdom realm 里会撞上 `TextEncoder` 的原型不一致（`M4 README` 的记录）。
 * 这里也顺带验证了一件事：**打包管线本身不依赖 DOM**——模板渲染、指纹、校验全是纯函数，
 * 唯一碰 DOM 的是产物里的浏览器侧代码（那部分由 `e2e/` 的 Playwright 与打包冒烟覆盖）。
 */
const alias = (dir: string): string => fileURLToPath(new URL(dir, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@iforge/num': alias('../num/src/index.ts'),
      '@iforge/expr': alias('../expr/src/index.ts'),
      '@iforge/model': alias('../model/src/index.ts'),
      '@iforge/runtime': alias('../runtime/src/index.ts'),
      '@iforge/ui-kit': alias('../ui-kit/src/index.ts'),
    },
  },
  test: {
    name: 'build',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
