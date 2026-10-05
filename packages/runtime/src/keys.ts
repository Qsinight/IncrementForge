/**
 * 属性键（path key）的构造与解析（TECH_DESIGN 5.6「变量解析」、5.9、8.4）。
 *
 * ## 为什么需要一个薄封装而不是到处拼字符串
 *
 * 键的规范形式（`res.r1.amount`、`gen.g1.costs[0].amount`、`up.u1.effectValues[2]`）
 * 由 `expr` 的 `formatPathKey` 生成——**只有它**知道下标在 AST 里是独立数段、
 * 必须写成 `costs[0]` 而不是 `costs.0`（5.9 的 `formatPathKey` 注释里写明了
 * “编译器、检查器、`set()` 三处必须走同一份格式化”）。运行时是第四处，
 * 因此这里只提供**语义化**的构造器，底层一律转发给它：
 *
 * ```ts
 * Keys.res('r1').amount            // 'res.r1.amount'
 * Keys.gen('g1').costAmount(0)      // 'gen.g1.costs[0].amount'
 * Keys.up('u1').effectValue(2)      // 'up.u1.effectValues[2]'
 * ```
 *
 * 另加 `Keys.parse()` 供运行时反查（8.4 的 `pageOf`、副作用提交阶段都要按键找条目）。
 */
import type { PathPrefix } from '@iforge/expr'
import { formatPathKey, parseLiteralPath, templateKey } from '@iforge/expr'

export { formatPathKey, parseLiteralPath, templateKey }

/** 运行时关心的四种实体内缀（5.9.1 条目 / 5.9.2 页面）。 */
export type RuntimeEntityKind = 'resource' | 'generator' | 'upgrade' | 'page'

/** 路径前缀 -> 实体类型（5.2 的 `path` 前缀、6.3 的存档容器）。 */
export const PREFIX_TO_KIND: Readonly<Record<PathPrefix, RuntimeEntityKind>> = {
  res: 'resource',
  gen: 'generator',
  up: 'upgrade',
  page: 'page',
}

/** 实体类型 -> 路径前缀（`has()` / `create()` 的 `kind` 参数用，5.4）。 */
export const KIND_TO_PREFIX: Readonly<Record<RuntimeEntityKind, PathPrefix>> = {
  resource: 'res',
  generator: 'gen',
  upgrade: 'up',
  page: 'page',
}

/** `has(kind, id)` / `create(kind, …)` 接受的 kind 字符串（8.7、D-34）。 */
export const CREATE_KINDS = ['generator', 'upgrade'] as const
export type CreateKind = (typeof CREATE_KINDS)[number]

/** `res.<id>` / `gen.<id>` / … 这类“条目主键”（不带属性）。 */
export function entityKey(prefix: PathPrefix, id: string): string {
  return formatPathKey(prefix, id, [])
}

/** 解析后的键。 */
export interface ParsedKey {
  prefix: PathPrefix
  kind: RuntimeEntityKind
  id: string
  /** 模板化的属性名（如 `costs[i].amount`）；无属性时为空串。 */
  attr: string
  /** 具体属性名（如 `costs[0].amount`）。 */
  concreteAttr: string
  /** 列表下标；非列表属性为 `undefined`。 */
  index?: number
}

const LIST_INDEX_PATTERN = /^([A-Za-z]+)(?:\[(\d+)\])(?:\.(.+))?$/

/**
 * 解析属性键。
 *
 * @returns 解析失败（形如 `tick` 的内置变量、无法识别的形态）时返回 `undefined`。
 */
