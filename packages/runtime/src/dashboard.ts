/**
 * 仪表盘数据（TECH_DESIGN 8.9）。
 *
 * 两项数据：
 * 1. **增长速度**：对每个资源维护 `rate` = 最近 20 tick 的 `amount` 线性回归斜率，展示 `+x/s`；
 * 2. **下一个可购买条目的预测时间**：只对**当前可购买**的条目预测。
 *
 * ## 预测时间的两处易错点
 *
 * - **`cost_m` 取“下一件”的单件价格，不是当前件**（8.9 的加粗段）：用只读等级视图取
 *   `j = target.bought + 1`。用 `bought` 级价格会让预测早于真实可购买时刻——
 *   `bought = 0` 时 `P(0)` 与 `P(1)` 在陡峭价格下相差一个数量级。
 * - **免费模式直接显示“现在”**：`buyAmount < 0`（自动最大购买、免费）不消耗材料，
 *   `dt` 恒为 `0`，不参与价格与速率推算。
 *
 * 以下情形显示 `—`：无可购买条目、相关材料产出速率为 0、已达数量上限、
 * 升级条件不满足、**点击器**（不可购买，否则会给出永远无法兑现的倒计时）。
 */
import { Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'
import { levelOverlayKey, levelOverlayReader } from '@iforge/expr'
import type { Value } from '@iforge/expr'

import type { EntryState } from './attribute-store.js'
import { entityKeyOf, costsOf } from './attribute-store.js'
import type { GameState } from './game-state.js'
import { modeOf } from './purchase.js'

/** 线性回归的窗口（8.9：最近 20 tick）。 */
export const RATE_WINDOW = 20

/** 资源增长速度的采样历史。 */
class RateHistory {
  /** 每个资源保留最近 `RATE_WINDOW` 个 (tick, amount) 样本。 */
  private readonly samples = new Map<string, { tick: number; amount: Decimal }[]>()

  push(resourceKey: string, tick: number, amount: Decimal): void {
    const list = this.samples.get(resourceKey) ?? []
    list.push({ tick, amount })
    // 超出窗口就丢最旧的：保持“最近 20 tick”的语义（D-49 允许近似，但不能无限增长）。
    while (list.length > RATE_WINDOW) list.shift()
    this.samples.set(resourceKey, list)
  }

  /** 线性回归斜率（Decimal 差分，8.9「Decimal 差分」）。 */
  slope(resourceKey: string): Decimal {
    const list = this.samples.get(resourceKey)
    if (!list || list.length < 2) return Num.fromNumber(0)
    const n = list.length
    // 用最小二乘：`slope = Σ(t−t̄)(a−ā) / Σ(t−t̄)²`。t 是等间隔 tick，故可简化为闭式。
    let sumT = 0
    let sumA = Num.fromNumber(0)
    for (const sample of list) {
      sumT += sample.tick
      sumA = Num.add(sumA, sample.amount)
    }
    const meanT = sumT / n
    const meanA = Num.div(sumA, Num.fromNumber(n))
    let numerator = Num.fromNumber(0)
    let denominator = 0
    for (const sample of list) {
      const dt = sample.tick - meanT
      const da = Num.sub(sample.amount, meanA)
      numerator = Num.add(numerator, Num.mul(Num.fromNumber(dt), da))
      denominator += dt * dt
    }
    if (denominator === 0) return Num.fromNumber(0)
    // 斜率是“每 tick”，换算成“每秒”需要乘 tickRate。
    return Num.div(numerator, Num.fromNumber(denominator))
  }

  clear(): void {
    this.samples.clear()
  }
}

/** 仪表盘快照（8.9；游戏视图的 Dashboard 组件消费，8.11）。 */
export interface DashboardSnapshot {
  /** 各资源的当前数量。 */
  amounts: { id: string; name: string; amount: Decimal; ratePerSecond: Decimal }[]
  /** 下一个可购买条目的预测时间（秒）；无候选为 `undefined`（UI 显示 `—`）。 */
  nextBuy?: {
    id: string
    name: string
    /** 距现在多少秒。 */
    dt: Decimal
  }
  /** 候选为空时的原因（悬浮提示，8.9 的 `—` 分支）。 */
  nextBuyHint?: string
}

const history = new RateHistory()

/** 清空采样历史（“重新开始”/ 载入项目）。 */
export function resetRateHistory(): void {
  history.clear()
}

/** 记录一次采样（由 `GameState.stepTick` 在产出结算后调用）。 */
export function sampleRates(state: GameState): void {
  for (const resource of state.attrs.listByKind('resource')) {
    if (!state.judge.isVisible(resource)) continue
    history.push(entityKeyOf('resource', resource.id), state.stats.tick, state.attrs.value(resource, 'amount'))
  }
}

/**
 * 采集仪表盘数据（8.9）。
 *
 * @param tickRate 有效帧率（把“每 tick 的斜率”换算成“每秒”）
 */
export function collectDashboard(state: GameState): DashboardSnapshot {
  const settings = state.effectiveSettings()
  const amounts = state.attrs
    .listByKind('resource')
    .filter((resource) => state.judge.isVisible(resource))
    .map((resource) => ({
      id: resource.id,
      name: resource.def.name,
      amount: state.attrs.value(resource, 'amount'),
      ratePerSecond: Num.mul(history.slope(entityKeyOf('resource', resource.id)), Num.fromNumber(settings.tickRate)),
    }))

  const rateByResource = new Map(amounts.map((entry) => [`res.${entry.id}`, entry.ratePerSecond]))
  let best: { id: string; name: string; dt: Decimal } | undefined
  let hint: string | undefined

  const candidates: EntryState[] = [...state.attrs.listByKind('generator'), ...state.attrs.listByKind('upgrade')].filter((entry) =>
    state.judge.canBuy(entry),
  )

  if (candidates.length === 0) {
    hint = candidatesHint(state)
  }

  for (const candidate of candidates) {
    const buyAmount = state.attrs.fieldValue(candidate, 'buyAmount')
    const mode = modeOf(buyAmount)
    if (mode === 'free') {
      // 免费模式：`dt` 恒为 0（“现在”），不因材料不足而递增（8.9 的加粗段）。
      const dt = Num.fromNumber(0)
      if (!best || dt.lt(best.dt)) best = { id: candidate.id, name: candidate.def.name, dt }
      continue
    }
    const entity = entityKeyOf(candidate.kind, candidate.id)
    const bought = state.attrs.value(candidate, 'bought')
    // **下一件**的价格：只读等级视图 `j = bought + 1`（8.9 的加粗段、8.6.1）。
    const read = levelOverlayReader(state.attrs.read, `${entity}.bought`, Num.add(bought, Num.fromNumber(1)) as Value)
    const overlay = levelOverlayKey(`${entity}.bought`, Num.add(bought, Num.fromNumber(1)))

    let worst = Num.fromNumber(0)
    let blocked = false
    const costCount = costsOf(candidate).length
    for (let index = 0; index < costCount; index += 1) {
      const materialId = state.attrs.textOr(candidate, `costs[${index}].materialId`)
      const material = state.attrs.find(entityKeyOf('resource', materialId))
      if (!material) {
        blocked = true
        break
      }
      const price = state.runtime.evaluateNumber(
        state.attrs.textOr(candidate, `costs[${index}].amount`),
        'price',
        `${entity}.costs[${index}].amount`,
        { read, overlayKey: overlay },
      )
      const have = state.attrs.value(material, 'amount')
      const rate = rateByResource.get(entityKeyOf('resource', materialId)) ?? Num.fromNumber(0)
      if (!rate.gt(0)) {
        // 材料产出速率为 0 → 永远不会买得起（8.9 的 `—` 分支）。
        blocked = true
        break
      }
      const need = Num.sub(price, have)
      const dt = need.lte(0) ? Num.fromNumber(0) : Num.div(need, rate)
      // 多材料取各材料 `dt` 的**最大**值，即“全部材料都能付得起”的时刻（8.9）。
      if (dt.gt(worst)) worst = dt
    }
    if (blocked) continue
    if (!best || worst.lt(best.dt)) best = { id: candidate.id, name: candidate.def.name, dt: worst }
  }

  return best ? { amounts, nextBuy: best } : { amounts, nextBuyHint: hint ?? '无可购买条目' }
}

/** 候选为空的常见原因（UI 悬浮提示，8.9）。 */
function candidatesHint(state: GameState): string | undefined {
  const generators = state.attrs.listByKind('generator')
  const upgrades = state.attrs.listByKind('upgrade')
  const clickers = generators.filter((entry) => state.judge.isClicker(entry))
  const capped = [...generators, ...upgrades].filter((entry) => {
    if (!state.judge.isVisible(entry) || state.judge.isDisabled(entry)) return false
    return state.attrs.value(entry, 'owned').gte(state.attrs.capOf(entry))
  })
  if (capped.length > 0) return '已达上限'
  if (clickers.length > 0 && generators.length === clickers.length) return '只有点击器（不可购买）'
  return '无可购买条目'
}
