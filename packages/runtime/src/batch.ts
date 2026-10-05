/**
 * 批量 / 最大 / 自动最大购买求解（TECH_DESIGN 8.6、8.6.1、8.6.2、ADR-08、D-24、D-36、D-48、R-03、R-04、R-23）。
 *
 * ```
 * solveBatch(target, mode):
 *   kAll = [ solveForMaterial(target, m, mode) for m in target.costs ]   // 1) 多材料逐个求
 *   k    = min(kAll)                                                     //    材料不可互换
 *   k    = min(k, max(0, ceil(cap − owned)))                             // 2) 硬上限
 *   if mode == 'count': k = min(k, buyAmount, 100)
 *   if target is upgrade:                                                 // 3) 升级条件
 *      k = (mode == 'free') ? checkLastLevelOnly(target, k)
 *                           : solveByConditionPrefix(target, k, mode)
 *   if k == 0 → return 0                                                 // 4) 结算
 *   if mode != 'free': 一次性扣除各材料 cost(k)
 *   target.bought += k; target.owned += k; return k
 * ```
 *
 * ## 三个决定成败的实现要点
 *
 * 1. **`free` 模式不需要闭式求和**（D-48 的关键点）：自动最大购买只校验 `P(k−1) ≤ amount`，
 *    不需要 `C(k)`。只要 `P` 单调非减，谓词对 `k` 就是单调的，因此**无论是否等比**都能
 *    对 `P` 直接二分。这让“价格写成 `10 * 1.15 ^ bought + 5`”这类常见非纯等比写法在
 *    自动购买下**不会**退化成逐级累加——而这正是绝大多数增量游戏的默认配置。
 * 2. **升级条件的“前缀语义”不能省**（8.6.2、R-23）：`count`/`max` 下“连续购买直到不满足条件”
 *    要求**每一次购买**都在成交时满足条件。条件形如 `gen.g1.bought != 5` 时，只校验末级会越过
 *    中间为假的等级，因此这里做「逐级确认」（`level` 从 **0** 起：第 `level` 次购买发生在等级
 *    `bought + level` 上——与 `purchase.ts` 的 `prefixHolds`、卡片件数的 `affordableInCountMode`
 *    以及 `free` 模式的 `lastLevelHolds` **同一套等级口径**）。单调条件走二分/抽查快路径，
 *    非单调逐级确认；两者都只作性能优化，绝不作为正确性前提。
 * 3. **只读等级视图**（8.6.1）：价格 `P(j)` 求的是“第 `j` 级”，而表达式里写的是当前属性路径。
 *    覆盖读取值即可，**绝不**修改 `AttributeStore`——否则一次批量求解会污染存档。
 *
 * ## `planBatch` / `solveBatch` 的分工（8.6 的 0~3 步 与 第 4 步）
 *
 * | 入口 | 副作用 | 谁在用 |
 * | --- | --- | --- |
 * | `planBatch` | 只记诊断 | `solveBatch`、视图模型（卡片要显示“当前买得起的件数与消耗”） |
 * | `solveBatch` | 扣材料、推进 `bought/owned`、结算升级效果 | 交互购买与自动购买阶段 |
 *
 * 拆开的唯一理由是**卡片必须显示真实可负担的件数**：视图层若自己再写一份“逐级累加 +
 * 与存量比较”，就成了第二条购买路径，一漂移就出现“按钮写 ×10、点下去只买到 1 件”。
 */
import { Diagnostics, NUM_MAX, Num, isInf } from '@iforge/num'
import type { Decimal } from '@iforge/num'

import type { EntryState } from './attribute-store.js'
import { entityKeyOf, conditionsOf, costsOf } from './attribute-store.js'
import { parse, staticCheck } from '@iforge/expr'
import type { Node } from '@iforge/expr'
import type { BuyMode, PurchaseDeps } from './purchase.js'
import {
  advanceCounters,
  conditionsAllTrue,
  deductCosts,
  evaluateCostAt,
  evaluateSingleCost,
  lastLevelHolds,
  modeOf,
  prefixHolds,
  priceRowsUsable,
  rejectBrokenPrice,
} from './purchase.js'
import { applyEffect } from './upgrade-effect.js'

/** 迭代预算（8.6 的 C 分支、12 性能预算“单 tick ≤ 1e5 次求值”）。 */
export const ITERATION_BUDGET = 1e5

/**
 * `max` 无限制时形状识别的**固定采样步长** `h`（见 `solveForMaterial` 里的说明）。
 *
 * 100 是“数值条件”与“溢出风险”的折中：最远采样点 `8h = 800`，对常见的 `q ≈ 1.15`
 * 约是 `10^78`，`Decimal` 完全够；而 `h = 1` 时族 ③ 的 `(q−1)²` 分母在慢增长价格上
 * 会小到只剩 1e-8 量级，减去两个几乎相等的差分会吃掉全部有效位。
 */