export function parseKey(key: string): ParsedKey | undefined {
  const resolved = parseLiteralPath(key)
  if (!resolved) return undefined
  const concrete = templateKey(resolved.key)
  const parsed: ParsedKey = {
    prefix: resolved.prefix,
    kind: PREFIX_TO_KIND[resolved.prefix],
    id: resolved.id,
    attr: concrete,
    concreteAttr: resolved.key,
  }
  const match = LIST_INDEX_PATTERN.exec(resolved.key)
  if (match) {
    const index = Number(match[2])
    // `noUncheckedIndexedAccess` 下 `match[2]` 已确认为字符串分支，这里给出兜底。
    if (Number.isInteger(index)) parsed.index = index
  }
  return parsed
}

/** 列出属性名的全部可写/可读变体（供运行时构造键时不必手写下标字符串）。 */
function attrs(name: string, index?: number): string[] {
  return index === undefined ? [name] : [name, String(index)]
}

/** 条目与页面共有的标识/展示属性（5.9.1 第 1 行、5.9.2 第 4 行，**只读**）。 */
export interface IdentityKeys {
  id: string
  order: string
  name: string
  icon: string
}

/** `res.<id>.*` 的键构造器。 */
export interface ResourceKeys extends IdentityKeys {
  readonly entity: string
  /** 资源数量；`owned` 是它的读写别名（D-37）。 */
  amount: string
  owned: string
  initial: string
  max: string
  visible: string
  description: string
}

/** `gen.<id>.*` 的键构造器（生成器专有字段）。 */
export interface GeneratorKeys extends IdentityKeys {
  readonly entity: string
  bought: string
  owned: string
  initial: string
  max: string
  visible: string
  disabled: string
  description: string
  /** 每秒产出合计（派生、只读，5.9.1 第 18 行）。 */
  perSec: string
  buyDelay: string
  isClicker: string
  buyAmount: string
  costMaterial(index: number): string
  costAmount(index: number): string
  produceMaterial(index: number): string
  produceAmount(index: number): string
}

/** `up.<id>.*` 的键构造器（升级专有字段）。 */
export interface UpgradeKeys extends IdentityKeys {
  readonly entity: string
  bought: string
  owned: string
  initial: string
  max: string
  visible: string
  disabled: string
  description: string
  buyDelay: string
  perSecond: string
  buyAmount: string
  costMaterial(index: number): string
  costAmount(index: number): string
  condition(index: number): string
  effectCondition(index: number): string
  effectAction(index: number): string
  effectValue(index: number): string
}

/** `page.<id>.*` 的键构造器。 */
export interface PageKeys {
  readonly entity: string
  visible: string
  disabled: string
  description: string
  id: string
  order: string
  name: string
  icon: string
  theme: string
  columns: string
  entries: string
}

/**
 * 语义化键构造器。
 *
 * 全部走 `formatPathKey`，保证与表达式侧生成的键**逐字一致**——
 * `set("gen.g1.produces[0].amount", …)` 落到运行时必须能找到同一个条目与同一个下标。
 */
