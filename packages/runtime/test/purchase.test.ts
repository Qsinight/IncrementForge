/**
 * 购买结算与批量求解（TECH_DESIGN 8.5、8.6、8.6.1、8.6.2、D-06、D-24、D-36、D-48、R-23、R-25）。
 */
import { describe, expect, it } from 'vitest'

import { Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'
import { DYNAMIC_LIMIT } from '../src/dynamic-registry.js'
import { detectPriceShape, sumShape } from '../src/batch.js'
import type { PriceFn } from '../src/batch.js'
import { conditionsAllTrue, evaluateCostAt, modeOf } from '../src/purchase.js'
import { Harness, assignToPage, createExampleProject, createDefaultProject, withGenerator, withUpgrade } from './helpers/harness.js'

/** 一个只有 1 个资源 + 1 个生成器的最小项目，便于聚焦价格与数量。 */
function economy(generator: Parameters<typeof withGenerator>[0]) {
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
  // 注意：必须把 `project` 显式传进去——`withGenerator` 的默认 base 是一个**空**项目，
  // 用默认值会把上面刚加的资源整个替换掉。
  return assignToPage(withGenerator(generator, project), 'p1', ['r1', generator.id])
}

/** 求 `P(j)` 的暴力参考实现（性质测试的比对基准）。 */
function bruteForceSum(price: PriceFn, k: number): number {
  let sum = 0
  for (let i = 0; i < k; i += 1) sum += price(Num.fromNumber(i)).toNumber()
  return sum
}

describe('buyOne（8.5）', () => {
  it('单件购买即时扣材料并推进 bought/owned', () => {
    const h = new Harness({ project: economy({ id: 'g1', costs: [{ materialId: 'r1', amount: '10' }] }) })
    h.grant('r1', 100)
    expect(h.state.buy('g1')).toBe(true)
    expect(h.resource('r1').toNumber()).toBe(90)
    expect(h.count('generator', 'g1', 'bought').toNumber()).toBe(1)
    expect(h.count('generator', 'g1', 'owned').toNumber()).toBe(1)
  })

  it('材料不足报 E_NOT_ENOUGH 且不改变任何状态', () => {
    const h = new Harness({ project: economy({ id: 'g1', costs: [{ materialId: 'r1', amount: '10' }] }) })
    expect(h.state.buy('g1')).toBe(false)
    expect(h.state.diagnosticCount('E_NOT_ENOUGH')).toBe(1)
    expect(h.count('generator', 'g1', 'bought').toNumber()).toBe(0)
  })

  it('owned 达上限后不可购买（PRD 补充 3 的硬上限），降到上限以下又可买', () => {
    const h = new Harness({ project: economy({ id: 'g1', max: '1', costs: [{ materialId: 'r1', amount: '1' }] }) })
    h.grant('r1', 10)
    expect(h.state.buy('g1')).toBe(true)
    expect(h.state.buy('g1')).toBe(false)
    expect(h.state.diagnosticCount('E_CAP')).toBeGreaterThan(0)
    // 写低 owned 后恢复可买。
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(0), '<test>')
    expect(h.state.buy('g1')).toBe(true)
  })

  it('bought 与 owned 独立可写（PRD 补充 3）', () => {
    const h = new Harness({ project: economy({ id: 'g1', costs: [{ materialId: 'r1', amount: '10 * 1.15 ^ gen.g1.bought' }] }) })
    const priceAt = (bought: number): Decimal => {
      h.state.attrs.write('gen.g1.bought', Num.fromNumber(bought), '<test>')
      return evaluateCostAt(h.state, h.generator('g1'), Num.fromNumber(bought)).quotes[0]!.price
    }
    const first = priceAt(0)
    const later = priceAt(5)
    expect(later.gt(first)).toBe(true)
    // 写 owned 不改变下一件价格。
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(999), '<test>')
    expect(priceAt(5).toString()).toBe(later.toString())
  })

  it('bought 写入不受 max 约束（PRD 补充 3：只有“拥有数量”受上限影响）', () => {
    const h = new Harness({ project: economy({ id: 'g1', max: '3', costs: [{ materialId: 'r1', amount: '1' }] }) })
    h.grant('r1', 100)
    for (let i = 0; i < 10; i += 1) h.state.buy('g1')
    // 购买路径受 `canBuy` 的上限判定保护，买到 3 件就停。
    expect(h.count('generator', 'g1', 'owned').toNumber()).toBe(3)
    expect(h.count('generator', 'g1', 'bought').toNumber()).toBe(3)
    // 直接写 `bought` 则不受上限影响——否则价格成长会被 `max` 卡死。
    h.state.attrs.write('gen.g1.bought', Num.fromNumber(50), '<test>')
    expect(h.count('generator', 'g1', 'bought').toNumber()).toBe(50)
    // 而 `owned` 的写入仍然被夹到 `max`。
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(99), '<test>')
    expect(h.count('generator', 'g1', 'owned').toNumber()).toBe(3)
  })
})

