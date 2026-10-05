/**
 * 项目 store：唯一事实源（TECH_DESIGN 7.2 `projectStore`、7.3 事务、ADR-06/ADR-03）。
 *
 * ## 写入只有一个入口
 *
 * `commit(label, recipe, options)` 是**唯一**的项目写入路径：它用
 * `produceWithPatches` 产出 forward/inverse patches，把结果写进 store，
 * 同时把 patches 交给 `historyStore`（7.3「事务提交时自动记录」）。
 * 直接 `setState` 改项目会绕过撤销栈——代码里因此不提供这种写法。
 *
 * ## 影子运行时同步（7.4、D-15）
 *
 * `revision` 每次提交 +1。预览容器（M4 的 iframe、打包版的直挂）订阅它并重新 `host:init`，
 * 这样“编辑器改动 → 预览热更新”只有**一个**信号源，不存在两套 patch 逻辑。
 */
import { enablePatches, produceWithPatches } from 'immer'
import { create } from 'zustand'

import { ENGINE_VERSION, createDefaultProject } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'

import { useHistoryStore } from './history.js'

/**
 * immer 的 patches 插件是**可选**的，必须显式启用（否则 `produceWithPatches` 抛
 * “The plugin for 'Patches' has not been loaded”）。
 *
 * 放在本模块顶层而不是 `main.tsx`：撤销栈是 store 层的能力，任何入口（应用、测试、
 * 未来的 Playwright fixture）都应该开箱即用。
 */
enablePatches()

/** 提交选项。 */
export interface CommitOptions {
  /**
   * 合并键（7.3「文本输入类操作按 `(entityId, field)` 在 400ms 窗口内合并」）。
   *
   * 形如 `gen.g1.name`；给出时同键连续输入会合并为一次撤销。
   */
  mergeKey?: string
}

interface ProjectState {
  /** IndexedDB 主键（7.9：`crypto.randomUUID()`）。 */
  projectId: string
  project: ProjectFile
  /** 是否有未保存改动（7.1：项目名后显示圆点标记）。 */
  dirty: boolean
  /** 每次提交 +1，供预览订阅（7.4）。 */
  revision: number
  /** 上次保存完成的时间戳。 */
  savedAt: string | null

  commit(label: string, recipe: (draft: ProjectFile) => void, options?: CommitOptions): void
  /** 整体替换项目（新建 / 导入 / 读档后），并清空撤销栈（7.3「跨项目切换时清空」）。 */
  replace(project: ProjectFile, projectId?: string): void
  /** 保存成功后调用（更新 dirty 与时间戳）。 */
  markSaved(at: string, project?: ProjectFile): void
  /** 撤销/重做的状态搬运（由 `undoRedo.ts` 调用，避免 store 之间直接耦合）。 */
  applyPatched(project: ProjectFile): void
}

/** 生成 `projectId`（`crypto.randomUUID`，不可用时退回时间戳，7.9）。 */
export function newProjectId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `pid-${Date.now().toString(36)}`
}

/** 初始状态：新建项目模板（7.9「新建」写默认模板）。 */
function initialState(): Pick<ProjectState, 'projectId' | 'project' | 'dirty' | 'revision' | 'savedAt'> {
  return {
    projectId: newProjectId(),
    project: createDefaultProject({ engineVersion: ENGINE_VERSION }),
    dirty: false,
    revision: 0,
    savedAt: null,
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  ...initialState(),

  commit(label, recipe, options) {
    const state = get()
    const [next, patches, inverse] = produceWithPatches(state.project, (draft) => {
      recipe(draft as ProjectFile)
      // 数组顺序 = `order` 顺序（D-40/PRD 补充 5）：把四类列表就地重排一次，
      // 这样“文件里的数组顺序”“渲染顺序”“order 字段”三者永远一致。
      // 不这样做就会出现“order 是 1..N 但数组顺序是乱的”，导出文件时顺序看起来就是错的。
      for (const list of [draft.resources, draft.generators, draft.upgrades, draft.pages]) {
        list.sort((a, b) => a.order - b.order)
      }
      for (const page of draft.pages) {
        page.entries.sort((a, b) => a.order - b.order)
      }
    })
    if (patches.length === 0) return
    set({ project: next as ProjectFile, dirty: true, revision: state.revision + 1 })
    useHistoryStore.getState().record({
      label,
      forward: patches,
      inverse,
      mergeKey: options?.mergeKey,
      at: Date.now(),
    })
  },

  replace(project, projectId) {
    set({
      project,
      projectId: projectId ?? get().projectId,
      // 读档/新建/导入都回到“干净”状态：它们本身就是一次完整的项目状态装载。
      dirty: false,
      revision: get().revision + 1,
    })
    // 7.3：跨项目切换时清空历史栈。
    useHistoryStore.getState().clear()
  },

  markSaved(at, project) {
    set({ dirty: false, savedAt: at, revision: get().revision + 1, ...(project ? { project } : {}) })
  },

  applyPatched(project) {
    set({ project, dirty: true, revision: get().revision + 1 })
  },
}))

/** 便捷读取：当前项目（组件里用 `useProjectStore((s) => s.project)`）。 */
export function useProject(): ProjectFile {
  return useProjectStore((state) => state.project)
}
