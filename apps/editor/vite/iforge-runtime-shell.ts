/**
 * `iforgeRuntimeShell()` —— 产出两份运行时注入物（TECH_DESIGN 9.1 的预览 `srcdoc` 与
 * 11.1 的打包产物）。
 *
 * ## 两份注入物、两个入口、两个挂载点
 *
 * | 虚拟模块 | 入口 | 挂载点 | 谁提供挂载点 |
 * | --- | --- | --- | --- |
 * | `virtual:iforge-runtime-shell` | `iframe-entry.ts` | `#iforge-root` | 宿主写在 `srcdoc` 里（9.1） |
 * | `virtual:iforge-standalone-runtime` | `standalone-entry.ts` | `#app` | 打包模板 `renderBundleHtml` 写在 `<body>` 里（17.3） |
 *
 * ## 为什么打包**不能**复用预览那份
 *
 * 打包模板只提供 `<div id="app">`。`iframe-entry` 找不到 `#iforge-root` 时会**自己新建一个
 * 挂到 `body` 末尾**，于是模板里那个**空**的 `#app`（模板 CSS 给了 `height: 100%`）留在
 * 游戏上方整整一屏，文档高度变成两屏——作者看到的是“页面上半部分一大片留白、往下滚才
 * 看到游戏”，而数据、点击、导航这类功能断言**全绿**。
 *
 * `packages/build/src/bundle.ts` 的 `STANDALONE_ENTRY` 早就写明了这条（“不是
 * `iframe-entry.ts`……会永远停在空白页”）。CLI 走的是那条路；编辑器此前误用了预览那份，
 * 两端因此产出了**不同的字节**。这里补上第二份虚拟模块，让两端重新一致（ADR-03/ADR-05
 * 想要的“预览与产物同源”）。
 *
 * ## 为什么不用 iframe 直接引 dev server 的模块脚本
 *
 * 9.1 的 iframe 是 `sandbox="allow-scripts"` 且**不加** `allow-same-origin`，因此它的文档处于
 * 不透明源：
 * - `<script type="module" src="…">` 跨源会被 CORS 拦（`Origin: null`）；
 * - 即使允许同源，`pnpm build` 之后也没有对应的服务器可引。
 *
 * 9.1 的原文是“运行时脚本通过**构建产物**注入 `srcdoc`”，因此这里照做：esbuild 把入口打成
 * 单文件 IIFE（含 React 与 `@iforge/*`），作为**虚拟模块**提供给宿主。
 *
 * ## dev 与 build 走同一条路
 *
 * 两条模式都只经 `load()` 产出文本（`buildStart` 只是把它提前算好、避免首个请求等 300ms）：
 * - dev：`buildStart` 编译一次，之后 `load` 直接返回缓存；
 * - build：同样在 `buildStart` 编译，Rollup 打包时内联成字符串常量。
 *
 * 这样**不存在**“dev 能跑、build 挂掉”的第二种代码路径——这正是 14.3 强调的
 * “改了一处漏了另一处”里最难排查的一类。
 *
 * ## 为什么用 esbuild 的**异步** API
 *
 * `buildSync` 不支持 `plugins`，而我们需要一条规则把 `*.css?inline` 变成“导出 CSS 文本的
 * 模块”（见 `cssInlinePlugin`）。因此全链路异步：Vite 的 `buildStart`/`load` 都接受
 * Promise，代价只是首次编译多一个 microtask。
 *
 * ## 关于体积
 *
 * 预览用的运行时是**开发资产**（作者要反复改项目并立刻看到效果），因此默认 `minify: true`。
 * 它会进编辑器产物的 bundle（约 +150KB gzip，与 React/immer/zustand 同量级），
 * 与 11.2 的 1.5MB 预算无关——那条针对的是 M5 的**游戏本体**。打包用的那份同样 `minify`，
 * 因为它就是要进产物的字节。
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Plugin as EsbuildPlugin } from 'esbuild'
import { build } from 'esbuild'
import type { Plugin } from 'vite'

/** 虚拟模块 id：宿主 `import source from 'virtual:iforge-runtime-shell'` 取到编译产物文本。 */
export const VIRTUAL_ID = 'virtual:iforge-runtime-shell'

export const VIRTUAL_STANDALONE_ID = 'virtual:iforge-standalone-runtime'

const RESOLVED_ID = `\0${VIRTUAL_ID}`
const RESOLVED_STANDALONE_ID = `\0${VIRTUAL_STANDALONE_ID}`

const here = dirname(fileURLToPath(import.meta.url))
/**
 * 被编译的入口所在目录。
 *
 * 本文件位于 `apps/editor/vite/`，目标在 `apps/runtime-shell/src/`——
 * 因此要退**两**级（`apps/editor` -> `apps`）。写成一级会指向 `apps/editor/runtime-shell`，
 * 症状是 esbuild 报 “Could not resolve …”，且只在启动时出现、报错信息里看不出路径写错。
 */
