/**
 * 删除流程（TECH_DESIGN 7.5「删除时的引用处理」、D-38）。
 *
 * 单独成模块的原因：列表的删除按钮、键盘 `Delete`、以及页面条目里的“移除”都走同一条流程，
 * 而确认弹窗需要读取**当前**项目状态做影响面分析（`references.ts`）——放在组件里会
 * 让三处各写一遍弹窗，导致 D-38 的“列出受影响引用”在某条路径上消失。
 *
 * 确认后**只删条目本体 + 页面归属**；引用方保留原文本，悬空引用由保存/打包时的
 * `E_DANGLING_REF` 阻断（7.5 表），这一点在弹窗里明确告知作者。
 */
import type { EntryKind } from '@iforge/model'

import { analyzeDeletion } from '../../lib/references.js'
import { useEditorStore } from '../../stores/editor.js'
import { removeEntry } from '../../stores/entries.js'
import { useProjectStore } from '../../stores/project.js'

/** 请求删除条目（列表按钮 / 键盘 Delete 统一入口）。 */
export function requestDeleteFor(kind: EntryKind, id: string): void {
  const project = useProjectStore.getState().project
  const lists: Record<EntryKind, Array<{ id: string; name: string }>> = {
    resource: project.resources,
    generator: project.generators,
    upgrade: project.upgrades,
    page: project.pages,
  }
  const name = lists[kind].find((item) => item.id === id)?.name ?? id
  useEditorStore.getState().requestDelete({ kind, id, name })
}

/** 确认删除（弹窗的“删除”按钮）。 */
export function confirmDelete(): void {
  const pending = useEditorStore.getState().pendingDelete
  if (!pending) return
  // 影响面在确认瞬间重算一次：弹窗打开期间项目可能被编辑（撤销/导入）。
  analyzeDeletion(useProjectStore.getState().project, pending.kind, pending.id)
  removeEntry(pending.kind, pending.id)
  useEditorStore.getState().requestDelete(null)
}
