/**
 * 属性读写矩阵（TECH_DESIGN 5.9）。
 *
 * 本模块是表达式解析、静态校验、`set()` 权限判定与打包前检查的**唯一**权限依据（5.9 开篇）。
 * 表外属性一律只读。每一行对应 5.9.1（条目属性）或 5.9.2（页面属性）表格的一行；
 * 14.3 的交叉校验脚本会以本表为准比对 6.3 的 `SaveFile` 字段集合（R-33 的直接防线）。
 *
 * 属性键的规范形式（编译期由路径解析器归一，14.2「路径解析」用例固定）：
 * - 普通属性：`initial`、`max`、`visible`
 * - 列表下标：`costs[0].amount`、`produces[1].materialId`、`conditions[0]`、
 *   `effects[2].condition`、`effectValues[0]`
 */
import type { PathPrefix, ValueType } from './ast.js'

/** 属性值的持久化位置（6.3）。 */
export type StorageLocation =
  /** 顶层字段 + `assignments` 双写（布尔/数值/字符串属性的当前生效值以顶层为准）。 */
  | 'top-level'
  /** 只落在 `assignments`（列表与表达式文本字段的唯一权威副本）。 */
  | 'assignments'
  /** 不持久化（派生量，每 tick 重算）。 */
  | 'derived'

export interface PropertySpec {
  /** 该属性适用的条目前缀；`['*']` 表示四类都适用（但同一属性名在不同类上的语义可能不同，故分开列）。 */
  prefixes: readonly PathPrefix[]
  /** 静态类型。 */
  type: ValueType
  /** 可读（所有上下文均可读，5.5）。 */
  readable: boolean
  /** 可写：仅 `effect` 上下文允许写入（5.5 副作用列）。 */
  writable: boolean
  /** 存档位置（5.9.1/5.9.2 第 4 列）。 */
  storage: StorageLocation
  /** “重新开始”时的行为（5.9.1/5.9.2 第 5 列）。 */
  resetTo: string
}

/**
 * 只读属性的说明文案（`E_READONLY_TARGET` 的悬浮提示，5.4 末段）。
 * 这些属性创建后不变或属布局/派生量，PRD 未要求可赋值。
 */
export const READONLY_REASON = '该属性创建后不变、属布局或为派生量，不可被表达式修改（5.9）'

const entry = (prefixes: readonly PathPrefix[], type: ValueType, writable: boolean, storage: StorageLocation, resetTo: string): PropertySpec => ({
  prefixes,
  type,
  readable: true,
  writable,
  storage,
  resetTo,
})

/**
 * 属性表。键为规范化的属性名。
 *
 * 完整对应 5.9.1（条目）与 5.9.2（页面），逐行对齐，不多不少：
 * - `id`/`order`/`name`/`icon` 只读（5.3 末段、5.4 末段）；
 * - `perSec`（生成器）与 `buyDelay` 只读（前者是派生量，后者是实现细节字段）；
 * - 页面 `theme`/`columns`/`entries` 只读（布局属性）；
 * - `res.<id>.owned` 是 `amount` 的**读写别名**（D-37），映射到同一份存储，不单独存档。
 */
