/**
 * 数值层：break_eternity `Decimal` 封装 + 饱和（saturate）语义。
 *
 * 对应 TECH_DESIGN 4（4.1 需求映射 / 4.2 分层表示 / 4.3 API / 4.4 溢出下溢 / 4.5 显示格式）。
 * 落点说明：
 * - ADR-01：统一使用 break_eternity 的 `Decimal`，本文件是唯一的数值出入口。
 * - 4.2：L0/L1/L2/L3+ 四层表示全部由 `Decimal` 的 mantissa/exponent/layer 承载；
 *   核心逻辑禁止把 `Decimal` 转成 JS `number`，仅格式化与非数值比较可用 `toNumber()`。
 * - 4.4：溢出饱和为 `NUM_MAX`、数量类下界 0、`saturated` 经 WeakSet 挂在值上可观测。
 * - D-46：`NUM_INF` 是“无上限”哨兵，与饱和上界 `NUM_MAX` **区分开**（前者语义、不钳制，后者数值边界）。
 * - D-01/D-02：饱和不抛异常，只打标记 + 记诊断。
 */
import Decimal from 'break_eternity.js'

import { Diagnostics, ForgeError } from './errors.js'

export { Decimal }

/**
 * 允许的最大指数层层数（4.4 第 1 条）。
 * `Decimal` 的 `layer` 字段即“10 的层数”，超过该值一律饱和。
 */
export const NUM_MAX_LAYER = 1e15

/** 饱和上界：`10 ↑↑ 1e15`（4.4 第 1 条）。 */
export const NUM_MAX: Decimal = Decimal.tetrate(10, NUM_MAX_LAYER)

/** 饱和下界 / 数量类下界：`0`（4.4 第 2 条、PRD 补充 3“下限为零”）。 */
export const NUM_MIN: Decimal = new Decimal(0)

/**
 * “无上限”哨兵：JS `Infinity` 字面量在 `Decimal` 中的原生表示（D-46、4.4 第 6 条）。
 *
 * 与 `NUM_MAX` 的分工：
 * - `isInf(max)` 为真 → `applyCap` **完全跳过**钳制（语义哨兵，不引入比较与夹取开销）；
 * - 参与算术 → 按饱和语义折算为 `NUM_MAX`（负方向为 `NUM_MIN`）并打 `saturated`；
 * - `Num.format` 输出 `∞`；
 * - 比较时等同 `+∞`（由 `Decimal` 原生 Infinity 语义保证，无需折算）。
 */
export const NUM_INF: Decimal = Decimal.dInf

/** 纯数学结果的下溢门限：小于该量级饱和为 `0`（4.4 第 2 条，`exp(-1e308)` 一类）。 */
export const NUM_MIN_POSITIVE = 1e-323

/**
 * 饱和标记：挂在**值**上（4.4 第 3 条“标记可观测”）。
 *
 * 用模块级 `let` 而非 `const`，使 `resetSaturated()` 能整表重建——WeakSet 不可枚举，
 * 无法逐个删除元素（该限制是 WeakSet 相比 Set 的取舍：避免饱和标记让值对象无法回收）。
 */
let saturatedValues = new WeakSet<Decimal>()

/** 标记一个值已饱和，并按方向记 `E_OVERFLOW` / `E_UNDERFLOW` 诊断（D-02：只计数不抛异常）。 */
function markSaturated(value: Decimal, code: 'E_OVERFLOW' | 'E_UNDERFLOW', where?: string): Decimal {
  saturatedValues.add(value)
  Diagnostics.record(code, where)
  return value
}

/** `isSaturated(a)`：该值是否经过饱和钳制（4.3 诊断 API）。 */
export function isSaturated(value: Decimal): boolean {
  return saturatedValues.has(value)
}

/** 清空全部饱和标记（仅 `resetDiagnostics()` 使用）。 */
export function resetSaturated(): void {
  saturatedValues = new WeakSet<Decimal>()
}

