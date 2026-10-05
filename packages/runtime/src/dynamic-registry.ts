/**
 * 动态条目注册表（TECH_DESIGN 8.7「动态创建」、D-32、D-34、D-44、R-16）。
 *
 * `create(kind, spec)` / `destroy(id)` 的**实际落地**。三条硬约束在这里实现：
 *
 * | 约束 | 落点 |
 * | --- | --- |
 * | 动态条目**不写项目文件**，只进存档（PRD 升级编辑器 12） | 注册表与项目定义分开；序列化只写 `SaveFile.dynamic`（6.3） |
 * | 总数硬上限 2000（D-32） | `create()` 超限**整体拒绝**并报 `E_DYNAMIC_LIMIT`（不做部分创建） |
 * | `spec.page` 必填且必须存在（PRD 补充 7、D-09） | `E_CREATE_NO_PAGE` / `E_PAGE_UNKNOWN` |
 *
 * ## “孤儿”动态条目（8.7 的 pageId 失效口径）
 *
 * `pageOf()` 返回 `undefined` 时按「不可见且禁用」处理并记 `E_PAGE_UNKNOWN`，
 * 但条目**仍保留在内存与存档中**、仍占 2000 上限名额、不渲染不结算；
 * 唯一移除路径是 `destroy(id)`（表达式）或预览诊断面板的“丢弃”。
 * 页面恢复（id 改回）后条目自动重新出现，玩家无需任何操作。
 */