export const PROPERTY_SPECS: Readonly<Record<string, PropertySpec>> = {
  // ---- 标识与展示属性（只读，5.9.1 第 1 行）----
  id: entry(['res', 'gen', 'up', 'page'], 'string', false, 'top-level', '回到项目文件值'),
  order: entry(['res', 'gen', 'up', 'page'], 'number', false, 'top-level', '回到项目文件值'),
  name: entry(['res', 'gen', 'up', 'page'], 'string', false, 'top-level', '回到项目文件值'),
  icon: entry(['res', 'gen', 'up', 'page'], 'string', false, 'top-level', '回到项目文件值'),

  // ---- 通用可写属性（5.9.1 第 2~6 行）----
  description: entry(['res', 'gen', 'up', 'page'], 'string', true, 'top-level', '回到项目文件值'),
  visible: entry(['res', 'gen', 'up', 'page'], 'boolean', true, 'top-level', '回到项目文件值'),
  disabled: entry(['gen', 'up', 'page'], 'boolean', true, 'top-level', '回到项目文件值'),
  initial: entry(['res', 'gen', 'up'], 'number', true, 'top-level', '回到项目文件值'),
  max: entry(['res', 'gen', 'up'], 'number', true, 'top-level', '回到项目文件值'),

  // ---- 数量属性 ----
  /** 资源数量（`res.<id>.owned` 是它的别名，D-37）。 */
  amount: entry(['res'], 'number', true, 'top-level', '回到 initial'),
  bought: entry(['gen', 'up'], 'number', true, 'top-level', '回到 initial（生成器/升级按 8.5 初始化规则）'),
  owned: entry(['gen', 'up'], 'number', true, 'top-level', '回到 initial（生成器/升级按 8.5 初始化规则）'),
  /** `res.<id>.owned` 的别名条目（同一存储，不单独存档，5.9.1 第 8 行）。 */
  'res.owned': entry(['res'], 'number', true, 'top-level', '回到 initial'),

  // ---- 生成器 / 升级专有 ----
  buyAmount: entry(['gen', 'up'], 'number', true, 'top-level', '回到项目文件值'),
  isClicker: entry(['gen'], 'boolean', true, 'top-level', '回到项目文件值'),
  perSecond: entry(['up'], 'boolean', true, 'top-level', '回到项目文件值'),
  /** 生成器每秒产出合计：派生量、只读、不存档（5.9.1 第 18 行）。 */
  perSec: entry(['gen'], 'number', false, 'derived', '—'),
  /** 自动最大购买的间隔 tick 数：实现细节、只读（5.9.1 第 19 行）。 */
  buyDelay: entry(['gen', 'up'], 'number', false, 'top-level', '回到项目文件值'),

  // ---- 列表字段（表达式文本属性，只落 assignments，6.3 末段）----
  'costs[i].materialId': entry(['gen', 'up'], 'string', true, 'assignments', '回到项目文件值'),
  'costs[i].amount': entry(['gen', 'up'], 'number', true, 'assignments', '回到项目文件值'),
  // `produces` 只属生成器（5.9.1：升级无产出列表，8.7 升级专有字段同理）。
  'produces[i].materialId': entry(['gen'], 'string', true, 'assignments', '回到项目文件值'),
  'produces[i].amount': entry(['gen'], 'number', true, 'assignments', '回到项目文件值'),
  'conditions[i]': entry(['up'], 'number', true, 'assignments', '回到项目文件值'),
  'effects[i].condition': entry(['up'], 'number', true, 'assignments', '回到项目文件值'),
  'effects[i].action': entry(['up'], 'number', true, 'assignments', '回到项目文件值'),
  'effectValues[i]': entry(['up'], 'number', true, 'top-level', '清零为 0'),

  // ---- 页面布局属性（只读，5.9.2 第 7 行）----
  theme: entry(['page'], 'string', false, 'top-level', '—'),
  columns: entry(['page'], 'number', false, 'top-level', '—'),
  entries: entry(['page'], 'number', false, 'top-level', '—'),
}

/** 列表属性名（用于路径解析时判断是否含下标）。 */
export const LIST_PROPERTIES: ReadonlySet<string> = new Set(['costs', 'produces', 'conditions', 'effects', 'effectValues'])

/**
 * 解析后的属性描述。
 *
 * `key` 是**具体**的规范化键（如 `costs[0].amount`），用于查 `PROPERTY_SPECS`、
 * 作为 `set()` 的字面量路径目标、以及运行时定位到具体的列表行。
 *
 * 注意它与**模板**键（`costs[i].amount`）的区别：查表时用模板，返回时给具体键。
 * 早期实现误把模板键返回，导致 `set("gen.g1.produces[0].amount", …)`
 * 在运行期找不到第 0 行——`runtime` 的 `parseKey` 因此无法还原下标。
 * `spec` 允许为 `undefined` 表示“该条目类没有此属性”（读报 `E_UNKNOWN_ATTR`）。
 */
export interface ResolvedProperty {
  key: string
  spec: PropertySpec | undefined
}

/**
 * 把路径的属性链归一为规范键。
 *
 * `['costs', '0', 'amount']` -> `costs[0].amount`；
 * 非列表属性的链超过一段（如 `res.r1.a.b`）同样归一为 `a.b`，查表未命中即 `E_UNKNOWN_ATTR`。
 */
export function normalizePropertyKey(attrs: readonly string[]): string {
  if (attrs.length === 0) return ''
  const [head, ...rest] = attrs as [string, ...string[]]
  if (LIST_PROPERTIES.has(head)) {
    if (rest.length === 0) return `${head}[]`
    const [index, ...tail] = rest
    return tail.length === 0 ? `${head}[${index}]` : `${head}[${index}].${tail.join('.')}`
  }
  return attrs.join('.')
}