// ---------------------------------------------------------------------------
// 构造与判定
// ---------------------------------------------------------------------------

export function fromNumber(value: number): Decimal {
  return Decimal.fromNumber(value)
}

export function fromString(text: string): Decimal {
  return Decimal.fromString(text)
}

/** 从 `number | string | Decimal` 归一化（表达式字面量与项目文件的 `NumExpr` 都走这里）。 */
export function fromValue(value: Decimal | number | string): Decimal {
  return Decimal.fromValue(value as Decimal)
}

/** `NaN` 判定。`Decimal` 用专门实例表示 NaN，不能用 `=== NaN` 比较。 */
export function isNaN(a: Decimal): boolean {
  return a.isNan()
}

/** 有限性判定：`NUM_INF` 与溢出到 Infinity 的结果都为假。 */
export function isFinite(a: Decimal): boolean {
  return a.isFinite()
}

/**
 * `isInf(a)`：是否 `NUM_INF` 哨兵（4.3 注释：比较时等同 `+∞`）。
 *
 * 实现说明：`Decimal` 用原生 Infinity（`layer/mag = Infinity`）承载无穷，因此
 * `!isFinite && !isNaN` 即为无穷；负无穷在算术路径上被折算为 `NUM_MIN`，此处只认正无穷。
 */
export function isInf(a: Decimal): boolean {
  return !a.isFinite() && !a.isNan() && a.sign > 0
}

/** 是否为负无穷（算术折算的中间态判定，正常不会外泄到 API 之外）。 */
export function isNegInf(a: Decimal): boolean {
  return !a.isFinite() && !a.isNan() && a.sign < 0
}

// ---------------------------------------------------------------------------
// 饱和
// ---------------------------------------------------------------------------

/**
 * 饱和钳制（4.4）。
 *
 * 规则：
 * 1. `NaN` 原样返回（`applyCap`/`normalizeCap` 对 `NaN` 有专门语义，见 4.4 第 4 条）；
 * 2. 无穷折算：`NUM_INF` → `NUM_MAX`、负无穷 → `NUM_MIN`，并打 `saturated`；
 * 3. 达到或超过 `NUM_MAX` → 钳到 `NUM_MAX` 并打标记。
 *
 * **判定用 `gte` 而非 `gt`**：break_eternity 在归一化时已经把超过上界的层数压回上界，
 * `NUM_MAX + 1`、`NUM_MAX * 2`、`NUM_MAX ^ 2` 的返回值与 `NUM_MAX` **完全相等**，
 * `gt` 永远为假，饱和将永远检测不到（14.2 要求这三种运算 `isSaturated() === true`）。
 *
 * 下溢的两条路径缺一不可：
 * - 库把 `1e-300 × 1e-300` 保留为 `1e-600`（layer 1 的负指数），**不是 0**，由本函数
 *   的 `lt(NUM_MIN_POSITIVE)` 判定钳到 0；
 * - 但 `exp(-1e308)` 这类函数结果库直接给精确 `0`，此时无法与“本来就是 0”区分，
 *   由算术函数在归一化前用操作数判定（见 `underflowedToZero`）。
 *
 * 数量类“下限为零”不在此处强制（负价格是合法表达式结果，8.6 的单调性判定依赖它），
 * 由 `clampLower0()` 在写入数量属性时显式调用（4.4 第 2 条）。
 */
export function saturate(value: Decimal, where?: string): Decimal {
  if (value.isNan()) return value
  if (isNegInf(value)) return markSaturated(NUM_MIN, 'E_UNDERFLOW', where)
  if (isInf(value)) return markSaturated(NUM_MAX, 'E_OVERFLOW', where)
  if (value.gte(NUM_MAX)) return markSaturated(NUM_MAX, 'E_OVERFLOW', where)
  if (!isZero(value) && value.abs().lt(NUM_MIN_POSITIVE)) {
    return markSaturated(NUM_MIN, 'E_UNDERFLOW', where)
  }
  return value
}

