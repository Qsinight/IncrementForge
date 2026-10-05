/**
 * 存档往返（TECH_DESIGN 6.3 的读档顺序 ①~⑦、6.4 向前兼容、8.5 复位、D-18、D-37）。
 *
 * 6.3 的读档顺序（逐条断言）：
 * ① 用项目文件构建静态 `AttributeStore`；
 * ② 重建动态条目并校验 `pageId`（失效则降级为不显示、记 `E_PAGE_UNKNOWN`，**仍保留**）；
 * ③ 顶层字段逐项覆盖（缺失项回落项目文件值）；
 * ④ 按 `assignments` 回填列表/文本字段与 `description`；
 * ⑤ 恢复 `effectValues`；
 * ⑥ 合并未知字段进 `extra`；
 * ⑦ 全部表达式重新编译（失败时静态取项目文本、动态保留存档文本并记 `E_PARSE`）。
 *
 * 另外断言 6.3 的两条硬约束：**游戏内设置不进入存档**、**导航状态不落盘**（D-50）。
 */
import { describe, expect, it } from 'vitest'

import { NUM_MAX, Num } from '@iforge/num'
import { ENGINE_VERSION, NO_LIMIT, createExampleProject, saveFileSchema } from '@iforge/model'
import type { SaveFile } from '@iforge/model'

import { restoreSave, serializeSave } from '../src/save.js'
import { applyEffect } from '../src/upgrade-effect.js'
import { Harness, assignToPage, withPage } from './helpers/harness.js'

/** 存一份再读回来（新的 `GameState`，同一个项目文件）。 */
function roundTrip(h: Harness): { save: SaveFile; restored: Harness; result: ReturnType<typeof restoreSave> } {
  const save = serializeSave(h.state, { projectId: 'p1', projectName: '示例', engineVersion: ENGINE_VERSION })
  const restored = new Harness({ project: h.state.project })
  const result = restoreSave(restored.state, save, { project: h.state.project })
  return { save, restored, result }
}

/** 造一个动态条目（走真实的 `create()` 副作用链路）。 */
function createDynamic(h: Harness, spec: string): string {
  const upgrade = h.upgrade('u1')
  h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
  h.state.attrs.writeText(upgrade, 'effects[0].condition', 'true', '<test>')
  h.state.attrs.writeText(upgrade, 'effects[0].action', `create("generator", ${spec})`, '<test>')
  applyEffect(h.state, upgrade)
  h.state.commitEffects()
  return h.state.dynamicEntries()[0]!.id
}

