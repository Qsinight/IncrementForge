/**
 * 动态条目（TECH_DESIGN 8.7 的「创建动态条目」、D-32、D-34、D-44、D-45、R-16）。
 *
 * 覆盖 14.2 列出的用例：上限 2000、孤儿 `pageId`、`E_CREATE_ID_CONFLICT`、幂等守卫。
 */
import { describe, expect, it } from 'vitest'

import { Num } from '@iforge/num'
import { DYNAMIC_LIMIT } from '../src/dynamic-registry.js'
import { applyEffect } from '../src/upgrade-effect.js'
import { createExampleProject } from '@iforge/model'
import { Harness, assignToPage, createDefaultProject } from './helpers/harness.js'

/** 一个只有资源 r1 + 页面 p1 的项目，供 `create()` 落地。 */
function base(): Harness {
  const project = createDefaultProject()
  project.resources = [
    {
      kind: 'resource',
      id: 'r1',
      order: 1,
      name: '矿石',
      description: '',
      icon: { kind: 'builtin', value: 'gem' },
      initial: '0',
      max: 'Infinity',
      visible: true,
    },
  ]
  return new Harness({ project })
}

/** 通过升级效果触发一次 `create()`（走真实的副作用链路）。 */
/**
 * 通过升级效果触发一次 `create()`（走真实的副作用链路）。
 *
 * 直接 `applyEffect` + `commitEffects()`，而不是 `stepTick`：示例项目的 `u1.perSecond`
 * 为真，效果只在**跨过整秒**时才触发（8.3 第 2 步），跑一个 tick 不会结算它。
 */
function createViaUpgrade(h: Harness, spec: string): void {
  const upgrade = h.upgrade('u1')
  h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
  h.state.attrs.writeText(upgrade, 'effects[0].condition', 'true', '<test>')
  h.state.attrs.writeText(upgrade, 'effects[0].action', `create("generator", ${spec})`, '<test>')
  applyEffect(h.state, upgrade)
  h.state.commitEffects()
}

describe('create() 的落地与 id 生成（D-44、D-45）', () => {
  it('缺省 id 生成 `dyn_<序号>`，落进指定页面', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ name: "碎片", page: "p1" }')
    expect(h.state.dynamicCount()).toBe(1)
    const entry = h.state.dynamicEntries()[0]!
    expect(entry.id.startsWith('dyn_')).toBe(true)
    expect(entry.kind).toBe('generator')
    expect(entry.pageId).toBe('p1')
    // 动态条目立刻可被读/可被表达式引用。
    expect(h.state.attrs.find(`gen.${entry.id}`)).toBeDefined()
  })

  it('连续创建的序号递增，互不冲突', () => {
    const h = new Harness({ project: createExampleProject() })
    for (let i = 0; i < 3; i += 1) {
      createViaUpgrade(h, '{ name: "碎片", page: "p1" }')
    }
    expect(h.state.dynamicCount()).toBe(3)
    expect(new Set(h.state.dynamicEntries().map((e) => e.id)).size).toBe(3)
  })

  it('显式 id 必须以 `g`/`u` 开头且不与任何条目冲突（D-44、D-45）', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ id: "gMine", name: "x", page: "p1" }')
    expect(h.state.dynamicCount()).toBe(1)
    expect(h.state.dynamicEntries()[0]!.id).toBe('gMine')

    // 与静态条目冲突 -> 整体拒绝。
    const h2 = new Harness({ project: createExampleProject() })
    createViaUpgrade(h2, '{ id: "g1", name: "x", page: "p1" }')
    expect(h2.state.dynamicCount()).toBe(0)
    expect(h2.state.diagnosticCount('E_CREATE_ID_CONFLICT')).toBeGreaterThan(0)
  })

  it('`spec.id` 不得占用保留前缀 `dyn`（D-45）', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ id: "dyn_x1", name: "x", page: "p1" }')
    expect(h.state.dynamicCount()).toBe(0)
    expect(h.state.diagnosticCount('E_CREATE_ID_CONFLICT')).toBeGreaterThan(0)
  })

  it('`create()` 的幂等守卫：重复求值同一 id 第二次报冲突且不新建（8.7）', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ id: "gMine", name: "x", page: "p1" }')
    expect(h.state.dynamicCount()).toBe(1)
    createViaUpgrade(h, '{ id: "gMine", name: "x", page: "p1" }')
    // 整体拒绝，`has(kind, id)` 仍为真——作者必须自己在 `condition` 里加 `!has(...)`。
    expect(h.state.dynamicCount()).toBe(1)
    expect(h.state.diagnosticCount('E_CREATE_ID_CONFLICT')).toBe(1)
  })
})