/**
 * 判断一次乘法/除法/幂运算是否下溢到了精确 `0`。
 *
 * 库的 `exp` 一类函数在下溢时直接返回精确 `0`，事后无法区分“结果是 0”与“本来就有一个
 * 操作数是 0”，因此必须在归一化前用操作数判定：结果为 0 且**所有**操作数都非 0（4.4 第 2 条）。
 */
function underflowedToZero(result: Decimal, ...operands: Decimal[]): boolean {
  return isZero(result) && operands.every((operand) => !isZero(operand) && !isNaN(operand))
}

/**
 * 数量类下界钳制：`< 0` 一律截断为 `0`（4.4 第 2 条、PRD 补充 3）。
 * 资源/生成器/升级的 `amount`/`bought`/`owned`/`initial`/`effectValues` 写入路径必须经此函数。
 */
export function clampLower0(value: Decimal, where?: string): Decimal {
  if (value.isNan()) return value
  if (value.lt(0)) return markSaturated(NUM_MIN, 'E_UNDERFLOW', where)
  return saturate(value, where)
}

/**
 * 数量上限归一化（4.4 第 4 条）：
 * - `NUM_INF` → 原样返回（`isInf` 走“无上限”语义，`applyCap` 会跳过钳制）；
 * - `NaN`（如 `0/0`）或 `≤ 0` → 按 `1` 处理并记 `E_CAP_NON_POSITIVE`。
 *
 * `NaN` 必须显式拦截：`NaN` 不满足任何比较，直接走夹取路径会绕过 `≤ 0` 判定。
 */
export function normalizeCap(max: Decimal, where?: string): Decimal {
  if (isInf(max)) return max
  if (max.isNan() || max.lte(0)) {
    Diagnostics.record('E_CAP_NON_POSITIVE', where)
    return new Decimal(1)
  }
  return saturate(max, where)
}

/**
 * 应用数量上限（4.4 第 4 条）：`applyCap(value, max) = isInf(max) ? value : min(value, max)`。
 * `max` 需先经 `normalizeCap()`；本函数不重复归一化以免重复记诊断。
 */
export function applyCap(value: Decimal, cap: Decimal, _where?: string): Decimal {
  if (isInf(cap)) return value
  return value.gt(cap) ? cap : value
}

/**
 * 数量属性写入的统一入口：先钳下界 0，再应用上限（PRD 补充 3“下限为零、受数量上限影响”）。
 */
export function clampQuantity(value: Decimal, cap: Decimal, where?: string): Decimal {
  return applyCap(clampLower0(value, where), cap, where)
}

// ---------------------------------------------------------------------------
// 算术（全部内部 saturate）
// ---------------------------------------------------------------------------

/**
 * 判断是否含 ±∞ 操作数。
 *
 * 本模块的所有算术出口都会把无穷折算回有限值（`NUM_MAX`/`NUM_MIN`），因此“∞ 作为操作数”
 * 只可能来自显式的 `NUM_INF` 字面量或被内层库算出的真无穷（如 `x / 0`）。
 * 折算方向按 IEEE-754 的组合律推导（`∞ + ∞ = ∞`、`∞ − ∞ = ∞`、`∞ × 负数 = −∞`……），
 * 避免出现 `NUM_INF` 泄漏到下游造成不可预期的比较结果。
 */
function isInfinite(v: Decimal): boolean {
  return !v.isFinite() && !v.isNan()
}

function hasInfiniteOperand(...values: Decimal[]): boolean {
  return values.some(isInfinite)
}

/** 按“是否向负方向”折算无穷：负方向落 `NUM_MIN`，否则落 `NUM_MAX`。 */
function foldInfinite(negative: boolean, where?: string): Decimal {
  return markSaturated(negative ? NUM_MIN : NUM_MAX, 'E_OVERFLOW', where)
}