describe('③ 顶层字段逐项覆盖', () => {
  it('资源 `amount`、`bought`/`owned`、`isClicker`、`perSecond`、`assignments` 全部往返', () => {
    const h = new Harness({ project: createExampleProject() })
    h.grant('r1', 1244.5)
    h.state.buy('g1')
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(7), '<test>')
    h.state.attrs.write('gen.g1.isClicker', 'true', '<test>')
    h.state.attrs.write('up.u1.perSecond', 'false', '<test>')
    h.state.attrs.writeText(h.generator('g1'), 'costs[0].amount', '10 * 1.15 ^ gen.g1.bought', '<test>')
    h.state.attrs.write('up.u1.effectValues[0]', Num.fromNumber(42), '<test>')
    h.state.attrs.write('gen.g1.description', '改过', '<test>')

    const { save, restored } = roundTrip(h)
    const r1 = restored.state.attrs.require('res.r1')
    const g1 = restored.state.attrs.require('gen.g1')

    // 1244.5 减去一次购买的 10。
    expect(restored.state.attrs.value(r1, 'amount').toNumber()).toBe(1234.5)
    expect(restored.state.attrs.value(g1, 'bought').toNumber()).toBe(1)
    expect(restored.state.attrs.value(g1, 'owned').toNumber()).toBe(7)
    // `isClicker` 有独立存档位（6.3 的“必须单独存档”条），不能只剩 `assignments`。
    expect(restored.state.judge.isClicker(g1)).toBe(true)
    expect(save.generators['g1']!.isClicker).toBe(true)
    expect(save.upgrades['u1']!.perSecond).toBe(false)
    // `description` 同时进顶层与 `assignments`（6.5.1 第 3 行 / PRD 补充 6）。
    expect(restored.state.attrs.textOr(g1, 'description')).toBe('改过')
    expect(save.generators['g1']!.description).toBe('改过')
    expect(g1.assignments.get('gen.g1.description')?.value).toBe('改过')
  })

  it('④ `assignments` 回填表达式文本字段，值与来源 `expr` 一起保留（6.3）', () => {
    const h = new Harness({ project: createExampleProject() })
    h.runTicks(7)
    h.state.attrs.write('gen.g1.costs[0].amount', '10 * 1.15 ^ gen.g1.bought', 'gen.g1.bought >= 7')
    const { save, restored } = roundTrip(h)
    expect(save.generators['g1']!.assignments['gen.g1.costs[0].amount']?.expr).toBe('gen.g1.bought >= 7')
    expect(restored.state.attrs.textOr(restored.state.attrs.require('gen.g1'), 'costs[0].amount')).toBe('10 * 1.15 ^ gen.g1.bought')
  })

  it('⑤ `effectValues` 往返；它既进顶层也进 `assignments`（6.3「赋值也进」）', () => {
    const h = new Harness({ project: createExampleProject() })
    h.state.attrs.write('up.u1.effectValues[0]', Num.fromNumber(42), '<test>')
    const { save, restored } = roundTrip(h)
    expect(save.upgrades['u1']!.effectValues['0']).toBe('42')
    // 6.3 把 `effectValues[i]` 列为“赋值类权威字段”：顶层存当前值、`assignments` 记留痕。
    expect(save.upgrades['u1']!.assignments['up.u1.effectValues[0]']?.value).toBe('42')
    // 顶层优先于 `assignments`：读档后仍是 42。
    expect(restored.state.attrs.value(restored.state.attrs.require('up.u1'), 'effectValues[0]').toNumber()).toBe(42)
  })

  it('缺失的顶层项回落项目文件值（③ 的括号条款）', () => {
    const h = new Harness({ project: createExampleProject() })
    const save = serializeSave(h.state, { projectId: 'p1', projectName: '示例', engineVersion: ENGINE_VERSION })
    const projectCap = h.state.attrs.capOf(h.generator('g1')).toString()
    // 手工删掉两个字段，模拟“旧版本存档缺项”。
    delete (save.generators['g1'] as Partial<(typeof save.generators)[string]>).max
    delete (save.generators['g2'] as Partial<(typeof save.generators)[string]>).bought
    const restored = new Harness({ project: h.state.project })
    restoreSave(restored.state, save, { project: h.state.project })
    // `g1.max` 回到项目文件里的值。
    expect(restored.state.attrs.capOf(restored.state.attrs.require('gen.g1')).toString()).toBe(projectCap)
    // `g2.bought` 回到 0（项目文件没有 `bought`，按 8.5 初始化表置 0）。
    expect(restored.state.attrs.value(restored.state.attrs.require('gen.g2'), 'bought').toNumber()).toBe(0)
  })

  it('`res.<id>.owned` 别名不产生第二处存档位（D-37、6.3）', () => {
    const h = new Harness({ project: createExampleProject() })
    h.state.attrs.write('res.r1.owned', Num.fromNumber(77), '<test>')
    const { save, restored } = roundTrip(h)
    expect(save.resources['r1']).not.toHaveProperty('owned')
    expect(save.resources['r1']!.amount).toBe('77')
    expect(restored.resource('r1').toNumber()).toBe(77)
  })

  it(`缺省的 \`max\` 存成 ${NO_LIMIT} 而不是具体数字（D-46）`, () => {
    const h = new Harness({ project: createExampleProject() })
    h.state.attrs.writeText(h.generator('g2'), 'max', 'Infinity', '<test>')
    const { save, restored } = roundTrip(h)
    expect(save.generators['g2']!.max).toBe(NO_LIMIT)
    expect(restored.state.attrs.capOf(restored.state.attrs.require('gen.g2')).isFinite()).toBe(false)
  })

  it('`max = 0` 存原值；4.4 第 4 条的兜底只在**读**时生效', () => {
    const h = new Harness({ project: createExampleProject() })
    h.state.attrs.writeText(h.generator('g1'), 'max', '0', '<test>')
    const { save, restored } = roundTrip(h)
    expect(save.generators['g1']!.max).toBe('0')
    expect(restored.state.attrs.capOf(restored.state.attrs.require('gen.g1')).toNumber()).toBe(1)
    expect(restored.state.diagnosticCount('E_CAP_NON_POSITIVE')).toBeGreaterThan(0)
  })

  it('`NUM_MAX` 按十进制字符串往返（6.3 的“数值一律 `Decimal.toString()`”）', () => {
    const h = new Harness({ project: createExampleProject() })
    h.state.attrs.writeText(h.state.attrs.require('res.r1'), 'max', 'Infinity', '<test>')
    h.state.attrs.writeQuantity(h.state.attrs.require('res.r1'), 'amount', NUM_MAX, 'res.r1.amount', '<test>')
    const { save, restored } = roundTrip(h)
    expect(save.resources['r1']!.amount).toBe(NUM_MAX.toString())
    expect(restored.resource('r1').toString()).toBe(NUM_MAX.toString())
  })
})

