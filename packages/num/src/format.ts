/**
 * 显示格式化（TECH_DESIGN 4.5）。
 *
 * 五种格式枚举（D-17）：
 * | 格式 | 行为 |
 * | --- | --- |
 * | `standard`（默认） | 小于 1e6 定点；之后按量级切换 K/M/B/T/Qa/Qi…；再大用科学计数；幂塔级用分层记法 |
 * | `scientific` | 统一科学计数 `1.23e456` |
 * | `engineering` | 指数取 3 的倍数 `123e456` |
 * | `letters` | 字母记数 `1.5A`、`2.3B`、`1.1Za` |
 * | `layered` | 分层指数，用于展示幂塔量级 |
 *
 * ## break_eternity 的分解语义（本文件全部公式的依据）
 *
 * `Decimal` 内部四元组为 `s`（符号）、`m`（尾数）、`e`（指数）、`l`（层数），满足
 * `value = sign * m * 10^e`。实测语义（已在 `test/format.test.ts` 固定为契约）：
 *
 * - **`Number.isFinite(e)` 为真**：数值可由 `m`、`e` 精确还原（`abs(m)` 落在 `[1, 10)`、
 *   `e` 是整数），按 flat 路径格式化。注意这**不等于** `layer === 0`——库在指数超过约
 *   1e15 之前就会把 `layer` 抬到 1，但此时 `m`/`e` 仍然可用（`1e78` 是 `m=1, e=78`）。
 * - **`e` 为 `Infinity`**（`layer >= 2`，如 `1e1e1e10` 与 `NUM_MAX`）：`m * 10^e` 不再是
 *   有效表达，真正的信息是“`layer` 个 10 的幂塔，塔底指数 `mag`”。此时走 layered 路径，
 *   输出 `<尾数>e<层数>e<mag>`；`layer = 1` 时省略中间的层数（`1e1e10` → `1e10000000000`）。
 *
 * 两个坑（都有用例守护）：
 * 1. 不要用 `pow(10, log10(x) - floor(log10(x)))` 重建尾数——`999999` 会因浮点误差得到
 *    `9.99999` 再进位成 `10`，输出 `10e5` 而不是 `1e6`。
 * 2. 四舍五入进位要同步抬档位：尾数 `9.99999` 按 2 位小数会显示成 `1000`，此时应把档位 +3。
 *
 * ## 性能
 *
 * 格式化是每 tick 数千条目下的主要 CPU 开销之一（12 性能预算：>= 10000 次/s），因此带
 * LRU 缓存。缓存键必须是**能唯一还原数值状态的完整指纹**（4.5）：仅 `mantissa + layer +
 * format` 会漏掉符号与低阶指数，导致 `-1.5`、`1.5`、`1e3`、`1e1e10` 互相命中彼此的条目
 * （14.2「格式化缓存键」用例断言互不命中）。
 */
import type { Decimal } from './num.js'
import { isInf, isZero } from './num.js'

export type NumberFormat = 'standard' | 'scientific' | 'engineering' | 'letters' | 'layered'

export const NUMBER_FORMATS: readonly NumberFormat[] = ['standard', 'scientific', 'engineering', 'letters', 'layered']

/** 格式化选项：尾数小数位数（默认 2）。项目设置只暴露 `numberFormat`，位数属实现细节。 */
export interface FormatOptions {
  places?: number
}

const DEFAULT_PLACES = 2

/** 标准计数后缀：1e3 起，每档 3 个数量级。 */
const STANDARD_SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'] as const

/** 标准计数切后缀的下限（4.5：小于 1e6 走定点）。 */
const STANDARD_SUFFIX_MIN_EXP = 6