describe('点击器不可购买（8.4 canBuy、D-28、R-25）', () => {
  it('canBuy 恒假、buyOne/batch 拒绝、自动购买阶段跳过（14.2 三路径）', () => {
    const h = new Harness({
      project: economy({ id: 'g1', isClicker: true, initial: '1', buyAmount: '-1', costs: [{ materialId: 'r1', amount: '1' }] }),
    })
    const clicker = h.generator('g1')
    expect(h.state.judge.isClicker(clicker)).toBe(true)
    expect(h.state.judge.canBuy(clicker)).toBe(false)

    h.grant('r1', 1000)
    expect(h.state.buy('g1')).toBe(false)
    expect(h.state.diagnosticCount('E_CLICKER_NOT_BUYABLE')).toBeGreaterThan(0)

    const batch = h.state.batch('g1')
    expect(batch?.k.toNumber()).toBe(0)

    // 自动购买阶段同样跳过它（buyAmount 已写成 -1）。
    for (let i = 0; i < 100; i += 1) h.state.stepTick(50, 50)
    expect(h.count('generator', 'g1', 'bought').toNumber()).toBe(0)
  })

  it('初始化：点击器 bought = 0、owned = initial（D-19）', () => {
    const h = new Harness({ project: economy({ id: 'g1', isClicker: true, initial: '3' }) })
    expect(h.count('generator', 'g1', 'bought').toNumber()).toBe(0)
    expect(h.count('generator', 'g1', 'owned').toNumber()).toBe(3)
  })

  it('点击即时结算产出（8.5 click），公式与自动产出同式', () => {
    const h = new Harness({ project: economy({ id: 'g1', isClicker: true, initial: '4', produces: [{ materialId: 'r1', amount: '3' }] }) })
    const before = h.resource('r1')
    const outcome = h.state.click('g1')
    expect(outcome.ok).toBe(true)
    // 单次点击 = owned × Σ 单件速率 = 4 × 3 = 12。
    expect(outcome.gained.toNumber()).toBe(12)
    expect(Num.sub(h.resource('r1'), before).toNumber()).toBe(12)
  })
})

