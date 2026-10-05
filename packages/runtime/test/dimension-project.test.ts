/**
 * 「反物质维度（增量工坊学习版）」——`docs/` 里的真实项目文件作为夹具（回归用例）。
 *
 * ## 为什么用真实项目文件而不是现造的夹具
 *
 * 这一族缺陷都**只在“价格/条件表达式引用别的条目属性”时**才显形，而维度跃迁类项目
 * 恰好全都这么写：
 *
 * ```
 * g1.costs[0].amount = 10  * (1000 ^ floor(gen.g1.bought / 10))
 * g1.produces[0].amount = (2 ^ (floor(gen.g1.bought/10) + max(up.u1.owned, 0))) * (up.u2.effectValues[0] + 1)
 * u2.conditions[0]       = (up.u2.bought==0 && gen.g1.bought>=1) || (up.u2.bought==1 && gen.g2.bought>=1) || ...
 * ```
 *
 * `u2`（购买维度）的条件是典型的“**下一档**”写法：第 `k` 件按 `up.u2.bought == k` 判定，
 * 并要求 `gen.g(k+1).bought >= 1`。现成的 `createExampleProject()` / `richProject()`
 * 全部写阈值型条件（`gen.<自己>.bought >= n`），天然测不到这一族。
 *
 * ## 本文件守的三件事
 *
 * | # | 现象 | 断言落点 |
 * | --- | --- | --- |
 * | 1 | 基于 `up.u2.effectValues[i]` 的**产出表达式**永远乘不上那个倍率 | 「产出倍率随升级链复活」 |
 * | 2 | 成就页里基于“下一档”条件的**升级买不了**（按钮写 `购买`，点下去 0 件） | 「卡片件数 == 结算件数」+「买满 8 档」 |
 * | 3 | 第二个及以后的生成器买不了（价格合计缓存的键漏了价格表达式引用的**别的条目**） | 「价格跟着引用项的版本走」 |
 *
 * ## 夹具会随作者改动
 *
 * `docs/` 里那份文件是作者真实在改的项目（价格台阶的写法换过好几轮）。因此凡��断言
 * “价格跟着 **别的条目** 走”的用例，都在**用例内**把价格表达式改成引用 `gen.g1.bought`
 * 再断言——这样夹具怎么改都不影响用例的立意。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

import { Num, resetDiagnostics } from '@iforge/num'
import type { GeneratorDef, ProjectFile } from '@iforge/model'

import { affordableInCountMode, resetMonotonicCache } from '../src/batch.js'
import { resetRateHistory } from '../src/dashboard.js'
import { unitRate } from '../src/production.js'
import { buildViewModel, NOT_ENOUGH_MATERIAL_REASON, resetViewModelCache } from '../src/view-model.js'
import type { CardView } from '../src/view-model.js'
import { Harness } from './helpers/harness.js'

/** `docs/` 下那份项目文件（文件名含中文与全角括号，用 `readdirSync` 定位而不是硬编码）。 */
function loadDimensionProject(): ProjectFile {
  const dir = fileURLToPath(new URL('../../../docs/', import.meta.url))
  const file = readdirSync(dir).find((name) => name.endsWith('.json'))
  if (!file) throw new Error('docs 下没有项目文件')
  return JSON.parse(readFileSync(dir + file, 'utf8')) as ProjectFile
}

/** 卡片上某个条目（用于少写几遍 `find`）。 */
function cardOf(state: Harness, id: string): CardView {
  const card = buildViewModel(state.state).page?.entries.find((entry) => entry.id === id)
  if (!card) throw new Error(`当前页面没有条目 ${id}`)
  return card
}

/** 卡片上的价格行文本（已格式化，8.11）。 */
function costOf(state: Harness, id: string): string {
  return cardOf(state, id).costs![0]!.amount
}

/** 卡片上的价格文本（用同一个格式化函数，别写死字面量）。 */
function fmt(value: string): string {
  return Num.format(Num.fromString(value), 'standard')
}

