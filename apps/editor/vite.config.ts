import { defineConfig } from 'vite'
import type { ConfigEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

import { iforgeRuntimeShell } from './vite/iforge-runtime-shell'

// 编辑器是 M3 起的唯一 Vite 应用（3.1 的目录树：`apps/editor`）。
// 工作区包以源码形式互引（与 packages/*/package.json 的 exports 一致），
// 因此改 `@iforge/*` 源码即可热更新，不必先 build 包。
// M4 起新增 `apps/runtime-shell`：预览沙箱的运行时以 esbuild 产物内联进 `srcdoc`（9.1）。
const workspaceAlias = (name: string, dir: string): string => fileURLToPath(new URL(dir, import.meta.url))

/**
 * 解析 `base`——只为「部署到子路径」这一个目的存在。
 *
 * GitHub Pages 的项目站点在 `https://<user>.github.io/<repo>/` 下，产物里的资源 URL
 * 必须带这个前缀。漏配的症状很有迷惑性：`index.html` 能打开、页面全白、控制台一条
 * `GET /assets/index-*.js 404`——因为默认 base 是 `/` 而不是仓库名。
 *
 * 两种取值：
 * - **CI**：由 `actions/configure-pages` 把 `base_path`（`/IncrementForge`）写进
 *   `IFORGE_BASE`，这里补上结尾斜杠即得 `/IncrementForge/`。用户/组织站点（`base_path`
 *   为 `/`）也因此自动退回 `./`。
 * - **本地**：不设环境变量就退回 `./`。相对路径对 `/` 和任意子路径都成立，所以同一份
 *   配置本地 `preview` 与线上 Pages 不需要分别处理，编辑器也没有路由，不存在深链接 404。
 *
 * 只把 **dev server** 固定成 `/`：`vite preview` 的 `command` 也是 `'serve'`（靠
 * `isPreview` 区分），若一并退回 `/`，就会把带 `/IncrementForge/` 前缀的产物挂到 4173 根路径，
 * 本地预览恰好复现线上那个 404 —— 那正是这段代码要防的症状。
 */
const resolveBase = (env: ConfigEnv): string => {
  if (env.command === 'serve' && !env.isPreview) return '/'
  const raw = process.env.IFORGE_BASE?.trim()
  if (!raw || raw === '/' || raw === './') return './'
  return raw.endsWith('/') ? raw : `${raw}/`
}

export default defineConfig((env: ConfigEnv) => ({
  base: resolveBase(env),
  plugins: [react(), iforgeRuntimeShell()],
  resolve: {
    alias: {
      '@iforge/build': workspaceAlias('@iforge/build', '../../packages/build/src/index.ts'),
      '@iforge/num': workspaceAlias('@iforge/num', '../../packages/num/src/index.ts'),
      '@iforge/expr': workspaceAlias('@iforge/expr', '../../packages/expr/src/index.ts'),
      '@iforge/model': workspaceAlias('@iforge/model', '../../packages/model/src/index.ts'),
      '@iforge/runtime': workspaceAlias('@iforge/runtime', '../../packages/runtime/src/index.ts'),
      '@iforge/persist': workspaceAlias('@iforge/persist', '../../packages/persist/src/index.ts'),
      '@iforge/ui-kit': workspaceAlias('@iforge/ui-kit', '../../packages/ui-kit/src/index.ts'),
      '@iforge/i18n': workspaceAlias('@iforge/i18n', '../../packages/i18n/src/index.ts'),
      '@': workspaceAlias('@', './src'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 11.2 的“< 1.5MB”预算针对的是**打包产物（游戏本体，M5）**，不是编辑器。
    // 编辑器把 React/zod/immer/zustand/四个核心包全部打进一个 bundle，体积天然更大；
    // 这里把阈值抬到 800KB 只是为了区分“编辑器变大”和“产物超标”两件事。
    //
    // 2000KB 的由来（缺陷 3 的修复带来的一次性成本）：编辑器现在内联**两份**运行时——
    // 预览用的 `iframe-entry.ts`（`srcdoc`）与打包用的 `standalone-entry.ts`（`#app`），
    // esbuild 无法跨两份 bundle 去重，于是编辑器 bundle 大约多 550KB（raw）/150KB（gzip）。
    // 这只影响**编辑器自身**（开发期资产），11.2 的 1.5MB 预算与**游戏产物**无关——
    // 产物里仍然只有一份运行时，约 560KB raw / 160KB gzip。
    chunkSizeWarningLimit: 2000,
  },
}))
