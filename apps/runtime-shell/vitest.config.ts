import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const workspaceAlias = (name: string, dir: string): string => fileURLToPath(new URL(dir, import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@iforge/num': workspaceAlias('@iforge/num', '../../packages/num/src/index.ts'),
      '@iforge/expr': workspaceAlias('@iforge/expr', '../../packages/expr/src/index.ts'),
      '@iforge/model': workspaceAlias('@iforge/model', '../../packages/model/src/index.ts'),
      '@iforge/runtime': workspaceAlias('@iforge/runtime', '../../packages/runtime/src/index.ts'),
      '@iforge/ui-kit': workspaceAlias('@iforge/ui-kit', '../../packages/ui-kit/src/index.ts'),
      '@iforge/i18n': workspaceAlias('@iforge/i18n', '../../packages/i18n/src/index.ts'),
    },
  },
  test: {
    name: 'runtime-shell',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
  },
})