/**
 * 后缀表覆盖的最大指数：`Dc` 档覆盖 `1e33`~`1e35`，故 `exponent <= 35` 仍有后缀。
 *
 * 用整数比较而不是 `mantissa * 10^exponent < 1e36`：`1e36` 的尾数实际是
 * `0.9999999999999999`，浮点重建后落在 `1e36` 之下而误判为“仍有后缀”，
 * 输出成没有后缀的 `1`。指数是整数，直接比整数无精度问题。
 */
const STANDARD_SUFFIX_MAX_EXP = (STANDARD_SUFFIXES.length - 1) * 3 + 2

/** 定点显示下限：小于该值走科学计数，避免 `0.00` 丢失数量级。 */
const FIXED_MIN_EXP = -3

/**
 * 去掉尾随 0，避免 `1.50`、`0.50` 这类噪声。
 *
 * `places` 的语义是**最大精度**（四舍五入到该位后剥掉多余的 0），而不是固定宽度：
 * `1.5` 在 `places = 2` 与 `places = 3` 下都输出 `1.5`，而 `1.23456` 在
 * `places = 1/2/3` 下分别输出 `1.2/1.23/1.235`——精度参数因此仍然可感知，
 * 且展示不会出现无意义的补零。
 */
function trim(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/** 尾数按最大 `places` 位精度输出。 */
function fixed(value: number, places: number): string {
  return trim(value.toFixed(places))
}

/**
 * 尾数与指数是否可用于定点/后缀/字母类格式拼装。
 *
 * 除 `e` 必须有限外，还要求 `|e| <= 1e15`：超过该量级（如 `1e1e10` 的 `e = 1e10`）后缀与
 * 工程计数已经失去意义，`engineering` 会算出 `10e9999999999` 这种无法阅读的输出，
 * 此时统一退回分层记法。
 */
const MAX_DISPLAY_EXPONENT = 1e15

function isFlat(value: Decimal): boolean {
  return Number.isFinite(value.exponent) && Math.abs(value.exponent) <= MAX_DISPLAY_EXPONENT
}

/**
 * 尾数进位规整：按 `places` 位小数格式化后若进位到 10（或 1000）就同步抬指数/档位。
 *
 * `999999` 的尾数是 `9.99999`，按 2 位小数会显示成 `10`；不抬指数就会输出 `10e5`，
 * 而正确结果是 `1e6`。返回规整后的尾数与指数。
 */
function carryMantissa(mantissa: number, exponent: number, places: number): { mantissa: number; exponent: number } {
  if (Number(mantissa.toFixed(places)) >= 10) {
    return { mantissa: mantissa / 10, exponent: exponent + 1 }
  }
  return { mantissa, exponent }
}

/**
 * 分层记法：flat 值写 `<尾数>e<指数>`（单层塔）；`layer >= 2` 写 `<尾数>e<层数>e<mag>`。
 *
 * 用库内部的 `layer`/`mag` 而不是 `toStringWithDecimalPlaces()`：后者在层数极大时会退化成
 * `(e^999999999999998)10000000000` 这种内部记法，对玩家不可读。
 */
function layered(value: Decimal, places: number): string {
  const prefix = value.sign < 0 ? '-' : ''
  const head0 = Math.abs(value.mantissa)
  if (isFlat(value)) {
    const { mantissa, exponent } = carryMantissa(head0, value.exponent, places)
    return `${prefix}${fixed(mantissa, places)}e${exponent}`
  }
  const head = fixed(head0, places)
  const mag = value.mag
  const tail = Number.isFinite(mag) ? (Number.isInteger(mag) ? mag.toFixed(0) : trim(mag.toFixed(places))) : '\u221e'
  const layer = value.layer
  return layer <= 1 ? `${prefix}${head}e${tail}` : `${prefix}${head}e${layer}e${tail}`
}

/**
 * 把尾数规整到 `[1, 1000)` 并返回所处档位（每档 3 个数量级）。
 *
 * 进位时同步抬档位：`999999` 的尾数是 `9.99999`、档位 `1`，按 2 位小数会显示成 `1000`，
 * 与 `1e6` 的 `1.00M` 等价却不统一。
 */
function scaled(mantissa: number, exponent: number, places: number): { tier: number; mantissa: number } {
  let tier = Math.floor(exponent / 3)
  let scaledMantissa = mantissa * Math.pow(10, exponent - tier * 3)
  if (Number(scaledMantissa.toFixed(places)) >= 1000) {
    tier += 1
    scaledMantissa /= 1000
  }
  return { tier, mantissa: scaledMantissa }
}

/** 统一科学计数 `1.23e456`；不可 flat 时退化为分层记法。 */
function scientific(value: Decimal, places: number): string {
  const prefix = value.sign < 0 ? '-' : ''
  if (!isFlat(value)) return layered(value, places)
  if (isZero(value)) return `${prefix}0`
  // 尾数四舍五入进位到 10 时同步抬指数，否则 `999999` 会输出 `10e5`。
  const { mantissa, exponent } = carryMantissa(Math.abs(value.mantissa), value.exponent, places)
  return `${prefix}${fixed(mantissa, places)}e${exponent}`
}

/** 工程计数：指数取 3 的倍数，`123e456`。 */
function engineering(value: Decimal, places: number): string {
  const prefix = value.sign < 0 ? '-' : ''
  if (!isFlat(value)) return layered(value, places)
  if (isZero(value)) return `${prefix}0`
  const exponent = value.exponent
  let aligned = exponent - (((exponent % 3) + 3) % 3)
  let mantissa = Math.abs(value.mantissa) * Math.pow(10, exponent - aligned)
  if (Number(mantissa.toFixed(places)) >= 1000) {
    aligned += 3
    mantissa /= 1000
  }
  return `${prefix}${fixed(mantissa, places)}e${aligned}`
}

/** 字母记数：1e3 -> `A`、1e6 -> `B` …… 1e78 -> `Z`，之后 `Za`、`Zb`。 */
function letterSuffix(index: number): string {
  if (index < 26) return String.fromCharCode(65 + index)
  return `Z${String.fromCharCode(97 + ((index - 26) % 26))}`
}

function letters(value: Decimal, places: number): string {
  const prefix = value.sign < 0 ? '-' : ''
  if (!isFlat(value)) return layered(value, places)
  if (isZero(value)) return `${prefix}0`
  if (value.exponent < 3) return `${prefix}${standard(value, places)}`
  const { tier, mantissa } = scaled(Math.abs(value.mantissa), value.exponent, places)
  return `${prefix}${fixed(mantissa, places)}${letterSuffix(tier - 1)}`
}

/** 标准计数：小于 1e6 定点；1e6~1e36 后缀；更大走科学计数；幂塔级走分层记法。 */
function standard(value: Decimal, places: number): string {
  const prefix = value.sign < 0 ? '-' : ''
  if (!isFlat(value)) return layered(value, places)
  if (isZero(value)) return `${prefix}0`
  const exponent = value.exponent
  // 小于 1e-3 走科学计数：定点会把它压成 `0.00`，丢掉数量级。
  if (exponent < FIXED_MIN_EXP) return `${prefix}${scientific(value, places)}`
  const abs = Math.abs(value.mantissa) * Math.pow(10, exponent)
  if (exponent < STANDARD_SUFFIX_MIN_EXP) {
    // 4.5「小于 1e6 直接整数」：整数不补小数位。
    return `${prefix}${Number.isInteger(abs) ? abs.toFixed(0) : fixed(abs, places)}`
  }
  if (exponent <= STANDARD_SUFFIX_MAX_EXP) {
    const { tier, mantissa } = scaled(Math.abs(value.mantissa), exponent, places)
    return `${prefix}${fixed(mantissa, places)}${STANDARD_SUFFIXES[tier] ?? ''}`
  }
  return `${prefix}${scientific(value, places)}`
}

const RENDERERS: Record<NumberFormat, (value: Decimal, places: number) => string> = {
  standard,
  scientific,
  engineering,
  letters,
  layered,
}

function render(value: Decimal, format: NumberFormat, places: number): string {
  // `NUM_INF` 统一格式化为无穷号（4.3 Num.format 注释、D-46）。
  if (isInf(value)) return '\u221e'
  if (value.isNan()) return 'NaN'
  return RENDERERS[format](value, places)
}

/**
 * 缓存键：`fmt(sign|mag|layer|mantissa|exponent|places|format)`（4.5）。
 *
 * 完整性论证（14.2「格式化缓存键」用例）：flat 路径由 `sign | mantissa | exponent` 唯一
 * 确定数值，缺 `sign` 会让 `+1.5` 与 `-1.5` 互串；分层路径由 `layer | mag | mantissa` 唯一
 * 确定，缺 `layer` 或 `mag` 会让 `1e3` 与 `1e1e10` 互串。两者都带上即无碰撞。
 */
function cacheKey(value: Decimal, places: number, format: NumberFormat): string {
  return `fmt(${value.sign}|${value.mag}|${value.layer}|${value.mantissa}|${value.exponent}|${places}|${format})`
}

/** LRU 缓存上限 4096 条，超出淘汰最久未使用项（4.5）。 */
const CACHE_LIMIT = 4096
const cache = new Map<string, string>()

/**
 * 格式化调用计数（12 性能预算「格式化 ≥ 10000 次/s」、末条「诊断面板显示格式化次数」）。
 *
 * 为什么用**两个单调计数器**而不是直接算命中率：`format()` 是热路径，
 * 每 tick 每条目都会调；命中率的分母在跨 tick 聚合时会被上一帧的缓存残留污染，
 * 而“本进程一共调了多少次、其中命中多少次”是无歧义的。
 * `formatHitRate()` 由这两个计数派生，调用方自己决定在哪个时间窗上取差值。
 */
let formatCalls = 0
let formatCacheHits = 0

/**
 * `format(a, format, opts)`（4.3）：带 LRU 缓存的格式化。
 *
 * LRU 用 `Map` 的插入序实现：命中后先删后插把条目移到队尾，淘汰取队首。
 */
export function format(value: Decimal, format: NumberFormat, options: FormatOptions = {}): string {
  const places = options.places ?? DEFAULT_PLACES
  const key = cacheKey(value, places, format)
  formatCalls += 1
  const hit = cache.get(key)
  if (hit !== undefined) {
    formatCacheHits += 1
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const text = render(value, format, places)
  cache.set(key, text)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  return text
}

/** 清空格式化缓存（单测与“重新开始”路径使用）。计数**一并清零**，否则命中率跨局累加失真。 */
export function resetFormatCache(): void {
  cache.clear()
  formatCalls = 0
  formatCacheHits = 0
}

/** 缓存条目数（诊断面板展示格式化命中率时使用）。 */
export function formatCacheSize(): number {
  return cache.size
}

/** 格式化性能快照（12 性能预算末条：诊断面板显示“格式化次数”）。 */
export interface FormatStats {
  /** 进程内累计 `format()` 调用次数。 */
  calls: number
  /** 其中命中 LRU 缓存的次数。 */
  cacheHits: number
  /** 当前缓存条目数（上限 4096）。 */
  cacheSize: number
  /** 累计命中率 `0..1`；一次都没调过时为 `0`。 */
  hitRate: number
}

/** 取格式化性能快照（12 性能预算）。 */
export function formatStats(): FormatStats {
  return {
    calls: formatCalls,
    cacheHits: formatCacheHits,
    cacheSize: cache.size,
    hitRate: formatCalls === 0 ? 0 : formatCacheHits / formatCalls,
  }
}

/** 默认数字格式（D-17 / 7.7 游戏默认设置 `numberFormat = standard`）。 */
export const DEFAULT_NUMBER_FORMAT: NumberFormat = 'standard'
