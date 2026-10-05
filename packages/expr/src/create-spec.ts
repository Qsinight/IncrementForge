/**
 * `create()` 的 `spec` 字段白名单与校验（TECH_DESIGN 8.7、5.2 约束表「键名」行、13 第 2 条）。
 *
 * 关键约束：白名单**编译期**判定，不留到运行期兜底（5.2 约束表「键名」行），
 * 并且与项目文件的 `GeneratorDef`/`UpgradeDef` 字段共用同一份定义——
 * `packages/model` 在 M2 直接复用本文件，不另写一份（5.2：「不允许实现期临时放宽」）。
 *
 * `page` 必填（PRD 补充 7、D-09）：缺失报 `E_CREATE_NO_PAGE`。
 * `kind`/`buyDelay` 由运行时接管，出现在 spec 中报 `E_CREATE_FIELD_INVALID`（8.7 字段集合行）。
 */
import { ForgeError } from '@iforge/num'

import type { ConstantObject, ConstantValue } from './ast.js'

/** `create()` 支持的两类条目（D-34：生成器与升级对称支持）。 */
export const CREATE_KINDS = ['generator', 'upgrade'] as const
export type CreateKind = (typeof CREATE_KINDS)[number]

/** 两类条目共有的字段（8.7「公共字段」行）。 */
const COMMON_SPEC_FIELDS = ['id', 'name', 'description', 'icon', 'initial', 'max', 'visible', 'order', 'page'] as const

/** 生成器专有字段（8.7 生成器分支）。 */
const GENERATOR_SPEC_FIELDS = ['disabled', 'buyAmount', 'costs', 'produces', 'isClicker'] as const

/** 升级专有字段（8.7 升级分支）。 */
const UPGRADE_SPEC_FIELDS = ['disabled', 'buyAmount', 'costs', 'conditions', 'effects', 'perSecond'] as const

/** 由运行时接管的字段：出现在 spec 中即 `E_CREATE_FIELD_INVALID`（8.7）。 */
export const RUNTIME_MANAGED_FIELDS = ['kind', 'buyDelay'] as const

/** 全量白名单（供 `docs:check` 比对 5.2 约束表与 8.7 字段集合）。 */
export const CREATE_SPEC_FIELDS: Readonly<Record<CreateKind, ReadonlySet<string>>> = {
  generator: new Set<string>([...COMMON_SPEC_FIELDS, ...GENERATOR_SPEC_FIELDS]),
  upgrade: new Set<string>([...COMMON_SPEC_FIELDS, ...UPGRADE_SPEC_FIELDS]),
}

/**
 * 校验 `spec` 的键名。
 *
 * @throws {ForgeError} `E_CREATE_FIELD_INVALID`（未知键或运行时接管字段）；
 *   `E_CREATE_NO_PAGE`（缺 `page`，PRD 补充 7）。
 */
export function checkCreateSpec(spec: ConstantObject, kind: string, span: { start: number; end: number }): void {
  if (!(CREATE_KINDS as readonly string[]).includes(kind)) {
    throw new ForgeError('E_CREATE_FIELD_INVALID', {
      message: `create() 的 kind 只能是 ${CREATE_KINDS.join(' / ')}`,
      span,
    })
  }
  const allowed = CREATE_SPEC_FIELDS[kind as CreateKind]
  for (const key of Object.keys(spec)) {
    if ((RUNTIME_MANAGED_FIELDS as readonly string[]).includes(key)) {
      throw new ForgeError('E_CREATE_FIELD_INVALID', {
        message: `${key} 由运行时接管，不能出现在 spec 中（8.7）`,
        span,
      })
    }
    if (!allowed.has(key)) {
      throw new ForgeError('E_CREATE_FIELD_INVALID', {
        message: `spec 含未知键 ${key}（${kind} 的合法字段：${[...allowed].join(' / ')}）`,
        span,
      })
    }
  }
  checkFieldTypes(spec, kind as CreateKind, span)
}

/**
 * 校验 `spec.page` 存在（页面存在性由运行期 `E_PAGE_UNKNOWN` 判定，6.4）。
 *
 * @throws {ForgeError} `E_CREATE_NO_PAGE`
 */
export function checkSpecPage(spec: ConstantObject, span: { start: number; end: number }): void {
  if (spec.page === undefined) {
    throw new ForgeError('E_CREATE_NO_PAGE', { message: 'create() 的 spec 必须指定 page（PRD 补充 7）', span })
  }
  if (typeof spec.page !== 'string') {
    throw new ForgeError('E_ASSIGN_TYPE', { message: 'page 必须是页面 id 字符串', span })
  }
}

