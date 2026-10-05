import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  compileStandaloneRuntime,
  iforgeRuntimeShell,
  invalidateRuntimeShellCache,
  RUNTIME_SHELL_ENTRY,
  RUNTIME_STANDALONE_ENTRY,
  VIRTUAL_ID,
  VIRTUAL_STANDALONE_ID,
} from '../vite/iforge-runtime-shell'

/**
 * 9.1 的注入物必须是一段**可独立执行**的 IIFE。
 *
 * 这条门禁挡住的是最容易在“写完 M4 才发现”的问题：esbuild 产物里混进了 ESM 语法
 * （在 `srcdoc` 的 `<script>` 里直接语法错误，iframe 整块空白）或根本没把 CSS 打进去
 * （预览里是一堆裸文字，作者完全看不出原因）。
 */
describe('9.1：运行时注入物（srcdoc 的脚本）', () => {
  const plugin = iforgeRuntimeShell()
  const resolveId = plugin.resolveId as (id: string) => string | undefined
  const load = plugin.load as (id: string) => Promise<string | undefined>

  async function source(): Promise<string> {
    const resolved = resolveId.call(plugin as never, 'virtual:iforge-runtime-shell')
    expect(resolved).toBeTruthy()
    const text = await load.call(plugin as never, resolved as string)
    expect(text).toBeTypeOf('string')
    // 虚拟模块是 `export default "<iife>"`；取出裸文本。
    return JSON.parse((text as string).slice('export default '.length).trim()) as string
  }

  it('编译成 IIFE：没有裸 ESM 语法，且自带启动调用', async () => {
    invalidateRuntimeShellCache()
    const text = await source()
    expect(text.length).toBeGreaterThan(10_000)
    // 用 `includes` 而不是 `toMatch`：产物是一百多 KB 的单行文本，
    // 正则断言失败时会把整段打进错误输出，把真正的失败信息淹没。
    expect(/^\s*import[\s{*(]/m.test(text)).toBe(false)
    expect(/^\s*export[\s{]/m.test(text)).toBe(false)
    expect(text.includes('iforge-root')).toBe(true)
  })

  it('CSS 以文本内联进产物（iframe 不再额外引样式表）', async () => {
    invalidateRuntimeShellCache()
    const text = await source()
    // `.iforge-game` 是 game.css 的根类；它必须出现在**产物里**而不是外部 <link>。
    expect(text.includes('.iforge-game')).toBe(true)
    expect(text.includes('--iforge-page-bg')).toBe(true)
  })

  it('srcdoc 内联时转义 </script>（否则宿主页面的 script 标签被提前闭合）', async () => {
    const { buildSrcdoc } = await import('../src/features/preview/session')
    // 用合成的载荷而不是真实产物：minify 后的产物里未必恰好含有该序列，
    // 断言“产物里一定有”会把门禁建立在一个第三方库的内部实现上。
    const script = 'console.log("</script>");console.log("</SCRIPT >")'
    const srcdoc = buildSrcdoc(script)
    // 整份 srcdoc 里只应有末尾那一个真实的结束标签。
    expect(srcdoc.split('</script').length - 1).toBe(1)
    expect(srcdoc).toContain('<\\/script')
    expect(srcdoc).toContain('id="iforge-root"')
  })

  it('入口路径指向 apps/runtime-shell（写错层级时 esbuild 会报 Could not resolve）', () => {
    expect(RUNTIME_SHELL_ENTRY.replace(/\\/g, '/')).toMatch(/apps\/runtime-shell\/src\/iframe-entry\.ts$/)
  })

  it('未知 id 不被本插件处理', () => {
    expect(resolveId.call(plugin as never, 'react')).toBeUndefined()
  })
})

/**
 * 缺陷 3：打包产物“页面上半部分留白面积过大”。
 *
 * ## 现象与根因
 *
 * 打包模板 `renderBundleHtml` 只在 `<body>` 里放一个 `<div id="app">`（并给它
 * `height: 100%`）。若产物里内联的是**预览**那份注入物（入口 `iframe-entry.ts`、
 * 挂载点 `#iforge-root`），运行时找不到该挂载点就**自己新建一个挂到 `body` 末尾**——
 * 空 `#app` 于是留在游戏上方整整一屏：
 *
 * ```
 * 实测（1904×941 的视口，Playwright 量 getBoundingClientRect）
 *   body 子节点   DIV#app, NOSCRIPT, SCRIPT, SCRIPT, DIV#iforge-root
 *   #app          top=0    bottom=941   height=941   <- 空的，整整一屏
 *   #iforge-root  top=941  bottom=1882  height=941   <- 游戏在这里
 *   .game-title   top=949                                  <- 标题在**第二屏**
 *   document.scrollHeight = 1882（视口 941 的两倍）
 * ```
 *
 * 功能断言（数据、点击、导航、存档）**全部通过**，只有肉眼能看出那半屏空白。
 *
 * ## 本组用例守住三件事
 *
 * 1. 打包用的是**直挂**入口（`standalone-entry.ts`），挂载点与模板一致；
 * 2. 两份虚拟模块都存在且**不是同一段文本**（共用一份就等于把这个缺陷装回去）；
 * 3. `packageGame()` 用的那份确实来自打包专用虚拟模块。
 */
describe('缺陷 3：打包产物内联的是直挂运行时（不是预览注入物）', () => {
  const plugin = iforgeRuntimeShell()
  const resolveId = plugin.resolveId as (id: string) => string | undefined
  const load = plugin.load as (id: string) => Promise<string | undefined>

  async function virtualSource(id: string): Promise<string> {
    const resolved = resolveId.call(plugin as never, id)
    expect(resolved, `${id} 应当被本插件解析`).toBeTruthy()
    const text = await load.call(plugin as never, resolved as string)
    return JSON.parse((text as string).slice('export default '.length).trim()) as string
  }

  it('打包用的虚拟模块存在，且入口是 standalone-entry（挂载点 #app）', async () => {
    invalidateRuntimeShellCache()
    const text = await virtualSource(VIRTUAL_STANDALONE_ID)
    expect(text.length).toBeGreaterThan(10_000)
    // 直挂入口找的是模板给的 `#app`；预览入口找的是 `#iforge-root`。
    expect(text).toContain('"app"')
    expect(text.includes('iforge-root')).toBe(false)
    // 同样必须是可独立执行的 IIFE + 内联 CSS。
    expect(/^\s*import[\s{*(]/m.test(text)).toBe(false)
    expect(text.includes('.iforge-game')).toBe(true)
  })

  it('两份虚拟模块解析到不同 id，且产出的文本不同（共用一份 = 把缺陷装回去）', async () => {
    invalidateRuntimeShellCache()
    const previewId = resolveId.call(plugin as never, VIRTUAL_ID)
    const standaloneId = resolveId.call(plugin as never, VIRTUAL_STANDALONE_ID)
    expect(previewId).toBeTruthy()
    expect(standaloneId).toBeTruthy()
    expect(previewId).not.toBe(standaloneId)

    const [preview, standalone] = await Promise.all([virtualSource(VIRTUAL_ID), virtualSource(VIRTUAL_STANDALONE_ID)])
    expect(preview).not.toBe(standalone)
    expect(preview.includes('iforge-root')).toBe(true)
    expect(standalone.includes('iforge-root')).toBe(false)
  })

  it('打包入口与 packages/build 的 STANDALONE_ENTRY 指向同一个文件', async () => {
    const { STANDALONE_ENTRY } = await import('../../../packages/build/src/bundle')
    expect(RUNTIME_STANDALONE_ENTRY.replace(/\\/g, '/')).toBe(STANDALONE_ENTRY.replace(/\\/g, '/'))
    // 两个入口文件都真实存在（写错层级时 esbuild 会报 Could not resolve）。
    expect(readFileSync(RUNTIME_STANDALONE_ENTRY, 'utf8')).toContain("const ROOT_ID = 'app'")
    expect(readFileSync(RUNTIME_SHELL_ENTRY, 'utf8')).toContain("const ROOT_ID = 'iforge-root'")
  })

  it('`compileStandaloneRuntime` 直接产出的也是直挂版（dev 模式点“打包”走的就是它）', async () => {
    invalidateRuntimeShellCache()
    const text = await compileStandaloneRuntime(true)
    expect(text.includes('iforge-root')).toBe(false)
    expect(text).toContain('"app"')
  })

  it('`packageGame()` 消费的是打包专用虚拟模块，而不是预览那份', () => {
    // 从源码里取 import 语句：断言“用的是哪个虚拟模块”，而不是断言编译后的 bundle 文本。
    const source = readFileSync(fileURLToPath(new URL('../src/features/shell/packageGame.ts', import.meta.url)), 'utf8')
    expect(source).toContain(`from '${VIRTUAL_STANDALONE_ID}'`)
    expect(source).not.toMatch(/import\s+\w+\s+from\s+'virtual:iforge-runtime-shell'/)
  })
})
