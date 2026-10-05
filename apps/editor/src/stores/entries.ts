/**
 * 四类列表的增删改复制排序动作（TECH_DESIGN 7.5「条目列表交互规格」、D-38/D-39/D-40、PRD 补充 7）。
 *
 * ## 三条容易写错的规则（本模块把它们集中在一处）
 *
 * 1. **复制必发新 id**（D-39）：条目复制后 `order` 紧跟源条目；**页面复制不复制 `entries`**，
 *    复制的条目也**不自动加入页面**（一个条目只能属于一个页面）。
 * 2. **排序重排为 `1..N`**（D-40）：上移/下移/拖拽之后同类条目的 `order` 连续无重复，
 *    PRD 补充 5 的稳定排序才成立。
 * 3. **删除不做级联**（D-38）：删除前由 `references.ts` 列出受影响引用供确认，
 *    确认后只移除条目本体与它的页面归属；引用方的文本保留，悬空引用由
 *    保存/打包时的 `E_DANGLING_REF` 阻断。
 *
 * 所有动作都通过 `projectStore.commit()` 走同一个事务入口（撤销栈因此自动覆盖）。
 */
import {
  collectIds,
  createGenerator,
  createPage,
  createResource,
  createUpgrade,
  insertAfter,
  moveOrder,
  normalizeOrder,
  reorderBy,
  sortByOrder,
} from '@iforge/model'
import type { EntryKind, PageDef, ProjectFile } from '@iforge/model'

import { useEditorStore } from './editor.js'
import { useProjectStore } from './project.js'

/** 条目所属的数组字段名（四类，6.2）。 */
const LIST_FIELD: Readonly<Record<EntryKind, 'resources' | 'generators' | 'upgrades' | 'pages'>> = {
  resource: 'resources',
  generator: 'generators',
  upgrade: 'upgrades',
  page: 'pages',
}

/** 同一份引用逻辑：读列表。immer draft 上就地操作。 */
function listOf(draft: ProjectFile, kind: EntryKind) {
  return draft[LIST_FIELD[kind]] as ProjectFile['resources']
}

/**
 * 把排序/增删的结果写回 immer draft 里的原数组。
 *
 * **不能用 `Object.assign`**：它按索引覆盖且**不缩短数组**——
 * “删掉最后一项”会变成“保留旧的最后一项”，表现为“删除无效”。
 * `splice(0, length, ...next)` 同时覆盖内容与长度，是数组整体替换的正确写法。
 */
function replaceArray<T>(target: T[], next: T[]): void {
  target.splice(0, target.length, ...next)
}

/** 当前项目里四类条目的全部 id（6.1「跨四类全局唯一」的分配依据）。 */
export function takenIds(project: ProjectFile): Set<string> {
  return collectIds(project.resources, project.generators, project.upgrades, project.pages)
}

/**
 * 新增条目（7.5「添加」按钮）。
 *
 * @returns 新条目 id（调用方可据此 `select()`）
 */
export function addEntry(kind: EntryKind): string {
  const project = useProjectStore.getState().project
  const taken = takenIds(project)
  const order = listOf(project, kind).length + 1
  const created =
    kind === 'resource'
      ? createResource({ taken, order })
      : kind === 'generator'
        ? createGenerator({ taken, order })
        : kind === 'upgrade'
          ? createUpgrade({ taken, order })
          : createPage({ taken, order })
  useProjectStore.getState().commit(`add-${kind}`, (draft) => {
    listOf(draft, kind).push(created as never)
  })
  useEditorStore.getState().select(kind, created.id)
  return created.id
}

/**
 * 复制条目（7.5「复制」行、D-39）。
 *
 * 页面复制**不复制 `entries`**（条目归属不跟着页面走）；复制的条目不自动加入页面。
 *
 * @returns 新 id；源条目不存在时返回 `undefined`
 */
export function duplicateEntry(kind: EntryKind, id: string): string | undefined {
  const project = useProjectStore.getState().project
  const source = listOf(project, kind).find((item) => item.id === id)
  if (!source) return undefined
  const taken = takenIds(project)
  const copyName = `${source.name} 副本`
  const created =
    kind === 'resource'
      ? createResource({ taken, name: copyName })
      : kind === 'generator'
        ? createGenerator({ taken, name: copyName })
        : kind === 'upgrade'
          ? createUpgrade({ taken, name: copyName })
          : createPage({ taken, name: copyName })

  // 除 id / order / 名称外逐字复制（D-39「其余字段逐字复制」）。
  const clone = structuredClone(source) as Record<string, unknown>
  clone['id'] = created.id
  clone['name'] = copyName
  if (kind === 'page') {
    // 页面复制不带条目：PRD 补充 7「一个条目只能属于一个页面」。
    clone['entries'] = []
  }

  useProjectStore.getState().commit(`duplicate-${kind}`, (draft) => {
    const list = listOf(draft, kind) as unknown as Array<{ id: string; order: number }>
    replaceArray(list, insertAfter(list, id, clone as { id: string; order: number }))
  })
  useEditorStore.getState().select(kind, created.id)
  return created.id
}

