/**
 * 回归：`costs[i].materialId` / `produces[i].materialId` 悬空（空串 / 指向已删除的条目）
 * 时的**结算**语义（D-38、`priceRowsUsable`、D-07、6.4 引用完整性）。
 *
 * ## 这个缺陷是怎么被发现的（症状 → 根因）
 *
 * 复现报告的现象是「生成器可免费购买，且不产出资源」：
 *
 * ```
 * 新生成器  5 / 5        ← 买了 5 台，材料始终是 0
 * 每秒 5                ← perSec = owned × Σ produces[i].amount，与真实增长无关
 * （没有价格行）        ← card.costs 为空
 * ```
 *
 * 根因不在“价格算错了”，而在**一条都算不出来时的退化方向**：
 *
 * | 环节 | 坏行（`materialId` 解析不出目标）时的行为 |
 * | --- | --- |
 * | `evaluateCostAt` | 记 `E_DANGLING_REF`，**跳过该行**（D-07「一行坏数据不中断结算」） |
 * | `deductCosts([])` | 没有要扣的材料 → 返回 `true` |
 * | `buyOne` | 于是**不扣任何东西**就推进 `bought/owned` —— 免费购买 |
 * | `produceTargets` | 同样记 `E_DANGLING_REF` 并跳过 → 资源永远不涨 |
 * | `buildCard` | `costs` 映射自 `quotes`，坏行不在里面 → 卡片**没有价格行**，按钮却可点 |
 *
 * “跳过坏行”对**展示**是对的（8.5/5.7 的 last-good 口径），对**结算**是灾难：
 * D-38 明确“不做级联删除/改写”，悬空引用必须**暴露成错误**而不是被当成“免费 / 无产出”。
 *
 * 现实触发路径：`GeneratorForm` 的“+ 购买价格 / + 产出资源”新增一行时 `materialId` 是空串，
 * 而 `RefPicker` 曾没有 `value === ""` 的 `<option>`——`<select>` 在“当前值匹配不到任何
 * option”时会把**第一个 option 显示为选中项**，于是界面上写着“矿石（r1）”，实际存的是 `""`。
 * 作者看不到任何异常，预览里就得到一个能白嫖又不产出的生成器。
 *
 * 本文件钉住的是**运行时**那一半（编辑器那一半见 `apps/editor/test/ref-picker.test.tsx`）。
 */
import { describe, expect, it } from 'vitest'

import { Num } from '@iforge/num'
import { ENGINE_VERSION } from '@iforge/model'
import type { GeneratorDef, ProjectFile, ResourceDef } from '@iforge/model'

import { restoreSave, serializeSave } from '../src/save.js'
import { applyProjectPatches } from '../src/patch.js'
import { BROKEN_PRICE_REASON, buildViewModel } from '../src/view-model.js'
import { priceRowsUsable } from '../src/purchase.js'
import { Harness, assignToPage, createDefaultProject, withGenerator } from './helpers/harness.js'

/**
 * `r1` + 一个生成器 `g1`，价格/产出的 `materialId` 由参数决定。
 *
 * 条目全部归入 `p1`：未归属的条目是孤儿（8.7），`isVisible` 恒假，所有交互都会被
 * `E_HIDDEN` 拒掉——那样测到的就不是“引用无效”而是“可见性判定”了。
 */
function shop(
  options: {
    costs?: GeneratorDef['costs']
    produces?: GeneratorDef['produces']
    buyAmount?: string
    max?: string
  } = {},
): ProjectFile {
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
    } satisfies ResourceDef,
  ]
  const withGen = withGenerator(
    {
      id: 'g1',
      max: options.max ?? 'Infinity',
      buyAmount: options.buyAmount ?? '1',
      costs: options.costs ?? [{ materialId: '', amount: '1' }],
      produces: options.produces ?? [{ materialId: '', amount: '1' }],
    },
    project,
  )
  return assignToPage(withGen, 'p1', ['r1', 'g1'])
}

