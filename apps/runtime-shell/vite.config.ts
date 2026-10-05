import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * 预览沙箱宿主页的**独立**开发服务器（3.1 目录树：`apps/runtime-shell/`「预览沙箱宿主页
 * （仅供开发调试 iframe 内容）」）。
 *
 * 编辑器预览**不走**这个服务器：9.1 要求运行时脚本以构建产物注入 `srcdoc`，编辑器侧的
 * Vite 插件（`apps/editor/vite.config.ts` 的 `iforgeRuntimeShell()`）会用 esbuild 打包
 * `src/iframe-entry.tsx` 并内联进 iframe。
 *
 * 这个服务器的价值在于**调试**：可以用 `?bootstrap=<json>` 或直接改 `window.__IFORGE_BOOTSTRAP__`
 * 起一个独立页面，不必先起编辑器。两条入口共用同一份 `mountGame()`（见 `src/boot.ts`），
 * 因此“独立调试”和“编辑器预览”渲染的是同一套代码。
 */
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
  server: { port: 5174 },
  build: { outDir: 'dist', emptyOutDir: true },
})
