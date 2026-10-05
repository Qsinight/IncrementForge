/**
 * `@iforge/num` —— 数值层（TECH_DESIGN 4）。
 *
 * 依赖规则（3.2）：`num ← expr ← model ← runtime`，本包不依赖任何其它 `@iforge/*` 包，
 * 也不导入任何 DOM API。`expr`/`model`/`runtime`/`persist`/`build` 统一从这里取数值能力与错误码。
 */
export * from './errors.js'
export * from './num.js'
export * from './format.js'

import {
  abs as numAbs,
  add,
  applyCap,
  ceil,
  clamp,
  clampLower0,
  clampQuantity,
  cmp,
  div,
  exp,
  floor,
  fromNumber,
  fromString,
  fromValue,
  gt,
  gte,
  isInf,
  isNaN,
  isPos,
  isSafeNumber,
  isSaturated,
  isZero,
  lerp,
  ln,
  log,
  log10,
  lt,
  lte,
  max,
  min,
  mod,
  mul,
  neg,
  normalizeCap,
  pow,
  requireSafeNumber,
  resetDiagnostics,
  round,
  saturate,
  sign,
  sqrt,
  sub,
  toNumber,
  trunc,
} from './num.js'

import { format } from './format.js'

// `Decimal` 由 `export * from './num.js'` 同时导出值与类型，这里只补类型标注用的别名。
import type { Decimal } from './num.js'
import type { FormatOptions, NumberFormat } from './format.js'

/**
 * `Num` 数值层 API（4.3 契约，实现即此对象的成员）。
 *
 * 聚合为单个对象而不是散落的具名导出，是为了让调用方（`expr` 编译器/求值器、`runtime`
 * 结算阶段）只依赖一个稳定入口，并保证 4.3 清单与实现一一对应——清单里没有的成员不新增，
 * 清单里有的成员必须全部存在（由 `test/api-surface.test.ts` 断言）。
 */
export const Num = {
  // 算术（全部内部 saturate）
  add,
  sub,
  mul,
  div,
  mod,
  pow,
  neg,
  numAbs,
  abs: numAbs,
  sign,

  // 比较
  cmp,
  eq: (a: Decimal, b: Decimal): boolean => cmp(a, b) === 0,
  lt,
  lte,
  gt,
  gte,
  isZero,
  isPos,
  isInf,

  // 取整与函数
  floor,
  ceil,
  round,
  trunc,
  sqrt,
  ln,
  log10,
  log,
  exp,
  min,
  max,
  clamp,
  lerp,

  // 转换与格式化
  fromNumber,
  fromString,
  fromValue,
  toNumber,
  isSafeNumber,
  format,

  // 饱和辅助（4.4）
  saturate,
  isSaturated,
  applyCap,
  clampLower0,
  clampQuantity,
  normalizeCap,
  requireSafeNumber,
  isNaN,
  resetDiagnostics,
} as const

export type NumApi = typeof Num
// `Decimal` 的“值 + 类型”双重身份由 `export * from './num.js'` 携带，此处不再重复导出，
// 否则同名导出会被这里的 type-only 声明覆盖（`verbatimModuleSyntax` 下直接报错）。
export type { FormatOptions, NumberFormat }