describe('价格行不可用 ≠ 没有价格：单件购买被拒绝（D-38、`priceRowsUsable`）', () => {
  it('空 `materialId`：0 材料也买不到，且 `bought/owned` 一动不动', () => {
    const h = new Harness({ project: shop({ costs: [{ materialId: '', amount: '1' }] }) })
    // 故意**不给**材料：修好之前这里会返回 `true`（“没有要扣的材料”）。
    expect(h.resource('r1').toNumber()).toBe(0)
    expect(h.state.buy('g1')).toBe(false)
    expect(h.count('generator', 'g1', 'bought').toNumber()).toBe(0)
    expect(h.count('generator', 'g1', 'owned').toNumber()).toBe(0)
    expect(h.state.diagnosticCount('E_DANGLING_REF')).toBeGreaterThan(0)
  })

  it('指向已删除的条目（`rGone`）同样拒绝，且**不**退化成“材料不足”的报错文案', () => {
    const h = new Harness({ project: shop({ costs: [{ materialId: 'rGone', amount: '1' }] }) })
    h.grant('r1', 1_000_000)
    expect(h.state.buy('g1')).toBe(false)
    // 材料给到天荒地老也没用——坏的是引用，不是余额。
    expect(h.resource('r1').toNumber()).toBe(1_000_000)
    expect(h.state.diagnosticCount('E_DANGLING_REF')).toBeGreaterThan(0)
  })

  it('价格文本被换成中性占位值时同样拒绝（作者写坏的价格不是“价格 0”）', () => {
    // `10 * (1 +` 在**装载**时就编译不过，`validateDefinitionTexts()` 会把它换成中性值 `'0'`
    // （5.7 的 last-good，`E_PARSE` 已入库）。`0` 不是作者定的价格，按它结算等于白送，
    // 因此 `EntryState.neutralized` 里的键一律判为不可用。
    const h = new Harness({ project: shop({ costs: [{ materialId: 'r1', amount: '10 * (1 +' }] }) })
    h.grant('r1', 1_000_000)
    expect(h.state.attrs.isNeutralText(h.generator('g1'), 'costs[0].amount')).toBe(true)
    expect(h.state.buy('g1')).toBe(false)
    expect(h.resource('r1').toNumber()).toBe(1_000_000)
    expect(h.state.diagnosticCount('E_PARSE')).toBeGreaterThan(0)
  })

  it('作者把坏价格改回合法文本后，占位标记必须撤销（别让守卫变成永久拉黑）', () => {
    const h = new Harness({ project: shop({ costs: [{ materialId: 'r1', amount: '10 * (1 +' }] }) })
    h.grant('r1', 100)
    expect(h.state.attrs.writeText(h.generator('g1'), 'costs[0].amount', '10', '<test>')).toBe(true)
    expect(h.state.attrs.isNeutralText(h.generator('g1'), 'costs[0].amount')).toBe(false)
    expect(h.state.buy('g1')).toBe(true)
    expect(h.resource('r1').toNumber()).toBe(90)
  })

  it('合法引用仍然正常扣款（这条守住“别把守卫写过头”）', () => {
    const h = new Harness({ project: shop({ costs: [{ materialId: 'r1', amount: '10' }] }) })
    h.grant('r1', 100)
    expect(h.state.buy('g1')).toBe(true)
    expect(h.resource('r1').toNumber()).toBe(90)
  })

  it('`costs` 为空的条目仍然是“合法免费条目”，不能被守卫误伤', () => {
    const h = new Harness({ project: shop({ costs: [] }) })
    expect(priceRowsUsable(h.state, h.generator('g1'))).toBe(true)
    expect(h.state.buy('g1')).toBe(true)
    expect(h.count('generator', 'g1', 'owned').toNumber()).toBe(1)
  })

  it('多材料里只有一行坏时整笔拒绝（材料之间不可互换，不能只扣好的那几行）', () => {
    const h = new Harness({
      project: (() => {
        const project = shop({ costs: [] })
        project.resources.push({
          kind: 'resource',
          id: 'r2',
          order: 2,
          name: '木材',
          description: '',
          icon: { kind: 'builtin', value: 'coin' },
          initial: '0',
          max: 'Infinity',
          visible: true,
        })
        project.pages[0]!.entries.push({ id: 'r2', order: 3 })
        project.generators[0]!.costs = [
          { materialId: 'r1', amount: '1' },
          { materialId: 'rGone', amount: '1' },
        ]
        return project
      })(),
    })
    h.grant('r1', 1_000_000)
    expect(h.state.buy('g1')).toBe(false)
    // 好那一行也**没有**被扣：半笔扣款比整笔拒绝更难排查。
    expect(h.resource('r1').toNumber()).toBe(1_000_000)
  })
})

