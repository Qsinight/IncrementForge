/**
 * 离线模拟（TECH_DESIGN 8.8、D-10、D-11、D-49、R-14、R-20）。
 *
 * ```
 * settleOffline(savedAt):
 *   now = wallClock()
 *   if now < max(savedAt, lastSeenAt) → 记诊断 E_CLOCK_ROLLBACK；不结算；只把 lastSeenAt 推到 now；return
 *   if !settings.offlineEnabled → 只更新时间戳
 *   elapsed = clamp(now − savedAt, 0, offlineCap·3600)
 *   segments = geometricSegments(elapsed, baseStep=1000/tickRate, maxSegments=2000, totalStepBudget=20000)
 *   offline = true
 *   for seg in segments:
 *      runProductionPhase(dt)
 *      skipPerSecondUpgrades()          // 离线不触发升级“每秒生效”（PRD 设置页 9）
 *      skipAutoBuy()                   // 离线不触发自动最大购买
 *   offline = false
 *   gameTime += elapsed; offlineAccum += elapsed
 * ```
 *
 * ## 三条必须成立的语义
 *
 * 1. **随机禁用**（PRD 补充 1）：`flags.offline = true` 时 `ExpressionRuntime` 注入的随机源
 *    是 `createOfflineRandomSource()`，调用即抛 `E_RAND_DISABLED`，由 last-good 兜住。
 * 2. **每秒生效与自动购买都不触发**（PRD 设置页 9 给出的“离线收益低于在线”的真正依据）：
 *    因此离线期间不产生**任何**副作用，`effect` 上下文不可达（5.4 的“离线 ✅ 读法说明”）。
 * 3. **墙钟回拨不结算**（R-20）：`now < max(savedAt, lastSeenAt)` 说明系统时间被往回改，
 *    此时结算要么白跑一次、要么在往复中反复吃到同一段时间。因此固定为：**不结算任何离线收益、
 *    不推进 `gameTime`/`offlineAccum`、只把 `lastSeenAt` 推到 `now` 并记 `E_CLOCK_ROLLBACK`**。
 *
 * ## 分段精度与误差方向（D-49）
 *
 * 分段只引入“段内产出速率不变”的假设。按速率趋势：
 * - **单调递增** → 分段结果恒 ≤ 逐 tick 真值（下界）；
 * - **单调递减** → 分段结果 ≥ 逐 tick 真值（上界/高估），记 `E_OFFLINE_APPROX`；
 * - **非单调** → 无方向保证，记 `E_OFFLINE_APPROX`。
 *
 * 注意“离线收益低于在线”**不是**由分段精度保证的（D-49 修正原表述）：它来自上面第 2 条
 * （不含随机/每秒生效/自动购买）。本文档**不**引入 PRD 未定义的额外打折系数（D-11）。
 */
