/**
 * 编辑器 → 预览的增量热更新（TECH_DESIGN 7.4、9.2 的 `host:patch`、D-25、D-50、R-08）。
 *
 * ## 为什么必须是“增量补丁”而不是整表重载
 *
 * 7.4 的第一条明确要求：编辑器变更 → 条目级 patch → `host:patch` → 运行时热更新。
 * 整表重载（`host:init` 重新带一份项目）会把**本局进度**清零——`loadProject()` 重建
 * `AttributeStore` 的结构，再由 `reset()` 按 8.5 的初始化表复位 `amount/bought/owned`，
 * 玩家刚买的 200 台矿机就没了。因此预览热更新必须在**保留运行时进度**的前提下换结构。
 *
 * ## 权威性：设计期改动 vs 运行期赋值
 *
 * 一条条目上同时存在两套值，冲突时按“谁更新”分层（PRD 补充 6、6.3、D-25）：
 *
 * | 字段 | 编辑器改了 | 运行时改过（`assignments` 里有该键） |
 * | --- | --- | --- |
 * | 表达式文本（`costs[i].amount`、`conditions[i]`…） | **采用项目值** | **保留运行期文本** |
 * | `visible` / `disabled` / `description` | 采用项目值 | 保留运行期值 |
 * | `amount` / `bought` / `owned` / `effectValues[i]` | **永远保留运行期值** | 保留 |
 * | `initial` / `max` / `buyAmount` | 采用项目值（它们只影响 `reset()` 与后续求值） | 保留 |
 *
 * 关键判断：**作者在编辑器里改一个字段就是要改它**，哪怕运行时也赋过值——
 * 否则作者永远无法把一个被表达式写坏的表达式改回来；而 `amount/bought/owned`
 * 属于“进度”，作者在编辑器里没有输入框（`initial` 才是），改了结构不该动进度。
 *
 * ## 删除条目的连带处理
 *
 * `remove` 时除了移除 `AttributeStore` 的状态，还要清理：
 * - 项目四类数组里的定义；
 * - 其它条目里指向它的 `costs[i].materialId` / `produces[i].materialId` 引用
 *   ——**保留原文本**（D-38：不做级联删除），让残留的悬空引用在结算时记 `E_DANGLING_REF`，
 *   并在保存/打包时被 `E_DANGLING_REF` 阻断。静默改写引用会让作者的表达式无声变形；
 * - `PageDef.entries` 里的归属记录（PRD 补充 7 的“唯一归属”）。
 */
import { Diagnostics } from '@iforge/num'
import type { GeneratorDef, PageDef, ProjectFile, ResourceDef, UpgradeDef } from '@iforge/model'

import type { EntryState } from './attribute-store.js'
import { createEntryState, entityKeyOf } from './attribute-store.js'
import type { GameState } from './game-state.js'
import { parseKey } from './keys.js'
import type { RuntimeEntityKind } from './keys.js'
import type { HostPatch } from './protocol.js'

/** 补丁的 `target`（9.2：条目级 patch 的四类 + `meta`/`settings`）。 */
const COLLECTIONS = ['resources', 'generators', 'upgrades', 'pages'] as const
type CollectionName = (typeof COLLECTIONS)[number]

const COLLECTION_KIND: Readonly<Record<CollectionName, RuntimeEntityKind>> = Object.freeze({
  resources: 'resource',
  generators: 'generator',
  upgrades: 'upgrade',
  pages: 'page',
})

/**
 * 由两份项目文件算出条目级补丁（7.4：编辑器侧调用）。
 *
 * 只做**结构与文本**层面的比对，输出最小补丁集：
 * - 增删：`remove` / `upsert`；
 * - 改：`upsert`（整条替换，运行时按上表逐字段仲裁）；
 * - `meta` / `settings`：整体替换（体积小、语义整体）。
 *
 * 逐条比较用 `JSON.stringify`：条目定义是**纯数据**（6.1），没有函数与循环引用，
 * 序列化即一个稳定指纹；这比手写 20 个字段的比较函数更不容易漏字段。
 */
export function diffProject(previous: ProjectFile, next: ProjectFile): HostPatch[] {
  const patches: HostPatch[] = []
  if (JSON.stringify(previous.meta) !== JSON.stringify(next.meta)) {
    patches.push({ op: 'meta', target: 'meta', data: next.meta })
  }
  if (JSON.stringify(previous.settings) !== JSON.stringify(next.settings)) {
    patches.push({ op: 'settings', target: 'settings', data: next.settings })
  }
  for (const collection of COLLECTIONS) {
    const before = new Map(previous[collection].map((entry) => [entry.id, entry]))
    const after = new Map(next[collection].map((entry) => [entry.id, entry]))
    for (const id of before.keys()) {
      if (!after.has(id)) patches.push({ op: 'remove', target: collection, id })
    }
    for (const [id, entry] of after) {
      const prior = before.get(id)
      if (!prior) {
        patches.push({ op: 'upsert', target: collection, id, data: entry })
        continue
      }
      if (JSON.stringify(prior) !== JSON.stringify(entry)) {
        patches.push({ op: 'upsert', target: collection, id, data: entry })
      }
    }
  }
  return patches
}

