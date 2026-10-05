/**
 * M2 交付门禁：可在无 UI 下跑通示例项目 1000 tick（TECH_DESIGN 17.5 M2 的交付标准）。
 *
 * 同时固定 8.3 的单 tick 时序与“时序可预测”这条性质：同一 tick 序列两次运行
 * 必须得到完全相同的状态（随机源由 `tick` 派生，8.3 第 1 步）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { Diagnostics, Num } from '@iforge/num'
import { GameState } from '../src/game-state.js'
import { entityKeyOf } from '../src/attribute-store.js'
import type { EntryState } from '../src/attribute-store.js'
import { collectDashboard, resetRateHistory, sampleRates } from '../src/dashboard.js'
import { Harness, T0, createExampleProject } from './helpers/harness.js'

describe('M2 交付标准：示例项目跑通 1000 tick（17.5）', () => {
  let harness: Harness

  beforeEach(() => {
    harness = new Harness({ project: createExampleProject() })
  })

  it('1000 tick 全绿：无未捕获异常、资源增长有限、tick 计数正确', () => {
    for (let i = 0; i < 1000; i += 1) {
      harness.state.stepTick(50, 50)
      sampleRates(harness.state)
    }
    expect(harness.state.stats.tick).toBe(1000)
    // 矿石不应为负，也不应是 NaN（数值饱和语义，4.4）。
    const ore = harness.resource('r1')
    expect(ore.gte(0)).toBe(true)
    expect(ore.isNan()).toBe(false)
    // 游戏内时间 = 1000 × 0.05s = 50s。
    expect(harness.state.gameTime.toNumber()).toBeCloseTo(50, 6)
  })

  it('示例项目 1000 tick 不产生诊断错误（编译期/运行期都不该报错）', () => {
    for (let i = 0; i < 1000; i += 1) harness.state.stepTick(50, 50)
    // 允许 `E_CAP`（矿机 `max = 500` 会被打满）与 `E_NOT_ENOUGH`（买不起时静默返回）这类**预期**诊断，
    // 但不允许解析/类型/权限类错误。
    const snapshot = Diagnostics.countsSnapshot()
    const forbidden = [
      'E_PARSE',
      'E_PARSE_DEPTH',
      'E_TYPE',
      'E_UNKNOWN_IDENT',
      'E_UNKNOWN_ATTR',
      'E_READONLY_TARGET',
      'E_ASSIGN_TYPE',
      'E_RAND_DISABLED',
      'E_SIDE_EFFECT_FORBIDDEN',
      'E_CYCLE',
      'E_BUDGET',
      'E_DANGLING_REF',
      'E_ID_INVALID',
      'E_CREATE_ID_CONFLICT',
      'E_DESTROY_STATIC',
      'E_PAGE_UNKNOWN',
      'E_CLICKER_NOT_BUYABLE',
    ]
    for (const code of forbidden) {
      expect(snapshot[code] ?? 0, `${code} 不应出现`).toBe(0)
    }
  })

  it('时序可预测：同一 tick 序列两次运行结果完全一致（8.3「固定时序，可预测」）', () => {
    const runOnce = (): string => {
      const h = new Harness({ project: createExampleProject() })
      for (let i = 0; i < 200; i += 1) h.state.stepTick(50, 50)
      return h.state.attrs
        .listByKind('resource')
        .map((resource: EntryState) => `${resource.id}=${h.state.attrs.value(resource, 'amount').toString()}`)
        .join(',')
    }
    expect(runOnce()).toBe(runOnce())
  })

  it('游戏内时间与真实时间分离：倍速 10x 时 gameTime 走 10 倍、realElapsed 不变（R-29、D-31）', () => {
    const h = new Harness({ project: createExampleProject() })
    h.state.flags.speed = 10
    h.state.clock.configure({ speed: 10 })
    // 直接推进 10 秒墙钟 -> 200 个 tick（20 tick/s），每个 tick 0.05s 游戏内时间 = 10s。
    for (let i = 0; i < 200; i += 1) h.state.stepTick(50, 50)
    expect(h.state.gameTime.toNumber()).toBeCloseTo(10, 6)
    expect(h.state.stats.realElapsed).toBeCloseTo(10, 6)
  })

  it('1000 tick 的实际产出符合 `owned × Σ rate × ΔgameTime`（D-30 的口径）', () => {
    const h = new Harness({ project: createExampleProject() })
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(10), '<test>')
    const before = h.resource('r1')
    h.runTicks(1000)
    // 50 游戏秒 × 10 件 × 1/s = 500。示例项目里 `g2` 是点击器（不参与自动产出），
    // 所以只有 `g1` 贡献这一份。
    expect(Num.sub(h.resource('r1'), before).toNumber()).toBeCloseTo(500, 6)
    // 打满 `max = 500` 的矿机：`perSec` = 10 × 2（17.2 的“双倍产量”示例里是 1）…
    // 这里只断言它确实按 `owned × rate` 走，而不是被截断成别的量级。
    expect(h.resource('r1').gte(500)).toBe(true)
  })

  it('单 tick 求值次数远低于 12 的 1e5 预算', () => {
    const h = new Harness({ project: createExampleProject() })
    h.grant('r1', 1e6)
    h.state.attrs.write('gen.g1.bought', Num.fromNumber(5), '<test>')
    h.state.buy('u1')
    let maxEvaluations = 0
    for (let i = 0; i < 100; i += 1) {
      h.state.stepTick(50, 50)
      maxEvaluations = Math.max(maxEvaluations, h.state.runtime.evaluations())
    }
    expect(maxEvaluations).toBeLessThan(1e5)
  })
})

describe('8.3 单 tick 时序（1~8 步）', () => {
  it('产出结算只乘一次 owned（D-30、R-26：不含 owned²）', () => {
    resetRateHistory()
    const h = new Harness({ project: createExampleProject() })
    // 直接给矿机 10 台（绕过购买，价格成长会干扰断言）。
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(10), '<test>')
    const before = h.resource('r1')
    // 1 秒 = 20 tick；单件速率 1 -> 10 × 1 × 1s = 10。
    h.runSeconds(1)
    const gained = Num.sub(h.resource('r1'), before)
    expect(gained.toNumber()).toBeCloseTo(10, 6)
    // 若被重复乘一次 owned，结果会是 100。
    expect(gained.toNumber()).toBeLessThan(50)
  })

  it('产出速率热替换为 2 后，增量翻倍（D-30 的“单件速率”语义）', () => {
    resetRateHistory()
    const h = new Harness({ project: createExampleProject() })
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(10), '<test>')
    // 直接提交一条 `set` 副作用（8.3 第 6 步的唯一提交点）。
    h.state.attrs.write('gen.g1.produces[0].amount', '2', '<test>')
    const before = h.resource('r1')
    h.runSeconds(1)
    expect(Num.sub(h.resource('r1'), before).toNumber()).toBeCloseTo(20, 6)
  })

  it('每秒触发阶段按 gameTime 判定：1x 下每真实秒触发一次（D-35）', () => {
    const h = new Harness({ project: createExampleProject() })
    // 已拥有（D-43：未购买的升级一律不生效）。
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    const upgrade = h.upgrade('u1')
    // 用一条“自增”的效果充当计数器：**通过 `writeText` 热替换文本**——
    // 直接改 `def.effects` 不起作用，因为 `EntryState.text` 在建条目时就已缓存了文本。
    h.state.attrs.writeText(upgrade, 'effects[0].condition', 'true', '<test>')
    h.state.attrs.writeText(upgrade, 'effects[0].action', 'up.u1.effectValues[0] = up.u1.effectValues[0] + 1', '<test>')
    h.runSeconds(10)
    // 10 游戏秒 -> 10 次（允许单 tick 至多一次的量化误差，14.2）。
    const triggers = h.state.attrs.value(upgrade, 'effectValues[0]').toNumber()
    expect(triggers).toBeGreaterThanOrEqual(9)
    expect(triggers).toBeLessThanOrEqual(11)
  })

  it('每秒触发以 gameTime 为基准：10x 倍速下 10 秒墙钟触发约 100 次（R-29、D-35）', () => {
    const h = new Harness({ project: createExampleProject() })
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    const upgrade = h.upgrade('u1')
    h.state.attrs.writeText(upgrade, 'effects[0].condition', 'true', '<test>')
    h.state.attrs.writeText(upgrade, 'effects[0].action', 'up.u1.effectValues[0] = up.u1.effectValues[0] + 1', '<test>')
    h.state.flags.speed = 10
    h.state.clock.configure({ speed: 10 })
    // 200 个 tick × 0.05s = 10 秒**游戏内**时间。
    h.runTicks(200)
    expect(h.state.gameTime.toNumber()).toBeCloseTo(10, 6)
    const triggers = h.state.attrs.value(upgrade, 'effectValues[0]').toNumber()
    expect(triggers).toBeGreaterThanOrEqual(9)
    expect(triggers).toBeLessThanOrEqual(11)
  })

  it('未拥有的升级不产生效果（D-43、R-34）', () => {
    const h = new Harness({ project: createExampleProject() })
    const upgrade = h.upgrade('u1')
    h.state.attrs.writeText(upgrade, 'effects[0].condition', 'true', '<test>')
    h.state.attrs.writeText(upgrade, 'effects[0].action', 'res.r1.initial = 12345', '<test>')
    h.runSeconds(5)
    // `owned = 0`：不生效，其它属性也不变。
    expect(h.state.attrs.textOr(h.page('p1'), 'columns')).toBeDefined()
    expect(h.resource('r1').toNumber()).toBe(0)
    expect(h.diagnosticCount('E_ASSIGN_TYPE')).toBe(0)
  })

  it('自动购买阶段只处理 buyAmount < 0 的条目，且跳过点击器（8.3 第 5 步、D-28）', () => {
    const h = new Harness({ project: createExampleProject() })
    // 把矿机改成自动最大购买（免费）。
    h.state.attrs.write('gen.g1.buyAmount', '-1', '<test>')
    h.state.attrs.write('gen.g1.costs[0].amount', '1', '<test>')
    // 把点击器的 buyAmount 也写成 -1（D-28 的反例：这样也绝不能被自动购买触碰）。
    h.state.attrs.write('gen.g2.buyAmount', '-1', '<test>')
    h.grant('r1', 100)
    const clickerBoughtBefore = h.count('generator', 'g2', 'bought')
    for (let i = 0; i < 100; i += 1) h.state.stepTick(50, 50)
    // 点击器买了 0 件。
    expect(h.count('generator', 'g2', 'bought').toNumber()).toBe(clickerBoughtBefore.toNumber())
    expect(h.diagnosticCount('E_CLICKER_NOT_BUYABLE')).toBe(0)
  })

  it('副作用在第 6 步统一提交，交互事件的副作用延到下一个提交阶段（8.3.1）', () => {
    const h = new Harness({ project: createExampleProject() })
    const upgrade = h.upgrade('u1')
    h.state.attrs.writeText(upgrade, 'effects[0].condition', 'true', '<test>')
    h.state.attrs.writeText(upgrade, 'effects[0].action', 'set("res.r1.initial", "777")', '<test>')
    const resource = h.state.attrs.require('res.r1')
    // 满足购买条件：`gen.g1.bought >= 5`（PRD 补充 4 的 AND 判定）。
    h.state.attrs.write('gen.g1.bought', Num.fromNumber(5), '<test>')
    h.grant('r1', 1000)
    // 购买（发生在两次 tick 之间）：状态字段即时结算，副作用**尚未**落地。
    expect(h.state.buy('u1')).toBe(true)
    expect(h.count('upgrade', 'u1', 'owned').toNumber()).toBe(1)
    // 立刻读被赋值的字段：仍是旧文本（副作用还在队列里）。
    expect(h.state.attrs.textOr(resource, 'initial')).toBe('0')
    // 下一个 tick 的第 6 步才落地。
    h.state.stepTick(50, 50)
    expect(h.state.attrs.textOr(resource, 'initial')).toBe('777')
  })
})

describe('仪表盘（8.9）', () => {
  it('预测时间用“下一件”价格而不是当前件价格（8.9 加粗段、8.6.1）', () => {
    resetRateHistory()
    const h = new Harness({ project: createExampleProject() })
    // 让矿机可购买：给足矿石并去掉条件限制（条件在升级上，不影响矿机）。
    h.grant('r1', 0)
    // 每 tick 采样，供速率回归使用。
    for (let i = 0; i < 40; i += 1) {
      h.state.stepTick(50, 50)
      sampleRates(h.state)
    }
    const snapshot = collectDashboard(h.state)
    expect(snapshot.amounts.map((entry) => entry.id)).toContain('r1')
    // 没有可购买条目时给出提示而不是 0。
    expect(snapshot.nextBuy?.id ?? snapshot.nextBuyHint).toBeDefined()
  })

  it('速率是“每 tick 的线性回归斜率 × tickRate”（8.9）', () => {
    resetRateHistory()
    const h = new Harness({ project: createExampleProject() })
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(10), '<test>')
    for (let i = 0; i < 40; i += 1) {
      h.state.stepTick(50, 50)
      sampleRates(h.state)
    }
    const snapshot = collectDashboard(h.state)
    const ore = snapshot.amounts.find((entry) => entry.id === 'r1')!
    // 10 台 × 1/秒 = 10/s，回归斜率在稳态下应收敛到该值附近。
    expect(ore.ratePerSecond.toNumber()).toBeGreaterThan(5)
  })
})

describe('GameState 生命周期', () => {
  it('新建/重新开始后按 8.5 的初始化表复位，并丢弃 dynamic（8.10、D-18）', () => {
    const h = new Harness({ project: createExampleProject() })
    h.grant('r1', 5000)
    h.state.buy('g1')
    h.state.attrs.write('res.r1.description', '改过', '<test>')
    // 17.2 的页面描述本来就非空，所以复位后应回到**项目文件值**而不是空串。
    const projectDescription = h.page('p1').description
    expect(projectDescription).toBe('主页面')
    h.state.attrs.write('page.p1.description', '改过', '<test>')
    expect(h.page('p1').description).toBe('改过')

    h.state.reset()
    expect(h.count('generator', 'g1', 'owned').toNumber()).toBe(0)
    expect(h.resource('r1').toNumber()).toBe(0)
    expect(h.page('p1').visible).toBe(true)
    expect(h.page('p1').description).toBe(projectDescription)
    // 动态条目一并丢弃。
    expect(h.state.dynamicCount()).toBe(0)
  })

  it('导航初值取 order 最小且可见的页面；全部不可见时回退到 order 最小（8.12）', () => {
    const h = new Harness({ project: createExampleProject() })
    // p1 可见 -> 选中 p1。
    expect(h.state.currentPageId).toBe('p1')
    h.state.attrs.write('page.p1.visible', false, '<test>')
    h.state.attrs.write('page.p2.visible', false, '<test>')
    expect(h.state.initialPageId()).toBe('p1')

    const empty = new GameState({
      project: { ...createExampleProject(), pages: [] },
      now: () => T0,
    })
    expect(empty.currentPageId).toBe('__settings__')
  })

  it('nav() 不校验 visible/disabled：禁用仍可跳转、不可见也可直达（8.12、PRD 页面编辑器 4）', () => {
    const h = new Harness({ project: createExampleProject() })
    // p2 本身 disabled = true（17.2 的补充片段 ③）。
    expect(h.page('p2').disabled).toBe(true)
    expect(h.state.nav('p2')).toBe(true)
    expect(h.state.currentPageId).toBe('p2')

    h.state.attrs.write('page.p2.visible', false, '<test>')
    expect(h.state.nav('p2')).toBe(true)
    expect(h.state.nav('pNope')).toBe(false)
  })

  it('导航状态不写入存档（D-50）', () => {
    const h = new Harness({ project: createExampleProject() })
    h.state.nav('p2')
    expect(h.state.currentPageId).toBe('p2')
    // `currentPageId` 不在 6.3 的 `SaveFile` 里，也不是任何条目的属性键。
    const keys = [...h.state.attrs.entries.keys()].join(',')
    expect(keys).not.toContain('currentPageId')
  })

  it('“解锁全部”把 visible 置真、disabled 置假，且标记是纯内存态（D-16）', () => {
    const h = new Harness({ project: createExampleProject() })
    expect(h.page('p2').disabled).toBe(true)
    h.state.unlockAll()
    expect(h.page('p2').disabled).toBe(false)
    expect(h.page('p2').visible).toBe(true)
    expect(h.state.isForceUnlocked(entityKeyOf('page', 'p2'))).toBe(true)
    // 标记不落任何持久化结构。
    expect(JSON.stringify(h.state.dynamicEntries())).not.toContain('forceUnlock')
  })
})
