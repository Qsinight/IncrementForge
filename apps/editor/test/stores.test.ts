/**
 * store 层测试（TECH_DESIGN 7.2/7.3、7.5、D-38/D-39/D-40、14.2 的列表用例）。
 *
 * 这一层不打 DOM：验证的是**事务与状态迁移**——撤销栈、合并窗口、`order` 连续化、
 * 页面唯一性、删除时的引用处理。
 */
import { describe, expect, it, vi } from 'vitest'

import { createDefaultProject, createResource } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'

import {
  addEntry,
  assignEntryToPage,
  duplicateEntry,
  moveEntry,
  movePageEntry,
  removeEntry,
  removePageEntry,
  reorderEntries,
} from '../src/stores/entries.js'
import { commitField, commitPageField, commitProject } from '../src/stores/form.js'
import { MERGE_WINDOW_MS } from '../src/stores/history.js'
import { analyzeDeletion } from '../src/lib/references.js'
import { useProjectStore } from '../src/stores/project.js'
import { redo, undo } from '../src/stores/undoRedo.js'
import { useEditorStore } from '../src/stores/editor.js'

/** 把项目替换成给定结构（测试夹具）。 */
function loadProject(build: (draft: ProjectFile) => void): void {
  const project = createDefaultProject() as ProjectFile
  build(project)
  useProjectStore.setState({ project, dirty: true, revision: 1 })
}

describe('projectStore 事务与撤销重做（7.2/7.3、ADR-06）', () => {
  it('一次 commit = 一条历史；撤销/重做对称', () => {
    commitField('resource', addEntry('resource'), 'res-name', (draft) => void (draft.name = '第一个'))
    const id = useProjectStore.getState().project.resources[0]!.id
    commitField('resource', id, 'res-name', (draft) => void (draft.name = '改名'))
    expect(useProjectStore.getState().project.resources[0]!.name).toBe('改名')

    expect(undo()).toBe(true)
    expect(useProjectStore.getState().project.resources[0]!.name).toBe('第一个')
    expect(redo()).toBe(true)
    expect(useProjectStore.getState().project.resources[0]!.name).toBe('改名')
  })

  it('同字段的连续输入在 400ms 窗口内合并为一次撤销（7.3）', () => {
    const id = addEntry('resource')
    vi.useFakeTimers()
    try {
      for (const name of ['矿', '矿石', '矿石矿']) {
        commitField('resource', id, 'res-name', (draft) => void (draft.name = name), `${id}.name`)
        vi.advanceTimersByTime(100)
      }
      // 窗口内三次输入 -> 撤销一次即回到最初状态（'新资源'）。
      expect(undo()).toBe(true)
      expect(useProjectStore.getState().project.resources[0]!.name).toBe('新资源')
      expect(MERGE_WINDOW_MS).toBe(400)
    } finally {
      vi.useRealTimers()
    }
  })

  it('窗口外的第二次输入是独立事务', () => {
    const id = addEntry('resource')
    vi.useFakeTimers()
    try {
      commitField('resource', id, 'res-name', (draft) => void (draft.name = 'A'), `${id}.name`)
      vi.advanceTimersByTime(MERGE_WINDOW_MS + 50)
      commitField('resource', id, 'res-name', (draft) => void (draft.name = 'B'), `${id}.name`)
      undo()
      expect(useProjectStore.getState().project.resources[0]!.name).toBe('A')
      undo()
      expect(useProjectStore.getState().project.resources[0]!.name).toBe('新资源')
    } finally {
      vi.useRealTimers()
    }
  })

  it('replace（新建/导入/读档）清空历史栈（7.3）', () => {
    addEntry('resource')
    expect(undo()).toBe(true)
    useProjectStore.getState().replace(createDefaultProject())
    expect(undo()).toBe(false)
  })

  it('dirty 标记与 revision 在每次提交后推进', () => {
    const before = useProjectStore.getState().revision
    addEntry('resource')
    expect(useProjectStore.getState().dirty).toBe(true)
    expect(useProjectStore.getState().revision).toBe(before + 1)
  })

  it('不改数据的 commit 不产生历史（避免空撤销步）', () => {
    const before = useProjectStore.getState().revision
    commitProject('noop', () => undefined)
    expect(useProjectStore.getState().revision).toBe(before)
    expect(undo()).toBe(false)
  })
})

