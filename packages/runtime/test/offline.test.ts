/**
 * 离线模拟（TECH_DESIGN 8.8、PRD 补充 1、R-14、R-20、D-11、12 性能预算）。
 *
 * 关键口径：
 * - 墙钟回拨**直接不结算**（`E_CLOCK_ROLLBACK`，R-20），只把 `lastSeenAt` 推到 `now`；
 * - 只结算产出，**跳过**“每秒生效”与自动购买（D-11）；
 * - 几何分段：前 10% 时间用细 tick、其余按指数放大，总预算 20000 tick；
 * - 近似产生误差时记 `E_OFFLINE_APPROX`，面板提示而非假装精确（PRD 补充 1）。
 */
import { describe, expect, it } from 'vitest'

import { Num } from '@iforge/num'
import { DEFAULT_SETTINGS, createExampleProject } from '@iforge/model'

import { DEFAULT_OFFLINE_PARAMS, geometricSegments, settleOffline } from '../src/offline.js'
import { Harness, assignToPage, createDefaultProject, withGenerator } from './helpers/harness.js'

const HOUR = 3600

/** 只有资源 `r1` 与生成器 `g1`（`owned = 10`、单价 2/s）的最小项目。 */
function economy(): Harness {
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
  const withGen = assignToPage(withGenerator({ id: 'g1', initial: '10', costs: [], produces: [{ materialId: 'r1', amount: '2' }] }, project), 'p1', [
    'r1',
    'g1',
  ])
  return new Harness({ project: withGen })
}

describe('8.8 墙钟回拨（R-20）', () => {
  it('`now < max(savedAt, lastSeenAt)` 时不结算任何产出，只推 `lastSeenAt`', () => {
    const h = economy()
    const report = settleOffline(h.state, 10_000, 10_000, 5_000)
    expect(report.settled).toBe(false)
    expect(report.rawSeconds).toBe(0)
    expect(h.resource('r1').toNumber()).toBe(0)
    expect(h.state.diagnosticCount('E_CLOCK_ROLLBACK')).toBe(1)
  })

  it('`now === max(...)` 也不结算（区间为空）', () => {
    const h = economy()
    const report = settleOffline(h.state, 10_000, 10_000, 10_000)
    expect(report.settled).toBe(false)
    expect(report.rawSeconds).toBe(0)
  })

  it('`elapsed = now - savedAt`；`lastSeenAt` 只参与回拨判定（8.8 的伪码）', () => {
    const h = economy()
    // savedAt=1000, lastSeenAt=2000, now=5000：回拨判定用 `max(...) = 2000` 通过，
    // 结算窗口用 `savedAt = 1000`，因此是 4 秒而不是 3 秒。
    const report = settleOffline(h.state, 1000, 2000, 5000)
    expect(report.rawSeconds).toBe(4)
    // 10 件 × 2/s × 4s。分段累加会带来浮点尾数，用相对容差断言（见下一条的说明）。
    expect(h.resource('r1').toNumber()).toBeCloseTo(80, 6)
  })
})

describe('8.8 离线开关与上限', () => {
  it('`offlineEnabled = false` 时只更新时间不产出', () => {
    const h = economy()
    h.state.settingsOverride.offlineEnabled = false
    const report = settleOffline(h.state, 0, 0, 10_000)
    expect(report.settled).toBe(false)
    expect(h.resource('r1').toNumber()).toBe(0)
  })

  it('超过 `offlineCap` 的部分被裁掉（项目设置 `offlineCap` 单位是**小时**）', () => {
    // 项目默认 `offlineCap = 8`（小时），因此 8 小时离线是**完整结算**的。
    expect(DEFAULT_SETTINGS.offlineCap).toBe(8)
    const h = economy()
    h.state.settingsOverride.offlineCap = 1
    const report = settleOffline(h.state, 0, 0, 5 * HOUR * 1000)
    expect(report.rawSeconds).toBe(5 * HOUR)
    expect(report.settledSeconds).toBe(HOUR)
    // 10 件 × 2/s × 3600s。
    expect(h.resource('r1').toNumber()).toBeCloseTo(10 * 2 * HOUR, 3)
  })

  it('默认参数满足 12 性能预算：段数 ≤ 2000、总 tick ≤ 20000', () => {
    expect(DEFAULT_OFFLINE_PARAMS.maxSegments).toBe(2000)
    expect(DEFAULT_OFFLINE_PARAMS.totalStepBudget).toBe(20000)
    expect(DEFAULT_OFFLINE_PARAMS.warmupRatio).toBe(0.1)
  })
})

