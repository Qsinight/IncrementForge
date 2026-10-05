/**
 * 存档序列化与读档（TECH_DESIGN 6.3、6.4、10.2、D-25、R-28、R-33）。
 *
 * ## 权威性口径（6.3）
 *
 * - **顶层字段 = 当前生效值**。布尔/数值/字符串属性以顶层为唯一权威副本；
 * - **`assignments` = 赋值审计记录 + 列表/文本字段的取值载体**。`costs[i].amount`、
 *   `produces[i].*`、`conditions[i]`、`effects[i].condition/action` **只有** `assignments`
 *   这一处持久化，读档时按路径回填；
 * - **不回放表达式**（6.3「不回放表达式」）：`assignments[path].expr` 只读不解释，
 *   回放会产生不可重复的副作用，`set/create/destroy` 无法保证幂等；
 * - **冲突裁决**：顶层与 `assignments[path].value` 冲突时以顶层为准，记 `E_SAVE_FIELD_CONFLICT`。
 *
 * ## 读档顺序不可颠倒（6.3「必须先重建动态条目、再回填 assignments」、R-28）
 *
 * ① 用项目文件构建静态 `AttributeStore` → ② 按 `dynamic` 重建动态条目定义 →
 * ③ 顶层字段逐项覆盖静态与动态条目 → ④ 按 `assignments` 路径回填列表/文本字段与 `description`
 * → ⑤ 恢复 `effectValues` → ⑥ 合并未知字段 → ⑦ 全部表达式重新编译。
 *
 * 顺序颠倒的后果：①③ 阶段顶层 `generators[动态id]` 无处落地、④ 阶段指向动态条目的
 * `assignments` 键会因目标条目尚不存在而被“丢弃不存在的属性”规则误删，
 * 动态条目的进度与赋值**静默丢失**。
 */