const UNBOUNDED_SAMPLE_STRIDE = Num.fromNumber(100)

/** C 分支（降级）在 `max` 无限制时的线性扫描上限；与 `ITERATION_BUDGET` 同量级。 */
const FALLBACK_LINEAR_LIMIT = Num.fromNumber(1e5)

/** 一个 tick 内求解器可用的求值次数（与上同源，作为“预算分摊”的记账单位）。 */
export interface SolveBudget {
  used: number
  /** 本 tick 是否已耗尽（跨 tick 续算，8.6 的 C 分支）。 */
  exhausted: boolean
}

export function createBudget(): SolveBudget {
  return { used: 0, exhausted: false }
}

function spend(budget: SolveBudget, n = 1): boolean {
  budget.used += n
  if (budget.used > ITERATION_BUDGET) {
    budget.exhausted = true
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 价格形状识别（8.6 的 A 段）—— 实现在 `./shape.ts`，这里只引入并重新导出
// ---------------------------------------------------------------------------

import { HOLDOUT_MULTIPLIERS, SAMPLE_MULTIPLIERS, detectPriceShape, sumShape } from './shape.js'
import type { PriceFn, PriceShape } from './shape.js'

// 重新导出：外部（含 bench 与用例）按 `batch` 的入口取形状 API。
export { detectPriceShape, evaluateShape, sumShape } from './shape.js'
export { HOLDOUT_MULTIPLIERS, SAMPLE_MULTIPLIERS } from './shape.js'
export type { PriceFn, PriceShape } from './shape.js'

// ---------------------------------------------------------------------------
// 单材料求解（8.6 的 `solveForMaterial`）
// ---------------------------------------------------------------------------

/** 单材料的求解结果。 */
export interface MaterialSolve {
  /** 可购买的最大件数。 */
  k: Decimal
  /** 是否走了降级路径（形状未知 / 非单调 / 预算耗尽）。 */
  degraded: boolean
  /** 是否命中闭式族（用于诊断与 bench 断言）。 */
  closedForm: boolean
  /** 本次求解消耗的求值次数。 */
  evaluations: number
}

/**
 * 单材料求解（8.6 的 A/B/C 三段）。
 *
 * - **B 段**（付费模式）：`C(k) ≤ available` 的最大 `k`。「倍增上界 + 二分」，闭式下 `O(log k)`。
 * - **free 模式**：`P(k−1) ≤ available` 的最大 `k`。只要 `P` 单调非减即可二分（D-48）。
 * - **C 段**（降级）：形状未知且 `P` 非单调（或含负价格）时逐级累加求 `C(k)`，上限 `1e5` 次/tick。
 */
export function solveForMaterial(
  deps: PurchaseDeps,
  state: EntryState,
  costIndex: number,
  available: Decimal,
  mode: BuyMode,
  upperBound: Decimal | undefined,
  budget: SolveBudget,
): MaterialSolve {
  const before = budget.used
  const entity = entityKeyOf(state.kind, state.id)
  const price: PriceFn = (j: Decimal) => {
    const quotes = evaluateCostAt(deps, state, Num.add(deps.attrs.value(state, 'bought'), j))
    const quote = quotes.quotes[costIndex]
    return quote ? quote.price : Num.fromNumber(0)
  }

  const free = mode === 'free'

  // ---- 上界：数量上限。`upperBound === undefined` 表示 `max` 无限制（`max = "Infinity"`）----
  const capped = upperBound !== undefined
  if (capped && upperBound.lte(0)) {
    return { k: Num.fromNumber(0), degraded: false, closedForm: false, evaluations: budget.used - before }
  }

  // ---- 形状识别的采样步长 `h` ----
  //
  // `h` 的作用只有一个：让拟合的数值条件变好。① ~ ③ 四族都是**精确解**，
  // 任何 `h` 都能拟合准；`h` 越大，`u = q^h` 离 1 越远，③ 的 `(u−1)²` 分母就越远离
  // 灾难性抵消（`q ≈ 1.0001` 时 `h = 1` 会把分母压到 1e-8 量级）。
  //
  // 取 `h ≈ 上界/8` 是为了让最远采样点 `8h` 正好覆盖搜索域。无上限时没有域可依，
  // 用一个固定步长——**不能**退化成 `h = 1`，否则 ③ 的拟合在慢增长价格上容易超差；
  // 也不能用 `NUM_MAX` 当上界，那会让 `h = NUM_MAX`、采样价格直接溢出。
  const h = capped ? Num.max(Num.fromNumber(1), Num.floor(Num.div(upperBound, Num.fromNumber(8)))) : UNBOUNDED_SAMPLE_STRIDE

  let shape: PriceShape | undefined
  let monotonic = true
  if (free) {
    // free：只需判定 `P` 单调非减（否则谓词不单调，二分无意义）。
    monotonic = checkMonotonic(price, h)
    if (!monotonic) {
      Diagnostics.record('E_BATCH_MONOTONE', `${entity}.costs[${costIndex}].amount`, '价格非单调，自动最大购买降级')
    }
  } else {
    shape = detectPriceShape(price, h)
    if (!shape) {
      Diagnostics.record('E_BATCH_MONOTONE', `${entity}.costs[${costIndex}].amount`, '价格形状无法闭式求解，降级迭代')
    }
  }

  // ---- 预算检查 ----
  if (!spend(budget, SAMPLE_MULTIPLIERS.length + HOLDOUT_MULTIPLIERS.length)) {
    return { k: Num.fromNumber(0), degraded: true, closedForm: false, evaluations: budget.used - before }
  }

  const affordable: (k: Decimal) => boolean = (k: Decimal) => {
    if (free) {
      if (k.lte(0)) return true
      // 只校验**最后一件**的价格（PRD 生成器 8 / 升级 9）。
      return price(Num.sub(k, Num.fromNumber(1))).lte(available)
    }
    if (shape) return sumShape(shape, k).lte(available)
    return sumIteratively(price, k, budget).lte(available)
  }

  if (free && !monotonic) {
    // C 段：非单调只能逐级试探。
    const k = searchIteratively(price, available, upperBound, budget, (level) => price(level).lte(available))
    return { k, degraded: true, closedForm: false, evaluations: budget.used - before }
  }

  if (!free && !shape) {
    // C 段：逐级累加求 `C(k)`，预算内完成不了就返回已确认的前缀。
    const k = searchIteratively(price, available, upperBound, budget, (level) => {
      // 找到最大 `k` 使 `Σ_{i<k} P(i) ≤ available`：逐级累加，超出即停。
      let sum = Num.fromNumber(0)
      for (let i = 0; i < level.toNumber(); i += 1) {
        if (!spend(budget)) return false
        sum = Num.add(sum, price(Num.fromNumber(i)))
        if (sum.gt(available)) return false
      }
      return true
    })
    return { k, degraded: true, closedForm: false, evaluations: budget.used - before }
  }

  // ---- B 段：倍增 + 二分 ----
  //
  // 二分的不变式是「`lo` 可行、`hi` 不可行」，因此**必须先判断搜索域上界本身可不可行**：
  // 若有上界且它已可行，答案就是它；否则从 1 开始倍增找不可行上界。
  // （早期实现漏了这个判断，`upperBound` 可行时 `lo` 停在 0，直接把答案报成 0 件。）
  if (upperBound !== undefined && affordable(upperBound)) {
    return { k: upperBound, degraded: false, closedForm: shape !== undefined, evaluations: budget.used - before }
  }

  let lo = Num.fromNumber(0)
  let hi = Num.fromNumber(1)
  let steps = 0
  while (affordable(hi) && steps < 200) {
    lo = hi
    hi = Num.mul(hi, Num.fromNumber(2))
    if (!spend(budget)) break
    steps += 1
  }

  // 现在 `lo` 可行、`hi` 不可行，二分收敛到最大的可行 `k`。
  //
  // 循环条件是 `hi − lo ≥ 1`（还有可分的整数），**不是** `hi − lo < 1`：
  // 后者在 `hi−lo = 2` 时直接退出，把 `lo` 原样返回，于是答案恒为倍增停下的那一档，
  // 少买一半。这个方向写反的 bug 表现为“批量购买结果偏小”，且在 `upperBound`
  // 本身就可行时被早返回分支掩盖，只有“材料刚好不够”的中间档位才会暴露。
  while (Num.gte(Num.sub(hi, lo), Num.fromNumber(1))) {
    const mid = Num.floor(Num.div(Num.add(lo, hi), Num.fromNumber(2)))
    if (mid.lte(lo) || mid.gte(hi)) break
    if (!spend(budget)) {
      return { k: lo, degraded: true, closedForm: shape !== undefined, evaluations: budget.used - before }
    }
    if (affordable(mid)) lo = mid
    else hi = mid
  }

  return { k: lo, degraded: false, closedForm: shape !== undefined, evaluations: budget.used - before }
}

/** 逐级累加求 `C(k)`（预算内；预算耗尽时按已累加部分返回）。 */
function sumIteratively(price: PriceFn, k: Decimal, budget: SolveBudget): Decimal {
  let sum = Num.fromNumber(0)
  const n = k.toNumber()
  if (!Number.isFinite(n)) return Num.fromNumber(Number.POSITIVE_INFINITY)
  for (let i = 0; i < n; i += 1) {
    if (!spend(budget)) return sum
    sum = Num.add(sum, price(Num.fromNumber(i)))
  }
  return sum
}

/** 判定 `P` 在采样点上是否单调非减（`free` 模式的二分前提，D-48）。 */
function checkMonotonic(price: PriceFn, h: Decimal): boolean {
  let previous: Decimal | undefined
  for (const m of SAMPLE_MULTIPLIERS) {
    const j = Num.mul(h, Num.fromNumber(m))
    const current = price(j)
    if (current.lt(0)) return false
    if (previous !== undefined && current.lt(previous)) return false
    previous = current
  }
  return true
}

/**
 * C 分支的线性搜索：找到最大的 `k ≤ upperBound` 使 `ok(k)` 为真。
 *
 * `upperBound === undefined`（`max` 无限制）时用 `FALLBACK_LINEAR_LIMIT` 作为硬性扫描上限：
 * 逐级累加本来就是降级路径，1e5 次求值就是它的预算天花板（`ITERATION_BUDGET`），
 * 与其让预算在别处被静默耗光，不如在这里显式承认“扫到这里为止”。
 */
function searchIteratively(
  price: PriceFn,
  available: Decimal,
  upperBound: Decimal | undefined,
  budget: SolveBudget,
  ok: (level: Decimal) => boolean,
): Decimal {
  void price
  void available
  const limit = upperBound ?? FALLBACK_LINEAR_LIMIT
  const n = limit.toNumber()
  let best = Num.fromNumber(0)
  for (let i = 1; i <= n; i += 1) {
    if (!spend(budget)) return best
    if (ok(Num.fromNumber(i))) best = Num.fromNumber(i)
    else break // `ok` 是前缀单调的：第一个失败即停
  }
  return best
}

// ---------------------------------------------------------------------------
// 升级条件的单调性判定（8.6.2「单调条件快路径」）
// ---------------------------------------------------------------------------

/**
 * 判定升级的 `conditions` 是否是**关于 `bought` 单调**的。
 *
 * 判据（8.6.2）：条件是若干**阈值型比较**的 `&&`，形如
 * `gen.g1.bought >= 5`、`res.r1.amount >= a + b * gen.g1.bought`，
 * 运算符为 `>=`/`>`，左侧是 `bought` 的**单调非减线性式**、右侧不依赖 `bought`。
 * `==`/`!=`/`<`/`<=`、`||`、以及依赖本批次内会变化的其它可变属性，一律不算单调。
 *
 * 判定结果随表达式文本记忆化（`MONOTONIC_CACHE`）：同一条文本在每 tick 被判定一次即可。
 */
const MONOTONIC_CACHE = new Map<string, boolean>()

export function isMonotonicInBought(deps: PurchaseDeps, state: EntryState): boolean {
  if (state.kind !== 'upgrade') return false
  const conditions = conditionsOf(state)
  if (conditions.length === 0) return true
  const entity = entityKeyOf('upgrade', state.id)
  const key = `${entity}|${conditions.join('\u0000')}`
  const cached = MONOTONIC_CACHE.get(key)
  if (cached !== undefined) return cached
  const result = conditions.every((text) => isMonotonicCondition(text, `${entity}.bought`))
  MONOTONIC_CACHE.set(key, result)
  return result
}

/** 清空单调性记忆化（文本热替换后重新判定，8.6.2「结论随表达式 hash 记忆化」）。 */
export function resetMonotonicCache(): void {
  MONOTONIC_CACHE.clear()
}

/** 一条条件文本是否单调。 */
function isMonotonicCondition(text: string, boughtKey: string): boolean {
  let ast: Node
  try {
    ast = parse(text)
    // 编译期失败的条件不算单调：它不会被满足，走逐级确认更安全。
    staticCheck(ast, 'condition')
  } catch {
    return false
  }
  return checkNode(ast, boughtKey)
}

function checkNode(node: Node, boughtKey: string): boolean {
  const record = node as unknown as Record<string, unknown>
  switch (record['kind']) {
    case 'boolean':
      // `true` 是平凡单调；`false` 恒假，也算单调（不会造成“非单调跳过”）。
      return true
    case 'binary': {
      const op = record['op'] as string
      const left = record['left'] as Node
      const right = record['right'] as Node
      if (op === '&&') return checkNode(left, boughtKey) && checkNode(right, boughtKey)
      // `||` 会把两个单调条件并成非单调（如 `(bought>=5) || (bought<3)` 恒真），
      // 且 `||` 的两侧可能互不单调——一律判非单调，走逐级确认。
      if (op === '||') return false
      if (op !== '>=' && op !== '>') return false
      // 左侧必须是对 `bought` 的非减线性式；右侧不得依赖 `bought`。
      const slope = linearCoefficient(left, boughtKey)
      if (slope === undefined || slope.lt(0)) return false
      return !dependsOnBought(right, boughtKey)
    }
    default:
      return false
  }
}

/**
 * 求表达式对 `bought` 的线性系数；不是“非负系数的线性式”返回 `undefined`。
 *
 * 允许的形式：`bought`、`a * bought`、`bought * a`、`a`（常数，看作系数 0）、
 * 以及它们的加减组合。**不允许** `bought ^ 2`、`bought / 2`（系数随 `bought` 变）、
 * `-bought`（非减）。
 */
function linearCoefficient(node: Node, boughtKey: string): Decimal | undefined {
  const record = node as unknown as Record<string, unknown>
  switch (record['kind']) {
    case 'number':
      return Num.fromNumber(0)
    case 'path': {
      const path = record['path'] as { prefix: string; id: string; attrs: string[] }
      return keyOf(path) === boughtKey ? Num.fromNumber(1) : undefined
    }
    case 'unary': {
      // 一元 `-` 会让系数变号，非单调；`+` 保持。
      if (record['op'] !== '+') return undefined
      return linearCoefficient(record['operand'] as Node, boughtKey)
    }
    case 'binary': {
      const op = record['op'] as string
      const left = linearCoefficient(record['left'] as Node, boughtKey)
      const right = linearCoefficient(record['right'] as Node, boughtKey)
      if (left === undefined || right === undefined) return undefined
      if (op === '+') return Num.add(left, right)
      if (op === '-') return Num.sub(left, right)
      if (op === '*') {
        // 只有“一侧是常数”时才是线性式。
        if (right.eq(0)) return Num.fromNumber(0)
        if (left.eq(0)) return Num.fromNumber(0)
        return undefined
      }
      return undefined
    }
    default:
      return undefined
  }
}

/** 表达式是否读取了 `bought`。 */
function dependsOnBought(node: Node, boughtKey: string): boolean {
  const record = node as unknown as Record<string, unknown>
  if (record['kind'] === 'path') {
    const path = record['path'] as { prefix: string; id: string; attrs: string[] }
    return keyOf(path) === boughtKey
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item) && dependsOnBought(item, boughtKey)) return true
    } else if (isNode(value) && dependsOnBought(value, boughtKey)) {
      return true
    }
  }
  return false
}

