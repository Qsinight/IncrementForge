/**
 * 编辑器测试环境初始化（TECH_DESIGN 14.1「集成：Vitest + jsdom」）。
 *
 * 三件事：
 * 1. `fake-indexeddb` —— 10.1 的 IndexedDB 在 Node/jsdom 里不存在（jsdom 不实现它）；
 * 2. `@testing-library/jest-dom` —— DOM 断言扩展；
 * 3. `window.alert` 桩 —— 页面唯一性冲突时 UI 用它提示（7.6），否则 jsdom 会静默吞掉。
 */
import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'

import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

import { resetShadow } from '../src/lib/shadow.js'
import { useEditorStore } from '../src/stores/editor.js'
import { useHistoryStore } from '../src/stores/history.js'
import { useProjectStore, newProjectId } from '../src/stores/project.js'
import { usePreviewStore } from '../src/stores/preview.js'
import { useSettingsStore, DEFAULT_SETTINGS_SNAPSHOT } from '../src/stores/settings.js'
import { createDefaultProject } from '@iforge/model'

/** 每个用例前把全部 store 复位（7.3：跨项目切换清空历史栈）。 */
beforeEach(() => {
  resetShadow()
  useProjectStore.setState({
    projectId: newProjectId(),
    project: createDefaultProject(),
    dirty: false,
    revision: 0,
    savedAt: null,
  })
  useHistoryStore.getState().clear()
  useEditorStore.getState().resetUi()
  usePreviewStore.getState().reset()
  useSettingsStore.setState({ ...DEFAULT_SETTINGS_SNAPSHOT, hydrated: true })
  // jsdom 未实现 Object URL；导出/存档下载走它（10.2）。
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:iforge-test',
    revokeObjectURL: () => undefined,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