describe('8.8 几何分段（12 性能预算）', () => {
  it('`8h` 分段：段数 ≤ `maxSegments`，总时长**不丢秒**，段长单调不减', () => {
    const segments = geometricSegments(8 * HOUR, 0.05, DEFAULT_OFFLINE_PARAMS)
    expect(segments.length).toBeLessThanOrEqual(DEFAULT_OFFLINE_PARAMS.maxSegments)
    // 关键：段数上限**不允许**吞掉离线时长——否则玩家少拿收益且毫无提示。
    const total = segments.reduce((sum, seg) => sum + seg.seconds, 0)
    expect(total).toBeCloseTo(8 * HOUR, 3)
    // 段数就是求值次数的上界，因此也满足 tick 总预算。
    expect(segments.length).toBeLessThanOrEqual(DEFAULT_OFFLINE_PARAMS.totalStepBudget)
    // 段长单调不减（最后一段可能因为兜底合并而变长，仍然不减）。
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.seconds).toBeGreaterThanOrEqual(segments[i - 1]!.seconds)
    }
  })

  it('`8h` 与 `1h` 都打满段数上限，但总时长各自完整（上限只影响粒度，不影响时长）', () => {
    const eightHours = geometricSegments(8 * HOUR, 0.05, DEFAULT_OFFLINE_PARAMS)
    const oneHour = geometricSegments(HOUR, 0.05, DEFAULT_OFFLINE_PARAMS)
    // 两者的预热段都已经超过 `maxSegments`，所以段数相同——
    // 差别只体现在最后一段有多粗（8h 的尾段吞掉的时间更多）。
    expect(eightHours.length).toBe(DEFAULT_OFFLINE_PARAMS.maxSegments)
    expect(oneHour.length).toBe(DEFAULT_OFFLINE_PARAMS.maxSegments)
    expect(eightHours[eightHours.length - 1]!.seconds).toBeGreaterThan(oneHour[oneHour.length - 1]!.seconds)
  })

  it('`elapsed = 0` 产出空分段', () => {
    expect(geometricSegments(0, 0.05, DEFAULT_OFFLINE_PARAMS)).toHaveLength(0)
  })

  it('段的总时长等于请求的 `elapsed`（不丢秒）', () => {
    const seconds = 600
    const segments = geometricSegments(seconds, 0.05, DEFAULT_OFFLINE_PARAMS)
    const total = segments.reduce((sum, seg) => sum + seg.seconds, 0)
    expect(total).toBeCloseTo(seconds, 6)
    // 分段是连续的：`startSeconds` 紧接上一段的终点。
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.startSeconds).toBeCloseTo(segments[i - 1]!.startSeconds + segments[i - 1]!.seconds, 6)
    }
  })
})

describe('8.8 只结算产出、跳过升级与自动购买（D-11）', () => {
  it('`perSecond` 升级在离线期间**不**触发', () => {
    const h = new Harness({ project: createExampleProject() })
    h.grant('r1', 1000)
    h.state.attrs.write('gen.g1.bought', Num.fromNumber(5), '<test>')
    h.state.buy('u1')
    expect(h.count('upgrade', 'u1', 'owned').toNumber()).toBe(1)
    const before = h.state.attrs.value(h.upgrade('u1'), 'effectValues[1]').toNumber()

    settleOffline(h.state, 0, 0, 60_000)
    // `u1.effectValues[1]` 由“每秒生效”写入，离线期间必须保持不变。
    expect(h.state.attrs.value(h.upgrade('u1'), 'effectValues[1]').toNumber()).toBe(before)
  })

  it('`buyAmount < 0` 的自动购买在离线期间**不**触发（D-11）', () => {
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
    const withGen = assignToPage(
      withGenerator(
        { id: 'g1', initial: '1', buyAmount: '-1', costs: [{ materialId: 'r1', amount: '1' }], produces: [{ materialId: 'r1', amount: '1' }] },
        project,
      ),
      'p1',
      ['r1', 'g1'],
    )
    const h = new Harness({ project: withGen })
    const boughtBefore = h.count('generator', 'g1', 'bought').toNumber()
    settleOffline(h.state, 0, 0, 60_000)
    expect(h.count('generator', 'g1', 'bought').toNumber()).toBe(boughtBefore)
  })

  it('不可见的生成器在离线期间不产出（按页面层级，8.4）', () => {
    const h = economy()
    h.state.attrs.write('gen.g1.visible', 'false', '<test>')
    settleOffline(h.state, 0, 0, 60_000)
    expect(h.resource('r1').toNumber()).toBe(0)
  })
})