/** `NumExpr` / 表达式文本字段：值必须是字符串（8.7「字段形态」行）。 */
const STRING_FIELDS = ['initial', 'max', 'buyAmount', 'name', 'description'] as const

/** 布尔字段（8.7 字段集合行）。 */
const BOOLEAN_FIELDS = ['visible', 'disabled', 'isClicker', 'perSecond'] as const

/**
 * 字段形态校验（8.7「字段形态」行：数值/表达式字段仍传**字符串**）。
 *
 * 这里只校验结构形状，不校验语义——悬空引用 `E_DANGLING_REF` 需要全局条目表，
 * 由 `runtime` 在创建时判定（8.7）。
 *
 * 三种列表形状各不相干，**不能共用同一套校验**：
 * - `costs` / `produces`：元素是 `{ materialId, amount }`，且 `amount` 必须是字符串；
 * - `conditions`：元素直接是表达式字符串；
 * - `effects`：元素是 `{ condition, action }`，两者都必须是字符串。
 */
function checkFieldTypes(spec: ConstantObject, kind: CreateKind, span: { start: number; end: number }): void {
  for (const field of STRING_FIELDS) {
    const value = spec[field]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      throw new ForgeError('E_CREATE_FIELD_INVALID', {
        message: `${field} 必须传字符串（NumExpr / 文本字段，8.7 字段形态）`,
        span,
      })
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    const value = spec[field]
    if (value === undefined) continue
    if (typeof value !== 'boolean') {
      throw new ForgeError('E_CREATE_FIELD_INVALID', { message: `${field} 必须是布尔值`, span })
    }
  }
  if (spec.order !== undefined && typeof spec.order !== 'number') {
    throw new ForgeError('E_CREATE_FIELD_INVALID', { message: 'order 必须是数值', span })
  }

  // `amount` 型列表（8.7 的 CostEntry）。
  for (const field of ['costs', ...(kind === 'generator' ? ['produces'] : [])]) {
    const value = spec[field]
    if (value === undefined) continue
    if (!Array.isArray(value)) {
      throw new ForgeError('E_CREATE_FIELD_INVALID', { message: `${field} 必须是列表`, span })
    }
    for (const entry of value as ConstantValue[]) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new ForgeError('E_CREATE_FIELD_INVALID', {
          message: `${field} 的元素必须是 { materialId, amount } 形式的对象`,
          span,
        })
      }
      const row = entry as ConstantObject
      if (typeof row.materialId !== 'string') {
        throw new ForgeError('E_CREATE_FIELD_INVALID', { message: `${field} 的元素缺少字符串字段 materialId`, span })
      }
      if (typeof row.amount !== 'string') {
        throw new ForgeError('E_CREATE_FIELD_INVALID', {
          message: `${field} 的 amount 必须传字符串（NumExpr，8.7 字段形态）`,
          span,
        })
      }
    }
  }

  if (kind !== 'upgrade') return

  const conditions = spec.conditions
  if (conditions !== undefined) {
    if (!Array.isArray(conditions)) {
      throw new ForgeError('E_CREATE_FIELD_INVALID', { message: 'conditions 必须是列表', span })
    }
    for (const entry of conditions as ConstantValue[]) {
      if (typeof entry !== 'string') {
        throw new ForgeError('E_CREATE_FIELD_INVALID', { message: 'conditions 的元素必须是表达式字符串', span })
      }
    }
  }

  const effects = spec.effects
  if (effects !== undefined) {
    if (!Array.isArray(effects)) {
      throw new ForgeError('E_CREATE_FIELD_INVALID', { message: 'effects 必须是列表', span })
    }
    for (const entry of effects as ConstantValue[]) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new ForgeError('E_CREATE_FIELD_INVALID', { message: 'effects 的元素必须是 { condition, action } 对象', span })
      }
      const row = entry as ConstantObject
      if (typeof row.condition !== 'string' || typeof row.action !== 'string') {
        throw new ForgeError('E_CREATE_FIELD_INVALID', {
          message: 'effects 的元素必须含字符串字段 condition 与 action',
          span,
        })
      }
    }
  }
}

/** 导出供 `docs:check` 交叉校验的字段清单（8.7 / 5.2 约束表）。 */
export const CREATE_SPEC_FIELD_LIST: Record<CreateKind, readonly string[]> = {
  generator: [...COMMON_SPEC_FIELDS, ...GENERATOR_SPEC_FIELDS],
  upgrade: [...COMMON_SPEC_FIELDS, ...UPGRADE_SPEC_FIELDS],
}