describe('条目列表动作（7.5、D-38/D-39/D-40、PRD 补充 7）', () => {
  it('添加生成不冲突的 id，并落默认字段（14.2 用例）', () => {
    const first = addEntry('resource')
    const second = addEntry('resource')
    const generator = addEntry('generator')
    expect([first, second, generator]).toEqual(['r1', 'r2', 'g1'])
    const project = useProjectStore.getState().project
    expect(project.resources[1]!.order).toBe(2)
    expect(project.generators[0]!.buyAmount).toBe('1')
  })

  it('复制生成新 id、order 紧跟源条目，且不自动加入页面（D-39）', () => {
    loadProject((project) => {
      project.resources.push(createResource({ id: 'r1', order: 1 }))
      project.resources.push(createResource({ id: 'r2', order: 2 }))
      project.pages[0]!.entries.push({ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } })
    })
    const copyId = duplicateEntry('resource', 'r1')
    const project = useProjectStore.getState().project
    expect(copyId).toBe('r3')
    // D-39：副本的 order 紧跟源条目，因此顺序是 r1 -> r3(副本) -> r2，且 order 重排为 1..3。
    expect(project.resources.map((r) => r.id)).toEqual(['r1', 'r3', 'r2'])
    expect(project.resources.map((r) => r.order)).toEqual([1, 2, 3])
    // 副本不进入页面（一个条目只能属于一个页面）
    expect(project.pages[0]!.entries.map((e) => e.id)).toEqual(['r1'])
  })

  it('复制页面不复制 entries', () => {
    loadProject((project) => {
      project.pages[0]!.entries.push({ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } })
    })
    const pageId = duplicateEntry('page', 'p1')
    const project = useProjectStore.getState().project
    const copy = project.pages.find((p) => p.id === pageId)
    expect(copy?.entries).toEqual([])
    expect(project.pages[0]!.entries).toHaveLength(1)
  })

  it('排序把 order 重排为 1..N（D-40）', () => {
    loadProject((project) => {
      project.resources.push(createResource({ id: 'r1', order: 3 }))
      project.resources.push(createResource({ id: 'r2', order: 1 }))
      project.resources.push(createResource({ id: 'r3', order: 2 }))
    })
    moveEntry('resource', 'r3', -1)
    // 初始 order：r1=3、r2=1、r3=2 → 归一化后 [r2, r3, r1]；r3 上移一位 → [r3, r2, r1]。
    expect(useProjectStore.getState().project.resources.map((r) => r.id)).toEqual(['r3', 'r2', 'r1'])
    expect(useProjectStore.getState().project.resources.map((r) => r.order)).toEqual([1, 2, 3])
  })

  it('拖拽排序按给定 id 顺序重排', () => {
    loadProject((project) => {
      project.resources.push(createResource({ id: 'r1', order: 1 }))
      project.resources.push(createResource({ id: 'r2', order: 2 }))
    })
    reorderEntries('resource', ['r2', 'r1'])
    expect(useProjectStore.getState().project.resources.map((r) => r.id)).toEqual(['r2', 'r1'])
  })

  it('删除条目同时移除其页面归属；引用方文本保留（D-38）', () => {
    loadProject((project) => {
      project.resources.push(createResource({ id: 'r1', order: 1 }))
      project.generators.push({
        kind: 'generator',
        id: 'g1',
        order: 1,
        name: '矿机',
        description: '',
        icon: { kind: 'builtin', value: 'factory' },
        visible: true,
        initial: '0',
        max: 'Infinity',
        disabled: false,
        isClicker: false,
        buyAmount: '1',
        buyDelay: 1,
        costs: [{ materialId: 'r1', amount: '10' }],
        produces: [{ materialId: 'r1', amount: '1' }],
      })
      project.pages[0]!.entries.push({ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } })
    })
    removeEntry('resource', 'r1')
    const project = useProjectStore.getState().project
    expect(project.resources).toHaveLength(0)
    expect(project.pages[0]!.entries).toHaveLength(0)
    // 引用方保留原文本 -> 悬空引用由保存时的 E_DANGLING_REF 阻断
    expect(project.generators[0]!.costs[0]!.materialId).toBe('r1')
  })

  it('删除分析列出价格/产出/页面归属（D-38 表）', () => {
    loadProject((project) => {
      project.resources.push(createResource({ id: 'r1', order: 1 }))
      project.generators.push({
        kind: 'generator',
        id: 'g1',
        order: 1,
        name: '矿机',
        description: '',
        icon: { kind: 'builtin', value: 'factory' },
        visible: true,
        initial: '0',
        max: 'Infinity',
        disabled: false,
        isClicker: false,
        buyAmount: '1',
        buyDelay: 1,
        costs: [{ materialId: 'r1', amount: '10' }],
        produces: [{ materialId: 'r1', amount: '1' }],
      })
      project.pages[0]!.entries.push({ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } })
    })
    const impact = analyzeDeletion(useProjectStore.getState().project, 'resource', 'r1')
    expect(impact.dangling.map((d) => d.where).sort()).toEqual(['产出资源[0]', '购买价格[0]'])
    expect(impact.page?.name).toBe('主页面')
  })

  it('条目页面唯一性：重复分配被拒并指出原页面（PRD 补充 7）', () => {
    loadProject((project) => {
      project.resources.push(createResource({ id: 'r1', order: 1 }))
      project.pages.push({
        kind: 'page',
        id: 'p2',
        order: 2,
        name: '第二页',
        description: '',
        icon: { kind: 'builtin', value: 'map' },
        visible: true,
        disabled: false,
        theme: { kind: 'builtin', value: 'page-dark' },
        columns: 1,
        entries: [],
      })
      project.pages[0]!.entries.push({ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } })
    })
    const result = assignEntryToPage('p2', 'r1')
    expect(result.ok).toBe(false)
    expect(result.message).toBe('主页面')
    expect(useProjectStore.getState().project.pages[1]!.entries).toHaveLength(0)
  })

  it('页面内排序只改 entries[i].order，不改条目自身 order（7.5）', () => {
    loadProject((project) => {
      project.resources.push(createResource({ id: 'r1', order: 7 }))
      project.pages[0]!.entries.push(
        { id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } },
        { id: 'r2', order: 2, theme: { kind: 'builtin', value: 'entry-dark' } },
      )
    })
    movePageEntry('p1', 'r2', -1)
    const project = useProjectStore.getState().project
    expect(project.pages[0]!.entries.map((e) => e.id)).toEqual(['r2', 'r1'])
    expect(project.pages[0]!.entries.map((e) => e.order)).toEqual([1, 2])
    expect(project.resources[0]!.order).toBe(7)
  })

  it('从页面移除条目不删除条目本身', () => {
    loadProject((project) => {
      project.resources.push(createResource({ id: 'r1', order: 1 }))
      project.pages[0]!.entries.push({ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } })
    })
    removePageEntry('p1', 'r1')
    const project = useProjectStore.getState().project
    expect(project.pages[0]!.entries).toHaveLength(0)
    expect(project.resources).toHaveLength(1)
  })
})

describe('editorStore（7.1/7.2、D-14）', () => {
  it('选择条目会切到对应功能区，但不产生历史记录', () => {
    useEditorStore.getState().select('upgrade', 'u1')
    expect(useEditorStore.getState().activeSection).toBe('upgrades')
    expect(useEditorStore.getState().selection.upgrade).toBe('u1')
    expect(undo()).toBe(false)
  })
})

describe('表单提交入口（stores/form.ts）', () => {
  it('按 kind 定位草稿条目；id 不存在时安全跳过', () => {
    const id = addEntry('resource')
    commitField('resource', id, 'x', (draft) => void (draft.description = '矿石'))
    expect(useProjectStore.getState().project.resources[0]!.description).toBe('矿石')
    expect(() => commitField('resource', 'rNope', 'x', (draft) => void (draft.description = 'y'))).not.toThrow()
    expect(useProjectStore.getState().project.resources[0]!.description).toBe('矿石')
  })

  it('页面字段提交走独立入口', () => {
    commitPageField('p1', 'page-columns', (page) => void (page.columns = 3))
    expect(useProjectStore.getState().project.pages[0]!.columns).toBe(3)
  })
})