import { Diagnostics, Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'
import { SAVE_FORMAT, SCHEMA_VERSION } from '@iforge/model'
import type { Assignment, DynamicGenerator, DynamicUpgrade, GeneratorDef, ProjectFile, SaveFile, UpgradeDef } from '@iforge/model'

import { createEntryState, entityKeyOf, isClickerDef, effectsOf, perSecondDef, generatorDefOf, upgradeDefOf } from './attribute-store.js'
import type { EntryState } from './attribute-store.js'
import { parseKey } from './keys.js'
import type { DynamicEntry } from './dynamic-registry.js'
import type { GameState } from './game-state.js'
import { resetMonotonicCache } from './batch.js'

/** 序列化选项。 */
export interface SaveOptions {
  projectId: string
  projectName: string
  slotId?: string
  engineVersion: string
  /** ISO8601 时间戳（默认取当前时间）。 */
  now?: () => string
}

/**
 * 写存档（6.3 的 `SaveFile`）。
 *
 * **不含**：`currentPageId`（导航是 UI 会话状态，D-50）、游戏内设置（D-22）、
 * `forceUnlock`（纯内存标记，D-16）。
 */
export function serializeSave(state: GameState, options: SaveOptions): SaveFile {
  const iso = options.now ? options.now() : new Date().toISOString()

  const resources: SaveFile['resources'] = Object.create(null) as SaveFile['resources']
  for (const resource of state.attrs.listByKind('resource')) {
    resources[resource.id] = {
      amount: decimalText(state, resource, 'amount'),
      max: textOf(state, resource, 'max'),
      initial: textOf(state, resource, 'initial'),
      visible: resource.visible,
      description: resource.description,
      assignments: assignmentsOf(resource),
    }
  }

  const generators: SaveFile['generators'] = Object.create(null) as SaveFile['generators']
  for (const generator of state.attrs.listByKind('generator')) {
    generators[generator.id] = {
      bought: decimalText(state, generator, 'bought'),
      owned: decimalText(state, generator, 'owned'),
      max: textOf(state, generator, 'max'),
      initial: textOf(state, generator, 'initial'),
      visible: generator.visible,
      disabled: generator.disabled,
      // R-33：`isClicker` 必须落在顶层——布尔属性读档以顶层为准，
      // 只写进 `assignments` 会让运行时赋值在读档后静默丢失。
      isClicker: isClickerDef(generator),
      buyAmount: textOf(state, generator, 'buyAmount'),
      buyDelay: generator.buyDelay,
      description: generator.description,
      assignments: assignmentsOf(generator),
    }
  }

  const upgrades: SaveFile['upgrades'] = Object.create(null) as SaveFile['upgrades']
  for (const upgrade of state.attrs.listByKind('upgrade')) {
    const effectValues: Record<string, string> = Object.create(null) as Record<string, string>
    for (let index = 0; index < effectsOf(upgrade).length; index += 1) {
      effectValues[String(index)] = (upgrade.values.get(`effectValues[${index}]`) ?? Num.fromNumber(0)).toString()
    }
    upgrades[upgrade.id] = {
      bought: decimalText(state, upgrade, 'bought'),
      owned: decimalText(state, upgrade, 'owned'),
      max: textOf(state, upgrade, 'max'),
      initial: textOf(state, upgrade, 'initial'),
      visible: upgrade.visible,
      disabled: upgrade.disabled,
      buyAmount: textOf(state, upgrade, 'buyAmount'),
      buyDelay: upgrade.buyDelay,
      perSecond: perSecondDef(upgrade),
      description: upgrade.description,
      effectValues,
      assignments: assignmentsOf(upgrade),
    }
  }

  const pages: SaveFile['pages'] = Object.create(null) as SaveFile['pages']
  for (const page of state.attrs.listByKind('page')) {
    pages[page.id] = {
      visible: page.visible,
      disabled: page.disabled,
      description: page.description,
      assignments: assignmentsOf(page),
    }
  }

  // 动态条目：不写项目文件，只进存档（PRD 升级编辑器 12）。
  const dynamicGenerators: DynamicGenerator[] = state.dynamic
    .list('generator')
    .map((entry) => ({ ...(entry.state.def as GeneratorDef), createdAt: entry.createdAt, pageId: entry.pageId }))
  const dynamicUpgrades: DynamicUpgrade[] = state.dynamic
    .list('upgrade')
    .map((entry) => ({ ...(entry.state.def as UpgradeDef), createdAt: entry.createdAt, pageId: entry.pageId }))

  return {
    format: SAVE_FORMAT,
    version: SCHEMA_VERSION,
    engineVersion: options.engineVersion,
    projectId: options.projectId,
    projectName: options.projectName,
    slotId: options.slotId ?? 'main',
    savedAt: iso,
    lastSeenAt: iso,
    playtime: state.stats.playtime,
    gameTime: state.gameTime.toNumber(),
    offlineAccum: state.offlineAccum,
    resources,
    generators,
    upgrades,
    pages,
    dynamic: { generators: dynamicGenerators, upgrades: dynamicUpgrades },
  }
}

/** 读档（10.2「导入存档」第 3 步）。 */
export interface RestoreOptions {
  project: ProjectFile
  now?: () => string
}

export interface RestoreResult {
  /** 孤儿动态条目（`pageId` 已失效，8.7）：仍保留在存档与内存中、不渲染、计入上限。 */
  orphans: string[]
  /** 冲突裁决记录（`E_SAVE_FIELD_CONFLICT`）。 */
  conflicts: number
  /** 未知字段（进 `extra`，下次写回时保留，6.4）。 */
  extra: Record<string, unknown>
}

/**
 * 按 6.3 的读档顺序 ①~⑦ 重建 `GameState` 的状态。
 *
 * @returns 孤儿动态条目列表与冲突计数（供诊断面板展示）
 */
export function restoreSave(state: GameState, save: SaveFile, options: RestoreOptions): RestoreResult {
  // ---- ① 用项目文件构建静态 AttributeStore ----
  state.attrs.loadProject(options.project)

  // ---- ② 按 dynamic 重建动态条目定义（必须先于 ④）----
  const dynamicEntries: DynamicEntry[] = []
  let conflicts = 0
  for (const def of [...save.dynamic.generators, ...save.dynamic.upgrades] as Array<DynamicGenerator | DynamicUpgrade>) {
    const kind = def.kind === 'generator' ? 'generator' : 'upgrade'
    // 存档里的动态 `id` 与**静态**条目撞名（手改存档或两局存档混用）：静态胜出。
    // 不检查就直接 `restore` 会让 `addDynamic` 覆盖静态 `EntryState`——作者写的
    // 价格/产出被存档里的动态定义悄悄顶掉，且不报任何错（6.3 冲突裁决 + 6.4）。
    if (state.attrs.find(entityKeyOf(kind, def.id))) {
      Diagnostics.record('E_SAVE_FIELD_CONFLICT', `dynamic.${def.id}`, `动态条目 ${def.id} 与静态条目 id 冲突，已忽略该动态条目`)
      conflicts += 1
      continue
    }
    const entryState: EntryState = createEntryState(kind, def.id, def, {
      dynamic: { createdAt: def.createdAt, pageId: def.pageId },
      sortOrder: def.order,
    })
    const entry: DynamicEntry = { state: entryState, kind, id: def.id, pageId: def.pageId, createdAt: def.createdAt }
    dynamicEntries.push(entry)
    state.dynamic.restore(entry)
    // `pageId` 不存在 -> 孤儿：条目仍完整保留、仍占上限名额，只是不显示（8.7、6.3 读档顺序 ②）。
    if (!state.attrs.find(entityKeyOf('page', def.pageId))) {
      Diagnostics.record('E_PAGE_UNKNOWN', `dynamic.${def.id}`, `动态条目 ${def.id} 的 pageId "${def.pageId}" 不存在（孤儿条目）`)
    }
  }

  // ---- ③ 顶层字段逐项覆盖（缺失项回落项目文件值 / spec 默认值）----
  for (const [id, record] of Object.entries(save.resources)) {
    const entity = state.attrs.find(entityKeyOf('resource', id))
    if (!entity) continue
    entity.values.set('amount', safeDecimal(record.amount))
    entity.visible = record.visible
    entity.description = record.description
    applyTopLevelText(state, entity, 'max', record.max)
    applyTopLevelText(state, entity, 'initial', record.initial)
  }
  for (const [id, record] of Object.entries(save.generators)) {
    const entity = state.attrs.find(entityKeyOf('generator', id))
    if (!entity) continue
    entity.values.set('bought', safeDecimal(record.bought))
    entity.values.set('owned', safeDecimal(record.owned))
    entity.visible = record.visible
    entity.disabled = record.disabled
    generatorDefOf(entity).isClicker = record.isClicker
    entity.buyDelay = record.buyDelay
    entity.description = record.description
    applyTopLevelText(state, entity, 'max', record.max)
    applyTopLevelText(state, entity, 'initial', record.initial)
    applyTopLevelText(state, entity, 'buyAmount', record.buyAmount)
  }
  for (const [id, record] of Object.entries(save.upgrades)) {
    const entity = state.attrs.find(entityKeyOf('upgrade', id))
    if (!entity) continue
    entity.values.set('bought', safeDecimal(record.bought))
    entity.values.set('owned', safeDecimal(record.owned))
    entity.visible = record.visible
    entity.disabled = record.disabled
    entity.buyDelay = record.buyDelay
    entity.description = record.description
    upgradeDefOf(entity).perSecond = record.perSecond
    applyTopLevelText(state, entity, 'max', record.max)
    applyTopLevelText(state, entity, 'initial', record.initial)
    applyTopLevelText(state, entity, 'buyAmount', record.buyAmount)
  }
  for (const [id, record] of Object.entries(save.pages)) {
    const entity = state.attrs.find(entityKeyOf('page', id))
    if (!entity) continue
    entity.visible = record.visible
    entity.disabled = record.disabled
  }

  // ---- ④ 按 assignments 路径回填列表/文本字段与 description ----
  for (const entity of state.attrs.entries.values()) {
    // 存档里的该条目记录（静态与动态一视同仁，6.3 读档顺序 ③）。
    const record = assignmentsRecordOf(save, entity)
    if (!record) continue
    for (const [key, assignment] of Object.entries(record)) {
      const applied = state.attrs.write(key, assignment.value, assignment.expr)
      if (applied) {
        // 冲突裁决：布尔/数值属性以**顶层**为准，`assignments` 只作审计。
        if (typeof assignment.value === 'string' && isNumericAttribute(key)) {
          conflicts += detectConflict(entity, key, assignment.value) ? 1 : 0
        }
        continue
      }
      // ⑦ 编译失败时的分叉处置：
      // - **静态**条目 -> 回落项目文件文本（`write` 已经没改任何东西）。
      // - **动态**条目 -> 保留存档文本并记 `E_PARSE`。动态条目的当前值只存在于存档，
      //   丢掉它等于让玩家进度归零；宁可留一条会报错的文本，也不要静默改写玩家数据。
      if (entity.dynamic) {
        const parsed = parseKey(key)
        if (parsed && state.attrs.forceTextForRestore(entity, parsed.concreteAttr, assignment.value, key)) {
          Diagnostics.record('E_PARSE', key, `动态条目 ${entity.kind}.${entity.id} 的表达式无法编译，已保留存档文本`)
        }
      }
    }
  }

  // ---- ⑤ 恢复 effectValues（放在 ④ 之后：效果文本可能影响 ⑤ 的语义）----
  for (const [id, record] of Object.entries(save.upgrades)) {
    const entity = state.attrs.find(entityKeyOf('upgrade', id))
    if (!entity) continue
    for (const [index, text] of Object.entries(record.effectValues)) {
      entity.values.set(`effectValues[${index}]`, safeDecimal(text))
    }
  }

  // ---- ⑥ 合并未知字段（进 extra 并在下次写回时保留，6.4）----
  const known = new Set([
    'format',
    'version',
    'engineVersion',
    'projectId',
    'projectName',
    'slotId',
    'savedAt',
    'lastSeenAt',
    'playtime',
    'gameTime',
    'offlineAccum',
    'resources',
    'generators',
    'upgrades',
    'pages',
    'dynamic',
    'extra',
  ])
  const extra: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(save as unknown as Record<string, unknown>)) {
    if (known.has(key)) continue
    extra[key] = value
  }

  // ---- ⑦ 时间字段与页面状态 ----
  state.gameTime = Num.fromNumber(save.gameTime)
  state.offlineAccum = save.offlineAccum
  state.stats.playtime = save.playtime
  state.stats.realElapsed = 0
  // `lastPerSecondAt` 由 `gameTime` 单调推导，读档时用 `floor(gameTime)` 重新初始化（8.3 第 2 步）。
  state.lastPerSecondAt = Math.floor(save.gameTime)
  // 导航状态不持久化（D-50）：每次读档回到 8.12 的初始页面。
  state.currentPageId = state.initialPageId()
  // 表达式文本热替换后，单调性判定结果必须重新计算（8.6.2）。
  resetMonotonicCache()
  state.runtime.resetSink()

  return {
    orphans: state.dynamic.orphans().map((entry) => entry.id),
    conflicts,
    extra,
  }
}

