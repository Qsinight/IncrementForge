/**
 * 升级效果结算（TECH_DESIGN 8.7、PRD 补充 12、D-06、D-23、D-43、D-47、R-34、R-36）。
 *
 * 覆盖 14.2 列出的四条：`owned > 0` 门槛、多效果不短路、`effValue` 同生共死、
 * `E_CAP_NON_POSITIVE` 的兜底值 1。
 *
 * **每个用例都要显式 `commitEffects()`**：效果里的赋值与 `set/create/destroy` 一样
 * 都进 `EffectSink`，唯一的落地点是提交阶段（8.3 第 6 步 / 5.6）。这不是测试的额外负担，
 * 而是运行时契约的一部分——同一条效果链里的多条赋值读到的是**同一份提交前状态**。
 */
import { describe, expect, it } from 'vitest'

import { NUM_MAX, Num, isInf } from '@iforge/num'

import { applyEffect, effectValue } from '../src/upgrade-effect.js'
import { Harness, assignToPage, createDefaultProject, createExampleProject, withGenerator, withUpgrade } from './helpers/harness.js'

/** 一个只有资源 + 生成器 + 升级的最小项目，升级效果全部由 `effects` 给出。 */
function withEffects(effects: { condition: string; action: string }[]): Harness {
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
  const withGen = assignToPage(withGenerator({ id: 'g1', costs: [] }, project), 'p1', ['r1', 'g1'])
  const withUp = withUpgrade({ id: 'u1', costs: [], conditions: [], effects }, withGen)
  return new Harness({ project: assignToPage(withUp, 'p1', ['r1', 'g1', 'u1']) })
}

/** 结算一次升级效果并提交，返回结算结果。 */
function settle(h: Harness): ReturnType<typeof applyEffect> {
  const outcome = applyEffect(h.state, h.upgrade('u1'))
  h.state.commitEffects()
  return outcome
}

describe('8.7 生效门槛（D-43、R-34）', () => {
  it('`owned = 0` 时一条效果都不执行', () => {
    const h = withEffects([{ condition: 'true', action: 'res.r1.amount += 100' }])
    const outcome = settle(h)
    expect(h.resource('r1').toNumber()).toBe(0)
    expect(outcome.applied).toBe(0)
  })

  it('`owned > 0` 后立即生效', () => {
    const h = withEffects([{ condition: 'true', action: 'res.r1.amount += 100' }])
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    settle(h)
    expect(h.resource('r1').toNumber()).toBe(100)
  })

  it('门槛读的是 `owned` 而不是 `bought`：bought > 0 而 owned = 0 仍不生效', () => {
    // 这一条是 `D-43` 与 `D-19` 的分界：点击器初始化 `owned = initial`、`bought = 0`。
    // 若误用 `bought` 当门槛，所有 `initial > 0` 的条目在未购买前就会开始产出/生效。
    const h = withEffects([{ condition: 'true', action: 'res.r1.amount += 100' }])
    h.state.attrs.write('up.u1.bought', Num.fromNumber(7), '<test>')
    settle(h)
    expect(h.resource('r1').toNumber()).toBe(0)
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    settle(h)
    expect(h.resource('r1').toNumber()).toBe(100)
  })

  it('门槛实时读取 `owned`，不缓存（D-43）', () => {
    const h = withEffects([{ condition: 'true', action: 'res.r1.amount += 1' }])
    settle(h)
    expect(h.resource('r1').toNumber()).toBe(0)
    h.state.attrs.write('up.u1.owned', Num.fromNumber(3), '<test>')
    settle(h)
    expect(h.resource('r1').toNumber()).toBe(1)
    // 降回 0：门槛重新生效，值不再增加。
    h.state.attrs.write('up.u1.owned', Num.fromNumber(0), '<test>')
    settle(h)
    expect(h.resource('r1').toNumber()).toBe(1)
  })
})

