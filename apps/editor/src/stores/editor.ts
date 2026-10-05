/**
 * 编辑器 UI 状态（TECH_DESIGN 7.2 `editorStore`、7.1、7.5）。
 *
 * **不进历史栈**（D-14：撤销/重做只覆盖项目数据，不覆盖 UI 状态）——
 * 因此本 store 没有任何 commit/history 逻辑，只改自己的 state。
 * 切换功能区（`activeSection`）同样不进历史，且**不触碰项目数据与预览**（7.1）。
 */
import { create } from 'zustand'

import type { EntryKind } from '@iforge/model'

/** 左侧功能区（PRD 工作页面一览：资源 / 生成器 / 升级 / 页面 / 设置）。 */
export type SectionId = 'resources' | 'generators' | 'upgrades' | 'pages' | 'settings'

/** 功能区顺序（7.1「由上至下依次显示」）。 */
export const SECTIONS: readonly SectionId[] = ['resources', 'generators', 'upgrades', 'pages', 'settings']

/** 条目类型 -> 功能区（`settings` 没有条目列表）。 */
export const SECTION_OF_KIND: Readonly<Record<EntryKind, SectionId>> = {
  resource: 'resources',
  generator: 'generators',
  upgrade: 'upgrades',
  page: 'pages',
}

interface EditorState {
  activeSection: SectionId
  /** 四类列表各自的选中 id（7.5「选中行高亮，与中间工作区表单双向绑定」）。 */
  selection: Record<Exclude<EntryKind, 'page'> | 'page', string | null>
  /** 待确认的删除（7.5「删除：二次确认并列出受影响引用」）。 */
  pendingDelete: PendingDelete | null
  /** 待确认的新建（7.9「当前项目有未保存改动或正在预览时弹确认」）。 */
  confirmNew: boolean
  /** 待确认的导入（10.2「覆盖当前项目 / 取消导入」，D-33）。 */
  pendingImport: string | null
  /** 提示条消息（保存成功、导入完成等）。 */
  toast: { text: string; tone: 'info' | 'error' } | null

  setSection(section: SectionId): void
  select(kind: EntryKind, id: string | null): void
  requestDelete(target: PendingDelete | null): void
  requestNew(): void
  confirmNewProject(): void
  setPendingImport(text: string | null): void
  notify(text: string, tone?: 'info' | 'error'): void
  dismissToast(): void
  resetUi(): void
}

/** 待删除对象（条目或页面，7.5 表）。 */
export interface PendingDelete {
  kind: EntryKind
  id: string
  name: string
}

export const useEditorStore = create<EditorState>((set) => ({
  activeSection: 'resources',
  selection: { resource: null, generator: null, upgrade: null, page: null },
  pendingDelete: null,
  confirmNew: false,
  pendingImport: null,
  toast: null,

  setSection: (section) => set({ activeSection: section }),
  select: (kind, id) =>
    set((state) => {
      // 选中条目即切到它所属的功能区：列表与中间表单双向绑定（7.5）。
      // 在同一功能区内点击不会产生视觉变化，因此统一写入比“仅在 settings 时切换”更不容易出错。
      return {
        selection: { ...state.selection, [kind]: id },
        activeSection: SECTION_OF_KIND[kind],
      }
    }),
  requestDelete: (target) => set({ pendingDelete: target }),
  requestNew: () => set({ confirmNew: true }),
  confirmNewProject: () => set({ confirmNew: false }),
  setPendingImport: (text) => set({ pendingImport: text }),
  notify: (text, tone = 'info') => set({ toast: { text, tone } }),
  dismissToast: () => set({ toast: null }),
  resetUi: () =>
    set({
      activeSection: 'resources',
      selection: { resource: null, generator: null, upgrade: null, page: null },
      pendingDelete: null,
      confirmNew: false,
      pendingImport: null,
    }),
}))

/** 读取当前选中的条目 id（列表与表单都用它，7.5 双向绑定）。 */
export function selectedId(kind: EntryKind): string | null {
  return useEditorStore.getState().selection[kind]
}