describe('create() 的校验：全部通过才落地（8.7）', () => {
  it('`page` 缺失报 `E_CREATE_NO_PAGE`，且不创建', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ name: "碎片" }')
    expect(h.state.dynamicCount()).toBe(0)
    expect(h.state.diagnosticCount('E_CREATE_NO_PAGE')).toBeGreaterThan(0)
  })

  it('`page` 指向不存在的页面报 `E_PAGE_UNKNOWN`，且不创建', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ name: "碎片", page: "p404" }')
    expect(h.state.dynamicCount()).toBe(0)
    expect(h.state.diagnosticCount('E_PAGE_UNKNOWN')).toBeGreaterThan(0)
  })

  it('非法字段报 `E_CREATE_FIELD_INVALID`，且不创建（无部分创建）', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ name: "碎片", page: "p1", kind: "generator" }')
    expect(h.state.dynamicCount()).toBe(0)
    expect(h.state.diagnosticCount('E_CREATE_FIELD_INVALID')).toBeGreaterThan(0)
  })

  it('`costs[].materialId` 悬空报 `E_DANGLING_REF`，且不创建', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ name: "碎片", page: "p1", costs: [{ materialId: "r404", amount: "1" }] }')
    expect(h.state.dynamicCount()).toBe(0)
    expect(h.state.diagnosticCount('E_DANGLING_REF')).toBeGreaterThan(0)
  })

  it('`costs[].amount` 是表达式文本：语法错误报 `E_PARSE`，且不创建', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ name: "碎片", page: "p1", costs: [{ materialId: "r1", amount: "1 +" }] }')
    expect(h.state.dynamicCount()).toBe(0)
    expect(h.state.diagnosticCount('E_PARSE')).toBeGreaterThan(0)
  })

  it('合法引用时创建成功；`create()` 本身**不扣费**（8.7：costs 是新条目自己的价格）', () => {
    const h = new Harness({ project: createExampleProject() })
    h.grant('r1', 100)
    createViaUpgrade(h, '{ name: "碎片", page: "p1", costs: [{ materialId: "r1", amount: "10 * 1.15 ^ gen.g1.bought" }] }')
    expect(h.state.dynamicCount()).toBe(1)
    // `create()` 只登记条目：`costs` 约束的是**它自己**之后的自动购买/批量购买，
    // 创建动作不结算任何费用（8.7 的「返回值」与「缺省」两行都只谈登记与字段）。
    expect(h.resource('r1').toNumber()).toBe(100)
    const created = h.state.dynamicEntries()[0]!
    const state = h.state.attrs.require(`gen.${created.id}`)
    // 价格成长表达式原样保留。
    expect(h.state.attrs.textOr(state, 'costs[0].amount')).toBe('10 * 1.15 ^ gen.g1.bought')
    // 缺省字段按 8.7 的「缺省」行取默认工厂值。
    expect(h.state.attrs.capOf(state).isFinite()).toBe(false)
    expect(h.state.attrs.fieldValue(state, 'buyAmount').toNumber()).toBe(1)
    expect(h.state.attrs.textOr(state, 'buyDelay')).toBe('1')
  })
})

describe('动态条目上限（D-32、R-16）', () => {
  it(`上限常量为 ${DYNAMIC_LIMIT}`, () => {
    expect(DYNAMIC_LIMIT).toBe(2000)
  })

  it('达到上限后 `create()` 整体拒绝（`E_DYNAMIC_LIMIT`，不做部分创建）', () => {
    const h = base()
    // 直接灌到上限：2000 次真实创建会拖慢测试，而上限判定与创建路径无关。
    const entries = h.state.dynamic as unknown as { entries: Map<string, unknown> }
    for (let i = 0; i < DYNAMIC_LIMIT; i += 1) {
      entries.entries.set(`gen.dyn_${i}`, {
        state: h.state.attrs.listByKind('generator')[0],
        kind: 'generator',
        id: `dyn_${i}`,
        pageId: 'p1',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    }
    expect(() => h.state.dynamic.create('generator', { page: 'p1' })).toThrowError(/2000/)
    expect(h.state.dynamicCount()).toBe(DYNAMIC_LIMIT)
  })
})

describe('孤儿动态条目（8.7：读档时 `pageId` 失效）', () => {
  it('`orphans()` 列出 `pageId` 已不存在的动态条目', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ name: "碎片", page: "p1" }')
    createViaUpgrade(h, '{ name: "碎片", page: "p1" }')
    expect(h.state.dynamic.orphans()).toHaveLength(0)
    // 把一个条目挪到不存在的页面（模拟“项目文件改了、存档里还留着旧 pageId”）。
    const entry = h.state.dynamicEntries()[0]!
    h.state.dynamic.restore({ ...entry, pageId: 'p404' })
    expect(h.state.dynamic.orphans()).toHaveLength(1)
    expect(h.state.dynamic.orphans()[0]!.id).toBe(entry.id)
  })

  it('孤儿条目：`pageId` 原样保留，但按 `visible=false` / `disabled=true` 处理并记 `E_PAGE_UNKNOWN`（8.7）', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ id: "gMine", name: "碎片", page: "p1", produces: [{ materialId: "r1", amount: "1" }] }')
    const entry = h.state.dynamicEntries()[0]!
    h.state.dynamic.restore({ ...entry, pageId: 'p404' })
    const state = h.state.attrs.require('gen.gMine')

    // `pageId` 原样保留（删档会让玩家在恢复页面后丢掉进度）。
    expect(h.state.pageOfEntry(state)).toBe('p404')
    // 不渲染、不参与结算。
    expect(h.state.judge.isVisible(state)).toBe(false)
    expect(h.state.judge.isDisabled(state)).toBe(true)
    expect(h.state.diagnosticCount('E_PAGE_UNKNOWN')).toBeGreaterThan(0)
    // 状态字段仍可读写，但不产生任何效果。
    expect(h.state.attrs.write('gen.gMine.owned', Num.fromNumber(100), '<test>')).toBe(true)
    const before = h.resource('r1')
    h.runSeconds(1)
    expect(h.resource('r1').toString()).toBe(before.toString())
  })

  it('`pageId` 恢复存在后条目自动重新出现（8.7「自动恢复」）', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ id: "gMine", name: "碎片", page: "p1" }')
    const entry = h.state.dynamicEntries()[0]!
    const state = h.state.attrs.require('gen.gMine')
    h.state.dynamic.restore({ ...entry, pageId: 'p404' })
    expect(h.state.judge.isVisible(state)).toBe(false)
    // 页面“改回同名 id” -> 立刻恢复，无需任何额外操作。
    h.state.dynamic.restore({ ...entry, pageId: 'p1' })
    expect(h.state.judge.isVisible(state)).toBe(true)
  })
})

