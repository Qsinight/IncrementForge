/**
 * 撤销/重做栈（TECH_DESIGN 7.3、ADR-06）。
 *
 * | 规则 | 实现 |
 * | --- | --- |
 * | 事务粒度 = 一次用户操作 | `commit()` 一次调用一条记录 |
 * | 文本输入 400ms 合并窗口 | `mergeKey` 相同且在窗口内 → 与上一条合并（保留最初的 inverse、采用最新的 forward） |
 * | 栈容量 200，超出丢弃最旧 | `HISTORY_CAPACITY` |
 * | 跨项目切换清空 | `clear()` |
 *
 * **为什么存 patches 而不是快照**（ADR-06）：项目级条目多时快照会让内存与耗时失控。
 * immer 的 `produceWithPatches` 同时给出 forward/inverse 两组 patch，
 * 因此“撤销”与“重做”是对称的两组 apply，不需要另外保存历史状态。
 */
import { applyPatches, type Patch } from 'immer'
import { create } from 'zustand'

import type { ProjectFile } from '@iforge/model'

/** 栈容量（7.3「栈容量 200 条」）。 */
export const HISTORY_CAPACITY = 200

/** 文本类输入的合并窗口（7.3「400ms 窗口」）。 */
export const MERGE_WINDOW_MS = 400

/** 一条历史记录：一个事务的 forward/inverse patches。 */
export interface HistoryEntry {
  /** 事务标签（按钮悬浮提示与调试用）。 */
  label: string
  forward: Patch[]
  inverse: Patch[]
  /** 合并键：`(entityId, field)` 形态（7.3）。缺省表示不可与其它事务合并。 */
  mergeKey?: string
  /** 记录时刻（`Date.now()`），用于合并窗口判定。 */
  at: number
}

interface HistoryState {
  past: HistoryEntry[]
  future: HistoryEntry[]
  /** 最近一次记录时刻（合并窗口判定）。 */
  lastAt: number
  record(entry: HistoryEntry): void
  undo(project: ProjectFile): ProjectFile | undefined
  redo(project: ProjectFile): ProjectFile | undefined
  clear(): void
  /** 清空 future（新的编辑动作发生即丢弃重做分支，7.3 的常见语义）。 */
  dropFuture(): void
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],
  lastAt: 0,

  record(entry) {
    const { past, lastAt } = get()
    const mergeable =
      entry.mergeKey !== undefined &&
      entry.inverse.length > 0 &&
      lastAt > 0 &&
      Date.now() - lastAt <= MERGE_WINDOW_MS &&
      past[past.length - 1]?.mergeKey === entry.mergeKey

    if (mergeable) {
      const head = past[past.length - 1]!
      const merged: HistoryEntry = {
        ...head,
        // 合并的关键：inverse 仍取**最初**那次（否则撤销只能退回到上一个按键动作），
        // forward 取最新（重做要能到达最终状态）。
        forward: entry.forward,
        at: entry.at,
      }
      set({ past: [...past.slice(0, -1), merged], future: [], lastAt: entry.at })
      return
    }
    const next = [...past, entry]
    set({
      past: next.length > HISTORY_CAPACITY ? next.slice(next.length - HISTORY_CAPACITY) : next,
      future: [],
      lastAt: entry.at,
    })
  },

  undo(project) {
    const { past, future } = get()
    const entry = past[past.length - 1]
    if (!entry) return undefined
    set({ past: past.slice(0, -1), future: [...future, entry], lastAt: 0 })
    return applyPatches(project, entry.inverse)
  },

  redo(project) {
    const { past, future } = get()
    const entry = future[future.length - 1]
    if (!entry) return undefined
    set({ past: [...past, entry], future: future.slice(0, -1), lastAt: 0 })
    return applyPatches(project, entry.forward)
  },

  clear() {
    set({ past: [], future: [], lastAt: 0 })
  },

  dropFuture() {
    if (get().future.length > 0) set({ future: [] })
  },
}))

/** 便捷读取：`canUndo` / `canRedo`（顶部标题栏按钮置灰用，7.1）。 */
export function historyAvailability(): { canUndo: boolean; canRedo: boolean } {
  const { past, future } = useHistoryStore.getState()
  return { canUndo: past.length > 0, canRedo: future.length > 0 }
}
