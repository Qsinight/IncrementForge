/**
 * 打包编排（TECH_DESIGN 11.1 的管线、11.2 的体积预算）。
 *
 * `runtimeSource` 用**假的**短脚本来测编排——这里要断言的是管线的**顺序与失败语义**，
 * 不是运行时的字节。真实产物由 `bundle.test.ts`（node 环境、真的跑 esbuild）与
 * `e2e/` 的单文件冒烟覆盖。
 */
import { describe, expect, it } from 'vitest'

import { createDefaultProject, createExampleProject, createGenerator, createResource, ENGINE_VERSION } from '@iforge/model'
import type { GeneratorDef, ResourceDef } from '@iforge/model'

import { gameFileName, projectFingerprint } from '../src/fingerprint.js'
import { packageGame, SIZE_BUDGET_BYTES } from '../src/package-game.js'
import type { PackageResult } from '../src/package-game.js'

/** `createDefaultProject()` 的模板里没有任何条目，上面的用例需要现造两个被引用的条目。 */
function createResourceStub(id: string): ResourceDef {
  return createResource({ id, order: 1 })
}

function createGeneratorStub(id: string): GeneratorDef {
  return createGenerator({ id, order: 1 })
}

const RUNTIME = 'window.__IFORGE_RUNTIME__=1;'

function ok(result: ReturnType<typeof packageGame>): PackageResult {
  if (!result.ok) throw new Error(`打包应当成功，却得到：${JSON.stringify(result.issues)}`)
  return result
}