describe('buyAmount 归一化（5.9.3 ①~④、D-36、14.2）', () => {
  const cases: [string, number, string][] = [
    ['3.7', 3, '按 floor 取整'],
    ['1e1e10', 100, '夹到 100'],
    ['0', 0, '最大购买模式'],
    ['-1', -1, '自动最大（免费）模式'],
    ['250', 100, '正数夹到 100'],
  ]

  it.each(cases)('buyAmount = "%s" -> %i（%s）', (text, expected) => {
    const h = new Harness({ project: economy({ id: 'g1', buyAmount: text }) })
    expect(h.state.attrs.fieldValue(h.generator('g1'), 'buyAmount').toNumber()).toBe(expected)
  })

  it('非有限实数被拒：报 E_BUY_AMOUNT_INVALID 并保持上次成功值（D-46）', () => {
    const h = new Harness({ project: economy({ id: 'g1', buyAmount: '5' }) })
    expect(h.state.attrs.fieldValue(h.generator('g1'), 'buyAmount').toNumber()).toBe(5)
    h.state.attrs.writeText(h.generator('g1'), 'buyAmount', 'Infinity', '<test>')
    expect(h.state.attrs.fieldValue(h.generator('g1'), 'buyAmount').toNumber()).toBe(5)
    expect(h.state.diagnosticCount('E_BUY_AMOUNT_INVALID')).toBeGreaterThan(0)
  })

  it('产生 NaN 的表达式被拒并保持 last-good（`0/0`）', () => {
    const h = new Harness({ project: economy({ id: 'g1', buyAmount: '7' }) })
    h.state.attrs.writeText(h.generator('g1'), 'buyAmount', '0 / 0', '<test>')
    expect(h.state.attrs.fieldValue(h.generator('g1'), 'buyAmount').toNumber()).toBe(7)
    expect(h.state.diagnosticCount('E_BUY_AMOUNT_INVALID')).toBeGreaterThan(0)
  })

  it('`ln(0)` 产出 NaN，同样被拒并保持 last-good（4.4 第 2 条的饱和不适用于 `ln`）', () => {
    // 说明：`Num.ln` 对**含无穷的操作数**才折算为饱和值；`ln(0)` 的操作数是有限的 0，
    // 而 `Decimal.ln(0)` 本身返回 `NaN`，因此原样冒上来，被 ② 步拒掉并保持 last-good。
    // 真正会触发 `E_BUY_AMOUNT_INVALID` 的三种写法：`Infinity` 字面量、`0 / 0`、本条的 `ln(0)`。
    const h = new Harness({ project: economy({ id: 'g1', buyAmount: '7' }) })
    h.state.attrs.writeText(h.generator('g1'), 'buyAmount', 'ln(0)', '<test>')
    expect(h.state.attrs.fieldValue(h.generator('g1'), 'buyAmount').toNumber()).toBe(7)
    expect(h.state.diagnosticCount('E_BUY_AMOUNT_INVALID')).toBeGreaterThan(0)
  })

  it('模式判定（8.6 的表）', () => {
    expect(modeOf(Num.fromNumber(1))).toBe('count')
    expect(modeOf(Num.fromNumber(100))).toBe('count')
    expect(modeOf(Num.fromNumber(0))).toBe('max')
    expect(modeOf(Num.fromNumber(-1))).toBe('free')
  })
})

describe('价格形状识别与闭式求和（8.6 的 A 段、D-48）', () => {
  const families: [string, PriceFn][] = [
    ['等比 A·q^j', (j) => Num.mul(Num.fromNumber(10), Num.pow(Num.fromNumber(1.15), j))],
    ['指数+常数', (j) => Num.add(Num.mul(Num.fromNumber(10), Num.pow(Num.fromNumber(1.15), j)), Num.fromNumber(5))],
    [
      '指数+线性+常数',
      (j) => Num.add(Num.add(Num.mul(Num.fromNumber(10), Num.pow(Num.fromNumber(1.2), j)), Num.mul(Num.fromNumber(2), j)), Num.fromNumber(7)),
    ],
    ['线性', (j) => Num.add(Num.mul(Num.fromNumber(3), j), Num.fromNumber(10))],
  ]

  it.each(families)('识别 %s 并在未见采样点上复验通过', (_name, price) => {
    const shape = detectPriceShape(price, Num.fromNumber(5))
    expect(shape, '应识别出某个族').toBeDefined()
    // 闭式求和与暴力逐级求和一致。
    for (const k of [1, 5, 17, 40]) {
      const closed = sumShape(shape!, Num.fromNumber(k)).toNumber()
      const brute = bruteForceSum(price, k)
      expect(Math.abs(closed - brute) / Math.max(1, Math.abs(brute))).toBeLessThan(1e-6)
    }
  })

  it('递减价格判为“未知形状”并记 E_BATCH_MONOTONE（8.6 的 A 段、R-04）', () => {
    const price: PriceFn = (j) => Num.fromNumber(100).sub(Num.mul(Num.fromNumber(2), j))
    expect(detectPriceShape(price, Num.fromNumber(4))).toBeUndefined()
  })

  it('改动未被采样的系数后必须识别失败（未见采样点复验的价值，D-48）', () => {
    // 前 5 个采样点落在同一条直线上，第 6 个采样点突变。
    const price: PriceFn = (j) => (j.lte(Num.fromNumber(25)) ? Num.fromNumber(10) : Num.fromNumber(10).mul(j))
    expect(detectPriceShape(price, Num.fromNumber(5))).toBeUndefined()
  })
})