describe('批量 / 最大 / 自动最大购买同样拒绝（8.6 的三条路径）', () => {
  const cases: [string, string][] = [
    ['1', 'count（固定次数）'],
    ['5', 'count（一次买 5 件）'],
    ['0', 'max（最大购买）'],
    ['-1', 'free（自动最大购买）'],
  ]

  it.each(cases)('buyAmount = %s -> %s：买 0 件，材料分文不动', (buyAmount) => {
    const h = new Harness({
      project: shop({ buyAmount, max: '100', costs: [{ materialId: '', amount: '1' }] }),
    })
    h.grant('r1', 1_000_000)
    const result = h.state.batch('g1')
    expect(result?.k.toNumber()).toBe(0)
    expect(h.count('generator', 'g1', 'bought').toNumber()).toBe(0)
    expect(h.resource('r1').toNumber()).toBe(1_000_000)
  })

  it('自动最大购买阶段（8.3 第 5 步）不会绕过守卫', () => {
    const h = new Harness({ project: shop({ buyAmount: '-1', max: '100', costs: [{ materialId: '', amount: '1' }] }) })
    h.grant('r1', 1_000_000)
    for (let i = 0; i < 100; i += 1) h.state.stepTick(50, 50)
    expect(h.count('generator', 'g1', 'bought').toNumber()).toBe(0)
    expect(h.count('generator', 'g1', 'owned').toNumber()).toBe(0)
  })

  it('合法引用时自动最大购买照常工作（守住自动购买主链路）', () => {
    const h = new Harness({ project: shop({ buyAmount: '-1', max: '5', costs: [{ materialId: 'r1', amount: '1' }] }) })
    h.grant('r1', 1000)
    for (let i = 0; i < 20; i += 1) h.state.stepTick(50, 50)
    expect(h.count('generator', 'g1', 'owned').toNumber()).toBe(5)
  })
})

describe('产出目标悬空：不产出、记 `E_DANGLING_REF`（D-07 的逐行跳过是既定语义）', () => {
  it('`produces` 目标不存在时资源数量不变，但每 tick 都有诊断', () => {
    const h = new Harness({ project: shop({ produces: [{ materialId: 'rGone', amount: '1' }] }) })
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(5), '<test>')
    h.state.attrs.write('gen.g1.bought', Num.fromNumber(5), '<test>')
    for (let i = 0; i < 40; i += 1) h.state.stepTick(50, 50)
    expect(h.resource('r1').toNumber()).toBe(0)
    expect(h.state.diagnosticCount('E_DANGLING_REF')).toBeGreaterThan(0)
  })

  it('引用有效时同一台生成器就会产出（把上一条钉成“引用问题”而不是“产出坏了”）', () => {
    const h = new Harness({ project: shop({ produces: [{ materialId: 'r1', amount: '1' }] }) })
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(5), '<test>')
    h.state.attrs.write('gen.g1.bought', Num.fromNumber(5), '<test>')
    for (let i = 0; i < 40; i += 1) h.state.stepTick(50, 50)
    // 40 tick × 50ms = 2s，速率 1/s、owned = 5 -> 10。
    expect(h.resource('r1').toNumber()).toBeCloseTo(10, 6)
    expect(h.state.diagnosticCount('E_DANGLING_REF')).toBe(0)
  })
})