import { Diagnostics, ForgeError, Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'
import type { ConstantObject, ConstantValue, DynamicHost } from '@iforge/expr'
import { validateExpression } from '@iforge/expr'
import { nextDynamicId } from '@iforge/model'
import type { GeneratorDef, UpgradeDef } from '@iforge/model'

import type { AttributeStore, EntryState } from './attribute-store.js'
import { contextOf, createEntryState, entityKeyOf } from './attribute-store.js'
import type { CreateKind } from './keys.js'

/** 动态条目总数硬上限（D-32、R-16）。 */
export const DYNAMIC_LIMIT = 2000

/** 动态条目的运行时形态。 */
export interface DynamicEntry {
  state: EntryState
  kind: CreateKind
  id: string
  /** 归属页面（PRD 补充 7 必填；读档时可能失效 → 孤儿）。 */
  pageId: string
  createdAt: string
}

/** 依赖注入：注册表需要能创建条目状态、查页面、查 id 占用。 */
export interface DynamicRegistryDeps {
  attrs: AttributeStore
  /** 项目里已占用的静态 id（四类全局唯一，6.1）。 */
  staticIds(): Set<string>
  /** 页面是否存在。 */
  hasPage(pageId: string): boolean
  /** 当前时间（ISO8601），便于测试注入。 */
  now(): string
}

/**
 * 动态条目注册表，同时实现 `expr` 的 `DynamicHost`（`has`/`count`，5.4）。
 */
export class DynamicRegistry implements DynamicHost {
  private readonly deps: DynamicRegistryDeps
  /** 动态条目：实体键 -> 条目（静态与动态在同一张表里，但用 `state.dynamic` 区分）。 */
  private readonly entries = new Map<string, DynamicEntry>()
  /** 自动 id 的序号游标（`dyn_<递增序号>`，8.7「id」行）。 */
  private sequence = 1

  constructor(deps: DynamicRegistryDeps) {
    this.deps = deps
  }

  // -------------------------------------------------------------------------
  // DynamicHost（5.4 的 `has` / `count`）
  // -------------------------------------------------------------------------

  /** `has(kind, id)`：动态条目是否存在。静态条目恒为假——`has` 只描述动态条目（5.4）。 */
  has(kind: string, id: string): boolean {
    return this.entries.has(entityKeyOf(kindToEntityKind(kind), id))
  }

  /** `count(kind)`：某类条目数量（**只数动态条目**，与 `has` 同口径）。 */
  count(kind: string): Decimal {
    let total = 0
    for (const entry of this.entries.values()) {
      if (entry.kind === kind) total += 1
    }
    return Num.fromNumber(total)
  }

  /** 动态条目总数（2000 上限的判定口径，D-32）。 */
  size(): number {
    return this.entries.size
  }

  /** 全部动态条目（序列化与诊断面板用）。 */
  list(kind?: CreateKind): DynamicEntry[] {
    const all = [...this.entries.values()]
    const filtered = kind ? all.filter((entry) => entry.kind === kind) : all
    return filtered.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }

  /** 取一个动态条目。 */
  find(kind: CreateKind, id: string): DynamicEntry | undefined {
    return this.entries.get(entityKeyOf(kindToEntityKind(kind), id))
  }

  /** 孤儿动态条目（`pageId` 已失效，8.7）：诊断面板的“唯一移除入口”列表。 */
  orphans(): DynamicEntry[] {
    return this.list().filter((entry) => !this.deps.hasPage(entry.pageId))
  }

  // -------------------------------------------------------------------------
  // 创建 / 销毁
  // -------------------------------------------------------------------------

  /**
   * `create(kind, spec)` 的落地（8.7）。
   *
   * 执行顺序刻意与文档的校验层级一致——**先校验后落地**，任何一步失败都**不**创建条目
   * （8.7「id」行：“冲突报 `E_CREATE_ID_CONFLICT`（整体拒绝、不做部分创建）”）。
   *
   * @returns 新条目的 id（调用方用它回填 `Effect.createdId`，`destroy(create(…))` 靠这个串联）
   * @throws {ForgeError} `E_CREATE_NO_PAGE` / `E_PAGE_UNKNOWN` / `E_CREATE_FIELD_INVALID` /
   *   `E_CREATE_ID_CONFLICT` / `E_DYNAMIC_LIMIT`
   */
  create(kind: string, spec: ConstantObject | undefined): string {
    if (kind !== 'generator' && kind !== 'upgrade') {
      throw new ForgeError('E_CREATE_FIELD_INVALID', { message: `create() 的 kind 只能是 generator / upgrade，收到 ${kind}` })
    }
    if (!spec) {
      throw new ForgeError('E_CREATE_FIELD_INVALID', { message: 'create() 的 spec 必须是对象字面量' })
    }
    const createKind: CreateKind = kind

    // ---- page：必填（PRD 补充 7）+ 必须存在（6.4「动态条目页面存在性」）----
    const pageId = spec['page']
    if (typeof pageId !== 'string') {
      throw new ForgeError('E_CREATE_NO_PAGE', { message: 'create() 的 spec 必须指定 page（PRD 补充 7）' })
    }
    if (!this.deps.hasPage(pageId)) {
      throw new ForgeError('E_PAGE_UNKNOWN', { message: `create() 的 page "${pageId}" 不存在` })
    }

    // ---- 上限：超限整体拒绝（D-32）----
    if (this.entries.size >= DYNAMIC_LIMIT) {
      throw new ForgeError('E_DYNAMIC_LIMIT', { message: `动态条目已达上限 ${DYNAMIC_LIMIT}` })
    }

    // ---- id：可选稳定 id（D-44）或自动生成 ----
    const explicitId = spec['id']
    let id: string
    if (explicitId === undefined || explicitId === null) {
      id = nextDynamicId(this.occupiedIds())
      this.sequence += 1
    } else {
      if (typeof explicitId !== 'string') {
        throw new ForgeError('E_CREATE_ID_CONFLICT', { message: 'spec.id 必须是字符串' })
      }
      id = explicitId
      this.assertAvailable(id)
    }

    const def = this.buildDef(createKind, id, spec)
    this.assertReferences(def)

    // ---- 落地 ----
    const createdAt = this.deps.now()
    const state = createEntryState(kindToEntityKind(createKind), id, def, {
      dynamic: { createdAt, pageId },
      // 缺省 `order` 取递增序号，保证页面内排序稳定（8.7「排序」行）。
      sortOrder: typeof spec['order'] === 'number' ? (spec['order'] as number) : this.entries.size + 1,
    })
    this.deps.attrs.addDynamic(state)
    this.entries.set(entityKeyOf(kindToEntityKind(createKind), id), {
      state,
      kind: createKind,
      id,
      pageId,
      createdAt,
    })
    return id
  }

  /**
   * `destroy(id)` 的落地（8.7「销毁」行）。
   *
   * 只能销毁**动态**条目：传入静态条目 id 报 `E_DESTROY_STATIC`——静态条目的增删
   * 只能通过编辑器（PRD 未提供运行时删除能力）。
   */
  destroy(id: string): void {
    for (const kind of ['generator', 'upgrade'] as const) {
      const key = entityKeyOf(kindToEntityKind(kind), id)
      const entry = this.entries.get(key)
      if (!entry) continue
      // 级联清理：条目本身、`assignments`、`effectValues` 与页面归属记录一起消失。
      // `AttributeStore.remove` 删掉的就是承载全部这些数据的 `EntryState`。
      this.deps.attrs.remove(key)
      this.entries.delete(key)
      return
    }
    if (this.deps.staticIds().has(id)) {
      throw new ForgeError('E_DESTROY_STATIC', { message: `静态条目 ${id} 只能在编辑器中删除` })
    }
    throw new ForgeError('E_DESTROY_STATIC', { message: `条目 ${id} 不是动态条目，无法销毁` })
  }

  /** 读档时登记动态条目（6.3 读档顺序 ②：先建动态条目、再回填顶层与 `assignments`）。 */
  restore(entry: DynamicEntry): void {
    // `EntryState.dynamic` 必须跟着一起更新：读档/重挂载时可能带着**旧的** `pageId`
    // （页面在编辑器里被删过），而 `pageOf()` 读的是 `state.dynamic.pageId`。
    // 只更新注册表不更新这个指针，孤儿条目会被当成“仍在原页面”照常渲染。
    entry.state.dynamic = entry
    this.deps.attrs.addDynamic(entry.state)
    this.entries.set(entityKeyOf(kindToEntityKind(entry.kind), entry.id), entry)
  }

  /** 清空（“重新开始”丢弃 `dynamic`，D-18）。 */
  reset(): void {
    for (const entry of this.entries.values()) this.deps.attrs.remove(entityKeyOf(kindToEntityKind(entry.kind), entry.id))
    this.entries.clear()
    this.sequence = 1
  }

  // -------------------------------------------------------------------------
  // 构造与校验
  // -------------------------------------------------------------------------

  /** 已占用的 id（静态 + 动态），用于 `nextDynamicId` 与冲突检查。 */
  private occupiedIds(): Set<string> {
    const ids = this.deps.staticIds()
    for (const entry of this.entries.values()) ids.add(entry.id)
    return ids
  }

  /** `spec.id` 合法性 + 全局唯一（8.7「id」行、D-44）。 */
  private assertAvailable(id: string): void {
    if (id.length === 0 || id.length > 32) {
      throw new ForgeError('E_CREATE_ID_CONFLICT', { message: `spec.id "${id}" 长度需在 1~32 之间` })
    }
    if (id[0] !== 'g' && id[0] !== 'u') {
      throw new ForgeError('E_CREATE_ID_CONFLICT', { message: `spec.id "${id}" 必须以 g（生成器）或 u（升级）开头` })
    }
    if (!/^[A-Za-z0-9_]+$/.test(id.slice(1))) {
      throw new ForgeError('E_CREATE_ID_CONFLICT', { message: `spec.id "${id}" 只允许字母、数字与下划线` })
    }
    if (id.startsWith('dyn')) {
      throw new ForgeError('E_CREATE_ID_CONFLICT', { message: `spec.id "${id}" 与保留前缀冲突` })
    }
    if (this.occupiedIds().has(id)) {
      throw new ForgeError('E_CREATE_ID_CONFLICT', { message: `spec.id "${id}" 与已有条目冲突` })
    }
  }

  /**
   * 由 `spec` 构造定义（8.7「缺省」行）。
   *
   * 未给出的字段取 `GeneratorDef`/`UpgradeDef` 的默认工厂值：
   * `initial="0"`、`max="Infinity"`、`buyAmount="1"`、`buyDelay=1`、`visible=true`、
   * `disabled=false`、`isClicker=false`、四个列表为空。`kind`/`buyDelay` 由运行时接管，
   * 不从 spec 读（出现在 spec 中编译期已报 `E_CREATE_FIELD_INVALID`）。
   */
  private buildDef(kind: CreateKind, id: string, spec: ConstantObject): GeneratorDef | UpgradeDef {
    const shared = {
      kind,
      id,
      order: typeof spec['order'] === 'number' ? (spec['order'] as number) : 0,
      name: readString(spec, 'name') ?? '新条目',
      description: readString(spec, 'description') ?? '',
      icon: (spec['icon'] as GeneratorDef['icon'] | undefined) ?? { kind: 'builtin', value: 'star' },
      initial: readString(spec, 'initial') ?? '0',
      // 缺省 `max` 是 `"Infinity"`——合法字面量（D-46），表示“无上限”。
      max: readString(spec, 'max') ?? 'Infinity',
      visible: typeof spec['visible'] === 'boolean' ? (spec['visible'] as boolean) : true,
      disabled: typeof spec['disabled'] === 'boolean' ? (spec['disabled'] as boolean) : false,
      buyAmount: readString(spec, 'buyAmount') ?? '1',
      buyDelay: 1,
      costs: readCostList(spec, 'costs'),
    }

    if (kind === 'generator') {
      return {
        ...shared,
        kind: 'generator',
        isClicker: typeof spec['isClicker'] === 'boolean' ? (spec['isClicker'] as boolean) : false,
        produces: readCostList(spec, 'produces'),
      }
    }
    return {
      ...shared,
      kind: 'upgrade',
      perSecond: typeof spec['perSecond'] === 'boolean' ? (spec['perSecond'] as boolean) : false,
      conditions: readStringList(spec, 'conditions'),
      effects: readEffects(spec),
    }
  }

  /** 悬空引用检查（8.7「字段形态」行：语法错误报 `E_PARSE`、悬空引用报 `E_DANGLING_REF`）。 */
  private assertReferences(def: GeneratorDef | UpgradeDef): void {
    def.costs.forEach((cost, index) => {
      if (!this.deps.attrs.materialExists(cost.materialId)) {
        throw new ForgeError('E_DANGLING_REF', {
          message: `动态条目 ${def.id} 的 costs[${index}].materialId "${cost.materialId}" 不存在`,
        })
      }
      this.assertExpression(cost.amount, 'costs[i].amount', `${kindToEntityKind(def.kind)}.${def.id}`)
    })
    if (def.kind === 'generator') {
      def.produces.forEach((produces, index) => {
        if (!this.deps.attrs.materialExists(produces.materialId, true)) {
          throw new ForgeError('E_DANGLING_REF', {
            message: `动态条目 ${def.id} 的 produces[${index}].materialId "${produces.materialId}" 不存在`,
          })
        }
        this.assertExpression(produces.amount, 'produces[i].amount', `${kindToEntityKind(def.kind)}.${def.id}`)
      })
    }
    if (def.kind === 'upgrade') {
      def.conditions.forEach((condition, index) => {
        this.assertExpression(condition, 'conditions[i]', `upgrade.${def.id}`)
        void index
      })
      def.effects.forEach((effect) => {
        this.assertExpression(effect.condition, 'effects[i].condition', `upgrade.${def.id}`)
        this.assertExpression(effect.action, 'effects[i].action', `upgrade.${def.id}`)
      })
    }
    // `NumExpr` 字段（8.7 的「缺省」行）：同样要能在对应上下文编译。
    this.assertExpression(def.initial, 'initial', `${kindToEntityKind(def.kind)}.${def.id}`)
    this.assertExpression(def.max, 'max', `${kindToEntityKind(def.kind)}.${def.id}`)
    this.assertExpression(def.buyAmount, 'buyAmount', `${kindToEntityKind(def.kind)}.${def.id}`)
  }

  /**
   * `spec` 里的表达式文本按**字段自己的上下文**编译一遍（8.7：`costs`/`produces`/`conditions`/
   * `effects` 按本局同一套校验走，报 `E_PARSE`/`E_RAND_DISABLED`/`E_SIDE_EFFECT_FORBIDDEN`）。
   *
   * 不做这一步的后果很具体：作者写 `costs: [{ amount: "1 +" }]`，条目会**创建成功**，
   * 直到自动购买阶段第一次求值才炸——而且此时已经在错误的 `bought/owned` 上付过钱。
   * “全部校验通过才落地”的价值就在这里提前失败。
   */
  private assertExpression(text: string, attr: string, where: string): void {
    const checked = validateExpression(text, contextOf(attr))
    if (!checked.ok) {
      throw new ForgeError(checked.code as never, {
        where: `${where}.${attr}`,
        message: `动态条目 spec 的表达式非法：${checked.message}`,
      })
    }
  }

  /** 读档后条目的 `createdAt`（诊断用）。 */
  createdAtOf(id: string): string | undefined {
    for (const entry of this.entries.values()) if (entry.id === id) return entry.createdAt
    return undefined
  }
}

/** 记诊断并吞掉异常（提交阶段的副作用不应中断整个 tick，5.6/D-07）。 */
export function reportCreateFailure(error: unknown, where: string): void {
  if (error instanceof ForgeError) {
    Diagnostics.record(error.code, where, error.message)
    return
  }
  Diagnostics.record('E_CREATE_FIELD_INVALID', where, error instanceof Error ? error.message : String(error))
}

function kindToEntityKind(kind: string): 'generator' | 'upgrade' {
  return kind === 'upgrade' ? 'upgrade' : 'generator'
}

function readString(spec: ConstantObject, field: string): string | undefined {
  const value = spec[field]
  return typeof value === 'string' ? value : undefined
}

function readStringList(spec: ConstantObject, field: string): string[] {
  const value = spec[field]
  if (!Array.isArray(value)) return []
  return (value as ConstantValue[]).filter((item): item is string => typeof item === 'string')
}

function readCostList(spec: ConstantObject, field: string): GeneratorDef['costs'] {
  const value = spec[field]
  if (!Array.isArray(value)) return []
  const out: GeneratorDef['costs'] = []
  for (const item of value as ConstantValue[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const row = item as { materialId?: unknown; amount?: unknown }
    if (typeof row.materialId === 'string' && typeof row.amount === 'string') {
      out.push({ materialId: row.materialId, amount: row.amount })
    }
  }
  return out
}

function readEffects(spec: ConstantObject): UpgradeDef['effects'] {
  const value = spec['effects']
  if (!Array.isArray(value)) return []
  const out: UpgradeDef['effects'] = []
  for (const item of value as ConstantValue[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const row = item as { condition?: unknown; action?: unknown }
    if (typeof row.condition === 'string' && typeof row.action === 'string') {
      out.push({ condition: row.condition, action: row.action })
    }
  }
  return out
}
