/**
 * 撤销/重做动作（TECH_DESIGN 7.3、7.1 顶部标题栏的撤销/重做按钮）。
 *
 * 单独成模块而不是塞进 `projectStore`：撤销要同时动 `historyStore` 与 `projectStore`，
 * 而这两个 store **互不认识**（避免循环依赖）。这里作为唯一的编排点：
 * 从历史栈取出状态，从项目 store 取出当前项目，交换两者。
 */
import { useHistoryStore } from './history.js'
import { useProjectStore } from './project.js'

/** 撤销一步（顶部标题栏 `Ctrl+Z` / 按钮共用同一入口，7.1「不存在旁路实现」）。 */
export function undo(): boolean {
  const { undo: pop } = useHistoryStore.getState()
  const current = useProjectStore.getState().project
  const next = pop(current)
  if (!next) return false
  useProjectStore.getState().applyPatched(next)
  return true
}

/** 重做一步（`Ctrl+Shift+Z` / `Ctrl+Y`）。 */
export function redo(): boolean {
  const { redo: pop } = useHistoryStore.getState()
  const current = useProjectStore.getState().project
  const next = pop(current)
  if (!next) return false
  useProjectStore.getState().applyPatched(next)
  return true
}

/** 是否有可撤销/可重做（按钮置灰依据，7.1）。 */
export function canUndo(): boolean {
  return useHistoryStore.getState().past.length > 0
}

export function canRedo(): boolean {
  return useHistoryStore.getState().future.length > 0
}