import { Diagnostics, Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'

import { entityKeyOf } from './attribute-store.js'
import type { EntryState } from './attribute-store.js'
import type { GameState } from './game-state.js'
import { produceOnce } from './production.js'
import type { VisibilitySnapshot } from './visibility.js'

/** 离线分段参数（8.8 的伪码）。 */
export interface OfflineParams {
  /** 段数上限。 */
  maxSegments: number
  /** 总步数预算（超预算时本段截断、剩余时间顺延到下次结算）。 */
  totalStepBudget: number
  /** 前 10% 时间保持 `baseStep` 不加速（8.8 约束 ②）。 */
  warmupRatio: number
}

export const DEFAULT_OFFLINE_PARAMS: OfflineParams = {
  maxSegments: 2000,
  totalStepBudget: 20000,
  warmupRatio: 0.1,
}

/** 一个离线的分段。 */
export interface OfflineSegment {
  /** 段时长（秒）。 */
  seconds: number
  /** 段内的 `gameTime` 起点（秒）。 */
  startSeconds: number
}

/** 一次离线结算的结果（8.8 的提示条消费，8.10）。 */
export interface OfflineReport {
  /** 是否实际结算了收益。 */
  settled: boolean
  /** 真实经过秒数。 */
  rawSeconds: number
  /** 实际结算秒数（被 `offlineCap` 截断后）。 */
  settledSeconds: number
  /** 结算前后的各资源增量。 */
  gains: { resourceId: string; gained: Decimal }[]
  /** 段数。 */
  segments: number
  /** 是否因墙钟回拨而未结算（R-20）。 */
  clockRollback: boolean
  /** 是否记了 `E_OFFLINE_APPROX`（速率递减/非单调，D-49）。 */
  approximate: boolean
  /** 是否因段数/步数预算而截断（剩余时间顺延，8.8 约束 ①）。 */
  truncated: boolean
}

/**
 * 几何分段（8.8 的 `geometricSegments`）。
 *
 * 前 `warmupRatio` 的时间保持 `baseStep` 不加速；此后步长按 `sqrt` 几何增长，
 * 段数与总步数都不超过上限。这样短离线几乎精确，长离线也不会因为 `8h × 20 tick/s
 * = 576000` 个 tick 而超时（12 性能预算：8h 结算 < 300ms）。
 */
export function geometricSegments(totalSeconds: number, baseStepSeconds: number, params: OfflineParams): OfflineSegment[] {
  if (totalSeconds <= 0) return []
  const segments: OfflineSegment[] = []
  let remaining = totalSeconds
  let start = 0
  const warmup = totalSeconds * params.warmupRatio
  // 浮点累加的收尾容差：分段是加法，`1e-9` 以内的残差不算“剩余时间”。
  const EPSILON = 1e-9

  // ① 预热段：`baseStep` 粒度（受段数上限约束）。
  //
  // 注意预热段**本身就可能超预算**：`8h × 10% = 2880s`，除以 `baseStep = 0.05s`
  // 需要 57600 段，远超 `maxSegments = 2000`。所以第 ③ 步的兜底不是可选的保险，
  // 而是这段逻辑能工作的前提。
  while (remaining > EPSILON && start < warmup && segments.length < params.maxSegments) {
    const step = Math.min(baseStepSeconds, remaining, warmup - start)
    if (step <= 0) break
    segments.push({ seconds: step, startSeconds: start })
    remaining -= step
    start += step
  }

  // ② 粗粒度段：步长按几何增长。段数本身就是“求值次数”的上界
  //（每段一次 `runProductionPhase`），因此 `totalStepBudget` 不再是额外的循环条件——
  // 它由 `maxSegments` 保证（2000 < 20000）。
  let step = baseStepSeconds
  while (remaining > EPSILON && segments.length < params.maxSegments) {
    const take = Math.min(step, remaining)
    segments.push({ seconds: take, startSeconds: start })
    remaining -= take
    start += take
    step *= 1.35
  }

  // ③ 兜底：**把剩余时长并入最后一段**，绝不让 `elapsed` 被悄悄截断。
  //
  // 少算时间 = 少给玩家收益，而且没有任何提示（唯一的信号是收益偏小）。
  // 与其那样，不如让最后一段的 `dt` 变粗：分段越粗，越接近“按平均速率一次算完”，
  // 而这本来就是 8.8 用几何分段换性能时接受的近似（PRD 补充 1 记 `E_OFFLINE_APPROX`）。
  if (remaining > EPSILON) {
    const last = segments[segments.length - 1]
    if (last) last.seconds += remaining
    else segments.push({ seconds: remaining, startSeconds: 0 })
  }
  return segments
}

/**
 * 离线结算（8.8）。
 *
 * @param savedAt 上次存档的墙钟（ms）
 * @param lastSeenAt 上次见到的墙钟（ms）
 * @param now 当前墙钟（ms）
 */
export function settleOffline(
  state: GameState,
  savedAt: number,
  lastSeenAt: number,
  now: number,
  params: OfflineParams = DEFAULT_OFFLINE_PARAMS,
): OfflineReport {
  const settings = state.effectiveSettings()
  const resourceKeys = state.attrs
    .listByKind('resource')
    .filter((resource) => state.judge.isVisible(resource))
    .map((resource) => entityKeyOf('resource', resource.id))
  const before = new Map<string, Decimal>()
  for (const key of resourceKeys) {
    const resource = state.attrs.find(key)
    if (resource) before.set(key, state.attrs.value(resource, 'amount'))
  }

  const gainsOf = (): { resourceId: string; gained: Decimal }[] =>
    resourceKeys.map((key) => {
      const resource = state.attrs.find(key)
      const now2 = resource ? state.attrs.value(resource, 'amount') : Num.fromNumber(0)
      return { resourceId: resource?.id ?? key, gained: Num.sub(now2, before.get(key) ?? Num.fromNumber(0)) }
    })

  // ---- 墙钟回拨：不结算任何收益（8.8 伪码第 2 行、R-20）----
  if (now < Math.max(savedAt, lastSeenAt)) {
    Diagnostics.record('E_CLOCK_ROLLBACK', 'offline', `系统时间被回拨（now=${now} < ${Math.max(savedAt, lastSeenAt)}），本次未结算离线收益`)
    return {
      settled: false,
      rawSeconds: 0,
      settledSeconds: 0,
      gains: gainsOf(),
      segments: 0,
      clockRollback: true,
      approximate: false,
      truncated: false,
    }
  }

  const rawSeconds = Math.max(0, (now - savedAt) / 1000)
  if (!settings.offlineEnabled || rawSeconds <= 0) {
    return {
      settled: false,
      rawSeconds,
      settledSeconds: 0,
      gains: gainsOf(),
      segments: 0,
      clockRollback: false,
      approximate: false,
      truncated: false,
    }
  }

  // `elapsed` 被 `offlineCap` 截断；剩余时间**不累计**（8.8：避免下次再结算同一段时间）。
  const capSeconds = settings.offlineCap * 3600
  const elapsed = Math.min(rawSeconds, capSeconds)
  const truncated = rawSeconds > elapsed

  const baseStep = 1 / settings.tickRate
  const segments = geometricSegments(elapsed, baseStep, params)

  const generators = state.attrs.listByKind('generator')
  state.flags.offline = true
  let approximate = false
  try {
    for (const segment of segments) {
      // 8.3 的判定快照在离线同样适用（页面继承，8.4）。
      const snapshot: VisibilitySnapshot = state.judge.snapshot(generators)
      const dt = Num.fromNumber(segment.seconds)
      for (const generator of generators) {
        if (state.judge.isClicker(generator)) continue
        if (!snapshot.canSettle('generator', generator.id)) continue
        const owned = state.attrs.value(generator, 'owned')
        if (!owned.gt(0)) continue
        produceOnce(state, generator, owned, dt)
      }
      // 离线**不**触发：升级“每秒生效”、自动最大购买（PRD 设置页 9、8.8）。
      // 因此离线期间不产生任何副作用，`effect` 上下文不可达（5.4）。
    }
  } finally {
    state.flags.offline = false
  }

  // 误差方向判定（D-49）：速率递减/非单调时高估，给出诊断与方向说明。
  approximate = detectApproximation(state, generators, baseStep)
  if (approximate) {
    Diagnostics.record('E_OFFLINE_APPROX', 'offline', '离线为近似结算：产出速率递减或非单调，误差方向可能为正（建议把速率写成非递减形式）')
  }

  // `gameTime` 与 `offlineAccum` 按**离线时长**推进（8.8 末两行）。
  state.gameTime = Num.add(state.gameTime, Num.fromNumber(elapsed))
  state.offlineAccum += elapsed

  return {
    settled: true,
    rawSeconds,
    settledSeconds: elapsed,
    gains: gainsOf(),
    segments: segments.length,
    clockRollback: false,
    approximate,
    truncated,
  }
}

/**
 * 判定本次分段结算的误差方向（8.8 的 ①、D-49）。
 *
 * 在若干采样点上比较“速率是否非递减”：单调递增 → 分段是**下界**（无需诊断）；
 * 递减或非单调 → 上界/无方向，记 `E_OFFLINE_APPROX`。
 */
function detectApproximation(state: GameState, generators: readonly EntryState[], baseStep: number): boolean {
  const samples = [0, 1, 2, 5, 8, 13]
  let previous: Decimal | undefined
  for (const step of samples) {
    state.runtime.beginTick(state.stats.tick + step, true)
    let total = Num.fromNumber(0)
    for (const generator of generators) {
      if (state.judge.isClicker(generator)) continue
      if (!state.judge.canProduce(generator)) continue
      const owned = state.attrs.value(generator, 'owned')
      if (!owned.gt(0)) continue
      const rate = state.attrs.perSecond(generator)
      if (rate.gt(0)) total = Num.add(total, Num.mul(rate, Num.fromNumber(baseStep)))
    }
    if (previous !== undefined && total.lt(previous)) return true
    previous = total
  }
  return false
}
