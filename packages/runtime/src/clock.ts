/**
 * 主循环的时间累积（TECH_DESIGN 8.2）。
 *
 * ## 为什么循环在 `packages/*` 里而不在 DOM 层
 *
 * 3.2 规定 `packages/*` **不允许导入 DOM API**（`persist`/`ui-kit` 除外），因此
 * `requestAnimationFrame` 不能出现在 `runtime` 包内。但 8.2 的核心逻辑——单帧步数、
 * 累加器、时间倍速、`MAX_STEPS_PER_FRAME` 丢弃积压——是**纯算术**，完全可以与“帧从哪里来”解耦：
 * `FrameClock.advance(now)` 只接收一个毫秒时间戳，DOM 侧（M4 的预览 iframe / M5 的打包版）
 * 只负责提供 `now`。
 *
 * ## 两套时间基准必须分开（8.2「两套时间基准」、R-29、D-35）
 *
 * - `gameTime`：**游戏内时间**，随 `flags.speed` 放大，供 `time` 变量、升级“每秒生效”、产出推进使用；
 * - `realElapsed`：**真实时间**，不放大，供自动存档间隔与 `elapsed` 使用。
 *
 * 任何“每秒 / 每 N 秒”的周期性逻辑**一律以 `gameTime` 为准**，禁止使用 rAF 的 `now`，
 * 否则 `10×` 倍速下游戏内过了 10 秒却只触发 1 次，周期逻辑与产出速率、`time` 变量互相矛盾。
 */
import { Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'

/** 单帧最多推进的 tick 数（8.2：超出的积压直接丢弃，防死亡螺旋）。 */
export const MAX_STEPS_PER_FRAME = 512

/** 一个 tick 计划的描述。 */
export interface TickPlan {
  /** 本帧要推进的 tick 数。 */
  count: number
  /** 每个逻辑帧的时长（ms，`1000 / tickRate`）。 */
  stepMs: number
  /** 本帧真实时间在各个 tick 间**均摊**的份额（ms）。倍速不放大它。 */
  realShareMs: number
  /** 是否因为触顶而丢弃了积压（UI 提示用，8.2 末句）。 */
  droppedBacklog: boolean
  /** 本帧消耗的真实时间（ms，已被 `maxFrameStep` 夹取）。 */
  realDtMs: number
}

/** 帧时钟配置（有效值 = 项目默认 ⊕ 会话覆盖，D-22）。 */
export interface ClockConfig {
  tickRate: number
  /** 单帧最大步长（ms）。 */
  maxFrameStep: number
  speed: number
}

export class FrameClock {
  /** 累加器（ms，已按倍速放大）。 */
  private accumulator = 0
  /** 上一帧的真实时间戳（ms）。 */
  private lastFrameAt: number | undefined

  constructor(private config: ClockConfig) {}

  /** 更新有效配置（游戏内设置页改动即时生效，7.7）。 */
  configure(config: Partial<ClockConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /** 当前配置（诊断面板展示）。 */
  current(): ClockConfig {
    return { ...this.config }
  }

  /**
   * 推进到 `now` 并给出本帧的 tick 计划（8.2 的 `frame(now)` 前半段）。
   *
   * @param now 真实墙钟时间戳（ms，单调）。`performance.now()` 即可（R-20）。
   * @param paused 暂停时只返回 0 步，保留渲染（8.2 第 1 行、7.1）。
   */
  advance(now: number): TickPlan {
    const stepMs = 1000 / this.config.tickRate
    const previous = this.lastFrameAt
    this.lastFrameAt = now
    if (previous === undefined) {
      // 首帧只对齐时间基准，不推进（否则首帧的 `now - 0` 会是天文数字）。
      return { count: 0, stepMs, realShareMs: 0, droppedBacklog: false, realDtMs: 0 }
    }

    // 单帧最大步长：防后台标签页回来后暴走。
    const realDtMs = Math.min(now - previous, this.config.maxFrameStep)
    if (pausedGuard(realDtMs)) {
      return { count: 0, stepMs, realShareMs: 0, droppedBacklog: false, realDtMs: 0 }
    }

    // 倍速只放大**游戏内时间**的推进（D-31）。
    this.accumulator += realDtMs * this.config.speed
    const planned = Math.floor(this.accumulator / stepMs)
    const count = Math.min(planned, MAX_STEPS_PER_FRAME)
    const droppedBacklog = planned >= MAX_STEPS_PER_FRAME

    // 本帧真实时间在各个 tick 间均摊：`realElapsed` 不随倍速放大（R-29）。
    const realShareMs = count > 0 ? realDtMs / count : realDtMs

    if (count >= MAX_STEPS_PER_FRAME) {
      // 丢弃积压：倍速过高时宁可不追，也不进入死亡螺旋。
      this.accumulator = Math.min(this.accumulator, stepMs)
    } else {
      this.accumulator -= count * stepMs
    }
    if (this.accumulator < 0) this.accumulator = 0

    return { count, stepMs, realShareMs, droppedBacklog, realDtMs }
  }

  /** 丢弃全部积压（暂停恢复、重新开始时用，8.12「切换副作用」）。 */
  resetAccumulator(): void {
    this.accumulator = 0
    this.lastFrameAt = undefined
  }
}

/** `realDtMs` 为负（时间戳回拨）时按 0 处理——真实墙钟在 rAF 下单调，负值只可能是调用方传错。 */
function pausedGuard(realDtMs: number): boolean {
  return realDtMs <= 0
}

/** 秒 -> `Decimal`（产出与 `dt` 用，避免浮点误差累积）。 */
export function seconds(value: number): Decimal {
  return Num.fromNumber(value)
}
