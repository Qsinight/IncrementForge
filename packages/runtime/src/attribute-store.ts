/**
 * `AttributeStore` —— 属性的**当前生效值**与读写入口（TECH_DESIGN 5.6、5.7、5.9.3、6.3、8.4）。
 *
 * 它同时是三件事的落点：
 * 1. `Scope.read` 的实现（5.6「变量解析」）——表达式读到的永远是这里的生效值；
 * 2. 副作用提交阶段 `set` 的落点（5.6 的**唯一提交点**、8.3 第 6 步）；
 * 3. 存档序列化的数据源（6.3「顶层字段 = 当前生效值」）。
 *
 * ## 三类字段与两种“文本/数值”形态
 *
 * 数据模型里 `initial`/`max`/`buyAmount` 与 `costs[i].amount`/`produces[i].amount`/
 * `conditions[i]`/`effects[i]..*` 都是**字符串字段**（6.1）。运行时它们各有两种形态：
 *
 * | 形态 | 存储 | `read(key)` 返回 | 典型字段 |
 * | --- | --- | --- | --- |
 * | 表达式文本 | `text` | **求值后的值**（与 `PROPERTY_SPECS` 的静态类型一致） | `max`、`costs[i].amount`、`conditions[i]` |
 * | 直接数值 | `values` | 直接返回 | `amount`、`bought`、`owned`、`effectValues[i]` |
 *
 * 读取文本型字段时**必须求值**：静态检查把 `costs[i].amount` 的类型标成 `number`
 * （`properties.ts`），若读取时返回文本，用户写 `gen.g1.costs[0].amount * 0.5`
 * 就会在运行期炸 `E_TYPE`，与编译期类型不符。文本本身由 `textOr()` 提供，
 * 供批量求解器（8.6.1）、热替换与存档回填使用。
 *
 * ## 版本号与 last-good（5.7）
 *
 * 每个属性维护 `version`，写入即递增；`buyAmount` 等归一化字段保留 `lastGood`
 * （求值失败或非有限时沿用上次成功值，D-36、D-07）。
 * 跨 tick 的“版本未变则复用缓存值”**未启用**——每 tick 归零记忆化是更强的失效策略（ADR-07）；
 * 版本号的职责是把写入**可观测**（诊断面板、14.2 用例）并向下游传播失效。
 */