/** 从存档里取某条目的 `assignments` 记录。 */
function assignmentsRecordOf(save: SaveFile, entity: EntryState): Record<string, Assignment> | undefined {
  switch (entity.kind) {
    case 'resource':
      return save.resources[entity.id]?.assignments
    case 'generator':
      return save.generators[entity.id]?.assignments
    case 'upgrade':
      return save.upgrades[entity.id]?.assignments
    case 'page':
      return save.pages[entity.id]?.assignments
  }
}

/** 顶层字段的文本（`max`/`initial`/`buyAmount`）写回条目。 */
function applyTopLevelText(state: GameState, entity: EntryState, attr: string, text: string): void {
  if (typeof text !== 'string' || text.length === 0) return
  // 顶层字段是权威副本：直接覆盖文本并使下游失效。
  entity.text.set(attr, text)
  // 文本型字段的派生缓存（`buyAmount` 的 last-good）需要跟着重算，否则会沿用上一局的值。
  if (attr === 'buyAmount') {
    try {
      state.attrs.setBuyAmountValue(entity, state.runtime.evaluateNumber(text, 'field', `${entity.id}.buyAmount`), `${entity.id}.buyAmount`)
    } catch {
      entity.lastGood.delete('buyAmount')
    }
  }
}

/** 顶层与 `assignments[path].value` 是否冲突（6.3「冲突裁决」）。 */
function detectConflict(entity: EntryState, key: string, assignmentValue: string): boolean {
  const attr = key.slice(key.indexOf('.', 4) + 1)
  const current = entity.values.get(attr) ?? entity.text.get(attr)
  const normalized = current instanceof Object && typeof (current as Decimal).cmp === 'function' ? (current as Decimal).toString() : String(current)
  if (normalized === assignmentValue) return false
  Diagnostics.record('E_SAVE_FIELD_CONFLICT', key, `顶层值 ${normalized} 与 assignments ${assignmentValue} 不一致，以顶层为准`)
  return true
}

/** 数值属性（顶层为准，`assignments` 仅审计）。 */
function isNumericAttribute(key: string): boolean {
  return /(?:^|\.)(?:amount|bought|owned|initial|max|buyAmount)$/.test(key) || key.includes('effectValues[')
}

function assignmentsOf(entity: EntryState): Record<string, Assignment> {
  const out: Record<string, Assignment> = Object.create(null) as Record<string, Assignment>
  for (const [key, assignment] of entity.assignments) out[key] = { ...assignment }
  return out
}

function decimalText(state: GameState, entity: EntryState, attr: string): string {
  void state
  return (entity.values.get(attr) ?? Num.fromNumber(0)).toString()
}

function textOf(_state: GameState, entity: EntryState, attr: string): string {
  return entity.text.get(attr) ?? ''
}

/** 存档里的十进制文本 -> `Decimal`；非法值按 0 处理并记诊断（6.4）。 */
function safeDecimal(text: string): Decimal {
  try {
    const value = Num.fromString(text)
    if (value.isNan()) return Num.fromNumber(0)
    return value
  } catch {
    Diagnostics.record('E_SCHEMA', 'save', `存档中的数值 "${text}" 无法解析，按 0 处理`)
    return Num.fromNumber(0)
  }
}