describe('视图模型：坏引用必须在卡片上看得见（否则按钮与结算就分家了）', () => {
  it('价格行无效：卡片没有价格行、`canBuy = false`、按钮 title 给出原因', () => {
    const h = new Harness({ project: shop() })
    h.state.stepTick(50, 50)
    const card = buildViewModel(h.state).page!.entries.find((entry) => entry.id === 'g1')!
    expect(card.costs).toEqual([])
    expect(card.canBuy).toBe(false)
    expect(card.buyBlockReason).toBe(BROKEN_PRICE_REASON)
  })

  it('引用有效：卡片给出价格行、按钮可买（守住正向路径）', () => {
    const h = new Harness({ project: shop({ costs: [{ materialId: 'r1', amount: '1' }] }) })
    h.state.stepTick(50, 50)
    // 按钮的可点性除了价格行有效还要**买得起**（`canBuy` 的材料维度）：
    // 亮着的按钮点下去结算 0 件，就是作者眼里的“买不了”。
    h.grant('r1', 10)
    const card = buildViewModel(h.state).page!.entries.find((entry) => entry.id === 'g1')!
    expect(card.costs).toHaveLength(1)
    expect(card.costs![0]!.materialId).toBe('r1')
    expect(card.canBuy).toBe(true)
    expect(card.buyBlockReason).toBeUndefined()
  })

  it('内置设置页的条目同样受守卫约束（守卫在结算层，不在视图层打补丁）', () => {
    const h = new Harness({ project: shop({ costs: [{ materialId: '', amount: '1' }] }) })
    h.state.stepTick(50, 50)
    const card = buildViewModel(h.state).page!.entries.find((entry) => entry.id === 'g1')!
    // `view-model` 与 `buyOne`/`solveBatch` 用的是同一个 `priceRowsUsable`，
    // 因此“界面上能点”与“运行时真能买”不可能分叉。
    expect(priceRowsUsable(h.state, h.generator('g1'))).toBe(false)
    expect(card.canBuy).toBe(false)
  })
})

describe('存档往返不掩盖坏引用（6.3 的顶层字段 = 当前生效值）', () => {
  it('读回存档后守卫仍然生效（不是只在开局那一刻判一次）', () => {
    const h = new Harness({ project: shop() })
    h.grant('r1', 1000)
    expect(h.state.buy('g1')).toBe(false)

    const save = serializeSave(h.state, { projectId: 'p1', projectName: '未命名项目', engineVersion: ENGINE_VERSION })
    const restored = new Harness({ project: h.state.project })
    restoreSave(restored.state, save, { project: h.state.project })
    restored.grant('r1', 1000)

    expect(priceRowsUsable(restored.state, restored.generator('g1'))).toBe(false)
    expect(restored.state.buy('g1')).toBe(false)
    expect(restored.count('generator', 'g1', 'bought').toNumber()).toBe(0)
  })
})

describe('占位值文本不会因为热更新而“被旧文本洗白”（7.4 `host:patch` 的仲裁）', () => {
  it('作者改别的字段时，上一轮就是占位值的价格仍被判为不可用', () => {
    const h = new Harness({ project: shop({ costs: [{ materialId: 'r1', amount: '10 * (1 +' }] }) })
    h.grant('r1', 1000)
    expect(h.state.attrs.isNeutralText(h.generator('g1'), 'costs[0].amount')).toBe(true)

    // 只改一个无关字段（`host:patch` 会整条替换生成器定义）。
    const patched = structuredClone(h.state.project.generators[0]!) as GeneratorDef
    patched.name = '新生成器（改名）'
    applyProjectPatches(h.state, [{ op: 'upsert', target: 'generators', id: 'g1', data: patched }])

    expect(h.state.attrs.textOr(h.state.attrs.require('gen.g1'), 'costs[0].amount')).toBe('0')
    expect(h.state.attrs.isNeutralText(h.state.attrs.require('gen.g1'), 'costs[0].amount')).toBe(true)
    expect(h.state.buy('g1')).toBe(false)
  })

  it('作者把价格改回合法文本后恢复可买（补丁路径同样撤销占位标记）', () => {
    const h = new Harness({ project: shop({ costs: [{ materialId: 'r1', amount: '10 * (1 +' }] }) })
    h.grant('r1', 100)

    const patched = structuredClone(h.state.project.generators[0]!) as GeneratorDef
    patched.costs = [{ materialId: 'r1', amount: '10' }]
    applyProjectPatches(h.state, [{ op: 'upsert', target: 'generators', id: 'g1', data: patched }])

    const generator = h.state.attrs.require('gen.g1')
    expect(h.state.attrs.isNeutralText(generator, 'costs[0].amount')).toBe(false)
    expect(h.state.buy('g1')).toBe(true)
    expect(h.resource('r1').toNumber()).toBe(90)
  })
})