/**
 * 把若干生成器的价格改成**引用 `gen.g1.bought`**（“价格挂在别的条目上”这一族的前提）。
 *
 * 夹具里 `g2`~`g4` 的台阶写的是各自的 `bought`（作者改过几轮），因此凡是要验
 * “价格跟着**别的条目**走”的用例都在这里改写，不依赖夹具当前的写法。
 */
function withCrossEntryPrice(project: ProjectFile, specs: Record<string, [base: string, ratio: string]>): ProjectFile {
  return {
    ...project,
    generators: project.generators.map((generator) => {
      const spec = specs[generator.id]
      if (!spec) return generator
      return { ...generator, costs: [{ materialId: 'r1', amount: `${spec[0]}*(${spec[1]}^floor(gen.g1.bought/10))` }] }
    }) as GeneratorDef[],
  }
}

/** `g2`/`g3`/`g4` 全部挂在 `g1.bought` 上（与「反物质维度」最初的价格形状一致）。 */
function crossEntryPrices(project: ProjectFile): ProjectFile {
  return withCrossEntryPrice(project, {
    g2: ['100', '10000'],
    g3: ['10000', '1e5'],
    g4: ['1e6', '1e6'],
  })
}

beforeEach(() => {
  resetDiagnostics()
  resetMonotonicCache()
  resetRateHistory()
  resetViewModelCache()
})

describe('夹具：docs/「反物质维度（增量工坊学习版）」', () => {
  it('产出表达式引用别的条目（`up.u1.owned` 与 `up.u2.effectValues[i]`）', () => {
    const project = loadDimensionProject()
    for (const generator of project.generators) {
      const amount = generator.produces[0]!.amount
      expect(amount, generator.id).toContain('up.u1.owned')
      expect(amount, generator.id).toContain('up.u2.effectValues[')
    }
  })

  it('“下一档”条件：第 k 件按 `up.u2.bought == k` 判定并要求第 k+1 个生成器', () => {
    const project = loadDimensionProject()
    const condition = project.upgrades.find((upgrade) => upgrade.id === 'u2')!.conditions[0]!
    expect(condition).toContain('up.u2.bought==0&&gen.g1.bought>=1')
    expect(condition).toContain('up.u2.bought==7&&gen.g8.bought>=1')
    // `u2.max = 8`：第 8 件的效果（`effValue = 0.5`）要求 `up.u2.bought==8`，
    // 也就是“买满 8 档”是产出倍率生效的唯一途径。
    const u2 = project.upgrades.find((upgrade) => upgrade.id === 'u2')!
    expect(u2.max).toBe('8')
    expect(u2.effects.filter((effect) => effect.action === 'effValue = 0.5')).toHaveLength(8)
  })

  it('产出表达式的倍率因子就是 `up.u2.effectValues[i] + 1`', () => {
    const project = loadDimensionProject()
    for (const [index, generator] of project.generators.entries()) {
      expect(generator.produces[0]!.amount, generator.id).toContain(`up.u2.effectValues[${index}]+1`)
    }
  })
})