describe('多效果不短路（D-23、R-36）', () => {
  it('三条效果逐条结算，中间条件为假不影响后面的（D-23）', () => {
    const h = withEffects([
      { condition: 'true', action: 'res.r1.amount += 1' },
      { condition: 'res.r1.amount >= 100', action: 'res.r1.amount += 1000' },
      { condition: 'true', action: 'res.r1.amount += 2' },
    ])
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    const outcome = settle(h)
    expect(outcome.applied).toBe(2)
    expect(outcome.skipped).toBe(1)
    // 结果是 2 而不是 3：赋值按 8.7 的“落地等价于一次提交期 `set`”执行——
    // 每条赋值的**值**在求值时就算好了（都基于 amount = 0），提交期按序写入，
    // 同一属性后写覆盖先写。因此 `+= 1` 与 `+= 2` 不能链式累加。
    expect(h.resource('r1').toNumber()).toBe(2)
  })

  it('条件抛错视为不成立（8.7：前置求值失败不得中断后续效果）', () => {
    const h = withEffects([
      { condition: '不存在的东西', action: 'res.r1.amount += 1' },
      { condition: 'true', action: 'res.r1.amount += 2' },
    ])
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    settle(h)
    expect(h.resource('r1').toNumber()).toBe(2)
  })

  it('空效果数组是合法的（`effects: []` 的“展示型”升级，PRD 补充 12）', () => {
    const h = withEffects([])
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    const outcome = settle(h)
    expect(outcome.applied).toBe(0)
    expect(h.state.diagnosticCount('E_ASSIGN_TYPE')).toBe(0)
  })

  it('同一条效果链里的多条赋值读到同一份提交前状态（单点提交，5.6 / 8.7）', () => {
    const h = withEffects([
      { condition: 'true', action: 'res.r1.amount += 1' },
      { condition: 'res.r1.amount >= 10', action: 'res.r1.amount += 1' },
    ])
    h.grant('r1', 10)
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    settle(h)
    // 两条赋值的**取值**都基于提交前的 10：第二条的条件 `>= 10` 成立（读到的是 10 而非
    // 已经 +1 后的 11 —— 两者都成立，因此断言的是结果值）。
    // 提交期按序写入同一属性，最后一条生效：10 → 11 → 11。
    expect(h.resource('r1').toNumber()).toBe(11)
  })
})

describe('`effValue` 同生共死（PRD 补充 12、R-36）', () => {
  it('`effValue` 与 `effectValues[i]` 是同一个值：两种写法结果一致', () => {
    const a = withEffects([{ condition: 'true', action: 'effValue = 42' }])
    a.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    settle(a)
    expect(a.state.attrs.value(a.upgrade('u1'), 'effectValues[0]').toNumber()).toBe(42)
    expect(effectValue(a.state, a.upgrade('u1'), 0).toNumber()).toBe(42)

    const b = withEffects([{ condition: 'true', action: 'up.u1.effectValues[0] = 42' }])
    b.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    settle(b)
    expect(b.state.attrs.value(b.upgrade('u1'), 'effectValues[0]').toNumber()).toBe(42)
    expect(effectValue(b.state, b.upgrade('u1'), 0).toNumber()).toBe(42)
  })

  it('`effValue` 在 `action` 里读回的是上一次已结算的值', () => {
    const h = withEffects([{ condition: 'true', action: 'effValue = effValue + 1' }])
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    settle(h)
    expect(effectValue(h.state, h.upgrade('u1'), 0).toNumber()).toBe(1)
    settle(h)
    expect(effectValue(h.state, h.upgrade('u1'), 0).toNumber()).toBe(2)
    // 未购买（`owned` 归零）时结算被跳过，值不动。
    h.state.attrs.write('up.u1.owned', Num.fromNumber(0), '<test>')
    settle(h)
    expect(effectValue(h.state, h.upgrade('u1'), 0).toNumber()).toBe(2)
  })

  it('效果未执行时 `effValue` 保持上一次的值（D-06 的批量购买语义）', () => {
    const h = withEffects([
      { condition: 'res.r1.amount >= 999999', action: 'effValue = 100' },
      { condition: 'true', action: 'effValue = effValue + 1' },
    ])
    const upgrade = h.upgrade('u1')
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    settle(h)
    // 效果 0 被跳过 -> `effectValues[0]` 仍是缺省的 0，而不是被“清零重算”。
    expect(effectValue(h.state, upgrade, 0).toNumber()).toBe(0)
    expect(effectValue(h.state, upgrade, 1).toNumber()).toBe(1)
  })

  it('批量购买只结算最后一级的效果（D-06）', () => {
    const project = createDefaultProject()
    project.resources = [
      {
        kind: 'resource',
        id: 'r1',
        order: 1,
        name: 'A',
        description: '',
        icon: { kind: 'builtin', value: 'gem' },
        initial: '0',
        max: 'Infinity',
        visible: true,
      },
    ]
    const withGen = assignToPage(withGenerator({ id: 'g1', costs: [{ materialId: 'r1', amount: '1' }] }, project), 'p1', ['r1', 'g1'])
    const withUp = withUpgrade(
      {
        id: 'u1',
        max: 'Infinity',
        buyAmount: '10',
        costs: [{ materialId: 'r1', amount: '1' }],
        effects: [{ condition: 'true', action: 'effValue = up.u1.bought' }],
      },
      withGen,
    )
    const h = new Harness({ project: assignToPage(withUp, 'p1', ['r1', 'g1', 'u1']) })
    h.grant('r1', 1000)
    expect(h.state.batch('u1')?.k.toNumber()).toBe(10)
    // 只算最后一级：`bought = 10`。若逐级结算，最后触发的中间级会让值停在别的数。
    h.state.commitEffects()
    expect(effectValue(h.state, h.upgrade('u1'), 0).toNumber()).toBe(10)
  })
})

