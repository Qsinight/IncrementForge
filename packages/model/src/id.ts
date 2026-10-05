/**
 * 条目 `id` 的命名约束与分配（TECH_DESIGN 6.1「条目 id 的命名约束」、D-45、R-35）。
 *
 * **单一事实源**：`ID_PATTERN`、`RESERVED_ID_PREFIXES`、动态 id 规则都只在这里定义，
 * Zod Schema（`schema.ts`）、表达式路径解析器（`packages/expr` 的 `parseLiteralPath`）、
 * 复制生成（7.5）、`create()` 冲突检查（8.7）共用同一份常量，**不得各写一套正则**（6.1「单一事实源」行）。
 *
 * ## 为什么必须约束（6.1 表格「为什么必须约束」行）
 *
 * 路径语法 `path = ("res"|"gen"|"up"|"page") "." id "." attr`（5.2）依赖 `id` 能被词法分析成
 * **单个标识符**。允许连字符/点号/空格/中文会让 `gen.my-gen.produces[0].amount` 被解析成减法、
 * `gen.a.b.amount` 与属性路径混淆，`set()` 字面量路径解析（D-27）、复制、导出与
 * `create()` 冲突检查一并失真；`dyn_<序号>` 也可能与用户自取的静态 id 撞名，
 * 使 8.7 的“不冲突”保证失效。
 */
import { ForgeError } from '@iforge/num'

/** 条目类型的首字符前缀：`r` 资源 / `g` 生成器 / `u` 升级 / `p` 页面（6.1、D-45）。 */
export const ID_PREFIXES = ['r', 'g', 'u', 'p'] as const
export type IdPrefix = (typeof ID_PREFIXES)[number]

/** 条目类型（与 5.2 的路径前缀一一对应）。 */
export const ENTRY_KINDS = ['resource', 'generator', 'upgrade', 'page'] as const
export type EntryKind = (typeof ENTRY_KINDS)[number]

/** 条目类型 -> `id` 首字符（复制生成、动态创建都按此表取前缀，7.5 / 8.7）。 */
export const KIND_ID_PREFIX: Readonly<Record<EntryKind, IdPrefix>> = {
  resource: 'r',
  generator: 'g',
  upgrade: 'u',
  page: 'p',
}

/**
 * 静态条目 `id` 的正则（6.1 `ID_PATTERN`、D-45）。
 *
 * 首字符限定类型前缀，其余只允许字母、数字与下划线，总长 ≤ 32（1 + 31）。
 */
export const ID_PATTERN = /^[rgup][A-Za-z0-9_]{0,31}$/

/** 保留前缀：动态条目的自动 id 以 `dyn` 开头，静态 id 不得占用（D-45、8.7「id」行）。 */
export const RESERVED_ID_PREFIXES = ['dyn'] as const

/** 动态条目 id 的生成前缀（8.7「id」行：省略 `spec.id` 时由运行时生成 `dyn_<递增序号>`）。 */
export const DYNAMIC_ID_PREFIX = 'dyn'

/** 动态条目 id 正则（与 `ID_PATTERN` 独立：首字符不在 `[rgup]` 内，因此不能用静态规则校验）。 */
export const DYNAMIC_ID_PATTERN = /^dyn_[A-Za-z0-9_]{1,28}$/

/** 动态条目 id 最大长度（与静态 `ID_PATTERN` 的 32 对齐，D-44「长度 ≤ 32」）。 */
export const ID_MAX_LENGTH = 32

/** `id` 是否匹配静态命名规范（D-45）。 */
export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id)
}

/** `id` 是否以保留前缀开头（D-45）。 */
export function hasReservedPrefix(id: string): boolean {
  return RESERVED_ID_PREFIXES.some((prefix) => id.startsWith(prefix))
}

/**
 * 校验静态 `id`，不合规抛 `E_ID_INVALID`（6.1「校验位置」、17.1）。
 *
 * **不做自动改 id**（6.4）：改 id 会连带 `costs/produces` 的 `materialId`、
 * `PageDef.entries[].id` 与存档 `assignments` 路径键，静默改名比报错更危险。
 *
 * @param where 定位路径（如 `generators[3].id`），供编辑器定位到具体条目。
 */