describe('② 动态条目重建与孤儿 `pageId`', () => {
  it('动态条目按 `dynamic` 重建，`costs`/`produces` 列表结构也恢复', () => {
    const h = new Harness({ project: createExampleProject() })
    const id = createDynamic(h, '{ id: "gMine", name: "碎片", page: "p1", costs: [{ materialId: "r1", amount: "5" }] }')
    const { save, restored } = roundTrip(h)
    expect(save.dynamic.generators.map((d) => d.id)).toEqual([id])
    const state = restored.state.attrs.require(`gen.${id}`)
    expect(restored.state.dynamicCount()).toBe(1)
    expect(restored.state.attrs.textOr(state, 'costs[0].amount')).toBe('5')
    expect(restored.state.pageOfEntry(state)).toBe('p1')
    // 动态条目的进度也在顶层（③ 的括号条款）。
    expect(save.generators[id]).toBeDefined()
  })

  it('`pageId` 失效时列入 `orphans`：降级为不显示 + `E_PAGE_UNKNOWN`，但条目仍保留', () => {
    const h = new Harness({ project: createExampleProject() })
    const id = createDynamic(h, '{ id: "gMine", name: "碎片", page: "p1" }')
    const save = serializeSave(h.state, { projectId: 'p1', projectName: '示例', engineVersion: ENGINE_VERSION })
    save.dynamic.generators[0]!.pageId = 'p404'

    const restored = new Harness({ project: h.state.project })
    const result = restoreSave(restored.state, save, { project: h.state.project })
    expect(result.orphans).toEqual([id])
    expect(restored.state.dynamicCount()).toBe(1)
    const state = restored.state.attrs.require(`gen.${id}`)
    expect(restored.state.judge.isVisible(state)).toBe(false)
    expect(restored.state.judge.isDisabled(state)).toBe(true)
    expect(restored.state.diagnosticCount('E_PAGE_UNKNOWN')).toBeGreaterThan(0)
    // 仍可被 `destroy()` 丢弃（唯一的移除路径）。
    expect(restored.state.discardDynamic(id)).toBe(true)
  })

  it('`dynamic[].id` 与静态条目冲突时报 `E_SAVE_FIELD_CONFLICT`，静态条目胜出', () => {
    const h = new Harness({ project: createExampleProject() })
    h.grant('r1', 10)
    const save = serializeSave(h.state, { projectId: 'p1', projectName: '示例', engineVersion: ENGINE_VERSION })
    const template = createExampleProject().generators[0]!
    save.dynamic.generators.push({
      ...template,
      kind: 'generator',
      id: 'g1',
      pageId: 'p1',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const restored = new Harness({ project: h.state.project })
    const result = restoreSave(restored.state, save, { project: h.state.project })
    expect(result.conflicts).toBe(1)
    expect(restored.state.diagnosticCount('E_SAVE_FIELD_CONFLICT')).toBe(1)
    expect(restored.state.dynamicCount()).toBe(0)
    // 静态条目仍然是作者写的那一个（没有被存档里的动态定义顶掉）。
    expect(restored.state.attrs.require('gen.g1').def.name).toBe('矿机')
    expect(restored.state.attrs.require('gen.g1').def.description).toBe('自动产出矿石')
  })
})

describe('⑥ / ⑦ 未知字段与表达式重编译', () => {
  it('顶层未知字段进 `extra`，不丢数据也不报错（6.4 向前兼容）', () => {
    const h = new Harness({ project: createExampleProject() })
    const save = serializeSave(h.state, { projectId: 'p1', projectName: '示例', engineVersion: ENGINE_VERSION })
    const raw = JSON.parse(JSON.stringify(save)) as Record<string, unknown>
    raw['futureFeature'] = { level: 7 }
    ;(raw['resources'] as Record<string, Record<string, unknown>>)['r1']!['futureFlag'] = 'on'
    const restored = new Harness({ project: h.state.project })
    const result = restoreSave(restored.state, raw as SaveFile, { project: h.state.project })
    expect(result.extra['futureFeature']).toEqual({ level: 7 })
    // 条目级的未知字段由 Schema 的 `.passthrough()` 原样保留在存档里（6.4），
    // 不进 `extra` —— `extra` 只收集**顶层**新字段（条目级字段由各自 Schema 承载）。
    expect(saveFileSchema.safeParse(raw).success).toBe(true)
    const reparsed = saveFileSchema.parse(raw) as unknown as { resources: Record<string, Record<string, unknown>> }
    expect(reparsed.resources['r1']!['futureFlag']).toBe('on')
  })

  it('⑦ 静态条目的表达式文本编译失败 -> 回落项目文件文本（存档里是旧的合法文本）', () => {
    const h = new Harness({ project: createExampleProject() })
    const save = serializeSave(h.state, { projectId: 'p1', projectName: '示例', engineVersion: ENGINE_VERSION })
    // 手改成一个非法表达式：模拟“存档被外部改坏”。
    save.generators['g1']!.assignments['gen.g1.costs[0].amount'] = {
      value: '10 *',
      expr: 'gen.g1.bought >= 1',
      tick: 1,
    }
    const restored = new Harness({ project: h.state.project })
    restoreSave(restored.state, save, { project: h.state.project })
    // 静态条目 -> 项目文本 `10 * 1.15 ^ gen.g1.bought`。
    expect(restored.state.attrs.textOr(restored.state.attrs.require('gen.g1'), 'costs[0].amount')).toBe('10 * 1.15 ^ gen.g1.bought')
  })

  it('⑦ 动态条目的表达式文本编译失败 -> 保留存档文本并记 `E_PARSE`（进度不能丢）', () => {
    const h = new Harness({ project: createExampleProject() })
    const id = createDynamic(h, '{ id: "gMine", name: "碎片", page: "p1", costs: [{ materialId: "r1", amount: "5" }] }')
    const save = serializeSave(h.state, { projectId: 'p1', projectName: '示例', engineVersion: ENGINE_VERSION })
    save.generators[id]!.assignments[`gen.${id}.costs[0].amount`] = { value: '1 +', expr: 'true', tick: 1 }

    const restored = new Harness({ project: h.state.project })
    restoreSave(restored.state, save, { project: h.state.project })
    // 动态条目的当前值只存在于存档，丢掉就等于让玩家进度归零，因此保留并报 `E_PARSE`。
    expect(restored.state.attrs.textOr(restored.state.attrs.require(`gen.${id}`), 'costs[0].amount')).toBe('1 +')
    expect(restored.state.diagnosticCount('E_PARSE')).toBeGreaterThan(0)
  })

  it('`saveFileSchema` 拒绝结构错误的存档', () => {
    const h = new Harness({ project: createExampleProject() })
    const save = serializeSave(h.state, { projectId: 'p1', projectName: '示例', engineVersion: ENGINE_VERSION })
    const raw = JSON.parse(JSON.stringify(save)) as Record<string, unknown>
    raw['resources'] = '不是对象'
    expect(saveFileSchema.safeParse(raw).success).toBe(false)
  })

  it('`__proto__` 键被 Schema 拦截（13 第 6 条）', () => {
    const h = new Harness({ project: createExampleProject() })
    const save = serializeSave(h.state, { projectId: 'p1', projectName: '示例', engineVersion: ENGINE_VERSION })
    // 必须用 `JSON.parse` 造出**自有**的 `__proto__` 键：直接赋值会写到原型上，
    // 那样测的就不是原型污染路径了。
    const raw = JSON.parse(`{"__proto__": {"polluted": true}, ${JSON.stringify(save).slice(1)}`) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(raw, '__proto__')).toBe(true)
    expect(saveFileSchema.safeParse(raw).success).toBe(false)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('6.3 的两条硬约束', () => {
  it('游戏内设置不进入存档（按 D-22 单独持久化）', () => {
    const h = new Harness({ project: createExampleProject() })
    const save = serializeSave(h.state, { projectId: 'p1', projectName: '示例', engineVersion: ENGINE_VERSION })
    for (const key of ['settings', 'numberFormat', 'tickRate', 'speed']) {
      expect(save, key).not.toHaveProperty(key)
    }
  })

  it('导航状态不落盘（D-50、14.3 规则 5）', () => {
    const project = assignToPage(createExampleProject(), 'p1', ['r1', 'g1', 'u1'])
    const withSecond = withPage(
      { id: 'p2', name: '第二页', entries: [{ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } }] },
      project,
    )
    const h = new Harness({ project: withSecond })
    h.state.nav('p2')
    const save = serializeSave(h.state, { projectId: 'p1', projectName: '示例', engineVersion: ENGINE_VERSION })
    // Schema 里根本没有这个字段：导航是 UI 会话状态，换存档位置就恢复到了别的页。
    expect(save).not.toHaveProperty('currentPageId')
    expect(saveFileSchema.safeParse(JSON.parse(JSON.stringify(save))).success).toBe(true)

    // 读档后回到项目定义的初始页（而不是存档里的上一页）。
    const restored = new Harness({ project: withSecond })
    restoreSave(restored.state, save, { project: withSecond })
    expect(restored.state.initialPageId()).toBe('p1')
  })
})

describe('8.5 复位与重新开始（D-18）', () => {
  it('`reset()` 丢弃 `assignments`/`effectValues`/`dynamic` 并回到项目默认值', () => {
    const h = new Harness({ project: createExampleProject() })
    h.grant('r1', 5000)
    h.state.buy('g1')
    h.state.attrs.write('gen.g1.description', '改过', '<test>')
    h.state.attrs.write('up.u1.effectValues[0]', Num.fromNumber(42), '<test>')
    createDynamic(h, '{ id: "gMine", name: "碎片", page: "p1" }')
    expect(h.state.dynamicCount()).toBe(1)

    h.state.reset()
    expect(h.count('generator', 'g1', 'owned').toNumber()).toBe(0)
    expect(h.resource('r1').toNumber()).toBe(0)
    expect(h.state.attrs.textOr(h.generator('g1'), 'description')).toBe('自动产出矿石')
    expect(h.state.attrs.value(h.upgrade('u1'), 'effectValues[0]').toNumber()).toBe(0)
    expect(h.generator('g1').assignments.size).toBe(0)
    expect(h.state.dynamicCount()).toBe(0)
    expect(h.state.attrs.find('gen.gMine')).toBeUndefined()
  })

  it('复位后 `tick` / `gameTime` 归零', () => {
    const h = new Harness({ project: createExampleProject() })
    h.runSeconds(3)
    expect(h.state.gameTime.toNumber()).toBeGreaterThan(0)
    h.state.reset()
    expect(h.state.stats.tick).toBe(0)
    expect(h.state.gameTime.toNumber()).toBe(0)
  })

  it('`loadProject()` 换项目：旧项目的条目与状态都不残留（D-18）', () => {
    const h = new Harness({ project: createExampleProject() })
    h.grant('r1', 5000)
    h.state.buy('g1')
    h.state.loadProject(createDefaultLike())
    expect(h.state.dynamicCount()).toBe(0)
    expect(h.resource('r1').toNumber()).toBe(0)
    // 新项目里没有 g1：条目彻底消失，读取直接抛错而不是返回上一局的值。
    expect(h.state.attrs.find('gen.g1')).toBeUndefined()
    expect(() => h.generator('g1')).toThrowError(/g1/)
  })
})

/** 一个更小的项目文件：只有资源 `r1` 与页面 `p1`。 */
function createDefaultLike(): ReturnType<typeof createExampleProject> {
  const project = createExampleProject()
  project.generators = []
  project.upgrades = []
  project.pages = project.pages.map((page) => ({ ...page, entries: [{ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } }] }))
  return project
}