export const Keys = {
  res(id: string): ResourceKeys {
    const p: PathPrefix = 'res'
    return {
      entity: entityKey(p, id),
      amount: formatPathKey(p, id, attrs('amount')),
      owned: formatPathKey(p, id, attrs('owned')),
      initial: formatPathKey(p, id, attrs('initial')),
      max: formatPathKey(p, id, attrs('max')),
      visible: formatPathKey(p, id, attrs('visible')),
      description: formatPathKey(p, id, attrs('description')),
      id: formatPathKey(p, id, attrs('id')),
      order: formatPathKey(p, id, attrs('order')),
      name: formatPathKey(p, id, attrs('name')),
      icon: formatPathKey(p, id, attrs('icon')),
    }
  },

  gen(id: string): GeneratorKeys {
    const p: PathPrefix = 'gen'
    return {
      entity: entityKey(p, id),
      id: formatPathKey(p, id, attrs('id')),
      order: formatPathKey(p, id, attrs('order')),
      name: formatPathKey(p, id, attrs('name')),
      icon: formatPathKey(p, id, attrs('icon')),
      bought: formatPathKey(p, id, attrs('bought')),
      owned: formatPathKey(p, id, attrs('owned')),
      initial: formatPathKey(p, id, attrs('initial')),
      max: formatPathKey(p, id, attrs('max')),
      visible: formatPathKey(p, id, attrs('visible')),
      disabled: formatPathKey(p, id, attrs('disabled')),
      description: formatPathKey(p, id, attrs('description')),
      perSec: formatPathKey(p, id, attrs('perSec')),
      buyDelay: formatPathKey(p, id, attrs('buyDelay')),
      isClicker: formatPathKey(p, id, attrs('isClicker')),
      buyAmount: formatPathKey(p, id, attrs('buyAmount')),
      costMaterial: (index: number) => formatPathKey(p, id, attrs('costs', index).concat('materialId')),
      costAmount: (index: number) => formatPathKey(p, id, attrs('costs', index).concat('amount')),
      produceMaterial: (index: number) => formatPathKey(p, id, attrs('produces', index).concat('materialId')),
      produceAmount: (index: number) => formatPathKey(p, id, attrs('produces', index).concat('amount')),
    }
  },

  up(id: string): UpgradeKeys {
    const p: PathPrefix = 'up'
    return {
      entity: entityKey(p, id),
      id: formatPathKey(p, id, attrs('id')),
      order: formatPathKey(p, id, attrs('order')),
      name: formatPathKey(p, id, attrs('name')),
      icon: formatPathKey(p, id, attrs('icon')),
      bought: formatPathKey(p, id, attrs('bought')),
      owned: formatPathKey(p, id, attrs('owned')),
      initial: formatPathKey(p, id, attrs('initial')),
      max: formatPathKey(p, id, attrs('max')),
      visible: formatPathKey(p, id, attrs('visible')),
      disabled: formatPathKey(p, id, attrs('disabled')),
      description: formatPathKey(p, id, attrs('description')),
      buyDelay: formatPathKey(p, id, attrs('buyDelay')),
      perSecond: formatPathKey(p, id, attrs('perSecond')),
      buyAmount: formatPathKey(p, id, attrs('buyAmount')),
      costMaterial: (index: number) => formatPathKey(p, id, attrs('costs', index).concat('materialId')),
      costAmount: (index: number) => formatPathKey(p, id, attrs('costs', index).concat('amount')),
      condition: (index: number) => formatPathKey(p, id, attrs('conditions', index)),
      effectCondition: (index: number) => formatPathKey(p, id, attrs('effects', index).concat('condition')),
      effectAction: (index: number) => formatPathKey(p, id, attrs('effects', index).concat('action')),
      effectValue: (index: number) => formatPathKey(p, id, attrs('effectValues', index)),
    }
  },

  page(id: string): PageKeys {
    const p: PathPrefix = 'page'
    return {
      entity: entityKey(p, id),
      id: formatPathKey(p, id, attrs('id')),
      order: formatPathKey(p, id, attrs('order')),
      name: formatPathKey(p, id, attrs('name')),
      icon: formatPathKey(p, id, attrs('icon')),
      visible: formatPathKey(p, id, attrs('visible')),
      disabled: formatPathKey(p, id, attrs('disabled')),
      description: formatPathKey(p, id, attrs('description')),
      theme: formatPathKey(p, id, attrs('theme')),
      columns: formatPathKey(p, id, attrs('columns')),
      entries: formatPathKey(p, id, attrs('entries')),
    }
  },
} as const

/** 内置变量名（5.3）：它们不带 `res/gen/up/page` 前缀，单独识别。 */
export const BUILTIN_VARIABLES = ['tick', 'time', 'dt', 'elapsed', 'offline', 'started'] as const
export type BuiltinVariable = (typeof BUILTIN_VARIABLES)[number]

/** 该键是否是内置变量（而非条目属性）。 */
export function isBuiltinVariable(key: string): key is BuiltinVariable {
  return (BUILTIN_VARIABLES as readonly string[]).includes(key)
}