describe('11.1：成功路径', () => {
  it('产出单文件 HTML，文件名按项目名', () => {
    const result = ok(packageGame({ project: createExampleProject(), runtimeSource: RUNTIME }))
    expect(result.fileName).toBe(gameFileName(createExampleProject()))
    expect(result.html.startsWith('<!doctype html>')).toBe(true)
  })

  it('meta 含引擎版本 / 打包时间 / 指纹（11.1 末条）', () => {
    const project = createExampleProject()
    const result = ok(packageGame({ project, runtimeSource: RUNTIME, builtAt: '2026-02-03T04:05:06.000Z' }))
    expect(result.meta.engineVersion).toBe(ENGINE_VERSION)
    expect(result.meta.builtAt).toBe('2026-02-03T04:05:06.000Z')
    expect(result.meta.fingerprint).toBe(projectFingerprint(project))
    expect(result.meta.slotId).toBe('main')
  })

  it('字节数等于 HTML 的 UTF-8 长度；gzip 可用时非 0（11.2）', () => {
    const result = ok(packageGame({ project: createDefaultProject(), runtimeSource: RUNTIME }))
    expect(result.bytes).toBe(new TextEncoder().encode(result.html).length)
    // `zlib` 在 node 环境可用；不可用时约定为 0，测试据此放宽。
    expect(result.gzipBytes).toBeGreaterThanOrEqual(0)
    if (result.gzipBytes > 0) expect(result.gzipBytes).toBeLessThan(result.bytes)
  })

  it('小项目在预算内（overBudget = false）', () => {
    expect(ok(packageGame({ project: createDefaultProject(), runtimeSource: RUNTIME })).overBudget).toBe(false)
  })

  it('超过 1.5MB 时**照常打包**并置 overBudget（11.2 是工程目标，不是正确性约束）', () => {
    const big = `/*${'x'.repeat(Math.ceil(SIZE_BUDGET_BYTES) + 1024)}*/`
    const result = ok(packageGame({ project: createDefaultProject(), runtimeSource: big }))
    expect(result.overBudget).toBe(true)
    expect(result.bytes).toBeGreaterThan(SIZE_BUDGET_BYTES)
  })

  it('内置页面/条目主题不产生额外 CSS（只有自定义主题才内联）', () => {
    const html = ok(packageGame({ project: createExampleProject(), runtimeSource: RUNTIME })).html
    // 只统计 `<style>` 块：项目 JSON 里必然还有页面/条目的主题数据，那是**数据**。
    // 内置主题是 `ui-kit` 里写死的令牌集，产物里不需要（也不应该）再预置一份。
    const styleText = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? '').join('\n')
    // 基础样式的**引用**（`var(--iforge-page-bg, …)`）是必须的：它让画布跟随页面主题。
    // 这里断言的是没有**声明**（`:root{--iforge-page-bg: …}`）——那才是“预置主题”。
    expect(styleText).toContain('var(--iforge-page-bg')
    expect(styleText).not.toMatch(/--iforge-(page|entry|bg)-[a-z]+\s*:\s*#/)
  })

  it('基础样式里的底色是 CSS 变量而不是写死的暗色（否则浅色主题仍有一圈黑边）', () => {
    const html = ok(packageGame({ project: createDefaultProject(), runtimeSource: RUNTIME })).html
    // 写死 `background:#14161a` 时，html 有背景 → body 的背景不再向画布传播，
    // 于是任何超出 body 盒子的区域都是暗色（17.3 的模板曾是这个写法）。
    expect(html).not.toMatch(/html,body\{[^}]*background:#/)
    expect(html).toMatch(/html,body\{[^}]*background:var\(--iforge-page-bg,#14161a\)/)
  })

  it('自定义主题被内联进 <style>（11.1 第 1 步）', () => {
    const project = createDefaultProject()
    project.pages[0]!.theme = { kind: 'data', value: ':root{--iforge-page-bg:#123456}' }
    const html = ok(packageGame({ project, runtimeSource: RUNTIME })).html
    expect(html).toContain('--iforge-page-bg:#123456')
  })

  it('同一份自定义主题被多处引用只在 <style> 里出现一次（不白白撑大产物）', () => {
    const project = createDefaultProject()
    const css = ':root{--iforge-page-bg:#123456}'
    project.pages[0]!.theme = { kind: 'data', value: css }
    project.pages[0]!.entries.push(
      { id: 'r1', order: 1, theme: { kind: 'data', value: css } },
      { id: 'g1', order: 2, theme: { kind: 'data', value: css } },
    )
    project.resources.push({ ...createResourceStub('r1') })
    project.generators.push({ ...createGeneratorStub('g1') })
    const html = ok(packageGame({ project, runtimeSource: RUNTIME })).html
    // 只统计 `<style>` 块：项目 JSON 里必然还有 3 份（页面 + 2 个条目），
    // 那是**数据**而不是样式，预置它们正是为了让首帧不闪。
    // 模板有两个 style 块（基础布局 + 自定义主题），因此要**全部**匹配后拼接。
    const styleText = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? '').join('\n')
    expect(styleText).toContain('--iforge-page-bg:#123456')
    expect(styleText.split('--iforge-page-bg:#123456')).toHaveLength(2)
  })
})

describe('11.1：失败路径一律返回问题清单且不抛错', () => {
  it('校验不通过时 ok=false 并给出问题位置', () => {
    const project = createDefaultProject()
    project.settings.tickRate = 0
    const result = packageGame({ project, runtimeSource: RUNTIME })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('不应成功')
    expect(result.issues.some((issue) => issue.where === 'settings.tickRate')).toBe(true)
  })

  it('runtimeSource 为空时明确报错（而不是产出一个打不开的 HTML）', () => {
    const result = packageGame({ project: createDefaultProject(), runtimeSource: '   ' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('不应成功')
    expect(result.issues[0]?.message).toContain('运行时产物')
  })

  it('`skipValidation` 仅用于测试：跳过校验后能打出产物（11.1 的门禁在真实调用里始终生效）', () => {
    const project = createDefaultProject()
    project.settings.tickRate = 0
    expect(packageGame({ project, runtimeSource: RUNTIME }).ok).toBe(false)
    expect(packageGame({ project, runtimeSource: RUNTIME, skipValidation: true }).ok).toBe(true)
  })
})

describe('11.1：产物内容自洽（不依赖运行时也能查）', () => {
  it('产物的指纹与 meta 一致，且与项目内容绑定', () => {
    const project = createExampleProject()
    const before = ok(packageGame({ project, runtimeSource: RUNTIME }))
    project.resources[0]!.name = '改了'
    const after = ok(packageGame({ project, runtimeSource: RUNTIME }))
    expect(before.meta.fingerprint).not.toBe(after.meta.fingerprint)
    expect(after.html).toContain(after.meta.fingerprint)
  })

  it('产物的 projectId 与指纹派生值一致（存档键）', () => {
    const result = ok(packageGame({ project: createExampleProject(), runtimeSource: RUNTIME }))
    expect(result.meta.projectId).toBe(`pkg-${result.meta.fingerprint.slice(0, 12)}`)
  })

  it('运行时代码只出现一次（11.2：单文件、无外部依赖）', () => {
    const html = ok(packageGame({ project: createDefaultProject(), runtimeSource: RUNTIME })).html
    expect(html.split(RUNTIME)).toHaveLength(2)
    // 没有外部资源引用：没有 `<link rel=stylesheet>`、没有 `<script src=`。
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i)
  })
})