export function assertValidId(id: string, where?: string): void {
  if (!isValidId(id)) {
    throw new ForgeError('E_ID_INVALID', { where, message: `条目 id "${id}" 不合规（${ID_PATTERN.source}）` })
  }
  if (hasReservedPrefix(id)) {
    throw new ForgeError('E_ID_INVALID', {
      where,
      message: `条目 id "${id}" 以保留前缀 "${RESERVED_ID_PREFIXES[0]}" 开头（保留给动态条目）`,
    })
  }
}

/**
 * 校验 `create()` 的 `spec.id`（8.7「id」行、D-44）。
 *
 * 规则与静态 `ID_PATTERN` 同源（首字符必须是 `g`/`u`，因此 `dyn_1` 也被判非法：
 * 稳定 id 要写 `uTmp`/`gTmp` 形式，8.7「id」行的 `[gu]` 前缀要求）。
 *
 * 注意错误码是 `E_CREATE_ID_CONFLICT` 而非 `E_ID_INVALID`（8.7 与 17.1）：
 * 诊断面板要能区分“项目文件里的静态 id 坏了”与“作者在表达式里写了个非法/冲突的
 * 动态 id”两种不同成因，二者的修复入口也不同（改项目 vs 改表达式）。
 */
export function assertDynamicId(id: string): void {
  // 8.7「id」行：`spec.id` 给出时必须以 `g`/`u` 开头、后接字母/数字/下划线、长度 ≤ 32。
  // 比静态规则更严一档——`p1` 虽满足 `ID_PATTERN`，却是页面 id，`create()` 造不出页面。
  if (id[0] !== 'g' && id[0] !== 'u') {
    throw new ForgeError('E_CREATE_ID_CONFLICT', { message: `spec.id "${id}" 必须以 g（生成器）或 u（升级）开头` })
  }
  if (!isValidId(id)) {
    throw new ForgeError('E_CREATE_ID_CONFLICT', {
      message: `spec.id "${id}" 非法：需以 g/u 开头、只含字母数字下划线且长度 ≤ ${ID_MAX_LENGTH}`,
    })
  }
  if (hasReservedPrefix(id)) {
    throw new ForgeError('E_CREATE_ID_CONFLICT', {
      message: `spec.id "${id}" 与保留前缀冲突（动态自动 id 使用 ${DYNAMIC_ID_PREFIX}_ 前缀）`,
    })
  }
}

/**
 * 分配下一个可用序号：返回 `prefix + n`，跳过已被占用的 id。
 *
 * 复制生成（7.5「复制」行）与新建（7.5「添加」行）都走这里，保证“新 id 不冲突”。
 *
 * @param prefix 类型前缀（`r`/`g`/`u`/`p`）
 * @param taken 已被占用的 id 集合（四类条目全局唯一，6.1）
 */
export function nextId(prefix: IdPrefix, taken: ReadonlySet<string> | ReadonlyMap<string, unknown>): string {
  const used = taken instanceof Map ? new Set(taken.keys()) : taken
  let n = 1
  while (used.has(`${prefix}${n}`)) n += 1
  return `${prefix}${n}`
}

/**
 * 生成动态条目 id（8.7「id」行：`dyn_<递增序号>`）。
 *
 * 静态 `id` 被 `ID_PATTERN` 禁止使用 `dyn` 前缀（D-45），因此自动 id 与静态条目
 * 及既有动态条目都不冲突，调用方无需再为它做冲突检查。
 *
 * @param taken 已占用的 id（静态 + 动态）
 */
export function nextDynamicId(taken: ReadonlySet<string>): string {
  let n = 1
  while (taken.has(`${DYNAMIC_ID_PREFIX}_${n}`)) n += 1
  return `${DYNAMIC_ID_PREFIX}_${n}`
}

/** 动态条目 id 判定（读档校验用，8.7「孤儿动态条目」与 6.3 读档顺序 ②）。 */
export function isDynamicId(id: string): boolean {
  return DYNAMIC_ID_PATTERN.test(id)
}

/** 跨四类收集已占用的 id（6.1「项目内所有静态 id 全局唯一」）。 */
export function collectIds(...lists: ReadonlyArray<ReadonlyArray<{ id: string }>>): Set<string> {
  const out = new Set<string>()
  for (const list of lists) for (const item of list) out.add(item.id)
  return out
}
