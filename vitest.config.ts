import { defineConfig } from 'vitest/config'

/**
 * 测试编排（14.1 的分层）。
 *
 * 项目清单**显式**列出而不是用 `apps/*` 通配：`apps/editor` 下有两份 vitest 配置
 * （jsdom 的 `vitest.config.ts` 与 node 的 `vitest.node.config.ts`），通配只能识别到一份，
 * 编排与 esbuild 产物的用例会因为跑在 jsdom 里而无法执行 esbuild（见那份配置的注释）。
 *
 * - `packages/*`、`apps/runtime-shell`、`apps/editor/vitest.config.ts`：目录内含配置，
 *   vitest 自动发现；
 * - `apps/editor/vitest.node.config.ts`：显式给出**文件**路径（而非目录）。
 */
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/runtime-shell', 'apps/editor/vitest.config.ts', 'apps/editor/vitest.node.config.ts'],
  },
})
