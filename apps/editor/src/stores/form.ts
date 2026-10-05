/**
 * 表单字段写入的统一入口（TECH_DESIGN 7.2/7.3、3.2「编辑器只通过 Schema 读写数据」）。
 *
 * ## 为什么需要这一层
 *
 * 表单拿到的是**草稿外的引用**（`project.resources.find(...)` 返回的原始对象），
 * 直接改它既绕过 immer 的不可变假设、也绕过撤销栈。四类工作区共有几十个字段，
 * 若每个 `onChange` 都手写 `commit(label, draft => { ... })` 会出现两类笔误：
 * - 写错列表（`draft.resources` vs `draft.generators`）；
 * - 漏传 `mergeKey`，导致逐字符输入产生几十条撤销记录（7.3 的 400ms 合并窗口形同虚设）。
 *
 * 因此本模块把“按 kind + id 找到草稿对象”收在一处。它们是**普通函数**而非 hook：
 * 调用点在渲染期间执行，hook 规则反而会误导读者以为这里有订阅语义。
 */
import type { EntryKind, PageDef, ProjectFile, ResourceDef } from '@iforge/model'

import { useProjectStore } from './project.js'

/** 三类条目的草稿类型（页面字段不同，单独用 `PageDef`）。 */
export type DraftEntry = ResourceDef | ProjectFile['generators'][number] | ProjectFile['upgrades'][number]

/**
 * 提交一次条目字段修改。
 *
 * @param kind 条目类型（决定目标数组）
 * @param id 条目 id
 * @param label 事务标签（撤销栈的悬浮提示）
 * @param recipe 对草稿条目的修改
 * @param mergeKey 合并键（`(entityId, field)`，7.3）；文本输入必须给
 */
export function commitField(
  kind: Exclude<EntryKind, 'page'>,
  id: string,
  label: string,
  recipe: (draft: DraftEntry) => void,
  mergeKey?: string,
): void {
  useProjectStore.getState().commit(
    label,
    (draft) => {
      const list = listOf(draft, kind)
      const target = list.find((item) => item.id === id)
      if (!target) return
      recipe(target as DraftEntry)
    },
    mergeKey ? { mergeKey } : undefined,
  )
}

/** 页面字段的提交入口（页面的 `entries` 是嵌套列表，需要独立处理，7.6 页面工作区）。 */
export function commitPageField(id: string, label: string, recipe: (draft: PageDef) => void, mergeKey?: string): void {
  useProjectStore.getState().commit(
    label,
    (draft) => {
      const page = draft.pages.find((item) => item.id === id)
      if (!page) return
      recipe(page)
    },
    mergeKey ? { mergeKey } : undefined,
  )
}

/** `meta` / `settings` 的提交入口（设置页专用，7.7）。 */
export function commitProject(label: string, recipe: (draft: ProjectFile) => void, mergeKey?: string): void {
  useProjectStore.getState().commit(label, recipe, mergeKey ? { mergeKey } : undefined)
}

function listOf(draft: ProjectFile, kind: Exclude<EntryKind, 'page'>): Array<{ id: string }> {
  switch (kind) {
    case 'resource':
      return draft.resources
    case 'generator':
      return draft.generators
    case 'upgrade':
      return draft.upgrades
  }
}