describe('批量购买三态（8.6）', () => {
  it('count 模式：受 buyAmount 与 100 上限约束', () => {
    const h = new Harness({ project: economy({ id: 'g1', buyAmount: '3', costs: [{ materialId: 'r1', amount: '10' }] }) })
    h.grant('r1', 1000)
    const result = h.state.batch('g1')
    expect(result?.k.toNumber()).toBe(3)
    expect(h.count('generator', 'g1', 'owned').toNumber()).toBe(3)
    expect(h.resource('r1').toNumber()).toBe(970)
  })

  it('count 模式：材料不够时买得起的那部分', () => {
    const h = new Harness({ project: economy({ id: 'g1', buyAmount: '10', costs: [{ materialId: 'r1', amount: '10' }] }) })
    h.grant('r1', 35)
    const result = h.state.batch('g1')
    expect(result?.k.toNumber()).toBe(3)
    expect(h.resource('r1').toNumber()).toBe(5)
  })

  it('max 模式：买满数量上限（无 100 上限）', () => {
    const h = new Harness({ project: economy({ id: 'g1', buyAmount: '0', max: '500', costs: [{ materialId: 'r1', amount: '1' }] }) })
    h.grant('r1', 1e9)
    const result = h.state.batch('g1')
    expect(result?.k.toNumber()).toBe(500)
    expect(h.count('generator', 'g1', 'owned').toNumber()).toBe(500)
  })

  it('free 模式：免费、不扣材料，价格写成“非纯等比但单调”也不降级（D-48）', () => {
    const h = new Harness({
      project: economy({ id: 'g1', buyAmount: '-1', max: '1000', costs: [{ materialId: 'r1', amount: '10 * 1.15 ^ gen.g1.bought + 5' }] }),
    })
    h.grant('r1', 5000)
    // 暴力参照必须在 `batch` **之前**取 `bought`：免费购买会推进 `bought`。
    const bought = h.count('generator', 'g1', 'bought')
    const result = h.state.batch('g1')
    expect(result?.mode).toBe('free')
    expect(result?.degraded).toBe(false)
    expect(result?.k.gt(0)).toBe(true)
    // 免费：不扣费。
    expect(h.resource('r1').toNumber()).toBe(5000)
    // 结果等于“末价 <= amount 的最大整数”的暴力解。
    const priceAt = (j: number): number =>
      Num.add(Num.mul(Num.fromNumber(10), Num.pow(Num.fromNumber(1.15), Num.add(bought, Num.fromNumber(j)))), Num.fromNumber(5)).toNumber()
    let brute = 0
    for (let k = 1; k < 400; k += 1) if (priceAt(k - 1) <= 5000) brute = k
    expect(result?.k.toNumber()).toBe(brute)
  })

  it('多材料取 min（8.6「多材料」）', () => {
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
      {
        kind: 'resource',
        id: 'r2',
        order: 2,
        name: 'B',
        description: '',
        icon: { kind: 'builtin', value: 'coin' },
        initial: '0',
        max: 'Infinity',
        visible: true,
      },
    ]
    const withTwo = assignToPage(
      withGenerator(
        {
          id: 'g1',
          // 必须用 `max`（自动最大）模式：默认 `buyAmount = 1` 的 `count` 模式上限就是 1，
          // 那样测出来只可能是 1 件，压根走不到“多材料取 min”。
          buyAmount: '0',
          costs: [
            { materialId: 'r1', amount: '10 * 1.15 ^ gen.g1.bought' },
            { materialId: 'r2', amount: '5 * 1.20 ^ gen.g1.bought' },
          ],
        },
        project,
      ),
      'p1',
      ['r1', 'r2', 'g1'],
    )
    const h = new Harness({ project: withTwo })
    h.grant('r1', 1e6)
    h.grant('r2', 400)
    const result = h.state.batch('g1')
    // 暴力校验：逐件模拟，第二个材料先耗尽。
    let cost = 0
    let n = 0
    for (let i = 0; i < 200; i += 1) {
      const next = 5 * Math.pow(1.2, i)
      if (cost + next > 400) break
      cost += next
      n += 1
    }
    expect(result?.k.toNumber()).toBe(n)
  })
})