describe('缺陷 2：成就页里基于“下一档”条件的升级买不了', () => {
  it('卡片写“购买 ×1”且按钮可用时，点下去必须真的买到 1 件（按钮不许说谎）', () => {
    const h = new Harness({ project: loadDimensionProject() })
    h.grant('r1', '1e30')
    h.state.batch('g1') // gen.g1.bought = 10 -> `up.u2.bought==0 && gen.g1.bought>=1` 成立
    h.state.nav('p2')

    const card = cardOf(h, 'u2')
    expect(card.conditions?.[0]?.true, '条件在当前状态为真').toBe(true)
    expect(card.canBuy).toBe(true)
    expect(card.buyCount, '卡片承诺的件数').toBe(1)

    // 修正前：条件读在“成交之后”一级（`up.u2.bought==1` 要求 `gen.g2.bought>=1`），
    // 于是这里结算 0 件——按钮亮着、写着“购买”，点下去毫无反应。
    expect(h.state.batch('u2')!.k.toNumber(), '结算件数必须等于卡片件数').toBe(card.buyCount)
    expect(h.count('upgrade', 'u2', 'bought').toNumber()).toBe(1)
  })

  it('买满 8 档：`up.u2.bought` 达到 `max`，之后任何条件都不再放行', () => {
    const h = new Harness({ project: loadDimensionProject() })
    h.state.unlockAll() // g5~g8 平时由 u1 的效果解锁；这里只为把 8 档走完
    h.grant('r1', '1e40')
    for (const id of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']) h.state.batch(id)

    for (let level = 1; level <= 8; level += 1) {
      expect(h.state.batch('u2')?.k.toNumber(), `第 ${level} 档`).toBe(1)
      expect(h.count('upgrade', 'u2', 'bought').toNumber(), `第 ${level} 档之后`).toBe(level)
    }
    // 条件链只覆盖 `bought == 0..7`，第 9 件永远不成立；再加 `max = 8` 双保险。
    expect(h.state.batch('u2')?.k.toNumber()).toBe(0)
    expect(h.count('upgrade', 'u2', 'bought').toNumber()).toBe(8)
  })

  it('“解锁全部”之外的真实链路也能走满：g4 买满 20 件 -> u1 生效 -> g5 可见', () => {
    const h = new Harness({ project: loadDimensionProject() })
    h.grant('r1', '1e60')
    h.state.batch('g1')
    h.state.batch('g2')
    h.state.batch('g3')
    h.state.batch('g4')
    // u1 的条件是 `gen.g4.owned >= 20`：买满 g4 的两批（10 + 10）即可。
    h.grant('r1', '1e60')
    h.state.batch('g4')
    expect(h.count('generator', 'g4', 'owned').gte(Num.fromNumber(20))).toBe(true)

    expect(h.state.batch('u1')?.k.toNumber(), 'u1 可购买').toBe(1)
    h.state.commitEffects() // `gen.g5.visible = true` 在提交阶段落地
    expect(h.state.attrs.find('gen.g5')!.visible, 'g5 被解锁').toBe(true)
    expect(h.state.batch('g5')?.k.toNumber(), 'g5 现在买得到').toBeGreaterThan(0)
  })
})

describe('缺陷 1：基于 `up.u2.effectValues[i]` 的产出表达式乘不上倍率', () => {
  it('升级链没走完时倍率是 1；走满 8 档后 `effectValues` 变 0.5、产出速率真的乘 1.5', () => {
    const h = new Harness({ project: loadDimensionProject() })
    h.state.unlockAll()
    h.grant('r1', '1e40')
    for (const id of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']) h.state.batch(id)

    const g1 = h.generator('g1')
    // `2^floor(10/10) * (0 + 1) = 2`：`effectValues` 还是初值 0。
    expect(unitRate(h.state, g1).toString()).toBe('2')

    for (let level = 1; level <= 8; level += 1) h.state.batch('u2')
    // 效果副作用在**下一个提交阶段**才落地（8.3.1 的单一提交点）。
    h.state.commitEffects()

    for (let index = 0; index < 8; index += 1) {
      expect(h.upgrade('u2').values.get(`effectValues[${index}]`)?.toString(), `effectValues[${index}]`).toBe('0.5')
    }
    // `2^1 * (0.5 + 1) = 3`：产出表达式的倍率因子真的生效了。
    expect(unitRate(h.state, g1).toString()).toBe('3')
    // 卡片上的“每秒”是同一条口径（`owned × Σ 单件速率`），不能与结算分叉。
    expect(cardOf(h, 'g1').output).toBe(Num.format(h.state.attrs.perSecond(g1), 'standard'))
  })

  it('产出目标可以是**生成器**：g2 的产出真的把 `gen.g1.owned` 顶上去', () => {
    const h = new Harness({ project: loadDimensionProject() })
    h.grant('r1', '1e40')
    h.state.batch('g1')
    h.state.batch('g2')

    const g2 = h.generator('g2')
    expect(h.state.attrs.textOr(g2, 'produces[0].materialId'), 'g2 的产出目标是生成器').toBe('g1')
    const ownedOfG1 = (): string => h.count('generator', 'g1', 'owned').toString()
    const before = ownedOfG1()
    const perSecond = h.state.attrs.perSecond(g2)
    h.runSeconds(1)
    const delta = Num.sub(h.count('generator', 'g1', 'owned'), Num.fromString(before)).toString()
    // 卡片上的“每秒”与一秒钟的真实增量同口径（D-30 的 `owned` 只乘一次）。
    expect(delta).toBe(perSecond.toString())
    // 产出**不影响价格**：加的是 `owned` 而不是 `bought`（8.3 第 3 步）。
    expect(h.count('generator', 'g1', 'bought').toNumber()).toBe(10)
  })
})

describe('缺陷 3：第二个及以后的生成器显示的是开局的旧价格，于是“买不了”', () => {
  it('价格表达式引用**别的条目**时，别人的 bought 变化必须让价格重算（缓存键含 deps）', () => {
    const h = new Harness({ project: crossEntryPrices(loadDimensionProject()) })
    h.grant('r1', '1e30')

    // 开局：g1.bought = 0 -> g2 单件 100、`buyAmount = 10` -> 合计 1000。
    expect(costOf(h, 'g2')).toBe(fmt('1000'))

    // 反复建视图把“开局价”写进缓存。
    for (let i = 0; i < 5; i += 1) buildViewModel(h.state)
    h.state.batch('g1') // g1.bought = 10 -> 台阶进位
    for (let i = 0; i < 5; i += 1) buildViewModel(h.state)
    expect(costOf(h, 'g2'), '跟着 gen.g1.bought 跳台阶').toBe(fmt('10000000'))

    // 第三、第四个同理（台阶不同，但都跟着 g1 走）。
    expect(costOf(h, 'g3')).toBe(fmt('1e10'))
    expect(costOf(h, 'g4')).toBe(fmt('1e13'))
  })

  it('材料够时第二个及以后的生成器**真的买得到**，且卡片件数 = 结算件数', () => {
    const h = new Harness({ project: crossEntryPrices(loadDimensionProject()) })
    h.grant('r1', '1e30')
    h.state.batch('g1')

    for (const id of ['g2', 'g3', 'g4'] as const) {
      const card = cardOf(h, id)
      expect(card.canBuy, `${id} 的按钮`).toBe(true)
      const k = h.state.batch(id)!.k.toNumber()
      expect(k, `${id} 的结算件数`).toBe(card.buyCount)
      expect(h.count('generator', id, 'bought').toNumber(), `${id} 的已购买`).toBe(k)
    }
  })

  it('“买不起”时按钮禁用并说明是材料不足，而不是亮着的死按钮', () => {
    const h = new Harness({ project: crossEntryPrices(loadDimensionProject()) })
    // 100 恰好买满 g1 的第一批 10 台（单件 10），花完之后一无所有。
    h.grant('r1', '100')
    expect(h.state.batch('g1')!.k.toNumber()).toBe(10)
    const card = cardOf(h, 'g2')
    expect(card.buyMode).toBe('count')
    expect(card.buyRequest).toBe(10)
    expect(card.buyCount).toBe(0)
    expect(card.canBuy).toBe(false)
    expect(card.buyBlockReason).toBe(NOT_ENOUGH_MATERIAL_REASON)
    // 价格仍然给出**真价**（作者据此知道还差多少），不再是开局的 1000。
    expect(card.costs![0]!.amount).toBe(fmt('10000000'))
  })

  it('材料只够一部分时：件数取可负担的前缀，消耗按这个前缀显示', () => {
    const h = new Harness({ project: crossEntryPrices(loadDimensionProject()) })
    h.grant('r1', '1e30')
    h.state.batch('g1') // 台阶进位后 g2 单件 1000000
    h.grant('r1', '2.5e6') // 恰好 2 台
    const card = cardOf(h, 'g2')
    expect(card.buyRequest).toBe(10)
    expect(card.buyCount).toBe(2)
    expect(card.costs![0]!.amount).toBe(fmt('2000000'))
    expect(h.state.batch('g2')!.k.toNumber()).toBe(2)
  })

  it('价格读内建变量（`10 + time`）时不能跨 tick 缓存', () => {
    // 注意要在**构造 Harness 之前**改项目：`AttributeStore` 在构造时就把 `costs` 读进去了。
    const project = loadDimensionProject()
    project.generators = project.generators.map((generator) =>
      generator.id === 'g2' ? { ...generator, costs: [{ materialId: 'r1', amount: '10 + time' }] } : generator,
    )
    const h = new Harness({ project })
    h.grant('r1', '1e12')
    const costOfG2 = (): string => cardOf(h, 'g2').costs![0]!.amount
    const first = costOfG2()
    // `time` 只在 `stepTick` 里推进，而 `tick` 与它同步推进 —— 因此内建变量用 tick 判脏。
    h.runSeconds(3)
    expect(costOfG2()).not.toBe(first)
  })
})

describe('缺陷 2（历史）：第一次点购买后按钮一直显示“计算中…”', () => {
  it('`10 * (1000 ^ floor(gen.g1.bought / 10))` 这种“台阶价”走迭代降级，但**一次就算完了**', () => {
    const h = new Harness({ project: loadDimensionProject() })
    h.grant('r1', '1e6')
    const result = h.state.batch('g1')!
    // 台阶价不属于四个闭式族 -> 降级（degraded），这是预期。
    expect(result.degraded).toBe(true)
    // 但它**不是**“预算用光、需要下一 tick 续算”：这一批只花了几十次求值。
    // 早先这两个标志混为一谈，于是 `degraded` 恒真 -> 卡片永久显示“计算中…”，
    // 而交互路径每次点击都拿一份全新预算、根本不存在“等下一 tick”这回事。
    expect(result.truncated).toBe(false)
    expect([...h.state.pendingSolves()]).toEqual([])
  })

  it('交互购买连续点多次，视图里始终没有“计算中”', () => {
    const h = new Harness({ project: loadDimensionProject() })
    h.grant('r1', '1e12')
    for (let round = 0; round < 4; round += 1) {
      h.state.batch('g1')
      for (const entry of buildViewModel(h.state).page!.entries) {
        // 资源卡片没有购买语义（`calculating` 缺省），按 `false` 处理。
        expect(entry.calculating ?? false, `${entry.id} 不应显示计算中`).toBe(false)
      }
    }
    expect([...h.state.pendingSolves()]).toEqual([])
  })

  it('按钮给出的是“当前买得起的件数与消耗”，而不是配置值', () => {
    const h = new Harness({ project: loadDimensionProject() })
    h.grant('r1', '35') // g1 单件 10 -> 只够 3 台
    const card = cardOf(h, 'g1')
    expect(card.buyRequest).toBe(10)
    expect(card.buyCount).toBe(3)
    expect(card.costs![0]!.amount).toBe(fmt('30'))
    expect(card.canBuy).toBe(true)
  })
})

describe('`affordableInCountMode` 与 `solveBatch` 同口径（防“两条购买路径”漂移）', () => {
  it('阶梯价 + 逐档材料：卡片件数恒等于结算件数', () => {
    const h = new Harness({ project: loadDimensionProject() })
    const g1 = h.generator('g1')
    let purchased = 0
    for (const budget of ['0', '10', '35', '100', '12345', '1e9', '1e30']) {
      h.grant('r1', budget)
      const affordable = affordableInCountMode(h.state, g1, 10)
      const k = h.state.batch('g1')!.k.toNumber()
      expect(k, `材料 ${budget}：结算件数`).toBe(affordable.k)
      purchased += k
      expect(h.count('generator', 'g1', 'bought').toNumber(), `材料 ${budget}：累计已购买`).toBe(purchased)
    }
  })

  it('升级：卡片件数恒等于结算件数（条件逐级确认，两侧必须同一套等级口径）', () => {
    const h = new Harness({ project: loadDimensionProject() })
    h.grant('r1', '1e40')
    h.state.unlockAll()
    for (const id of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']) h.state.batch(id)
    const u2 = h.upgrade('u2')
    for (let level = 1; level <= 8; level += 1) {
      const affordable = affordableInCountMode(h.state, u2, 1)
      const k = h.state.batch('u2')!.k.toNumber()
      expect(k, `第 ${level} 档：结算件数`).toBe(affordable.k)
    }
  })
})
