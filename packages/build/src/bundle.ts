/**
 * 运行时产物的编译（TECH_DESIGN 11.1 的「运行时产物 runtime.iife.js（无外部依赖）」）。
 *
 * ## 为什么这一段**不**在浏览器里跑
 *
 * 编辑器的“打包”按钮必须能在浏览器里完成（作者点一下就下载）。浏览器里没有 esbuild 的
 * 原生绑定（只有 `esbuild-wasm`，要多带 10MB 的 wasm 且首次调用有明显延迟），
 * 因此编辑器走的是另一条路：`apps/editor/vite/iforge-runtime-shell.ts` 在**构建期**就用
 * 同一套 esbuild 把运行时编译成字符串常量（虚拟模块 `virtual:iforge-runtime-shell`），
 * 打包时把它当作 `runtimeSource` 传进 `packageGame()`。
 *
 * 于是本模块只服务于 **Node 侧**：CLI（`iforge-pack`）、`e2e/` 的产物构建与冒烟测试。
 * 两端拿到的是**同一份字节**——这一点由 `test/bundle.test.ts` 断言
 * （编译产物的 `hash` 与编辑器虚拟模块的内容一致由 M4 的 `runtime-shell-build.test.ts` 保证）。
 *
 * ## 关键参数为什么是这些
 *
 * | 参数 | 值 | 理由 |
 * | --- | --- | --- |
 * | `format` | `iife` | 单文件产物里不能有 `import`/`export`（与 M4 的门禁同一条） |
 * | `target` | `es2022` | 与 M4 一致；`??`/`?.` 不必降级，产物更小 |
 * | `define` | `NODE_ENV=production` | 去掉 React 的开发分支（`process.env.NODE_ENV` 在浏览器里未定义会让 React 直接崩） |
 * | `minify` | `true` + `drop: ['console']` | 11.2「通过 terser + drop console 控制体积」 |
 * | `css?inline` | 自定义插件 | 让 CSS 以**文本**进产物（单文件不能外链样式表） |
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Plugin as EsbuildPlugin } from 'esbuild'
import { build } from 'esbuild'

/** 入口的**仓库内**相对路径（从 monorepo 根算起）。 */
const STANDALONE_ENTRY_RELATIVE = 'apps/runtime-shell/src/standalone-entry.ts'

/** 用于识别 monorepo 根的标记文件（3.1 目录树）。 */
const ROOT_MARKERS = ['pnpm-workspace.yaml', 'package.json']

/**
 * 默认入口：打包版的**直挂**入口（`standalone-entry.ts`）。
 *
 * **不是** `iframe-entry.ts`：那个入口等 `host:init` 才挂载（9.3 第 2 步），
 * 而打包产物没有宿主——会永远停在空白页。这条差异只在这个常量上体现，
 * 两者共用 `boot.ts` 与同一棵 `AppView`（ADR-03）。
 *
 * ## 为什么用“向上搜索”而不是 `resolve(__dirname, '../../../apps/...')`
 *
 * 这个常量会在**两种形态**下被求值：
 *
 * | 形态 | `import.meta.url` 指向 |
 * | --- | --- |
 * | Vitest / Vite 直接跑源码 | `packages/build/src/bundle.ts` |
 * | CLI（`scripts/iforge-pack.mjs` 用 esbuild 打成 bundle 后 `import()`） | `packages/build/node_modules/.cache/iforge-scripts/<hash>/main.mjs` |
 *
 * 第二种形态下相对路径的**基准变了**，写死层数就会指向
 * `.../node_modules/apps/runtime-shell/...` 并报 “Could not resolve”。
 * 向上搜索 `pnpm-workspace.yaml` 找到 monorepo 根，两种形态都正确。
 */
export const STANDALONE_ENTRY = findRepoFile(STANDALONE_ENTRY_RELATIVE)

/**
 * 从当前文件向上找到 monorepo 根，再解析仓库内路径。
 *
 * @throws 找不到标记文件时抛错——静默回落到某个猜测路径只会让错误信息变得毫无线索。
 */
function findRepoFile(relative: string): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  const { root } = parse(dir)
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(resolve(dir, marker)))) {
      const target = resolve(dir, relative)
      if (existsSync(target)) return target
    }
    if (dir === root) break
    dir = dirname(dir)
  }
  throw new Error(
    `@iforge/build: 从 ${import.meta.url} 向上找不到 ${relative}（缺少 ${ROOT_MARKERS[0]} 标记）。` + '这通常意味着本包被单独拷出了 monorepo。',
  )
}

/** 编译选项。 */
export interface CompileOptions {
  /** 入口文件；省略时用 `STANDALONE_ENTRY`。 */
  entry?: string
  /** 是否压缩（11.2：默认压缩）。 */
  minify?: boolean
}

/**
 * 把运行时编译成**单文件 IIFE**。
 *
 * @returns IIFE 源码文本（可直接内联进 `<script>`）
 */
export async function compileRuntimeBundle(options: CompileOptions = {}): Promise<string> {
  const entry = options.entry ?? STANDALONE_ENTRY
  const minify = options.minify ?? true
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    minify,
    legalComments: 'none',
    // 11.2：`drop console`。表达式求值路径上作者会写调试用的 console，留着只是白占体积。
    // 注意这也会去掉**诊断**里的 console.error —— 诊断走的是 `Diagnostics`（→ `game:error`），
    // 不依赖 console，因此不受影响。
    ...(minify ? { drop: ['console'] as 'console'[] } : {}),
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [cssInlinePlugin()],
    logLevel: 'silent',
  })
  const output = result.outputFiles?.[0]
  if (!output) throw new Error('@iforge/build: esbuild 没有产出任何文件')
  return output.text
}

/**
 * `*.css?inline` -> 导出 CSS **文本**的 JS 模块。
 *
 * 与 `apps/editor/vite/iforge-runtime-shell.ts` 里的同名插件逐字一致：
 * esbuild 默认把 `?inline` 当成文件名的一部分去解析而失败，而 Vite 把它定义为“取文本”。
 * 两处各写一份是因为它们分属两个互不依赖的包（3.2 禁止 app 之间互相 import），
 * 而 `test/bundle.test.ts` 断言两边产出的 CSS 文本一致。
 */
export function cssInlinePlugin(): EsbuildPlugin {
  return {
    name: 'iforge-css-inline',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /\.css\?inline$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace(/\?inline$/, '')),
        namespace: 'iforge-css-inline',
      }))
      pluginBuild.onLoad({ filter: /.*/, namespace: 'iforge-css-inline' }, async (args) => ({
        contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`,
        loader: 'js',
      }))
    },
  }
}