describe('升级批量购买：条件前缀语义（8.6.2、D-24、R-23）', () => {
  function upgradeProject(conditions: string[], buyAmount = '10', max = 'Infinity') {
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
    // 注意：每个 `with*` 都必须显式传入当前 project，否则会把刚加的资源替换掉。
    const withGen = assignToPage(withGenerator({ id: 'g1', max: 'Infinity', costs: [{ materialId: 'r1', amount: '1' }] }, project), 'p1', [
      'r1',
      'g1',
    ])
    const withUp = withUpgrade(
      {
        id: 'u1',
        max,
        buyAmount,
        conditions,
        costs: [{ materialId: 'r1', amount: '1' }],
      },
      withGen,
    )
    return assignToPage(withUp, 'p1', ['r1', 'g1', 'u1'])
  }

  /**
   * 「条件在**成交时**判定」这一条口径的守门用例（8.6.2 的 `j` 从 0 起）。
   *
   * 第 `j` 次购买发生在等级 `bought + j` 上——条件与价格都按**成交时**的状态判。
   * 早先的实现把条件读在 `bought + j + 1`（成交**之后**一级），于是：
   *
   * - 阈值型 `bought >= 5` 在 `bought = 4` 时末级为真 -> **一次买满 10 件**；
   * - “下一档”型 `(up.u2.bought==k && gen.gN.bought>=1) || …` 要求**再往后一档**的生成器，
   *   最后一档的条件永远不成立（见 `dimension-project.test.ts` 的缺陷 1/2）。
   */
  it('阈值条件 `bought >= 5`：差一级时不许“顺手买满”，够到阈值才买', () => {
    const h = new Harness({ project: upgradeProject(['up.u1.bought >= 5']) })
    h.grant('r1', 1e6)
    // bought = 4：第 1 次购买发生在等级 4 上，`4 >= 5` 为假 -> 一件都买不到。
    // （修正前这里是“末级 `5 >= 5` 为真 -> 一次买 10 件”。）
    h.state.attrs.write('up.u1.bought', Num.fromNumber(4), '<test>')
    expect(h.state.batch('u1')?.k.toNumber()).toBe(0)
    expect(h.count('upgrade', 'u1', 'bought').toNumber()).toBe(4)

    // bought = 5：第 1 次购买发生在等级 5 上 -> 条件成立，按 `buyAmount` 买满 10 件。
    h.state.attrs.write('up.u1.bought', Num.fromNumber(5), '<test>')
    expect(h.state.batch('u1')?.k.toNumber()).toBe(10)
    expect(h.count('upgrade', 'u1', 'bought').toNumber()).toBe(15)
  })

  it('中间为假的条件不能被“末级为真”越过：只能买到空洞之前（R-23/D-24）', () => {
    // 等级 0 与 >= 5 为真，1~4 为假。第 1 次购买发生在等级 0（真），第 2 次发生在等级 1（假）。
    const h = new Harness({ project: upgradeProject(['up.u1.bought == 0 || up.u1.bought >= 5']) })
    h.grant('r1', 1e6)
    const result = h.state.batch('u1')
    expect(result?.k.toNumber()).toBe(1)
    expect(h.count('upgrade', 'u1', 'bought').toNumber()).toBe(1)
    // 只校验末级会得到 10（末级 `10 >= 5` 为真）——那正是 R-23 描述的“买到不满足条件的等级”。
    expect(result?.k.toNumber()).not.toBe(10)
  })

  it('`bought != 5` 这种“上界”条件：最多持有 5 件，第 6 次购买被拒', () => {
    // 第 5 次购买发生在等级 4 上（`4 != 5` 真）-> 持有 5 件；
    // 第 6 次购买发生在等级 5 上（`5 != 5` 假）-> 拒绝。**没有跳过任何一级**。
    const h = new Harness({ project: upgradeProject(['up.u1.bought != 5']) })
    h.grant('r1', 1e6)
    const result = h.state.batch('u1')
    expect(result?.k.toNumber()).toBe(5)
    expect(h.count('upgrade', 'u1', 'bought').toNumber()).toBe(5)
    // 再买一次：条件在等级 5 上为假，一件也买不到（不是买成 6、也不是买成 0 后卡死）。
    expect(h.state.batch('u1')?.k.toNumber()).toBe(0)
    expect(h.count('upgrade', 'u1', 'bought').toNumber()).toBe(5)
  })

  it('单调条件走快路径且与逐级模拟一致', () => {
    const h = new Harness({ project: upgradeProject(['up.u1.bought >= 5']) })
    h.grant('r1', 1e6)
    const result = h.state.batch('u1')
    expect(result?.k.toNumber()).toBe(0)
    // 逐级模拟：bought=0 时条件为假，买 0 件。
    expect(h.count('upgrade', 'u1', 'bought').toNumber()).toBe(0)
  })

  it('非单调条件记 E_BATCH_CONDITION 并给出降级标记（8.6.2）', () => {
    const h = new Harness({ project: upgradeProject(['up.u1.bought != 5']) })
    h.grant('r1', 1e6)
    const result = h.state.batch('u1')
    expect(h.state.diagnosticCount('E_BATCH_CONDITION')).toBeGreaterThan(0)
    expect(result?.degraded).toBe(true)
  })

  it('条件 AND 判定：全真才可购买（PRD 补充 4）', () => {
    const h = new Harness({ project: upgradeProject(['true', 'up.u1.bought >= 100']) })
    h.grant('r1', 1e6)
    expect(h.state.batch('u1')?.k.toNumber()).toBe(0)
    expect(conditionsAllTrue(h.state, h.upgrade('u1'))).toBe(false)
  })

  it('free 模式按 PRD 只校验末级，因此会跨过条件空洞（8.6.2，与前缀解明确不同）', () => {
    // 同一条“空洞”条件、同一份材料：
    // - `count`/`max`（前缀语义）：等级 1 为假 -> 只能买 1 件（见上一条用例）。
    // - `free`（末级语义）：只要“最后一件买得起”就整批买 -> 直接买满 20 件上限，跨过空洞。
    // 这个差异是 PRD 明确要求并被 1.4 承认的（“free 只校验末级”，结果可能偏大）。
    const hole = ['up.u1.bought == 0 || up.u1.bought >= 5']
    const h = new Harness({ project: upgradeProject(hole, '-1', '20') })
    h.grant('r1', 1e6)
    const result = h.state.batch('u1')
    expect(result?.mode).toBe('free')
    expect(result?.k.toNumber()).toBe(20)
    expect(h.count('upgrade', 'u1', 'bought').toNumber()).toBe(20)
    // 明确区别于前缀解（1 件）。
    expect(result?.k.toNumber()).not.toBe(1)
  })
})