describe('destroy() 与幂等守卫（8.7、5.6）', () => {
  it('`destroy()` 移除条目状态，`discardDynamic` 返回是否存在', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ name: "碎片", page: "p1" }')
    const id = h.state.dynamicEntries()[0]!.id
    expect(h.state.attrs.find(`gen.${id}`)).toBeDefined()
    expect(h.state.discardDynamic(id)).toBe(true)
    expect(h.state.attrs.find(`gen.${id}`)).toBeUndefined()
    // 幂等：重复销毁返回 false，不抛错。
    expect(h.state.discardDynamic(id)).toBe(false)
  })

  it('`destroy()` 不存在的 id 同样幂等（返回 false）', () => {
    const h = new Harness({ project: createExampleProject() })
    expect(h.state.discardDynamic('dyn_999')).toBe(false)
  })

  it('`destroy` 先于 `create` 提交：同一 tick 内销毁再创建同名 id 会成功（5.6）', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ id: "gMine", name: "碎片", page: "p1" }')
    expect(h.state.dynamicCount()).toBe(1)
    // 一个 tick 里先销毁、再用同一个 id 创建。
    const upgrade = h.upgrade('u1')
    h.state.attrs.writeText(upgrade, 'effects[0].condition', 'true', '<test>')
    h.state.attrs.writeText(
      upgrade,
      'effects[0].action',
      'destroy("gMine"); create("generator", { id: "gMine", name: "再来一个", page: "p1" })',
      '<test>',
    )
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    applyEffect(h.state, upgrade)
    h.state.commitEffects()
    expect(h.state.dynamicCount()).toBe(1)
    expect(h.state.dynamic.find('generator', 'gMine')).toBeDefined()
  })
})

describe('动态条目不写项目文件（8.7、6.2、6.3）', () => {
  it('动态条目只进存档的 `dynamic`，不进项目条目列表（6.3）', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ id: "gMine", name: "碎片", page: "p1" }')
    const project = h.state.project
    const staticIds = [...project.resources, ...project.generators, ...project.upgrades, ...project.pages].map((entry) => entry.id)
    expect(staticIds).not.toContain('gMine')
    // 但它在运行时**是**一等条目：表达式能读、状态能写。
    expect(h.state.attrs.find('gen.gMine')).toBeDefined()
    expect(h.state.attrs.write('gen.gMine.owned', Num.fromNumber(5), '<test>')).toBe(true)
  })

  it('重新开始会丢弃全部动态条目（D-18）', () => {
    const h = new Harness({ project: createExampleProject() })
    createViaUpgrade(h, '{ name: "碎片", page: "p1" }')
    expect(h.state.dynamicCount()).toBe(1)
    h.state.reset()
    expect(h.state.dynamicCount()).toBe(0)
  })
})

describe('页面的动态条目渲染（8.10、PRD 页面编辑 7）', () => {
  it('动态条目出现在它所属页面的 `entriesOfCurrentPage()` 里', () => {
    const project = assignToPage(createExampleProject(), 'p1', ['r1', 'g1', 'u1'])
    const h = new Harness({ project })
    createViaUpgrade(h, '{ name: "碎片", page: "p1" }')
    h.state.nav('p1')
    const ids = h.state.entriesOfCurrentPage().map((e) => e.id)
    expect(ids).toContain(h.state.dynamicEntries()[0]!.id)
  })
})