/**
 * 删除条目（7.5「删除」行、D-38）。
 *
 * 同时从 `PageDef.entries` 移除该 id（页面因此变空是合法状态）。
 * 动态条目不受影响（只能 `destroy(id)`，8.7）。
 */
export function removeEntry(kind: EntryKind, id: string): void {
  useProjectStore.getState().commit(`remove-${kind}`, (draft) => {
    const list = listOf(draft, kind) as unknown as Array<{ id: string }>
    replaceArray(
      list,
      list.filter((item) => item.id !== id),
    )
    for (const page of draft.pages) {
      if (!page.entries.some((entry) => entry.id === id)) continue
      replaceArray(page.entries, normalizeOrder(page.entries.filter((entry) => entry.id !== id)))
    }
  })
  useEditorStore.getState().select(kind, null)
}

/** 上移 / 下移条目（7.5「排序」行、D-40）。 */
export function moveEntry(kind: EntryKind, id: string, direction: -1 | 1): void {
  useProjectStore.getState().commit(`move-${kind}`, (draft) => {
    const list = listOf(draft, kind) as unknown as Array<{ id: string; order: number }>
    replaceArray(list, moveOrder(list, id, direction))
  })
}

/** 拖拽排序：按给定 id 顺序重排（7.5「排序」行的拖拽形态）。 */
export function reorderEntries(kind: EntryKind, orderedIds: readonly string[]): void {
  useProjectStore.getState().commit(`reorder-${kind}`, (draft) => {
    const list = listOf(draft, kind) as unknown as Array<{ id: string; order: number }>
    replaceArray(list, reorderBy(list, orderedIds))
  })
}

/**
 * 把条目分配到页面（7.6 页面工作区、PRD 补充 7）。
 *
 * 一个条目只能属于一个页面：已分配到别的页面时报错（`E_DUPLICATE_PAGE_ENTRY`），
 * **不自动搬家**——7.6 的口径是“已分配者在原页面标记”，搬家会让作者失去对归属的掌控。
 *
 * @returns 成功返回 `{ok:true}`；失败返回 `{ok:false, message: 原页面名或页面 id}`
 */
export function assignEntryToPage(pageId: string, entryId: string): { ok: boolean; message?: string } {
  const project = useProjectStore.getState().project
  const owner = project.pages.find((page) => page.entries.some((entry) => entry.id === entryId))
  if (owner && owner.id !== pageId) {
    return { ok: false, message: owner.name }
  }
  if (!project.pages.some((page) => page.id === pageId)) {
    return { ok: false, message: pageId }
  }
  useProjectStore.getState().commit('assign-page-entry', (draft) => {
    const page = draft.pages.find((item) => item.id === pageId)
    if (!page) return
    // 条目主题缺省跟随页面主题（PRD 页面编辑器 8），由 `resolveEntryTokens` 在渲染时兜底。
    // 条目主题**不写**：缺省即跟随页面主题（PRD 页面编辑器 8），由
    // `resolveEntryTokens()` 在渲染期解析。写一个显式值会让新分配的条目永远不跟随页面。
    replaceArray(page.entries, normalizeOrder([...page.entries, { id: entryId, order: page.entries.length + 1 }]))
  })
  return { ok: true }
}

/** 从页面移除条目（不删除条目本身）。 */
export function removePageEntry(pageId: string, entryId: string): void {
  useProjectStore.getState().commit('remove-page-entry', (draft) => {
    const page = draft.pages.find((item) => item.id === pageId)
    if (!page) return
    replaceArray(page.entries, normalizeOrder(page.entries.filter((entry) => entry.id !== entryId)))
  })
}

/**
 * 页面内条目排序（7.5「页面内条目排序只改 `PageDef.entries[i].order`」）。
 *
 * **不改条目自身的 `order`**：条目有全局顺序，页面内的排列是另一件事（6.2 注释）。
 */
export function movePageEntry(pageId: string, entryId: string, direction: -1 | 1): void {
  useProjectStore.getState().commit('move-page-entry', (draft) => {
    const page = draft.pages.find((item) => item.id === pageId)
    if (!page) return
    replaceArray(page.entries, moveOrder(page.entries, entryId, direction))
  })
}

/** 页面内拖拽排序（同样只改 `entries[i].order`）。 */
export function reorderPageEntries(pageId: string, orderedIds: readonly string[]): void {
  useProjectStore.getState().commit('reorder-page-entries', (draft) => {
    const page = draft.pages.find((item) => item.id === pageId)
    if (!page) return
    replaceArray(page.entries, reorderBy(page.entries, orderedIds))
  })
}

/** 按 `order` 升序取页面条目（渲染顺序 = 布局顺序，7.6）。 */
export function pageEntries(page: PageDef): PageDef['entries'] {
  return sortByOrder(page.entries)
}