describe('只读等级视图（8.6.1）', () => {
  it('求第 j 级价格不修改 bought、不递增 version、不写 assignments', () => {
    const h = new Harness({ project: economy({ id: 'g1', costs: [{ materialId: 'r1', amount: '10 * 1.15 ^ gen.g1.bought' }] }) })
    const generator = h.generator('g1')
    const boughtKey = 'gen.g1.bought'
    const versionBefore = h.state.attrs.versionOf(boughtKey)
    const assignmentsBefore = generator.assignments.size

    const priceAt5 = evaluateCostAt(h.state, generator, Num.fromNumber(5)).quotes[0]!.price
    expect(priceAt5.toNumber()).toBeCloseTo(10 * Math.pow(1.15, 5), 9)

    // 存储未被污染。
    expect(h.count('generator', 'g1', 'bought').toNumber()).toBe(0)
    expect(h.state.attrs.versionOf(boughtKey)).toBe(versionBefore)
    expect(generator.assignments.size).toBe(assignmentsBefore)
  })

  it('同一 tick 内连续求 j=1..10 的结果互不相同（记忆化按覆盖层隔离）', () => {
    const h = new Harness({ project: economy({ id: 'g1', costs: [{ materialId: 'r1', amount: '10 * 1.15 ^ gen.g1.bought' }] }) })
    const generator = h.generator('g1')
    const prices: number[] = []
    for (let j = 1; j <= 10; j += 1) {
      prices.push(evaluateCostAt(h.state, generator, Num.fromNumber(j)).quotes[0]!.price.toNumber())
    }
    expect(new Set(prices).size).toBe(10)
  })

  it('条件侧 atLevel 与价格侧 j 用同一覆盖层入口', () => {
    const h = new Harness({
      project: (() => {
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
        const withGen = assignToPage(withGenerator({ id: 'g1', costs: [] }, project), 'p1', ['r1', 'g1', 'u1'])
        return assignToPage(withUpgrade({ id: 'u1', conditions: ['up.u1.bought >= 3'], costs: [] }, withGen), 'p1', ['r1', 'g1', 'u1'])
      })(),
    })
    // bought = 0 时条件为假；atLevel = 3 时为真——证明条件确实读到了覆盖层。
    expect(conditionsAllTrue(h.state, h.upgrade('u1'))).toBe(false)
    expect(conditionsAllTrue(h.state, h.upgrade('u1'), Num.fromNumber(3))).toBe(true)
  })
})