import { Diagnostics, ForgeError, isFinite as isFiniteDecimal, isInf, isNaN, normalizeCap, Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'
import type { ContextKind, Value } from '@iforge/expr'
import { lookupProperty, templateKey, validateExpression } from '@iforge/expr'
import type { Assignment, GeneratorDef, PageDef, ProjectFile, ResourceDef, UpgradeDef } from '@iforge/model'

import { PREFIX_TO_KIND, isBuiltinVariable, parseKey } from './keys.js'
import type { RuntimeEntityKind } from './keys.js'

/** 文本型（`NumExpr`）字段的属性名（5.9.1）。 */
const TEXT_FIELDS = new Set(['initial', 'max', 'buyAmount'])

/** 直接存数值的字段（不含列表）。 */
const VALUE_FIELDS = new Set(['amount', 'bought', 'owned'])

/** 布尔字段。 */
const BOOLEAN_FIELDS = new Set(['visible', 'disabled', 'isClicker', 'perSecond'])

/** 只读的属性（5.9 的“可写”列）：写入必须报 `E_READONLY_TARGET`。 */
const READONLY_FIELDS = new Set(['id', 'order', 'name', 'icon', 'theme', 'columns', 'entries', 'perSec'])

/** 一个运行时条目（资源/生成器/升级）或页面的当前状态。 */
export interface EntryState {
  kind: RuntimeEntityKind
  id: string
  /** 项目定义（动态条目为其 `spec` 构造出的定义，8.7）。 */
  def: ResourceDef | GeneratorDef | UpgradeDef | PageDef
  /** 表达式文本字段的**当前文本**（可被热替换，5.9.3）。 */
  text: Map<string, string>
  /** 直接数值字段的当前值。 */
  values: Map<string, Decimal>
  visible: boolean
  disabled: boolean
  /** 生成器/升级的 `buyDelay`（D-04），只读但随存档走。 */
  buyDelay: number
  description: string
  /** 动态条目的附加信息（8.7；静态条目为 `undefined`）。 */
  dynamic?: { createdAt: string; pageId: string }
  /** 属性版本号（5.7）。 */
  versions: Map<string, number>
  /** 赋值审计记录（6.3：值 + 表达式原文 + tick）。 */
  assignments: Map<string, Assignment>
  /** `buyAmount` 等归一化字段的 last-good（D-36）。 */
  lastGood: Map<string, Decimal>
  /**
   * 键是**被引擎换成中性占位值**的表达式文本字段（`costs[0].amount` 这种具体键）。
   *
   * 装载与 `host:patch` 时，作者写坏的表达式文本会被 `validateDefinitionTexts()` 换成
   * `neutralExpressionText()` 的占位值（5.7 的 last-good、`E_PARSE` 仍然入库）。那份文本
   * **不是作者写的**，因此不能被当作真实数据参与结算：价格占位值是 `'0'`，若按它结算，
   * 一个写坏了价格表达式的生成器就变成“免费可买”。
   *
   * `priceRowsUsable()` 据此拒绝结算（见 `purchase.ts`）；展示侧仍照常按占位值渲染
   * 并由 `E_PARSE` 提示作者改。
   */
  neutralized: Set<string>
  /** 稳定排序用的序号：静态条目用 `order`，动态条目用创建序号（8.7「排序」行）。 */
  sortOrder: number
}

/**
 * 求值宿主：把“按上下文求值一条表达式文本”的能力注入存储。
 *
 * 拆成接口而不是直接依赖 `ExpressionRuntime`，是为了让 `AttributeStore` 可以在
 * 单测里用一个假宿主驱动（5.7 的语义不依赖真实求值器）。
 */
export interface ExpressionHost {
  /** 求值并返回数值结果。 */
  evaluateNumber(text: string, context: ContextKind, where: string): Decimal
  /** 求值并返回布尔结果。 */
  evaluateBoolean(text: string, context: ContextKind, where: string): boolean
  /** 当前 tick 序号（写入 `assignments.tick`，6.3）。 */
  tick(): number
  /**
   * 丢弃本 tick 已缓存的表达式求值结果。
   *
   * 由 `bump()`（所有写路径的唯一收口）在每次写入后调用：tick 缓存只在
   * “这一 tick 内没有任何写入”时成立，否则缓存里留着的是**过期**的值，
   * 而且过期是静默的（见 `Evaluator.invalidateCache`）。
   */
  invalidateExpressions(): void
}

/** 运行时变量（5.3 内置变量）的取值来源。 */
export interface RuntimeVars {
  tick: number
  /** 游戏内累计秒数（随倍速推进，D-35）。 */
  time: Decimal
  /** 当前 tick 时长（秒）。 */
  dt: Decimal
  /** 距上次存档的秒数（离线时为离线秒数）。 */
  elapsed: number
  offline: boolean
  started: boolean
}

// ---------------------------------------------------------------------------
// 定义收窄（`def` 是四类的联合类型，`.passthrough()` 使 `in` 收窄失效，
// 因此统一用这些守卫函数访问专有字段）
// ---------------------------------------------------------------------------

/** 取资源定义。 */
export function resourceDefOf(state: EntryState): ResourceDef {
  if (state.kind !== 'resource') throw new ForgeError('E_UNKNOWN_ATTR', { message: `${state.id} 不是资源` })
  return state.def as ResourceDef
}

/** 取生成器定义（`isClicker`/`costs`/`produces` 的入口）。 */
export function generatorDefOf(state: EntryState): GeneratorDef {
  if (state.kind !== 'generator') throw new ForgeError('E_UNKNOWN_ATTR', { message: `${state.id} 不是生成器` })
  return state.def as GeneratorDef
}

/** 取升级定义（`perSecond`/`conditions`/`effects` 的入口）。 */
export function upgradeDefOf(state: EntryState): UpgradeDef {
  if (state.kind !== 'upgrade') throw new ForgeError('E_UNKNOWN_ATTR', { message: `${state.id} 不是升级` })
  return state.def as UpgradeDef
}

/** 取页面定义（`theme`/`columns`/`entries` 的入口）。 */
export function pageDefOf(state: EntryState): PageDef {
  if (state.kind !== 'page') throw new ForgeError('E_UNKNOWN_ATTR', { message: `${state.id} 不是页面` })
  return state.def as PageDef
}

/** 取购买价格列表（生成器/升级专有）。 */
export function costsOf(state: EntryState): GeneratorDef['costs'] {
  if (state.kind === 'generator') return generatorDefOf(state).costs
  if (state.kind === 'upgrade') return upgradeDefOf(state).costs
  return []
}

/** 取产出列表（生成器专有，升级无产出列表，5.9.1）。 */
export function producesOf(state: EntryState): GeneratorDef['produces'] {
  return state.kind === 'generator' ? generatorDefOf(state).produces : []
}

/** 取购买条件列表（升级专有）。 */
export function conditionsOf(state: EntryState): UpgradeDef['conditions'] {
  return state.kind === 'upgrade' ? upgradeDefOf(state).conditions : []
}

/** 取效果列表（升级专有）。 */
export function effectsOf(state: EntryState): UpgradeDef['effects'] {
  return state.kind === 'upgrade' ? upgradeDefOf(state).effects : []
}

/** 该条目是否点击器（生成器专有）。 */
export function isClickerDef(state: EntryState): boolean {
  return state.kind === 'generator' && generatorDefOf(state).isClicker
}

/** 该升级是否“每秒生效”。 */
export function perSecondDef(state: EntryState): boolean {
  return state.kind === 'upgrade' && upgradeDefOf(state).perSecond
}

/**
 * 读取 `def` 上的布尔字段。
 *
 * 为什么需要它：Zod 的 `.passthrough()` 让输出类型带 `[k: string]: unknown` 索引签名，
 * `'disabled' in def` 的收窄结果是 `unknown` 而不是 `boolean`。这里统一做一次
 * `typeof` 兜底，避免每个调用点各写一遍类型断言。
 */
function boolOf(def: object, field: string, fallback: boolean): boolean {
  const value = (def as Record<string, unknown>)[field]
  return typeof value === 'boolean' ? value : fallback
}

/** 读取 `def` 上的正整数字段（`buyDelay`）。 */
function intOf(def: object, field: string, fallback: number): number {
  const value = (def as Record<string, unknown>)[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 读取 `def` 上的字符串字段。 */
function strOf(def: object, field: string, fallback: string): string {
  const value = (def as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : fallback
}

// ---------------------------------------------------------------------------
// 键与辅助
// ---------------------------------------------------------------------------

/** 由类型与 id 拼出实体键（`res.r1`）。 */
export function entityKeyOf(kind: RuntimeEntityKind, id: string): string {
  switch (kind) {
    case 'resource':
      return `res.${id}`
    case 'generator':
      return `gen.${id}`
    case 'upgrade':
      return `up.${id}`
    case 'page':
      return `page.${id}`
  }
}

/** 实体类型 -> 表达式路径前缀（5.2 的 `path` 前缀）。 */
export function prefixOf(kind: RuntimeEntityKind): 'res' | 'gen' | 'up' | 'page' {
  switch (kind) {
    case 'resource':
      return 'res'
    case 'generator':
      return 'gen'
    case 'upgrade':
      return 'up'
    case 'page':
      return 'page'
  }
}

/**
 * 具体属性名 -> 属性链数组（`lookupProperty` 的入参形态）。
 *
 * `costs[0].amount` -> `['costs', '0', 'amount']`。与 `expr` 的 `normalizePropertyKey`
 * 必须是同一套切分规则，因此这里**不**自己 `split('.')`（那会把 `costs[0].amount`
 * 切成 `['costs[0]', 'amount']`，查表必然落空）。
 */
export function attrsFromConcrete(concreteAttr: string): string[] {
  if (concreteAttr.length === 0) return []
  const out: string[] = []
  for (const segment of concreteAttr.split('.')) {
    const match = /^([A-Za-z]+)\[(\d+)\]$/.exec(segment)
    if (match) out.push(match[1]!, match[2]!)
    else out.push(segment)
  }
  return out
}

/** `icon` 引用转成可比较的字符串（5.3 的只读展示属性）。 */
export function iconRefToString(icon: { kind: string; value: string }): string {
  return `${icon.kind}:${icon.value}`
}

/** `theme` 引用转字符串。 */
export function themeRefToString(theme: { kind: string; value: string }): string {
  return `${theme.kind}:${theme.value}`
}

/**
 * 属性存储。
 *
 * 构造时只建立**结构**（条目、列表、文本），数值状态由 `loadProject()` /
 * `resetValues()` / `restoreSave()` 填充；分开的理由是“重新开始”只重建数值、
 * 不重建结构（D-18）。
 */
export class AttributeStore {
  /** 条目与页面的当前状态，按实体键（`res.r1`）索引。 */
  readonly entries = new Map<string, EntryState>()

  /** 内置变量（5.3）的取值来源；`GameState` 每 tick 覆盖。 */
  vars: RuntimeVars = {
    tick: 0,
    time: Num.fromNumber(0),
    dt: Num.fromNumber(0),
    elapsed: 0,
    offline: false,
    started: false,
  }

  private readonly host: ExpressionHost

  constructor(host: ExpressionHost) {
    this.host = host
  }

  // -------------------------------------------------------------------------
  // 结构
  // -------------------------------------------------------------------------

  /**
   * 用项目文件建立静态结构（6.3 读档顺序 ①）。
   *
   * 动态条目**不在**这里建立——它们来自存档（读档顺序 ②）或 `create()`（8.7）。
   */
  loadProject(project: ProjectFile): void {
    this.entries.clear()
    for (const resource of project.resources) {
      const state = createEntryState('resource', resource.id, resource)
      this.entries.set(entityKeyOf('resource', resource.id), state)
    }
    for (const generator of project.generators) {
      const state = createEntryState('generator', generator.id, generator)
      this.entries.set(entityKeyOf('generator', generator.id), state)
    }
    for (const upgrade of project.upgrades) {
      const state = createEntryState('upgrade', upgrade.id, upgrade)
      this.entries.set(entityKeyOf('upgrade', upgrade.id), state)
    }
    for (const page of project.pages) {
      const state = createEntryState('page', page.id, page)
      this.entries.set(entityKeyOf('page', page.id), state)
    }
  }

  /** 注册一个动态条目（8.7「创建成功」行）。 */
  addDynamic(state: EntryState): void {
    this.entries.set(entityKeyOf(state.kind, state.id), state)
  }

  /**
   * 整体替换一个条目的状态（7.4 的 `host:patch` 热更新）。
   *
   * 与 `remove` + `addDynamic` 分两步相比，单次 `set` 不会给同一实体键留下**两个** `EntryState`
   * ——两者同时存在时 `entries.get` 只返回后写入的那条，另一条仍被引用着，
   * 症状是“改一个字段界面不动、也不报错”。
   */
  replace(state: EntryState): void {
    this.entries.set(entityKeyOf(state.kind, state.id), state)
  }

  /** 移除一个条目（含其 `assignments`/`effectValues`/页面归属，8.7「销毁」行）。 */
  remove(entity: string): void {
    this.entries.delete(entity)
  }

  /** 取条目状态；不存在时抛 `E_UNKNOWN_ATTR`（读不存在的条目，8.7 运行期兜底）。 */
  require(entity: string): EntryState {
    const state = this.entries.get(entity)
    if (!state) throw new ForgeError('E_UNKNOWN_ATTR', { where: entity, message: `条目 ${entity} 不存在` })
    return state
  }

  /** 取条目状态；不存在返回 `undefined`（判定类场景用，不抛错）。 */
  find(entity: string): EntryState | undefined {
    return this.entries.get(entity)
  }

  /** 某类条目的稳定排序列表（PRD 补充 5：按 `order`；同序号按创建时间，8.7「排序」行）。 */
  listByKind(kind: RuntimeEntityKind): EntryState[] {
    const items = [...this.entries.values()].filter((item) => item.kind === kind)
    return items.sort((a, b) => a.sortOrder - b.sortOrder || compareCreatedAt(a, b))
  }

  /** 按前缀取条目列表（`res`/`gen`/`up`/`page`）。 */
  listByPrefix(prefix: string): EntryState[] {
    return this.listByKind(PREFIX_TO_KIND[prefix as keyof typeof PREFIX_TO_KIND] ?? 'resource')
  }

  // -------------------------------------------------------------------------
  // 读（Scope.read，5.6）
  // -------------------------------------------------------------------------

  /** `Scope.read` 的实现。 */
  readonly read = (key: string): Value => {
    if (isBuiltinVariable(key)) return this.readBuiltin(key)
    const parsed = parseKey(key)
    if (!parsed) throw new ForgeError('E_UNKNOWN_ATTR', { where: key, message: `无法解析的属性键 ${key}` })
    const state = this.entries.get(entityKeyOf(parsed.kind, parsed.id))
    if (!state) {
      throw new ForgeError('E_UNKNOWN_ATTR', { where: key, message: `条目 ${parsed.prefix}.${parsed.id} 不存在` })
    }
    return this.readAttr(state, parsed.attr, parsed.concreteAttr, parsed.index, key)
  }

  private readBuiltin(key: string): Value {
    switch (key) {
      case 'tick':
        return Num.fromNumber(this.vars.tick)
      case 'time':
        return this.vars.time
      case 'dt':
        return this.vars.dt
      case 'elapsed':
        return Num.fromNumber(this.vars.elapsed)
      case 'offline':
        return this.vars.offline
      case 'started':
        return this.vars.started
      default:
        throw new ForgeError('E_UNKNOWN_ATTR', { where: key, message: `未知的内置变量 ${key}` })
    }
  }

  /**
   * 读单个属性。
   *
   * 第一步先过 `PROPERTY_SPECS`（5.9 权限矩阵）：条目类**没有**的属性一律 `E_UNKNOWN_ATTR`。
   * 编译期已拦过一次（`expr` 的 `checker`），这里再拦一次是因为运行期还有编译期看不到的路径：
   * `set()` 的字面量路径、存档回填、动态条目 spec 校验、以及直接构造键的调用方。
   * 两端共用同一份 `PROPERTY_SPECS`，语义因此不会分叉（5.9 开篇的要求）。
   */
  private readAttr(state: EntryState, attr: string, concreteAttr: string, index: number | undefined, key: string): Value {
    const { spec } = lookupProperty(prefixOf(state.kind), attrsFromConcrete(concreteAttr))
    if (!spec) {
      throw new ForgeError('E_UNKNOWN_ATTR', {
        where: key,
        message: `${state.kind} 没有属性 ${attr}（5.9 属性读写矩阵）`,
      })
    }

    // ---- 只读的标识/展示属性（5.9.1 第 1 行、5.9.2 第 4~7 行）----
    switch (attr) {
      case 'id':
        return state.id
      case 'order':
        return Num.fromNumber(state.def.order)
      case 'name':
        return state.def.name
      case 'icon':
        return iconRefToString(state.def.icon)
      case 'theme':
        return themeRefToString(pageDefOf(state).theme)
      case 'columns':
        return Num.fromNumber(pageDefOf(state).columns)
      case 'entries':
        // `entries` 是布局列表（只读）；表达式侧只作为占位引用（13 第 2 条禁止在非 spec 处出现字面量）。
        return Num.fromNumber(pageDefOf(state).entries.length)
      default:
        break
    }

    // ---- 布尔字段（5.9.1 第 3 行）----
    if (BOOLEAN_FIELDS.has(attr)) {
      if (attr === 'isClicker') return isClickerDef(state)
      if (attr === 'perSecond') return perSecondDef(state)
      return attr === 'visible' ? state.visible : state.disabled
    }

    // ---- 字符串字段 ----
    if (attr === 'description') return state.description

    // ---- 只读的数值派生量 ----
    if (attr === 'buyDelay') return Num.fromNumber(state.buyDelay)
    if (attr === 'perSec') return this.perSecond(state)

    // ---- 数值与列表字段 ----
    if (VALUE_FIELDS.has(attr)) return this.value(state, attr, key)

    if (TEXT_FIELDS.has(attr)) {
      const text = this.textOr(state, attr)
      const value = this.host.evaluateNumber(text, 'field', key)
      // 4.4 第 4 条：`max` 求值为 `NaN`/`≤ 0` 时按 1 处理并记 `E_CAP_NON_POSITIVE`。
      // `normalizeCap` 对 `NUM_INF` 原样返回——`max = "Infinity"` 表示“无上限”（D-46）。
      if (attr === 'max') return normalizeCap(value, key)
      if (attr === 'buyAmount') return this.normalizeBuyAmount(state, text, key)
      return value
    }

    return this.readListAttr(state, attr, concreteAttr, index, key)
  }

  /** 列表字段求值（`costs`/`produces`/`conditions`/`effects`/`effectValues`）。 */
  private readListAttr(state: EntryState, attr: string, concreteAttr: string, index: number | undefined, key: string): Value {
    const i = index
    if (i === undefined) {
      // 整个列表（如 `gen.g1.costs`）：静态类型是 `number`，返回长度供算术使用。
      return Num.fromNumber(this.listLength(state, attr))
    }

    // `materialId` 是字符串字段，原样返回当前文本。
    if (concreteAttr.endsWith('.materialId')) {
      const text = state.text.get(concreteAttr)
      if (text === undefined) throw indexError(state, attr, i, key)
      return text
    }

    // `effectValues[i]`：持久化的效果数值，默认 0（PRD 升级编辑器 12）。
    if (attr === 'effectValues[i]') {
      const value = state.values.get(concreteAttr)
      if (value !== undefined) return value
      if (i >= effectsOf(state).length) throw indexError(state, attr, i, key)
      return Num.fromNumber(0)
    }

    // 其余表达式文本字段：求值后返回（与静态类型 `number` 一致）。
    const text = state.text.get(concreteAttr)
    if (text === undefined) throw indexError(state, attr, i, key)
    return this.host.evaluateNumber(text, contextOf(attr), key)
  }

  /** 列表长度。 */
  private listLength(state: EntryState, attr: string): number {
    switch (attr) {
      case 'costs':
        return costsOf(state).length
      case 'produces':
        return producesOf(state).length
      case 'conditions':
        return conditionsOf(state).length
      case 'effects':
        return effectsOf(state).length
      case 'effectValues[i]':
        return effectsOf(state).length
      default:
        return 0
    }
  }

  /** 取数值属性的当前值；缺省为 0。 */
  value(state: EntryState, attr: string, where?: string): Decimal {
    const raw = state.values.get(attr)
    if (raw !== undefined) return raw
    // `amount` 只属资源（D-20：生成器/升级没有“数量”字段）。
    if (attr === 'amount' && state.kind !== 'resource') {
      throw new ForgeError('E_UNKNOWN_ATTR', { where, message: `${state.kind} 没有属性 amount（D-20）` })
    }
    if (attr === 'owned' && state.kind === 'resource') {
      // D-37：`res.<id>.owned` 是 `amount` 的别名，同一份存储。
      return state.values.get('amount') ?? Num.fromNumber(0)
    }
    return Num.fromNumber(0)
  }

  /**
   * `buyAmount` 的求值归一化（5.9.3 的 ①~④、D-36）。
   *
   * | 步骤 | 规则 | 违反时 |
   * | --- | --- | --- |
   * | ① 求值 | `field` 上下文 | 记诊断，保持上次成功值 |
   * | ② 有限性 | 必须是有限实数（拒 `NaN`/`±∞`，如 `ln(0)`、`0/0`） | `E_BUY_AMOUNT_INVALID`，保持 last-good |
   * | ③ 取整 | `floor`（超安全整数退化，4.4 第 5 条） | — |
   * | ④ 夹取 | `n ≥ 1` 夹到 `100`；`n = 0` / `n < 0` 无上限，不再夹 | — |
   */
  private normalizeBuyAmount(state: EntryState, text: string, where: string): Decimal {
    const lastGood = state.lastGood.get('buyAmount') ?? this.projectBuyAmount(state, where)
    let value: Decimal
    try {
      value = this.host.evaluateNumber(text, 'field', where)
    } catch (error) {
      Diagnostics.record('E_BUY_AMOUNT_INVALID', where, `buyAmount 求值失败：${describe(error)}`)
      return lastGood
    }
    if (isNaN(value) || isInf(value) || !isFiniteDecimal(value)) {
      // ②：`±Infinity` 与 `NaN` 都拒（4.4 第 6 条把 `Infinity` 归一到这里）。
      Diagnostics.record('E_BUY_AMOUNT_INVALID', where, 'buyAmount 求值结果为非有限实数，保持上次成功值')
      return lastGood
    }
    const clamped = clampBuyAmount(value)
    state.lastGood.set('buyAmount', clamped)
    return clamped
  }

  /**
   * 项目文件里的 `buyAmount` 归一化值，用作 last-good 的**初值**。
   *
   * 为什么需要它：5.9.3 归一化第 ① 步说“求值失败保持上次成功值”，但**第一次**读取就失败时
   * 并无“上次成功值”。此时正确的 last-good 是项目文件的默认值——那才是本局开始时真正
   * 生效过的值（8.5 初始化表）。少了它，`buyAmount` 一上来就被写成 `0 / 0` 时会落到兜底的
   * `1`，而项目文件明明写的是 `7`。
   */
  private projectBuyAmount(state: EntryState, where: string): Decimal {
    const projectText = collectProjectText(state).get('buyAmount') ?? '1'
    try {
      const value = this.host.evaluateNumber(projectText, 'field', where)
      if (isNaN(value) || isInf(value) || !isFiniteDecimal(value)) return Num.fromNumber(1)
      const clamped = clampBuyAmount(value)
      state.lastGood.set('buyAmount', clamped)
      return clamped
    } catch {
      return Num.fromNumber(1)
    }
  }

  /** 写入归一化后的 `buyAmount`（提交阶段，5.9.3「三类字段写入后各自走一次后处理」）。 */
  setBuyAmountValue(state: EntryState, value: Decimal, where: string): void {
    if (isNaN(value) || isInf(value) || !isFiniteDecimal(value)) {
      Diagnostics.record('E_BUY_AMOUNT_INVALID', where, 'buyAmount 求值结果为非有限实数，保持上次成功值')
      return
    }
    state.lastGood.set('buyAmount', clampBuyAmount(value))
  }

  /**
   * 生成器每秒产出合计（`gen.<id>.perSec`，D-30）。
   *
   * `owned × Σ produces[i].amount`，**只乘一次 `owned`**（R-26 的口径）。
   */
  perSecond(state: EntryState): Decimal {
    const produces = producesOf(state)
    if (produces.length === 0) return Num.fromNumber(0)
    const owned = this.value(state, 'owned')
    if (!Num.isPos(owned)) return Num.fromNumber(0)
    let sum = Num.fromNumber(0)
    produces.forEach((_, index) => {
      const where = `gen.${state.id}.produces[${index}].amount`
      sum = Num.add(sum, this.host.evaluateNumber(this.textOr(state, `produces[${index}].amount`), 'production', where))
    })
    return Num.mul(owned, sum)
  }

  /** 文本字段的当前文本；缺失时回落到项目文件定义值。 */
  textOr(state: EntryState, concreteAttr: string): string {
    // `description` 与布尔字段的值不在 `state.text` 里（它们是结构化标量，6.3 也单独存档），
    // 但 `textOr` 是 UI / 存档取“当前文本”的统一入口，必须能给出它们的文本形态，
    // 否则读回来的是兜底的 `'0'`——把一段描述显示成 `0`。
    if (concreteAttr === 'description') return state.description
    if (BOOLEAN_FIELDS.has(concreteAttr)) {
      if (concreteAttr === 'isClicker') return isClickerDef(state) ? 'true' : 'false'
      if (concreteAttr === 'perSecond') return perSecondDef(state) ? 'true' : 'false'
      if (concreteAttr === 'visible') return state.visible ? 'true' : 'false'
      return state.disabled ? 'true' : 'false'
    }
    const cached = state.text.get(concreteAttr)
    if (cached !== undefined) return cached
    const fallback = collectProjectText(state).get(concreteAttr)
    if (fallback !== undefined) {
      state.text.set(concreteAttr, fallback)
      return fallback
    }
    // 只读的**标量** def 字段（`buyDelay`/`order`/`columns`）：它们既不在 `state.text`
    // 也不在 `collectProjectText` 里，但对 UI 来说仍然需要一个可读的文本形态。
    // 这里显式列举而不是调 `readAttr` —— `readAttr` 对文本字段会回调 `textOr`，会递归。
    if (concreteAttr === 'buyDelay') return String(state.buyDelay)
    if (concreteAttr === 'order') return String(state.def.order)
    if (concreteAttr === 'columns' && state.kind === 'page') return String(pageDefOf(state).columns)
    return '0'
  }

  /** 写入文本型字段（热替换路径的公共部分，5.9.3）。 */
  writeText(state: EntryState, concreteAttr: string, text: string, where: string): boolean {
    // 与编辑器改文本完全相同的热替换路径：**先编译**（5.9.3「编译失败则报 E_PARSE/E_RAND_DISABLED
    // 并保留旧文本，last-good」）。在提交阶段编译而不是等下一 tick，是为了让“保留旧文本”
    // 真的成立——否则会出现“新坏文本已落盘、旧值又算不出来”的两难状态。
    const checked = validateExpression(text, contextOf(concreteAttr))
    if (!checked.ok) {
      Diagnostics.record(checked.code as never, where, checked.message)
      return false
    }
    state.text.set(concreteAttr, text)
    // 写进来的文本是真实文本（作者或运行时的），占位标记必须撤掉：
    // 否则“先把价格写坏、再改回来”的作者会永远买不了这个条目。
    state.neutralized.delete(concreteAttr)
    this.bump(state, concreteAttr)
    return true
  }

  /**
   * 校验**整条定义**里的表达式文本（5.9.3「编译失败则报 `E_PARSE`/`E_RAND_DISABLED`
   * 并保留旧文本，last-good」在 `host:patch` 那条路径上的对应物）。
   *
   * ## 为什么 `writeText()` 不够
   *
   * `writeText()` 覆盖的是**逐字段**写入（`set()` 副作用与 `writeAttr`），而 7.4 的
   * `host:patch` 是把整条条目定义换掉（`patch.ts` 的 `replaceDefinition` 与新增条目分支）——
   * 那条路径原本直接把作者的新文本塞进 `state.text`，**不编译**。于是：
   *
   * - 坏文本一路活到视图重建：`buildViewModel()` 求值时抛 `E_PARSE`，异常穿出重建调用
   *   （浏览器里表现为预览停在旧数据、主循环停摆），而
   * - 错误码**没有**进 `Diagnostics`，诊断面板一个字都不显示，作者只看到“改了没反应”。
   *
   * 编辑器是允许保存这种半成品的（保存与打包才拦），所以这不是“非法输入”，
   * 而是**必须被运行时兜住**的常态：兜住的口径就是 `writeText` 那一条——记错误码、换回旧文本。
   *
   * @param keep 取该属性**上一份**文本（通常来自替换前的 `EntryState`）；没有时用中性值。
   *
   * 同时维护 `state.neutralized`：它标记“当前文本是占位值、不是作者的文本”，供
   * `priceRowsUsable()` 拒绝按占位值结算（一个坏价格占位成 `0` 等于白送）。
   * 因此每次都是**全量重算**（先清空再逐个判定），不能只做增补——否则作者把坏文本
   * 改回合法文本后，占位标记会残留成假阳性。
   */
  validateDefinitionTexts(state: EntryState, keep: (attr: string) => string | undefined): void {
    state.neutralized.clear()
    for (const [attr, text] of collectProjectText(state)) {
      if (!isExprTextField(templateKey(attr))) continue
      const checked = validateExpression(text, contextOf(attr))
      if (checked.ok) continue
      Diagnostics.record(checked.code as never, `${entityKeyOf(state.kind, state.id)}.${attr}`, checked.message)
      state.text.set(attr, keep(attr) ?? neutralExpressionText(attr))
      state.neutralized.add(attr)
    }
  }

  /** 某个表达式文本字段当前是否是“引擎代填的中性占位值”（而不是作者的文本）。 */
  isNeutralText(state: EntryState, concreteAttr: string): boolean {
    return state.neutralized.has(concreteAttr)
  }

  /**
   * 读档专用：**跳过编译校验**写入表达式文本（6.3 读档顺序 ⑦）。
   *
   * 只允许动态条目的存档回填走这条路——静态条目有项目文件文本可回落，动态条目的当前值
   * 只存在于存档里，写不进去就等于把玩家的进度抹掉。调用方负责记 `E_PARSE`。
   *
   * 与 `writeText()` 的区别正是“编译失败也写”，这是它唯一存在的理由；
   * 任何交互/编辑路径都不该调用它。
   */
  forceTextForRestore(state: EntryState, concreteAttr: string, text: string, where: string): boolean {
    if (!state.dynamic) return false
    const checked = validateExpression(text, contextOf(concreteAttr))
    if (checked.ok) return false // 能编译的文本走正常路径，保留 last-good 语义
    state.text.set(concreteAttr, text)
    // 存档回填的坏文本同样不是“能结算的真实价格”，标成中性以免被当成 0 计价。
    state.neutralized.add(concreteAttr)
    this.bump(state, concreteAttr)
    this.recordAssignment(state, where, text, '<restore>')
    return true
  }

  // -------------------------------------------------------------------------
  // 写（提交阶段，5.6 / 5.9.3）
  // -------------------------------------------------------------------------

  /**
   * 应用一条 `set` 副作用（5.6 的提交阶段入口，8.3 第 6 步）。
   *
   * @param expr 右侧源码文本，仅作审计（6.3：`assignments.expr` 读档不回放）
   * @returns 是否成功写入（`false` 表示被拒且保留旧值）
   */
  write(key: string, value: Value, expr: string): boolean {
    const parsed = parseKey(key)
    if (!parsed) {
      Diagnostics.record('E_UNKNOWN_ATTR', key, `无法解析的写入目标 ${key}`)
      return false
    }
    const entity = entityKeyOf(parsed.kind, parsed.id)
    const state = this.entries.get(entity)
    if (!state) {
      Diagnostics.record('E_UNKNOWN_ATTR', key, `写入目标条目 ${entity} 不存在`)
      return false
    }
    if (READONLY_FIELDS.has(parsed.attr)) {
      Diagnostics.record('E_READONLY_TARGET', key, `属性 ${parsed.attr} 只读（5.9 属性读写矩阵）`)
      return false
    }
    return this.writeAttr(state, parsed.attr, parsed.concreteAttr, parsed.index, key, value, expr)
  }

  private writeAttr(
    state: EntryState,
    attr: string,
    concreteAttr: string,
    index: number | undefined,
    key: string,
    value: Value,
    expr: string,
  ): boolean {
    // ---- `res.<id>.owned` 是 `amount` 的别名（5.9.1 第 8 行、D-37）----
    //
    // 读取路径 `value()` 已经把 `owned` 归到 `amount`，写入必须归到同一处，否则
    // `set("res.r1.owned", "100")` 会落进一块**没人读**的存储：写成功、界面不变、
    // 也不报错。归一必须在最前面做——`attr` 决定后续分支，`concreteAttr` 决定 `version`
    // 与 `assignments` 的键，两者都要换成 `amount`，否则同一个概念会出现两套键。
    if (state.kind === 'resource' && attr === 'owned') {
      return this.writeAttr(state, 'amount', 'amount', undefined, key, value, expr)
    }

    // ---- 表达式文本 / NumExpr 字段（5.9.3 的三张表；两者**同规则**，D-29）----
    if (TEXT_FIELDS.has(attr) || isExprTextField(attr)) {
      return this.writeExprField(state, concreteAttr, value, expr, key)
    }

    // ---- 布尔字段 ----
    if (BOOLEAN_FIELDS.has(attr)) {
      // D-20 / 5.9.1：资源**没有** `disabled`。放行会写进一个 `isDisabled` 永远不读
      // 的字段（`state.kind === 'resource'` 直接返回 false）——写成功、界面不变、不报错。
      if (attr === 'disabled' && state.kind === 'resource') {
        Diagnostics.record('E_UNKNOWN_ATTR', key, '资源没有属性 disabled（D-20）')
        return false
      }
      // 两种写法都接受（5.9.3 表格里布尔字段的目标值形态写作 `"true"` / `"false"`，
      // 而 `gen.g1.visible = true` 这样的表达式赋值送进来的是真正的布尔）：
      //   - 布尔值：直接用；
      //   - 字符串 `"true"` / `"false"`：项目文件与 `assignments` 的存储形态（6.3）。
      // 其它一律 `E_ASSIGN_TYPE`——**特别是 `'1'` / `'0'`**：PRD 补充 6 明确布尔字段
      // 只认 `"true"`/`"false"`，放行数字会让 `1` 与 `true` 在存档里长得一样却含义不同。
      let flag: boolean
      if (typeof value === 'boolean') flag = value
      else if (value === 'true') flag = true
      else if (value === 'false') flag = false
      else {
        Diagnostics.record('E_ASSIGN_TYPE', key, `布尔属性 ${attr} 只接受 true / false，收到 ${typeof value}`)
        return false
      }
      if (attr === 'isClicker') generatorDefOf(state).isClicker = flag
      else if (attr === 'perSecond') upgradeDefOf(state).perSecond = flag
      else if (attr === 'visible') state.visible = flag
      else state.disabled = flag
      this.bump(state, concreteAttr)
      this.recordAssignment(state, key, String(flag), expr)
      return true
    }

    // ---- 字符串字段 ----
    if (attr === 'description') {
      if (typeof value !== 'string') {
        Diagnostics.record('E_ASSIGN_TYPE', key, '字符串属性 description 只接受字符串')
        return false
      }
      state.description = value
      this.bump(state, concreteAttr)
      this.recordAssignment(state, key, value, expr)
      return true
    }
    if (concreteAttr.endsWith('.materialId')) {
      if (typeof value !== 'string') {
        Diagnostics.record('E_ASSIGN_TYPE', key, `${concreteAttr} 只接受字符串`)
        return false
      }
      // 引用存在性检查：悬空引用记 `E_DANGLING_REF` 并**保留旧值**，
      // 否则结算阶段会在半个 tick 内读到一个不存在的条目。
      const allowGenerator = attr === 'produces[i].materialId'
      if (!this.materialExists(value, allowGenerator)) {
        Diagnostics.record('E_DANGLING_REF', key, `材料/产出目标 ${value} 不存在`)
        return false
      }
      state.text.set(concreteAttr, value)
      this.bump(state, concreteAttr)
      this.recordAssignment(state, key, value, expr)
      return true
    }

    // ---- 数值属性 ----
    if (VALUE_FIELDS.has(attr) || attr === 'effectValues[i]') {
      // D-20：生成器/升级没有 `amount`。读取侧 `value()` 已经报 `E_UNKNOWN_ATTR`，
      // 写入侧必须同样拒绝——否则 `set("gen.g1.amount", "5")` 会写进一块
      // 永远读不到的地方：返回成功、界面不变、也不报错。
      if (attr === 'amount' && state.kind !== 'resource') {
        Diagnostics.record('E_UNKNOWN_ATTR', key, `${state.kind} 没有属性 amount（D-20）`)
        return false
      }
      if (!isDecimalValue(value)) {
        Diagnostics.record('E_ASSIGN_TYPE', key, `数值属性 ${attr} 不接受布尔或 null（5.9.3）`)
        return false
      }
      void index
      return this.writeQuantity(state, concreteAttr, value, key, expr)
    }

    Diagnostics.record('E_READONLY_TARGET', key, `属性 ${attr} 不可被表达式修改`)
    return false
  }

  /**
   * 写表达式文本类字段（`NumExpr` 数值字段与表达式文本字段**同规则**，D-29）。
   *
   * | 右侧结果类型 | 写入结果 |
   * | --- | --- |
   * | 字符串 | 原样成为新的表达式源码（这是运行时就地替换字段文本的**唯一**手段） |
   * | 数值 | 该数值的十进制字面量文本作为新文本（**不回写源码**） |
   * | 布尔 / `null` | `E_ASSIGN_TYPE`，保留旧文本 |
   */
  private writeExprField(state: EntryState, concreteAttr: string, value: Value, expr: string, key: string): boolean {
    let text: string
    if (typeof value === 'string') {
      text = value
    } else if (isDecimalValue(value)) {
      // `Infinity` 是合法字面量（D-46）：写 `max = Infinity` 即“恢复为无上限”。
      text = isInf(value) ? 'Infinity' : value.toString()
    } else {
      Diagnostics.record('E_ASSIGN_TYPE', key, '表达式文本属性不接受布尔或 null（5.9.3）')
      return false
    }
    if (!this.writeText(state, concreteAttr, text, key)) return false
    this.recordAssignment(state, key, text, expr)
    // `buyAmount` 写后立刻归一化一次（5.9.3「三类字段写入后都各自走一次后处理」）。
    if (concreteAttr === 'buyAmount') {
      try {
        this.setBuyAmountValue(state, this.host.evaluateNumber(text, 'field', key), key)
      } catch {
        // 求值失败时保持 last-good（5.9.3 归一化第 ① 步）。
      }
    }
    return true
  }

  /** 写数量属性：先钳下界 0，再夹到 `max`（PRD 补充 3、4.4 第 4 条）。 */
  writeQuantity(state: EntryState, concreteAttr: string, value: Decimal, key: string, expr: string): boolean {
    let next: Decimal
    if (concreteAttr === 'amount' || concreteAttr === 'owned') {
      // 数量类属性受 `max` 约束（`owned >= max` 后不可再增加，PRD 补充 3）。
      next = Num.clampQuantity(value, this.capOf(state, key), key)
    } else {
      // `bought` 不受 `max` 约束（PRD 补充 3：只有“拥有数量”受上限影响），
      // 否则价格成长会被 `max` 卡死。下限仍为零。
      next = Num.clampLower0(value, key)
    }
    state.values.set(concreteAttr, next)
    this.bump(state, concreteAttr)
    this.recordAssignment(state, key, next.toString(), expr)
    return true
  }

  /**
   * 某条目当前生效的数量上限（`max` 归一化后）。
   *
   * `max = "Infinity"` 时返回 `NUM_INF`，`applyCap` 会**完全跳过**钳制（D-46、4.4 第 6 条）。
   */
  capOf(state: EntryState, where?: string): Decimal {
    const key = where ?? `${entityKeyOf(state.kind, state.id)}.max`
    const value = this.host.evaluateNumber(this.textOr(state, 'max'), 'field', key)
    return normalizeCap(value, key)
  }

  /** 引用完整性：`costs[i].materialId` 只能指向资源；`produces[i].materialId` 可指向资源或生成器。 */
  materialExists(id: string, allowGenerator = false): boolean {
    if (this.entries.has(entityKeyOf('resource', id))) return true
    return allowGenerator ? this.entries.has(entityKeyOf('generator', id)) : false
  }

  // -------------------------------------------------------------------------
  // 版本号与赋值审计（5.7、6.3）
  // -------------------------------------------------------------------------

  /** 属性版本号（未记录过为 0）。 */
  versionOf(key: string): number {
    const parsed = parseKey(key)
    if (!parsed) return 0
    const state = this.entries.get(entityKeyOf(parsed.kind, parsed.id))
    if (!state) return 0
    // 与写入路径共用同一套别名归一（`res.<id>.owned` -> `amount`，D-37）：
    // `versions` 是按 `concreteAttr` 记的，读取侧不归一就会让 UI 对同一个值
    // 拿到两个不同的版本号，缓存失效逻辑随之失灵。
    const attr = state.kind === 'resource' && parsed.attr === 'owned' ? 'amount' : parsed.concreteAttr
    return state.versions.get(attr) ?? 0
  }

  /**
   * 所有写路径的**唯一收口**：递增 `version` 并让本 tick 的表达式缓存失效。
   *
   * 两条动作必须成对——只递增 `version` 会让 UI 缓存失效了但表达式仍读旧值；
   * 只清缓存则 UI 不知道该重绘。放在这里而不是各分支里，是为了不可能漏掉某条写路径。
   */
  private bump(state: EntryState, attr: string): void {
    state.versions.set(attr, (state.versions.get(attr) ?? 0) + 1)
    this.host.invalidateExpressions()
  }

  /** 记 `assignments`（6.3：`value` + `expr` + `tick`；`expr` 读档不回放）。 */
  private recordAssignment(state: EntryState, key: string, value: string, expr: string): void {
    state.assignments.set(key, { value, expr, tick: this.host.tick() })
  }

  // -------------------------------------------------------------------------
  // 初始化与复位（8.5 初始化表、D-18）
  // -------------------------------------------------------------------------

  /**
   * 按项目文件重建**数值状态**（新开局与“重新开始”一次性执行，8.5）。
   *
   * @param only 只重建这些实体键；省略时重建全部（`reset()` 的用法）。
   *   7.4 的 `host:patch` 新增条目时必须走**同一个**函数，否则“热更新新增的生成器初始
   *   `bought = 0`”与“重新开始后的初始 `bought = initial`”会给出两套规则。
   *
   * | 条目类型 | `bought` | `owned` | 说明 |
   * | --- | --- | --- | --- |
   * | 资源 | —（不可读，`E_UNKNOWN_ATTR`） | —（用 `amount`） | `amount = initial` |
   * | 生成器（非点击器） | `initial` | `initial` | 计入已购买数量并影响价格 |
   * | 生成器（点击器） | `0` | `initial` | 初始数量只作拥有数量（D-19） |
   * | 升级 | `initial` | `initial` | 计入已购买数量并影响价格 |
   */
  resetValues(only?: readonly string[]): void {
    const scope = only ? new Set(only) : undefined
    for (const [entity, state] of this.entries) {
      if (scope && !scope.has(entity)) continue
      state.values.clear()
      state.assignments.clear()
      state.lastGood.clear()
      state.versions.clear()
      // 占位标记随文本一起回到项目文件值（`validateDefinitionTexts` 会全量重算）。
      state.neutralized.clear()
      // 布尔/字符串属性回到项目文件值（PRD 补充 6：重新开始后一切修改复原）。
      state.visible = state.def.visible
      state.disabled = boolOf(state.def, 'disabled', false)
      state.description = strOf(state.def, 'description', '')
      state.buyDelay = Math.max(1, Math.floor(intOf(state.def, 'buyDelay', 1)))
      // 文本字段回到项目文件值。
      state.text.clear()
      for (const [attr, text] of collectProjectText(state)) state.text.set(attr, text)
      // 项目文件里可能有**坏**表达式（编辑器拦的是保存与打包，而 9.3 的 `host:init` 送来的
      // 是编辑器内存里那份；手改过的项目文件同理）。这里是“文本回到项目文件值”的**唯一**入口，
      // 因此编译校验也必须放在这里——放在 `loadProject` 会被紧接着的 `reset()` 原样覆盖回去，
      // 坏文本则一路活到视图重建才抛 `E_PARSE`，预览停摆且诊断面板一片空白。
      this.validateDefinitionTexts(state, () => undefined)

      const initial = this.fieldValue(state, 'initial')
      switch (state.kind) {
        case 'resource':
          state.values.set('amount', Num.clampQuantity(initial, this.capOf(state), `${state.id}.amount`))
          break
        case 'generator':
          state.values.set('bought', isClickerDef(state) ? Num.fromNumber(0) : initial)
          state.values.set('owned', initial)
          break
        case 'upgrade':
          state.values.set('bought', initial)
          state.values.set('owned', initial)
          break
        case 'page':
          break
      }
    }
  }

  /**
   * `initial` / `buyAmount` 等文本型字段的当前**归一化**值。
   *
   * 走 `readAttr` 同一条路径而不是只求值：`buyAmount` 的归一化（5.9.3 的 ①~④）
   * 必须对“求解器读到的值”和“表达式读到的值”完全一致，否则求解器会按未取整的
   * `buyAmount` 决定模式、而 UI 显示取整后的值——同一份数据两种口径。
   */
  fieldValue(state: EntryState, attr: string): Decimal {
    if (attr === 'max') return this.capOf(state)
    const key = `${entityKeyOf(state.kind, state.id)}.${attr}`
    try {
      const value = this.readAttr(state, attr, attr, undefined, key)
      return isDecimalValue(value) ? value : Num.fromNumber(0)
    } catch {
      return Num.fromNumber(0)
    }
  }

  /** 清空动态条目（“重新开始”丢弃 `dynamic`，D-18）。 */
  clearDynamic(): void {
    for (const key of [...this.entries.keys()]) {
      const state = this.entries.get(key)
      if (state?.dynamic) this.entries.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** `buyAmount` 的 ③④ 两步（floor + 夹取）；② 的有限性检查由调用方做（D-36）。 */
export function clampBuyAmount(value: Decimal): Decimal {
  const floored = Num.floor(value)
  return floored.gte(1) ? Num.min(floored, Num.fromNumber(100)) : floored
}

/**
 * 该表达式文本字段的求值上下文（5.5 的五个上下文）。
 *
 * 这张映射必须与 `model` 的 `EXPRESSION_CONTEXTS`（6.4「表达式目标合法」）**逐条一致**——
 * 同一条文本换个上下文编译期结论就不同：`set()` 在 `effect` 合法、在 `condition` 报
 * `E_SIDE_EFFECT_FORBIDDEN`；`rand()` 在 `price` 报 `E_RAND_DISABLED`。
 * `writeText` 的编译期校验与 `readAttr` 的求值都走它，因此**不能**把 `effects[i].action`
 * 归到 `condition`——那会让作者热替换一条效果动作时被引擎自己的代码拒掉。
 */
export function contextOf(attr: string): ContextKind {
  // 归一到**模板**形式再判断：本函数被两处以**具体**下标的形式调用
  // （`readAttr`/`writeText` 传的是 `effects[0].action` 这样的具体键），
  // 而 `writeAttr` 传的是模板键。两种都要命中同一张表，否则 `effects[0].action`
  // 会被误判成 `condition` 上下文，作者热替换效果动作就被引擎自己的代码拒掉了。
  const key = templateKey(attr)
  // `effects[i].action` 是**赋值表达式**（5.1），只在 `effect` 上下文编译。
  if (key === 'effects[i].action') return 'effect'
  if (key.startsWith('costs')) return 'price'
  if (key.startsWith('produces')) return 'production'
  // 其余（`conditions[i]`、`effects[i].condition`）都是条件表达式。
  return 'condition'
}

/** 是否是表达式文本字段（`costs[i].amount` / `produces[i].amount` / `conditions[i]` / `effects[i].*`）。 */
export function isExprTextField(attr: string): boolean {
  return (
    attr === 'costs[i].amount' ||
    attr === 'produces[i].amount' ||
    attr === 'conditions[i]' ||
    attr === 'effects[i].condition' ||
    attr === 'effects[i].action'
  )
}

/**
 * 表达式文本的**中性**回落值。
 *
 * 与 `Evaluator` 求值失败时的中性值口径一致（布尔给 `false`、数值给 `0`）：
 * 条件类给 `false`（“前提不成立”是安全侧），数量/价格/动作类给 `0`（不凭空产出，也不凭空花钱）。
 */
function neutralExpressionText(attr: string): string {
  const key = templateKey(attr)
  return key === 'conditions[i]' || key === 'effects[i].condition' ? 'false' : '0'
}

function isDecimalValue(value: Value): value is Decimal {
  return typeof value === 'object' && value !== null && typeof (value as Decimal).cmp === 'function'
}

function indexError(state: EntryState, attr: string, index: number, key: string): ForgeError {
  return new ForgeError('E_UNKNOWN_ATTR', {
    where: key,
    message: `${state.kind}.${state.id} 的 ${attr} 没有下标 ${index}（读越界报 E_UNKNOWN_ATTR，5.9.3）`,
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 动态条目按创建时间升序（8.7「排序」行：同序号时按 `createdAt` 升序）。 */
function compareCreatedAt(a: EntryState, b: EntryState): number {
  const at = a.dynamic?.createdAt ?? ''
  const bt = b.dynamic?.createdAt ?? ''
  return at < bt ? -1 : at > bt ? 1 : 0
}

/** 建立一个条目状态（静态与动态通用）。 */
export function createEntryState(
  kind: RuntimeEntityKind,
  id: string,
  def: ResourceDef | GeneratorDef | UpgradeDef | PageDef,
  options: { dynamic?: { createdAt: string; pageId: string }; sortOrder?: number } = {},
): EntryState {
  const state: EntryState = {
    kind,
    id,
    def,
    text: new Map(),
    values: new Map(),
    visible: def.visible,
    disabled: boolOf(def, 'disabled', false),
    buyDelay: Math.max(1, Math.floor(intOf(def, 'buyDelay', 1))),
    description: strOf(def, 'description', ''),
    versions: new Map(),
    assignments: new Map(),
    lastGood: new Map(),
    neutralized: new Set(),
    sortOrder: options.sortOrder ?? def.order,
  }
  if (options.dynamic) state.dynamic = options.dynamic
  for (const [attr, text] of collectProjectText(state)) state.text.set(attr, text)
  return state
}

/**
 * 把项目定义里的全部表达式文本字段摊平成 `具体键 -> 文本`。
 *
 * 键是**具体**形式（`costs[0].amount`）——运行时读取与热替换都用它。
 */
export function collectProjectText(state: EntryState): Map<string, string> {
  const out = new Map<string, string>()
  const def = state.def
  if (def.kind === 'page') return out
  out.set('initial', def.initial)
  out.set('max', def.max)
  if (def.kind === 'resource') return out
  out.set('buyAmount', def.buyAmount)
  def.costs.forEach((cost, index) => {
    out.set(`costs[${index}].materialId`, cost.materialId)
    out.set(`costs[${index}].amount`, cost.amount)
  })
  if (def.kind === 'generator') {
    def.produces.forEach((produces, index) => {
      out.set(`produces[${index}].materialId`, produces.materialId)
      out.set(`produces[${index}].amount`, produces.amount)
    })
    return out
  }
  def.conditions.forEach((condition, index) => out.set(`conditions[${index}]`, condition))
  def.effects.forEach((effect, index) => {
    out.set(`effects[${index}].condition`, effect.condition)
    out.set(`effects[${index}].action`, effect.action)
  })
  return out
}