describe('8.8 时间字段与累计（PRD 补充 1）', () => {
  it('`gameTime` 与 `offlineAccum` 各加 `elapsed`；真实游戏时间**不变**', () => {
    const h = economy()
    h.runSeconds(2)
    const realBefore = h.state.stats.realElapsed
    const playedBefore = h.state.stats.playtime
    settleOffline(h.state, 0, 0, 60_000)
    // 墙钟（harness 时钟）没有推进——`settleOffline` 自己不 sleep、不等真实时间。
    expect(h.state.stats.realElapsed).toBe(realBefore)
    expect(h.state.stats.playtime).toBe(playedBefore)
    expect(h.state.offlineAccum).toBe(60)
  })

  it('方向性：8 小时离线的产出应当**显著多于** 1 小时（PRD 补充 1 的收益单调性）', () => {
    const short = economy()
    settleOffline(short.state, 0, 0, HOUR * 1000)
    const long = economy()
    settleOffline(long.state, 0, 0, 8 * HOUR * 1000)
    expect(long.resource('r1').toNumber()).toBeGreaterThan(short.resource('r1').toNumber())
    // 上限把收益钉在有界区间：把 `offlineCap` 压到 1 小时后，8 小时与 1 小时相等。
    const capped = economy()
    capped.state.settingsOverride.offlineCap = 1
    const report = settleOffline(capped.state, 0, 0, 8 * HOUR * 1000)
    expect(report.settledSeconds).toBe(HOUR)
    expect(capped.resource('r1').toNumber()).toBe(short.resource('r1').toNumber())
  })

  it('`max` 上限在离线期间照常生效（4.4 第 4 条）', () => {
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
        max: '100',
        visible: true,
      },
    ]
    const withGen = assignToPage(
      withGenerator({ id: 'g1', initial: '10', costs: [], produces: [{ materialId: 'r1', amount: '2' }] }, project),
      'p1',
      ['r1', 'g1'],
    )
    const h = new Harness({ project: withGen })
    settleOffline(h.state, 0, 0, HOUR * 1000)
    expect(h.resource('r1').toNumber()).toBe(100)
  })

  it('离线产出在浮点精度内准确（`num` 的分层表示不丢有效位）', () => {
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
    const withGen = assignToPage(
      withGenerator({ id: 'g1', initial: '1000', costs: [], produces: [{ materialId: 'r1', amount: '1e10' }] }, project),
      'p1',
      ['r1', 'g1'],
    )
    const h = new Harness({ project: withGen })
    settleOffline(h.state, 0, 0, HOUR * 1000)
    // 1000 × 1e10 × 3600 = 3.6e16。
    //
    // 这里用**相对容差**而不是字符串相等：离线的产出是按 2000 个分段逐段累加的，
    // 浮点尾数必然累积（实测 ~1e-16 相对误差）。这属于 8.8 几何分段换性能时
    // 已经接受的近似（PRD 补充 1 要求把它**显示**给玩家，而不是假装精确）。
    const expected = 1000 * 1e10 * HOUR
    expect(Math.abs(h.resource('r1').toNumber() - expected) / expected).toBeLessThan(1e-12)

    // `1e1e10` 是**分层**字面量（10^1e10），离线结算同样能承载，只是结果巨大。
    const layered = createDefaultProject()
    layered.resources = [{ ...project.resources[0]! }]
    const layeredGen = assignToPage(
      withGenerator({ id: 'g1', initial: '1', costs: [], produces: [{ materialId: 'r1', amount: '1e1e10' }] }, layered),
      'p1',
      ['r1', 'g1'],
    )
    const h2 = new Harness({ project: layeredGen })
    settleOffline(h2.state, 0, 0, 60_000)
    expect(h2.resource('r1').isFinite()).toBe(true)
    expect(h2.resource('r1').gt(Num.fromNumber(1e10))).toBe(true)
  })
})

describe('近似误差（E_OFFLINE_APPROX，PRD 补充 1）', () => {
  it('离线结算把 `offline` 标志置起来又复位，结算期间不触发升级', () => {
    const h = new Harness({ project: createExampleProject() })
    h.grant('r1', 1000)
    h.state.attrs.write('gen.g1.bought', Num.fromNumber(5), '<test>')
    h.state.buy('u1')
    const before = h.state.attrs.value(h.upgrade('u1'), 'effectValues[1]').toNumber()
    settleOffline(h.state, 0, 0, 10_000)
    expect(h.state.flags.offline).toBe(false)
    expect(h.state.attrs.value(h.upgrade('u1'), 'effectValues[1]').toNumber()).toBe(before)
  })

  it('离线结算后 `rand()` 在正常 tick 里恢复可用（PRD 补充 1）', () => {
    const h = economy()
    settleOffline(h.state, 0, 0, 60_000)
    const after = h.state.runtime.evaluateNumber('rand()', 'field', '<test>').toNumber()
    expect(Number.isFinite(after)).toBe(true)
  })
})