/**
 * 规范属性键（`deps` 元素、`deps` 缓存键、`set()` 目标路径的唯一形式）。
 *
 * 形如 `res.r1.amount`、`gen.g1.costs[0].amount`、`up.u1.effectValues[2]`。
 *
 * 必须由这个函数生成，不能用 `attrs.join('.')`：AST 里的下标是独立的数段
 * （`['costs','0','amount']`），直接 join 会得到 `costs.0.amount`，
 * 与 `set("gen.g1.costs[0].amount", …)` 的字面量路径**对不上**，
 * 副作用就会写到另一个键上。编译器、检查器、`set()` 三处必须走同一份格式化。
 */
export function formatPathKey(prefix: PathPrefix, id: string, attrs: readonly string[]): string {
  const key = normalizePropertyKey(attrs)
  return key.length === 0 ? `${prefix}.${id}` : `${prefix}.${id}.${key}`
}

/**
 * 把具体下标归一为**模板键**：`costs[0].amount` -> `costs[i].amount`。
 *
 * 属性表以 `[i]` 模板登记（`costs[i].materialId` 等），而实际路径带具体下标。
 * 两套形式各有用处：模板键用于查表与 `docs:check` 比对，具体键用于 `deps`、
 * 副作用目标与 `set()` 字面量路径——**只有这一处**负责把两者对齐，
 * 否则所有列表属性都会查不到并落到 `E_UNKNOWN_ATTR`。
 */
export function templateKey(key: string): string {
  return key.replace(/\[\d+\]/g, '[i]')
}

/** 查属性规格；条目类不适用时返回 `undefined`（调用方报 `E_UNKNOWN_ATTR`）。 */
export function lookupProperty(prefix: PathPrefix, attrs: readonly string[]): ResolvedProperty {
  const concrete = normalizePropertyKey(attrs)
  // `res.<id>.owned` 是 `amount` 的读写别名（5.9.1 第 8 行、D-37）：
  // 同一存储、同一 `applyCap`、不单独存档。查表时映射到 `amount` 的规格。
  // 返回的仍是调用方给的键（`owned`），否则 `write()` 会把 `owned` 错当成 `amount` 落到另一处存储。
  if (prefix === 'res' && concrete === 'owned') return { key: concrete, spec: PROPERTY_SPECS['amount'] }
  // 查表用**模板**键（属性表以 `[i]` 登记），返回给调用方的 `key` 用**具体**键。
  const spec = PROPERTY_SPECS[templateKey(concrete)]
  if (spec && !spec.prefixes.includes(prefix)) return { key: concrete, spec: undefined }
  return { key: concrete, spec }
}

/** 判断属性是否可读；不可读或不存在时返回 `false`。 */
export function isReadable(prefix: PathPrefix, attrs: readonly string[]): boolean {
  const { spec } = lookupProperty(prefix, attrs)
  return spec?.readable === true
}

/** 判断属性是否可写（仍需叠加 5.5 的上下文副作用权限）。 */
export function isWritable(prefix: PathPrefix, attrs: readonly string[]): boolean {
  const { spec } = lookupProperty(prefix, attrs)
  return spec?.writable === true
}

/**
 * `set()` 第一实参的字面量路径解析结果（5.4：`set()` 的路径必须是字面量，D-27）。
 */
export interface LiteralPath {
  prefix: PathPrefix
  id: string
  attrs: string[]
  key: string
  spec: PropertySpec | undefined
}

/**
 * 解析字面量路径文本（如 `gen.g1.produces[0].amount`）。
 *
 * 供 `set()` 的第一个实参与静态检查使用；`E_UNKNOWN_ATTR` / `E_READONLY_TARGET`
 * 的判定都基于解析结果（5.4 末段、5.9.3 末条）。
 *
 * 属性链文法：`( "." 标识符 | "[" 整数字面量 "]" )+`。
 * 注意 `name[idx]` 的下标**紧跟**标识符、中间没有点号（`effects[0].condition`），
 * 因此不能简单地按 `.` 切分——那样 `effectValues[0]` 会整体成一个键、查表必然失败。
 */
const LITERAL_PATH_PATTERN = /^(res|gen|up|page)\.([A-Za-z_][A-Za-z0-9_$]*)((?:\.[A-Za-z_][A-Za-z0-9_$]*|\[\d+\])+)$/

export function parseLiteralPath(text: string): LiteralPath | undefined {
  const match = LITERAL_PATH_PATTERN.exec(text)
  if (!match) return undefined
  const prefix = match[1] as PathPrefix
  const id = match[2]!
  const chain = match[3]!
  // `[0]` -> `.0`，与解析器产出的 attrs 结构一致（见 `normalizePropertyKey`）。
  const attrs = chain
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((part) => part.length > 0)
  const { key, spec } = lookupProperty(prefix, attrs)
  return { prefix, id, attrs, key, spec }
}