/** 应用一条补丁（9.2 的 `host:patch` 运行时侧）。返回是否命中了目标。 */
export function applyProjectPatch(state: GameState, patch: HostPatch): boolean {
  if (patch.op === 'meta') {
    state.project.meta = (patch.data ?? state.project.meta) as ProjectFile['meta']
    return true
  }
  if (patch.op === 'settings') {
    // 项目默认设置被编辑器改动：直接替换（7.7 的“游戏默认设置”只在这里被写）。
    // 会话覆盖不动——它是玩家偏好（D-22），作者改默认值不应抹掉玩家在游戏内的选择。
    state.project.settings = (patch.data ?? state.project.settings) as ProjectFile['settings']
    const effective = state.effectiveSettings()
    state.clock.configure({ tickRate: effective.tickRate, maxFrameStep: effective.maxFrameStep })
    return true
  }
  const collection = COLLECTIONS.find((name) => name === patch.target)
  if (!collection || patch.id === undefined) return false
  if (patch.op === 'remove') return removeEntry(state, collection, patch.id)
  if (patch.op === 'upsert') return upsertEntry(state, collection, patch.id, patch.data)
  return false
}

/** 批量应用（`host:patch` 的 `patches` 数组）。 */
export function applyProjectPatches(state: GameState, patches: readonly HostPatch[]): number {
  let applied = 0
  for (const patch of patches) if (applyProjectPatch(state, patch)) applied += 1
  return applied
}

/** 新增或替换一个条目，保留运行时进度（7.4 的核心语义）。 */
function upsertEntry(state: GameState, collection: CollectionName, id: string, data: unknown): boolean {
  const kind = COLLECTION_KIND[collection]
  const list = state.project[collection] as (ResourceDef | GeneratorDef | UpgradeDef | PageDef)[]
  const existing = state.attrs.find(entityKeyOf(kind, id))
  if (!isEntryDef(data)) {
    Diagnostics.record('E_SCHEMA', `${collection}.${id}`, 'host:patch 的 data 不是合法的条目定义')
    return false
  }

  if (existing) {
    replaceDefinition(state, existing, data)
    const index = list.findIndex((entry) => entry.id === id)
    if (index >= 0) list[index] = data
    else list.push(data)
    return true
  }

  // 动态条目**不**由编辑器创建（PRD 升级编辑器 12：编辑器列表不显示动态条目）。
  // 作者新增一个与某个动态条目同 id 的静态条目时，静态胜出并记冲突——
  // 否则 `AttributeStore` 里会同时存在两条同键记录，读取结果取决于插入顺序。
  if (state.dynamic.list().some((entry) => entry.id === id)) {
    Diagnostics.record('E_SAVE_FIELD_CONFLICT', `${collection}.${id}`, `动态条目 ${id} 与新增的静态条目冲突，按静态胜出处理（动态条目已移除）`)
    state.dynamic.destroy(id)
  }
  state.attrs.addDynamic(createEntryState(kind, id, data, { sortOrder: data.order }))
  list.push(data)
  // 新增的条目按 8.5 的初始化表给初值（它还没有任何运行时状态）。
  // 这一步内部会把文本字段按项目定义重建，并顺带做编译校验（`AttributeStore.resetValues`），
  // 因此新增条目带坏表达式时同样不会漏到求值器。
  initializeNewEntry(state, kind, id)
  return true
}

