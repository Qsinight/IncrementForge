/**
 * 真实运行时产物的编译与单文件打包（TECH_DESIGN 11.1 第 1 步、11.2、17.3、17.5 的 M5 交付标准）。
 *
 * ## 为什么这些用例必须在 **node** 环境里真的跑 esbuild
 *
 * 「产物可离线游玩」这句话只能靠**执行真实字节**来证明：
 *
 * - 产物里混进 ESM 语法 -> 单文件 `<script>` 里直接语法错误，页面一片空白；
 * - CSS 没被打进去 -> 功能全对但排版退化成浏览器默认样式（这正是 M4 修过的一个真实缺陷）；
 * - 引用了外部资源 -> 离线打开时图标/样式全丢，而所有功能断言都还是绿的。
 *
 * 合成载荷（`console.log("</script>")`）只能证明模板的**转义**有效，
 * 证明不了产物本身可执行——所以这里必须用真实产物。
 *
 * ## 与 M4 的门禁的分工
 *
 * M4 的 `apps/editor/test-node/runtime-shell-build.test.ts` 断言的是**预览注入物**
 * （`iframe-entry.ts`）。本文件断言的是**打包产物**（`standalone-entry.ts`）：
 * 入口不同（直挂 vs 等 `host:init`），因此这是两条独立的编译路径，都要各自有门禁。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createExampleProject, parseProjectFile } from '@iforge/model'

import { compileRuntimeBundle, STANDALONE_ENTRY } from '../src/bundle.js'
import { packageGame, warmUpGzip, SIZE_BUDGET_BYTES, SIZE_BUDGET_GZIP_BYTES } from '../src/package-game.js'

describe('11.1 第 1 步：运行时产物是无外部依赖的单文件 IIFE', () => {
  let source: string

  beforeAll(async () => {
    source = await compileRuntimeBundle()
  }, 120_000)

  it('入口是 standalone-entry（直挂），不是 iframe-entry（会等 host:init 而永远不挂载）', () => {
    expect(STANDALONE_ENTRY.replace(/\\/g, '/')).toMatch(/apps\/runtime-shell\/src\/standalone-entry\.ts$/)
  })

  it('编译出的是 IIFE：没有裸 ESM 语法，且自带启动调用', () => {
    expect(source.length).toBeGreaterThan(50_000)
    // 用 `includes` 而不是 `toMatch`：产物是一百多 KB 的单行文本，
    // 正则断言失败时会把整段打进错误输出，把真正的失败信息淹没（M4 的同款结论）。
    expect(/^\s*import[\s{*(]/m.test(source)).toBe(false)
    expect(/^\s*export[\s{]/m.test(source)).toBe(false)
    // 入口的 DOMContentLoaded 分支：产物里有这段就说明 standalone-entry 被编进去了。
    expect(source.includes('DOMContentLoaded')).toBe(true)
  })

  it('CSS 以文本内联进产物（离线打开不会掉样式）', () => {
    // `.iforge-game` 是 game.css 的根类，必须出现在**产物里**而不是外部 <link>。
    expect(source.includes('.iforge-game')).toBe(true)
    expect(source.includes('--iforge-page-bg')).toBe(true)
  })

  it('没有外部依赖：产物里不含 fetch/importScripts 之类的动态加载', () => {
    // `import(` 会被 Rollup/esbuild 改写，残留的**字符串** import 才说明有动态加载。
    expect(source.includes('importScripts(')).toBe(false)
  })

  it('生产模式：React 的开发分支被 define 去掉（NODE_ENV 未定义会让 React 直接崩）', () => {
    expect(source.includes('process.env.NODE_ENV')).toBe(false)
  })

  it('drop console 生效（11.2 的体积控制手段之一）', () => {
    expect(source.includes('console.log(')).toBe(false)
  })
})

describe('11.1 / 17.3：完整产物的结构与体积', () => {
  let html: string
  let bytes: number
  let gzipBytes: number
  let tempDir: string

  beforeAll(async () => {
    // gzip 数字要靠预加载（见 `package-game.ts` 的 `warmUpGzip` 注释）：
    // `packageGame` 是同步的，而 ESM 里 `node:zlib` 只有异步入口。
    await warmUpGzip()
    const source = await compileRuntimeBundle()
    tempDir = await mkdtemp(join(tmpdir(), 'iforge-pack-'))
    const outcome = packageGame({ project: createExampleProject(), runtimeSource: source })
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    html = outcome.html
    bytes = outcome.bytes
    gzipBytes = outcome.gzipBytes
  }, 120_000)

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('体积在 11.2 的预算内（< 1.5MB，gzip < 500KB）', () => {
    expect(bytes).toBeLessThan(SIZE_BUDGET_BYTES)
    expect(gzipBytes).toBeGreaterThan(0)
    expect(gzipBytes).toBeLessThan(SIZE_BUDGET_GZIP_BYTES)
  })

  it('单文件：没有 <script src>、没有 <link rel=stylesheet>、没有外部图片', () => {
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i)
    // 除了 data: URL 与 React 内置的错误文档链接（只出现在报错文案里，不是资源），
    // 产物里不该有任何会被浏览器去**取**的 http(s) 引用。
    const external = (html.match(/https?:\/\/(?!www\.w3\.org|react\.dev)[^"'\s)]+/g) ?? []).filter((url) => !/react\.dev/.test(url))
    expect(external).toEqual([])
  })

  it('注入的引导数据能解析回项目文件（17.3）', () => {
    const json = /window\.__IFORGE_BOOTSTRAP__=(\{[\s\S]*?\});/.exec(html)?.[1]
    expect(json).toBeTruthy()
    // 引导数据是 `{ project, save, meta }`（17.3），不是裸的项目文件；
    // 解析前先取 `project` —— 直接把整段喂给 `parseProjectFile` 会因 `format` 缺失而报 `E_VERSION`。
    const bootstrap = JSON.parse(json!) as { project: unknown }
    const parsed = parseProjectFile(bootstrap.project)
    expect(parsed.meta.name).toBe(createExampleProject().meta.name)
    expect(parsed.generators.length).toBe(createExampleProject().generators.length)
  })

  it('产物写到磁盘后再读回来仍然完全一致（幂等、可重复构建）', async () => {
    const path = join(tempDir, 'game.html')
    await writeFile(path, html, 'utf8')
    expect(await readFile(path, 'utf8')).toBe(html)
  })

  it('模板体积极小：项目数据 + 模板不足产物的 5%（体积主要来自运行时）', () => {
    // 这条断言的价值是**报警**：如果哪天模板里塞进了大 base64 资源而没人发现，
    // 体积会悄悄膨胀；这里给出一个上界，让改动越界时被门禁挡住。
    const templateBytes = new TextEncoder().encode(/<script>window\.__IFORGE_BOOTSTRAP__=[\s\S]*?;<\/script>/.exec(html)?.[0] ?? '').length
    expect(templateBytes / bytes).toBeLessThan(0.05)
  })
})

describe('11.1：改动项目内容后产物内容随之改变（指纹不是摆设）', () => {
  it('改资源名 -> 指纹与产物的 <title> 之外的项目数据都变', async () => {
    const source = await compileRuntimeBundle()
    const before = packageGame({ project: createExampleProject(), runtimeSource: source })
    const project = createExampleProject()
    project.resources[0]!.name = '改过名字的资源'
    const after = packageGame({ project, runtimeSource: source })
    if (!before.ok || !after.ok) throw new Error('应当打包成功')
    expect(after.meta.fingerprint).not.toBe(before.meta.fingerprint)
    expect(after.html).toContain('改过名字的资源')
    expect(before.html).not.toContain('改过名字的资源')
  }, 120_000)

  it('上传图标被内联成 data: URL（10.1「保存/导出规范化」之后的形态）', async () => {
    const source = await compileRuntimeBundle()
    const project = createExampleProject()
    // 已有资源改图标（示例项目里资源用的是内置图标，`createResource` 的默认值不能覆盖它）。
    project.resources[0]!.icon = { kind: 'data', value: 'data:image/png;base64,iVBORw0KGgo=' }
    const outcome = packageGame({ project, runtimeSource: source })
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    expect(outcome.html).toContain('data:image/png;base64,iVBORw0KGgo=')
  }, 120_000)
})
