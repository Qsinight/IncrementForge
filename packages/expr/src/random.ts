/**
 * 确定性伪随机源（TECH_DESIGN 8.3 第 1 步、PRD 补充 1）。
 *
 * 8.3 要求「刷新随机上下文（`rand` 使用 `tick` 派生的确定性伪随机源，保证同 tick 结果一致）」，
 * 这样同一次重放/复现会得到完全相同的结果，便于回归测试与「重新开始」后的一致性。
 *
 * 算法用 mulberry32：32 位状态、无依赖、周期足够，且在 JS double 上精确（全程 `Math.imul` /
 * `>>> 0`，不引入大数运算，不与 4.2 的分层数值体系纠缠）。
 */
import { ForgeError, Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'

export interface RandomSource {
  /** 返回 `[0, 1)`。 */
  next(): Decimal
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 为某个 tick 创建一个随机源。
 *
 * @param tick 逻辑帧序号（8.3 第 1 步）
 * @param salt 额外盐值（同一 tick 内不同表达式取不同序列，避免 `if(rand() > 0.5, …)` 的两条分支取到同一个值）
 */
export function createRandomSource(tick: number, salt = 0): RandomSource {
  const next = mulberry32((tick * 2654435761 + salt * 40503) >>> 0)
  return {
    next: () => Num.fromNumber(next()),
  }
}

/**
 * 离线期间使用的随机源。
 *
 * PRD 补充 1 与 8.8：离线禁用随机函数，因此这里**不提供**随机值——
 * 调用它意味着上层漏判了离线标记，直接抛 `E_RAND_DISABLED` 让错误在编译/调用点暴露，
 * 而不是静默返回一个假随机数。
 *
 * 抛的是 `ForgeError` 而不是普通 `Error`：求值器按 `code` 归类诊断（`evaluator.ts` 的
 * `extractErrorCode`），只有 `ForgeError` 才能让 last-good 机制把它记成
 * `E_RAND_DISABLED`；普通 `Error` 会被压成 `E_TYPE`，诊断面板就显示不出
 * “随机函数在离线不可用”这条真正的原因（17.1、5.4「随机函数集合的边界」）。
 */
export function createOfflineRandomSource(): RandomSource {
  return {
    next: () => {
      throw new ForgeError('E_RAND_DISABLED', { message: '随机函数在离线期间不可用（PRD 补充 1、8.8）' })
    },
  }
}