/** 用新的项目定义替换 `EntryState` 的结构，逐字段仲裁保留运行时值。 */
function replaceDefinition(state: GameState, existing: EntryState, next: ResourceDef | GeneratorDef | UpgradeDef | PageDef): void {
  // 先记下“运行时真正改过的键”：`assignments` 是判定运行期赋值的唯一依据（6.3、D-25）。
  const assigned = new Set(existing.assignments.keys())
  const rebuilt = createEntryState(existing.kind, existing.id, next, { dynamic: existing.dynamic, sortOrder: existing.sortOrder })

  // ---- 进度类数值：永远保留（作者在编辑器改结构不该动进度）----
  for (const [attr, value] of existing.values) rebuilt.values.set(attr, value)
  for (const [key, assignment] of existing.assignments) rebuilt.assignments.set(key, assignment)
  for (const [attr, value] of existing.lastGood) rebuilt.lastGood.set(attr, value)
  for (const [attr, version] of existing.versions) rebuilt.versions.set(attr, version)

  // ---- 标量：运行期赋过值的保留，否则采用项目新值 ----
  rebuilt.visible = assigned.has(`${entityKeyOf(existing.kind, existing.id)}.visible`) ? existing.visible : rebuilt.visible
  rebuilt.disabled = assigned.has(`${entityKeyOf(existing.kind, existing.id)}.disabled`) ? existing.disabled : rebuilt.disabled
  rebuilt.description = assigned.has(`${entityKeyOf(existing.kind, existing.id)}.description`) ? existing.description : rebuilt.description
  rebuilt.buyDelay = assigned.has(`${entityKeyOf(existing.kind, existing.id)}.buyDelay`) ? existing.buyDelay : rebuilt.buyDelay

  // ---- 表达式文本：逐键仲裁 ----
  // `rebuilt.text` 是项目新文本；对每个被运行期赋值过的键，把旧文本搬回去。
  for (const key of assigned) {
    const parsed = parseKey(key)
    // 必须走 `parseKey` 而不是自己切 `.`：键是 `<prefix>.<id>.<attr>` 三段，
    // 按第一个点切会得到 `g1.costs[0].amount`，`state.text` 里根本没有这个键——
    // 于是“保留运行期值”静默失效，作者改不回来被表达式写坏的表达式。
    if (!parsed) continue
    const previous = existing.text.get(parsed.concreteAttr)
    if (previous === undefined) continue
    rebuilt.text.set(parsed.concreteAttr, previous)
  }

  // 新文本里的坏表达式必须**换回旧文本**并记错误码（5.9.3 的 last-good 口径）。
  // 放在仲裁之后：运行期写过的文本本身合法，校验通过，等于“保留运行期值”优先于新值。
  //
  // `keep` 对**上一轮就是占位值**的键返回 `undefined`：那份文本是引擎代填的中性值而不是
  // 作者的文本，若当成“上一份合法文本”搬回来，占位标记会被 `validateDefinitionTexts` 的
  // 全量重算抹掉，作者就会重新拿到一个“按 0 计价”的价格（= 免费购买，`priceRowsUsable`）。
  const previousNeutral = existing.neutralized
  state.attrs.validateDefinitionTexts(rebuilt, (attr) => (previousNeutral.has(attr) ? undefined : existing.text.get(attr)))

  state.attrs.replace(rebuilt)
}

/**
 * 新增条目按 8.5 的初始化表给初值。
 *
 * 与 `resetValues()` 的差别：这里走的是**单个**条目，且必须复用同一份逻辑——
 * 重复实现一份初始值规则，迟早会与 8.5 的表漂移（例如漏掉“点击器 `bought = 0`”）。
 */
function initializeNewEntry(state: GameState, kind: RuntimeEntityKind, id: string): void {
  state.attrs.resetValues([entityKeyOf(kind, id)])
}

/** 移除条目及其连带引用（D-38：不做级联删除，只清理归属与状态）。 */
function removeEntry(state: GameState, collection: CollectionName, id: string): boolean {
  const kind = COLLECTION_KIND[collection]
  const list = state.project[collection] as (ResourceDef | GeneratorDef | UpgradeDef | PageDef)[]
  const index = list.findIndex((entry) => entry.id === id)
  if (index < 0) return false
  list.splice(index, 1)

  // 页面归属：条目被删后不能还挂在某个页面的 `entries` 里（PRD 补充 7 的唯一归属）。
  for (const page of state.project.pages) {
    const at = page.entries.findIndex((entry) => entry.id === id)
    if (at >= 0) page.entries.splice(at, 1)
  }

  // 价格/产出引用：保留文本并记诊断，让作者在保存/打包时被 `E_DANGLING_REF` 拦住（D-38）。
  for (const other of [...state.project.generators, ...state.project.upgrades]) {
    other.costs.forEach((cost, index) => {
      if (cost.materialId === id) {
        Diagnostics.record('E_DANGLING_REF', `${other.id}.costs[${index}].materialId`, `材料 ${id} 已被删除`)
      }
    })
  }
  for (const generator of state.project.generators) {
    generator.produces.forEach((produces, index) => {
      if (produces.materialId === id) {
        Diagnostics.record('E_DANGLING_REF', `${generator.id}.produces[${index}].materialId`, `产出目标 ${id} 已被删除`)
      }
    })
  }

  state.attrs.remove(entityKeyOf(kind, id))
  // 当前页面被删 → 回到 8.12 的初始页面（否则视图会停在一个不存在的页面上）。
  if (state.currentPageId === id) state.currentPageId = state.initialPageId()
  return true
}

/** 宽松的条目定义守卫（`host:patch` 的 data 来自消息，必须再校验一次，13 第 6 条）。 */
function isEntryDef(value: unknown): value is ResourceDef | GeneratorDef | UpgradeDef | PageDef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { order?: unknown }).order === 'number'
  )
}