function keyOf(path: { prefix: string; id: string; attrs: string[] }): string {
  const suffix = path.attrs.join('.')
  return suffix.length === 0 ? `${path.prefix}.${path.id}` : `${path.prefix}.${path.id}.${suffix}`
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

// ---------------------------------------------------------------------------
// solveBatch（8.6 的主流程）
// ---------------------------------------------------------------------------

/** `solveBatch` 的结果。 */
export interface BatchResult {
  /** 实际买到的件数。 */
  k: Decimal
  /** 归一化后的模式。 */
  mode: BuyMode
  /**
   * 走了**迭代降级**路径（形状不可闭式 / 非单调 / 非单调条件）。
   *
   * 只用于 8.6 末条的“连续 60 tick 降级 -> 建议改写价格形状”，**不代表**这次求解没做完。
   */
  degraded: boolean
  /**
   * 本次求解被**单 tick 求值预算**截断（8.6 的 C 分支），`k` 只是已确认的前缀，
   * 要等下一 tick 从断点继续。
   *
   * 这是“计算中…”的唯一依据（见 `GameState.pendingSolve`）。它与 `degraded` 必须分开：
   * 早先两者混用，导致**任何**走了迭代路径的购买都被标成“计算中…”，而交互路径
   * 每次点击都拿一份**全新的**预算、根本不存在跨 tick 续算——于是按钮第一次点击后
   * 就永远停在“计算中…”（降级只需要一两次百量级求值，预算从未耗尽）。
   */
  truncated: boolean
  /** 是否命中闭式族。 */
  closedForm: boolean
  /** 前置判定失败的原因（`k = 0` 时给出）。 */
  failure?: string
}

/**
 * `solveBatch(target)`：批量 / 最大 / 自动最大购买（8.6 的主流程）。
 *
 * 副作用：付费模式扣材料、推进 `bought/owned`、升级结算最后一级的效果；
 * `set/create/destroy` 仍由 `EffectSink` 在**下一个**提交阶段应用（8.3.1）。
 */
export function solveBatch(deps: PurchaseDeps, state: EntryState, budget = createBudget()): BatchResult {
  const result = planBatch(deps, state, budget)
  if (!result.k.gt(0)) return result

  // ---- 4) 结算 ----
  if (result.mode !== 'free') {
    // 一次性扣除各材料 `cost(k)`：付费模式的总价为 `Σ P(i)`，而上面的可负担判定正是按
    // 这个和做的（`sumShape` / 逐级累加），因此扣款与判定口径一致。
    const total = totalCostOf(deps, state, result.k)
    if (!deductCosts(deps, total)) {
      Diagnostics.record('E_NOT_ENOUGH', entityKeyOf(state.kind, state.id), '材料不足')
      return { ...result, k: Num.fromNumber(0) }
    }
  }
  advanceCounters(deps, state, result.k)

  if (state.kind === 'upgrade') {
    // 触发点 ②（D-06）：批量/最大/自动最大购买**只结算最后一级的效果**——
    // 先 `bought/owned += k`，再求值全部效果（通常覆盖中间结果），避免不可逆副作用累积。
    applyEffect(deps, state)
  }

  return result
}

/**
 * `solveBatch` 的**只读**部分：8.6 的 0)~3) 步，算出“买几件”，**不扣材料、不推进计数器**。
 *
 * ## 为什么把它单独拆出来
 *
 * 卡片必须显示“当前买得起的件数与消耗”（8.11 的价格行 + 购买按钮），而这个数**只能**
 * 由结算器给：视图层自己再写一套“逐级累加 + 与存量比较”的逻辑，等于开第二条购买路径，
 * 一漂移就出现“按钮写 ×10、点下去只买到 1 件”。
 *
 * 副作用面仅限 `Diagnostics`（8.6 的 `E_BATCH_MONOTONE`/`E_BATCH_CONDITION`），
 * 与拆分前完全一致。
 */
export function planBatch(deps: PurchaseDeps, state: EntryState, budget = createBudget()): BatchResult {
  const buyAmount = deps.attrs.fieldValue(state, 'buyAmount')
  const mode = modeOf(buyAmount)
  // `truncated` 的**唯一**来源：本次求解是否把单 tick 的求值预算用光了。
  //
  // 取“进入时未耗尽、出来时耗尽”的差值，而不是直接读 `budget.exhausted`：自动购买阶段
  // 的预算是**整个 tick 共享**的（8.3 第 5 步逐条目复用同一份），前一个条目耗光预算后，
  // 后面的条目一次求值都没做却会被标成“计算中…”。差值口径让标记只归给真正把它用光的那个条目。
  const exhaustedBefore = budget.exhausted
  const done = (k: Decimal, degraded: boolean, closedForm: boolean, failure?: string): BatchResult => ({
    k,
    mode,
    degraded,
    truncated: budget.exhausted && !exhaustedBefore,
    closedForm,
    ...(failure === undefined ? {} : { failure }),
  })

  // ---- 前置判定（任一不满足直接返回 0 件，不进入求解，8.6）----
  if (state.kind !== 'generator' && state.kind !== 'upgrade') {
    return done(Num.fromNumber(0), false, false, '资源没有购买路径')
  }
  // 点击器无条件返回 0 件：D-28——`buyAmount` 可被写成 0 或负数，但三种模式都不适用。
  if (deps.judge.isClicker(state)) {
    Diagnostics.record('E_CLICKER_NOT_BUYABLE', entityKeyOf(state.kind, state.id), '点击器不可购买')
    return done(Num.fromNumber(0), false, false, '点击器不可购买')
  }
  if (!deps.judge.isVisible(state)) {
    Diagnostics.record('E_HIDDEN', entityKeyOf(state.kind, state.id), '条目不可见')
    return done(Num.fromNumber(0), false, false, '不可见')
  }
  if (deps.judge.isDisabled(state)) {
    Diagnostics.record('E_DISABLED', entityKeyOf(state.kind, state.id), '条目已禁用')
    return done(Num.fromNumber(0), false, false, '已禁用')
  }

  const owned = deps.attrs.value(state, 'owned')
  const cap = deps.attrs.capOf(state)
  if (owned.gte(cap)) {
    Diagnostics.record('E_CAP', entityKeyOf(state.kind, state.id), '已达数量上限')
    return done(Num.fromNumber(0), false, false, '已达上限')
  }
  if (state.kind === 'upgrade' && !conditionsAllTrue(deps, state)) {
    return done(Num.fromNumber(0), false, false, '购买条件未满足')
  }

  // ---- 0) 价格行必须全部可用（`free` 模式同样要过）----
  //
  // 这一段放在所有前置判定之后、求解之前：`solveForMaterial` 逐材料取
  // `evaluateCostAt(...).quotes[costIndex]`，而行数对不上时它**一个都取不到**，
  // 于是 `k` 保持在上界、`deductCosts` 收到空数组返回 `true` —— 结果就是
  // 「按按钮上的件数白送」。悬空/不可求值的价格行必须显式失败（见 `priceRowsUsable`）。
  const single = evaluateSingleCost(deps, state)
  if (!priceRowsUsable(deps, state, single)) {
    rejectBrokenPrice(deps, state, mode)
    return done(Num.fromNumber(0), false, false, '价格行无效')
  }

  // ---- 2) 硬上限：k ≤ ceil(cap − owned) ----
  //
  // `max = "Infinity"` 表示**根本没有上限**（D-46、4.4 第 6 条），此时不能去算
  // `ceil(NUM_INF − owned)`：`num` 的 `sub` 对含无穷的操作数一律按“向负方向”折算
  // （`∞ − 0` -> `NUM_MIN = 0`），会把“无上限”算成“一件都买不了”。
  //
  // 也不能拿 `NUM_MAX` 当哨兵：它会让下游的采样步长 `h = floor(upperBound/8)` 也变成
  // `NUM_MAX`，采样点价格直接溢出、识别必然失败，于是降级成逐级累加并把预算耗光 -> k = 0。
  // 因此无上限一律用 **`undefined` 显式表达**，由 `solveForMaterial` 的「倍增」去找上界。
  let upperBound: Decimal | undefined = isInf(cap) ? undefined : Num.ceil(Num.sub(cap, owned))
  if (upperBound !== undefined && upperBound.lte(0)) upperBound = Num.fromNumber(0)
  if (mode === 'count') {
    // PRD 生成器 8 / 升级 9 的 100 上限；归一化已把 `buyAmount` 夹到 ≤ 100，这里再夹一次兜底。
    const limit = Num.min(buyAmount, Num.fromNumber(100))
    if (upperBound === undefined || limit.lt(upperBound)) upperBound = limit
  }
  if (upperBound !== undefined && upperBound.lte(0)) {
    return done(Num.fromNumber(0), false, false)
  }

  // ---- 1) 多材料：逐材料求最大可负担件数，取最小 ----
  let k = upperBound ?? (mode === 'free' ? Num.fromNumber(Number.MAX_SAFE_INTEGER) : NUM_MAX)
  let degraded = false
  let closedForm = true
  const quotes = single
  for (let costIndex = 0; costIndex < quotes.quotes.length; costIndex += 1) {
    const quote = quotes.quotes[costIndex]!
    const material = deps.attrs.find(quote.materialKey)
    if (!material) continue
    const available = deps.attrs.value(material, 'amount')
    const solve = solveForMaterial(deps, state, costIndex, available, mode, upperBound, budget)
    degraded = degraded || solve.degraded
    closedForm = closedForm && solve.closedForm
    if (solve.k.lt(k)) k = solve.k
    if (k.lte(0)) break
  }

  // ---- 3) 升级条件 ----
  if (state.kind === 'upgrade' && k.gt(0)) {
    const monotonic = isMonotonicInBought(deps, state)
    if (!monotonic) {
      Diagnostics.record('E_BATCH_CONDITION', entityKeyOf('upgrade', state.id), '升级购买条件非单调，批量件数需逐级确认（建议改写为 `bought >= n`）')
    }
    const affordableAt = (level: Decimal): boolean => {
      // 该级价格是否付得起：付费模式校验单件（`C` 单调，末级可支付即整批可支付的前缀可算）。
      const quotesAt = evaluateCostAt(deps, state, level)
      for (const quote of quotesAt.quotes) {
        const material = deps.attrs.find(quote.materialKey)
        if (!material) continue
        if (deps.attrs.value(material, 'amount').lt(quote.price)) return false
      }
      return true
    }
    if (mode === 'free') {
      // 末级语义（PRD 升级 9「仍要满足最后一级的购买条件和价格」）：只校验末级，
      // **不做**前缀回退（8.6.2）。
      if (!lastLevelHolds(deps, state, k, affordableAt)) {
        // 末级不成立时用二分收敛到满足末级的最大 k。
        // 不变式同为「`lo` 成立、`hi` 不成立」，因此循环条件是 `hi − lo ≥ 1`。
        let lo = Num.fromNumber(0)
        let hi = k
        while (Num.gte(Num.sub(hi, lo), Num.fromNumber(1))) {
          const mid = Num.floor(Num.div(Num.add(lo, hi), Num.fromNumber(2)))
          if (mid.lte(lo) || mid.gte(hi)) break
          if (lastLevelHolds(deps, state, mid, affordableAt)) lo = mid
          else hi = mid
        }
        k = lo
      }
    } else {
      // 前缀语义（8.6.2）：每一级都必须满足条件与价格。
      const result = prefixHolds(deps, state, k, affordableAt, monotonic)
      k = result.confirmed
      if (!result.ok) degraded = true
    }
    if (upperBound !== undefined && k.gt(upperBound)) k = upperBound
  }

  return done(k, degraded, closedForm)
}

/**
 * `count` 模式下“**当前**买得起的件数”与对应消耗（8.11 的价格行与购买按钮）。
 *
 * ## 口径必须与 `planBatch` 一致
 *
 * `count` 模式的 `k` 就是“满足 `Σ_{i<k} P(i) ≤ amount` 的最大 `k ≤ buyAmount`”，
 * 因此这里的逐级累加与 `planBatch` 的判定是**同一条算术**：同一份 `evaluateCostAt`、
 * 同一个“逐材料滚动和超过存量即停”的规则（材料之间不可互换，8.6「多材料」）。
 * `k` 的上界固定为 `min(buyAmount, 100)`（5.9.3 的夹取），因此这是常数级开销。
 *
 * 升级额外套上 8.6.2 的**前缀语义**（每一级都要满足 `conditions`），
 * 否则按钮会写出一个“点下去买不到”的件数。
 */
export function affordableInCountMode(deps: PurchaseDeps, state: EntryState, limit: number): CountAffordability {
  const costCount = costsOf(state).length
  const empty: CountAffordability = { k: 0, affordableTotals: [], fullTotals: [] }
  if (limit <= 0) return empty
  if (costCount === 0) {
    // 没有价格行 = 免费条目：全部买得起，`k = limit`、消耗为 0（无行可显示）。
    return { k: limit, affordableTotals: [], fullTotals: [] }
  }
  const bought = deps.attrs.value(state, 'bought')
  const materials: EntryState[] = []
  const available: Decimal[] = []
  for (let index = 0; index < costCount; index += 1) {
    const materialId = deps.attrs.textOr(state, `costs[${index}].materialId`)
    const material = deps.attrs.find(entityKeyOf('resource', materialId))
    if (!material) return empty // 价格行无效：`canBuy` 由 `priceRowsUsable` 单独判
    materials.push(material)
    available.push(deps.attrs.value(material, 'amount'))
  }

  const running = available.map(() => Num.fromNumber(0))
  const totals = (): { materialId: string; price: Decimal }[] =>
    materials.map((material, index) => ({
      materialId: material.id,
      price: running[index]!,
    }))

  let k = 0
  let snapshot: CountAffordability['affordableTotals'] = []
  // 循环**不提前退出**：买得起的前缀之外还要继续累加，才能给出 `fullTotals`
  // （“配置 10 件一共要多少”——一件也买不起时作者靠它判断还差多少）。
  // 上界 100（5.9.3 的夹取）保证这仍是常数级开销。
  for (let level = 0; level < limit; level += 1) {
    const quotes = evaluateCostAt(deps, state, Num.add(bought, Num.fromNumber(level)))
    let affordable = true
    for (let index = 0; index < costCount; index += 1) {
      const quote = quotes.quotes[index]
      // 求值失败的行按 0 计入（8.5/5.7 的 last-good 口径）；`priceRowsUsable` 才是它的裁决者。
      running[index] = Num.add(running[index]!, quote ? quote.price : Num.fromNumber(0))
      if (running[index]!.gt(available[index]!)) affordable = false
    }
    if (!affordable) continue
    // 升级走 8.6.2 的**前缀语义**：某一级条件不成立，后面的等级一律不算。
    if (state.kind === 'upgrade' && !conditionsAllTrue(deps, state, Num.add(bought, Num.fromNumber(level)))) continue
    k = level + 1
    snapshot = totals()
  }
  return { k, affordableTotals: snapshot, fullTotals: totals() }
}

/** `count` 模式的可负担结果（`k` 与两套消耗，顺序同 `costs`）。 */
export interface CountAffordability {
  /** 当前买得起的件数（`0 ≤ k ≤ limit`）。 */
  k: number
  /** 前 `k` 件的总价。`k = 0` 时为空数组。 */
  affordableTotals: { materialId: string; price: Decimal }[]
  /** 前 `limit` 件的总价（`k = 0` 时用它，让“还差多少”有数可看）。 */
  fullTotals: { materialId: string; price: Decimal }[]
}

/** 付费模式的总价：逐材料求 `Σ_{i<k} P(i)`。 */
function totalCostOf(deps: PurchaseDeps, state: EntryState, k: Decimal): { materialKey: string; materialId: string; price: Decimal }[] {
  const bought = deps.attrs.value(state, 'bought')
  const costCount = costsOf(state).length
  const out: { materialKey: string; materialId: string; price: Decimal }[] = []
  for (let index = 0; index < costCount; index += 1) {
    const materialId = deps.attrs.textOr(state, `costs[${index}].materialId`)
    if (!deps.attrs.materialExists(materialId)) continue
    let sum = Num.fromNumber(0)
    const n = k.toNumber()
    for (let i = 0; i < n; i += 1) {
      const quotes = evaluateCostAt(deps, state, Num.add(bought, Num.fromNumber(i)))
      const quote = quotes.quotes[index]
      if (!quote) continue
      sum = Num.add(sum, quote.price)
    }
    out.push({ materialKey: entityKeyOf('resource', materialId), materialId, price: sum })
  }
  return out
}