export function add(a: Decimal, b: Decimal, where?: string): Decimal {
  if (hasInfiniteOperand(a, b)) return foldInfinite(false, where)
  return saturate(a.add(b), where)
}

export function sub(a: Decimal, b: Decimal, where?: string): Decimal {
  if (hasInfiniteOperand(a, b)) return foldInfinite(true, where)
  return saturate(a.sub(b), where)
}

export function mul(a: Decimal, b: Decimal, where?: string): Decimal {
  if (hasInfiniteOperand(a, b)) return foldInfinite(a.sign < 0 !== b.sign < 0, where)
  const result = a.mul(b)
  if (underflowedToZero(result, a, b)) return markSaturated(NUM_MIN, 'E_UNDERFLOW', where)
  return saturate(result, where)
}

export function div(a: Decimal, b: Decimal, where?: string): Decimal {
  if (hasInfiniteOperand(a, b)) return foldInfinite(a.sign < 0 !== b.sign < 0, where)
  const result = a.div(b)
  // 除法只在分子非 0 时可能下溢；分母为 0 是无穷（已在上面折算）。
  if (underflowedToZero(result, a)) return markSaturated(NUM_MIN, 'E_UNDERFLOW', where)
  return saturate(result, where)
}

export function mod(a: Decimal, b: Decimal, where?: string): Decimal {
  if (hasInfiniteOperand(a, b)) return NUM_MIN
  return saturate(a.mod(b), where)
}

/** `pow(base, exp)`：`exp` 可为 `Decimal`，走分层幂（4.2 L2/L3+）。 */
export function pow(base: Decimal, exp: Decimal, where?: string): Decimal {
  // `(-∞) ^ n` 视 n 的奇偶在 ±∞ 间摆动，指数为无穷时无法判定，故一律落上界避免抛出。
  if (hasInfiniteOperand(base, exp)) return foldInfinite(false, where)
  const result = base.pow(exp)
  if (underflowedToZero(result, base, exp)) return markSaturated(NUM_MIN, 'E_UNDERFLOW', where)
  return saturate(result, where)
}

export function neg(a: Decimal, where?: string): Decimal {
  if (isInfinite(a)) return foldInfinite(true, where)
  return saturate(a.neg(), where)
}

export function abs(a: Decimal, where?: string): Decimal {
  if (isInfinite(a)) return foldInfinite(false, where)
  return saturate(a.abs(), where)
}

export function sign(a: Decimal): -1 | 0 | 1 {
  return a.sign as -1 | 0 | 1
}

// ---------------------------------------------------------------------------
// 比较
// ---------------------------------------------------------------------------

/** `cmp(a, b)`：全走 `Decimal.cmp`（R-02：禁止用 JS number 比较大数）。 */
export function cmp(a: Decimal, b: Decimal): -1 | 0 | 1 {
  return a.cmp(b) as -1 | 0 | 1
}

export const eq = (a: Decimal, b: Decimal): boolean => a.eq(b)
export const lt = (a: Decimal, b: Decimal): boolean => a.lt(b)
export const lte = (a: Decimal, b: Decimal): boolean => a.lte(b)
export const gt = (a: Decimal, b: Decimal): boolean => a.gt(b)
export const gte = (a: Decimal, b: Decimal): boolean => a.gte(b)
export const isZero = (a: Decimal): boolean => a.eq(0)
export const isPos = (a: Decimal): boolean => a.gt(0)

// ---------------------------------------------------------------------------
// 取整与函数
// ---------------------------------------------------------------------------

/**
 * 取整退化（4.4 第 5 条、R-02）：超过 `Number.MAX_SAFE_INTEGER` 的值本身已是整数
 * （尾数 × 10^指数 在该量级下没有可表示的小数部分），直接返回自身，避免精度灾难。
 */
