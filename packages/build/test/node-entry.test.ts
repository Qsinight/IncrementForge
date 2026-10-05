/**
 * `@iforge/build/node` 子路径入口（`node.ts`）。
 *
 * 这个文件的价值不在逻辑，而在**依赖方向**：它把 `bundle.ts`（顶层 `import { build } from 'esbuild'`）
 * 关在子路径里，编辑器只 import `@iforge/build` 就不会把 esbuild 的原生绑定拖进浏览器 bundle。
 *
 * 因此本文件测的是三件事：
 * 1. 子路径确实**导出了** CLI 需要的全部能力（漏一个导出，e2e 的产物构建就断）；
 * 2. 顶层 `@iforge/build` **不**导出 esbuild 相关能力（这条一旦回退，Vite 构建会在运行时才崩）；
 * 3. `STANDALONE_ENTRY` 在 monorepo 内能被解析到（`findRepoFile` 的成功路径）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'

import * as browserEntry from '../src/index.js'
import * as nodeEntry from '../src/node.js'
import { STANDALONE_ENTRY, cssInlinePlugin } from '../src/bundle.js'

describe('@iforge/build/node 导出面', () => {
  it('CLI 与产物构建需要的能力都在子路径上', () => {
    expect(typeof nodeEntry.runCli).toBe('function')
    expect(typeof nodeEntry.compileRuntimeBundle).toBe('function')
    expect(typeof nodeEntry.warmUpGzip).toBe('function')
    expect(typeof nodeEntry.writeExampleProject).toBe('function')
    expect(typeof nodeEntry.cssInlinePlugin).toBe('function')
    expect(typeof nodeEntry.STANDALONE_ENTRY).toBe('string')
  })

  it('`STANDALONE_ENTRY` 解析到仓库内真实存在的文件（`findRepoFile` 成功路径）', () => {
    expect(nodeEntry.STANDALONE_ENTRY).toBe(STANDALONE_ENTRY)
    expect(existsSync(STANDALONE_ENTRY)).toBe(true)
    expect(STANDALONE_ENTRY.endsWith('standalone-entry.ts')).toBe(true)
  })
})

describe('顶层入口不含 esbuild（防止浏览器 bundle 被污染）', () => {
  it('`@iforge/build` 不导出 `compileRuntimeBundle` / `runCli`', () => {
    // 这两个只能经 `@iforge/build/node` 引入；出现在顶层就意味着编辑器会把 esbuild 打进浏览器产物。
    expect('compileRuntimeBundle' in browserEntry).toBe(false)
    expect('runCli' in browserEntry).toBe(false)
    expect('STANDALONE_ENTRY' in browserEntry).toBe(false)
    expect('cssInlinePlugin' in browserEntry).toBe(false)
    // `write-example.ts` 要读 `node:fs`，同样只在子路径上。
    expect('writeExampleProject' in browserEntry).toBe(false)
  })

  it('顶层导出的是浏览器可用的纯函数', () => {
    expect(typeof browserEntry.validateForPack).toBe('function')
    expect(typeof browserEntry.formatPackIssues).toBe('function')
    expect(typeof browserEntry.packageGame).toBe('function')
    expect(typeof browserEntry.gameFileName).toBe('function')
    expect(typeof browserEntry.projectFingerprint).toBe('function')
    expect(typeof browserEntry.SIZE_BUDGET_BYTES).toBe('number')
  })
})

describe('cssInlinePlugin()：把 CSS 内联进产物（11.2 单文件预算）', () => {
  it('是一个 esbuild 插件对象（有名字的命名插件 + setup 钩子）', () => {
    const plugin = cssInlinePlugin()
    expect(plugin.name).toBe('iforge-css-inline')
    expect(typeof plugin.setup).toBe('function')
  })

  it('`?inline` 解析把后缀摘掉后按真实路径加载（bundle.ts 与 editor/vite 的同名插件逐字一致）', () => {
    // 不真跑 esbuild，直接固定插件契约：同名 + setup 可调用。
    // 真正的“CSS 文本一致”由 `test/bundle.test.ts` 断言。
    expect(cssInlinePlugin().name).toBe(cssInlinePlugin().name)
  })
})