const runtimeShellDir = resolve(here, '../../runtime-shell/src')

/** 预览注入物的入口（挂载点 `#iforge-root`，9.1）。 */
export const RUNTIME_SHELL_ENTRY = resolve(runtimeShellDir, 'iframe-entry.ts')

/** 打包产物的入口（挂载点 `#app`，与 `packages/build` 的 `STANDALONE_ENTRY` 同一个文件）。 */
export const RUNTIME_STANDALONE_ENTRY = resolve(runtimeShellDir, 'standalone-entry.ts')

export interface RuntimeShellPluginOptions {
  /** esbuild 的 `minify`；默认 `true`。 */
  minify?: boolean
}

/**
 * 进程级缓存。
 *
 * dev server 与 vitest 会各建一个插件实例，共用这份文本可避免重复打包（esbuild 全量
 * bundle 约 200~400ms）。缓存**存放编译结果**而非 Promise，这样并发 `load()` 不会互相等待。
 */
let cachedSource = ''
let cachedStandalone = ''

/** 让缓存失效（改 `apps/runtime-shell/src` 后由 `configureServer` 调用；测试复位也用它）。 */
export function invalidateRuntimeShellCache(): void {
  cachedSource = ''
  cachedStandalone = ''
}

async function compileEntry(entry: string, minify: boolean): Promise<string> {
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
    // 预览里的表达式求值不受 NODE_ENV 影响；固定为 production 去掉 React 的开发分支。
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [cssInlinePlugin()],
    logLevel: 'silent',
  })
  const output = result.outputFiles?.[0]
  if (!output) throw new Error('iforgeRuntimeShell: esbuild 没有产出任何文件')
  return output.text
}

/** 编译预览注入物（`iframe-entry.ts`）。 */
export async function compileRuntimeShell(minify: boolean): Promise<string> {
  cachedSource = await compileEntry(RUNTIME_SHELL_ENTRY, minify)
  return cachedSource
}

/** 编译打包产物运行时（`standalone-entry.ts`）——与 `packages/build` 的 CLI 同一个入口。 */
export async function compileStandaloneRuntime(minify: boolean): Promise<string> {
  cachedStandalone = await compileEntry(RUNTIME_STANDALONE_ENTRY, minify)
  return cachedStandalone
}

/** 产出预览沙箱与打包产物两份运行时的 Vite 插件（9.1 / 11.1）。 */
export function iforgeRuntimeShell(options: RuntimeShellPluginOptions = {}): Plugin {
  const minify = options.minify ?? true
  const ensure = async (): Promise<string> => (cachedSource ? cachedSource : compileRuntimeShell(minify))
  const ensureStandalone = async (): Promise<string> => (cachedStandalone ? cachedStandalone : compileStandaloneRuntime(minify))

  return {
    name: 'iforge-runtime-shell',
    enforce: 'pre',
    async buildStart() {
      // 两份都要在 `buildStart` 算好：dev 模式下“打包”按钮随时可能点，
      // 不能让作者在下载那一刻等 300ms 的 esbuild。
      await compileRuntimeShell(minify)
      await compileStandaloneRuntime(minify)
    },
    configureServer(server) {
      // 改 `apps/runtime-shell/src` 时必须让缓存失效：宿主的 iframe 里跑的是**上一次**
      // 编译的产物，不重新编译的话作者改完游戏视图、刷新页面也看不到变化——
      // 而这是“预览与编辑器同步”最基础的一条预期。
      const root = dirname(RUNTIME_SHELL_ENTRY)
      server.watcher.add(root)
      const onChange = (file: string): void => {
        if (!file.startsWith(root)) return
        invalidateRuntimeShellCache()
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.on('change', onChange)
      server.watcher.on('add', onChange)
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
      if (id === VIRTUAL_STANDALONE_ID) return RESOLVED_STANDALONE_ID
      return undefined
    },
    async load(id) {
      // 以 JS 模块形式导出文本。`JSON.stringify` 负责转义，因此产物里的 `</script>`
      // 不会提前闭合宿主的标签——srcdoc 与打包模板正是这样内联的。
      if (id === RESOLVED_ID) return `export default ${JSON.stringify(await ensure())}\n`
      if (id === RESOLVED_STANDALONE_ID) return `export default ${JSON.stringify(await ensureStandalone())}\n`
      return undefined
    },
  }
}

/**
 * `*.css?inline` -> 导出 CSS 文本的 JS 模块。
 *
 * esbuild 默认不认识 `?inline` 后缀，会把整串文件名当路径去找而失败。
 * 这里手写一条最小规则：让产物是**单个 JS 文件**（样式文本由入口自己注入 `<style>`），
 * 宿主因此不必再单独内联一个 `<link>` 或额外的一段 CSS（见 `iframe-entry.ts`）。
 */
function cssInlinePlugin(): EsbuildPlugin {
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