function isBeyondSafeInteger(a: Decimal): boolean {
  return a.abs().gt(Number.MAX_SAFE_INTEGER)
}

export function floor(a: Decimal): Decimal {
  return isBeyondSafeInteger(a) ? a : a.floor()
}
export function ceil(a: Decimal): Decimal {
  return isBeyondSafeInteger(a) ? a : a.ceil()
}
export function round(a: Decimal): Decimal {
  return isBeyondSafeInteger(a) ? a : a.round()
}
export function trunc(a: Decimal): Decimal {
  return isBeyondSafeInteger(a) ? a : a.trunc()
}

export function sqrt(a: Decimal): Decimal {
  if (isInfinite(a)) return foldInfinite(false)
  return saturate(a.sqrt())
}

export function ln(a: Decimal): Decimal {
  if (isInfinite(a)) return foldInfinite(false)
  return saturate(a.ln())
}

export function log10(a: Decimal): Decimal {
  if (isInfinite(a)) return foldInfinite(false)
  return saturate(a.log10())
}

export function log(a: Decimal, base: Decimal): Decimal {
  if (hasInfiniteOperand(a, base)) return foldInfinite(false)
  return saturate(a.log(base))
}

export function exp(a: Decimal): Decimal {
  if (isInfinite(a)) return foldInfinite(false)
  const result = Decimal.exp(a)
  // 库的 exp 在下溢时直接给精确 0，事后无法与 exp(0)=1 区分，故按操作数判定。
  if (underflowedToZero(result, a)) return markSaturated(NUM_MIN, 'E_UNDERFLOW')
  return saturate(result)
}

/** `min(...)` / `max(...)`：变参全走 `Decimal.cmp`。 */
export function min(...values: Decimal[]): Decimal {
  return values.reduce((acc, v) => (v.lt(acc) ? v : acc))
}

export function max(...values: Decimal[]): Decimal {
  return values.reduce((acc, v) => (v.gt(acc) ? v : acc))
}

export function clamp(a: Decimal, lo: Decimal, hi: Decimal): Decimal {
  return max(lo, min(a, hi))
}

export function lerp(a: Decimal, b: Decimal, t: Decimal): Decimal {
  return add(a, mul(sub(b, a), t))
}

/** `logn(x)`：`log(x, base)` 的便捷别名（`log` 与 `ln` 在表达式内置函数表中同义使用）。 */
export const logn = log

// ---------------------------------------------------------------------------
// 转换
// ---------------------------------------------------------------------------

/**
 * `toNumber(a)`（4.3）：不安全时夹到 `±Number.MAX_VALUE` 并置饱和标记。
 * 核心逻辑禁止调用本函数，仅格式化与非数值比较可用。
 */
export function toNumber(a: Decimal): number {
  const value = a.toNumber()
  if (Number.isFinite(value)) return value
  const clamped = a.sign < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE
  markSaturated(fromNumber(clamped), 'E_OVERFLOW')
  return clamped
}

/** `isSafeNumber(a)`：可无损表示为 JS `number`（有限且在安全整数/精度范围内）。 */
export function isSafeNumber(a: Decimal): boolean {
  return Number.isFinite(a.toNumber())
}

/** 安全转换为 `number`；不保证精度时抛出（供必须用 JS 数的布局/排序场景）。 */
export function requireSafeNumber(a: Decimal, where?: string): number {
  const value = toNumber(a)
  if (!Number.isFinite(value) || !isSafeNumber(a)) {
    throw new ForgeError('E_TYPE', { where, message: '该值无法安全转换为数值' })
  }
  return value
}

// ---------------------------------------------------------------------------
// 内部导出（供 resetDiagnostics 与测试使用）
// ---------------------------------------------------------------------------

/** `resetDiagnostics()`：同时清空诊断计数与饱和标记（4.3 诊断 API）。 */
export function resetDiagnostics(): void {
  Diagnostics.reset()
  resetSaturated()
}
