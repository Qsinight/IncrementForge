import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

import { iforgeRuntimeShell } from './vite/iforge-runtime-shell'

const workspaceAlias = (dir: string): string => fileURLToPath(new URL(dir, import.meta.url))

export default defineConfig({
  // 预览的运行时以 `virtual:iforge-runtime-shell` 提供（9.1），测试环境必须装同一个插件，
  // 否则 `PreviewFrame` 的 import 无法解析——这正是“dev 能跑、测试挂掉”的那类漂移。
  plugins: [react(), iforgeRuntimeShell()],
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
    name: 'editor',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
  },
})