describe('`max` 兜底值（4.4 第 4 / 6 条、`E_CAP_NON_POSITIVE`）', () => {
  it('`max` 求值为 0 时回落到 `1`，并记诊断', () => {
    const h = new Harness({ project: createExampleProject() })
    const generator = h.generator('g1')
    h.state.attrs.writeText(generator, 'max', '0', '<test>')
    expect(h.state.attrs.capOf(generator).toNumber()).toBe(1)
    expect(h.state.diagnosticCount('E_CAP_NON_POSITIVE')).toBeGreaterThan(0)
  })

  it('`max` 求值为 `NaN` 时同样回落到 `1`', () => {
    const h = new Harness({ project: createExampleProject() })
    const generator = h.generator('g1')
    h.state.attrs.writeText(generator, 'max', '0 / 0', '<test>')
    expect(h.state.attrs.capOf(generator).toNumber()).toBe(1)
  })

  it('`max` 求值为负数时回落到 `1`', () => {
    const h = new Harness({ project: createExampleProject() })
    const generator = h.generator('g1')
    h.state.attrs.writeText(generator, 'max', '-5', '<test>')
    expect(h.state.attrs.capOf(generator).toNumber()).toBe(1)
  })

  it('`max = "Infinity"` 表示无限，`applyCap` 不再钳制（4.4 第 6 条）', () => {
    const h = new Harness({ project: createExampleProject() })
    const generator = h.generator('g1')
    // 示例项目的 `g1.max` 是有限的（500），这里换成无限以便观察 4.4 第 6 条。
    h.state.attrs.writeText(generator, 'max', 'Infinity', '<test>')
    expect(isInf(h.state.attrs.capOf(generator))).toBe(true)
    h.state.attrs.writeQuantity(generator, 'owned', Num.fromNumber(1e10), 'gen.g1.owned', '<test>')
    expect(h.state.attrs.value(generator, 'owned').toNumber()).toBe(1e10)
    // 对照：有限的 `max` 会把它夹住。
    h.state.attrs.writeText(generator, 'max', '500', '<test>')
    h.state.attrs.writeQuantity(generator, 'owned', Num.fromNumber(1e10), 'gen.g1.owned', '<test>')
    expect(h.state.attrs.value(generator, 'owned').toNumber()).toBe(500)
    expect(NUM_MAX.toString().length).toBeGreaterThan(0)
  })

  it('有限的 `max` 会钳制写入；`owned` 被夹住但 `bought` 不受影响', () => {
    const h = new Harness({ project: createExampleProject() })
    const generator = h.generator('g1')
    h.state.attrs.writeText(generator, 'max', '25', '<test>')
    h.state.attrs.writeQuantity(generator, 'owned', Num.fromNumber(100), 'gen.g1.owned', '<test>')
    expect(h.state.attrs.value(generator, 'owned').toNumber()).toBe(25)
    h.state.attrs.writeQuantity(generator, 'bought', Num.fromNumber(100), 'gen.g1.bought', '<test>')
    expect(h.state.attrs.value(generator, 'bought').toNumber()).toBe(100)
  })
})

describe('副作用队列：升级效果产生的 `set/create`（8.3.1、8.7）', () => {
  it('`set()` 只进队列，`commitEffects()` 才落地', () => {
    const h = withEffects([{ condition: 'true', action: 'set("res.r1.initial", "500")' }])
    const resource = h.state.attrs.require('res.r1')
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    applyEffect(h.state, h.upgrade('u1'))
    expect(h.state.attrs.textOr(resource, 'initial')).toBe('0')
    h.state.commitEffects()
    expect(h.state.attrs.textOr(resource, 'initial')).toBe('500')
  })

  it('`create()` 生成的 id 带 `dyn_` 前缀（D-44/D-45）', () => {
    const h = new Harness({ project: createExampleProject() })
    const upgrade = h.upgrade('u1')
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    h.state.attrs.writeText(upgrade, 'effects[0].condition', 'true', '<test>')
    h.state.attrs.writeText(upgrade, 'effects[0].action', 'create("generator", { name: "碎片", page: "p1" })', '<test>')
    // `commitEffects()` 只提交**已入队**的分桶（5.6）；没人先跑 `applyEffect` 就什么都不会发生。
    applyEffect(h.state, upgrade)
    h.state.commitEffects()
    expect(h.state.diagnosticsSnapshot()).toEqual({})
    expect(h.state.dynamicCount()).toBe(1)
    const created = h.state.dynamicEntries()[0]!
    expect(created.id.startsWith('dyn_')).toBe(true)
    expect(created.pageId).toBe('p1')
  })
})