describe('动态条目上限（D-32、R-16）', () => {
  it(`上限常量 = ${DYNAMIC_LIMIT}，且超限整体拒绝`, () => {
    expect(DYNAMIC_LIMIT).toBe(2000)
    const h = new Harness({ project: economy({ id: 'g1' }) })
    // 直接灌满上限再试一次创建（不走 2000 次 create，太慢）。
    const registry = h.state.dynamic as unknown as { entries: Map<string, unknown> }
    for (let i = 0; i < DYNAMIC_LIMIT; i += 1) {
      registry.entries.set(`gen.dyn_${i}`, {
        state: h.generator('g1'),
        kind: 'generator',
        id: `dyn_${i}`,
        pageId: 'p1',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    }
    expect(() => h.state.dynamic.create('upgrade', { page: 'p1' })).toThrowError(/动态条目已达上限/)
    expect(h.state.dynamicCount()).toBe(DYNAMIC_LIMIT)
  })
})

describe('示例项目（17.2）回归', () => {
  it('矿机价格按 `10 * 1.15 ^ gen.g1.bought` 成长', () => {
    const h = new Harness({ project: createExampleProject() })
    const generator = h.generator('g1')
    const price0 = evaluateCostAt(h.state, generator, Num.fromNumber(0)).quotes[0]!.price.toNumber()
    const price5 = evaluateCostAt(h.state, generator, Num.fromNumber(5)).quotes[0]!.price.toNumber()
    expect(price0).toBeCloseTo(10, 9)
    expect(price5).toBeCloseTo(10 * Math.pow(1.15, 5), 9)
  })

  it('双倍产量升级的批量购买只结算最后一级的效果数值（D-06）', () => {
    const h = new Harness({ project: createExampleProject() })
    // `u1.max = 1`，只买 1 件。
    h.state.attrs.write('gen.g1.bought', Num.fromNumber(5), '<test>')
    h.grant('r1', 1000)
    const result = h.state.batch('u1')
    expect(result?.k.toNumber()).toBe(1)
    // 触发点 ②：结算全部效果 -> effect 0 热替换单件速率、effect 1 写 effectValues[1]。
    // 效果 2 的条件是 `bought >= 10`，不成立。
    h.state.commitEffects()
    expect(h.state.attrs.textOr(h.generator('g1'), 'produces[0].amount')).toBe('2')
  })
})
