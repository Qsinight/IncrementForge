/**
 * 组件与生命周期测试（TECH_DESIGN 14.1「集成：影子运行时与编辑器 store 同步、撤销重做一致性」、
 * 14.2 的列表/表单/项目生命周期用例）。
 *
 * 覆盖 PRD 的**可观察行为**：
 * - 列表“添加”生成不冲突 id，条目行显示图标+名称（7.5）；
 * - 改名称立即同步左侧列表与预览（各编辑器第 2 条；预览侧 M4 接入）；
 * - 数量上限/初始数量走 `NumExprField` 的双模式与实时校验（7.6、5.8、17.1）；
 * - 升级“效果数值”列**只读**且不写项目文件（7.6、D-47）；
 * - 页面条目分配的唯一性与布局联动（PRD 页面编辑器 7/8、补充 7）；
 * - 保存/导入导出走 IndexedDB 与同一条序列化路径（7.9、10.2）。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, act, render, screen, waitFor, within } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { AssetRepository, MetaRepository, ProjectRepository, deleteForgeDb, exportProjectJson, DB_NAME } from '@iforge/persist'
import { createDefaultProject } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'

import { App } from '../src/App.js'
import { exportProject, importProject, newProject, restoreLastProject, saveProject } from '../src/features/shell/projectIo.js'
import type { ProjectIo } from '../src/features/shell/projectIo.js'
import { commitField } from '../src/stores/form.js'
import { useProjectStore } from '../src/stores/project.js'
import { redo, undo } from '../src/stores/undoRedo.js'
import { addEntry } from '../src/stores/entries.js'

/** 每个用例一份独立的 IndexedDB（10.1 的库名参数化）。 */
let dbSeq = 0
async function makeIo(): Promise<ProjectIo> {
  dbSeq += 1
  await deleteForgeDb(`${DB_NAME}-editor-test-${dbSeq}`)
  const { openForgeDb } = await import('@iforge/persist')
  const db = await openForgeDb(`${DB_NAME}-editor-test-${dbSeq}`)
  const projects = new ProjectRepository(db)
  const assets = new AssetRepository(db)
  const meta = new MetaRepository(db)
  return {
    projects,
    assets,
    meta: {
      set: (key, value) => meta.set(key, value),
      get: <T,>(key: string) => meta.get<T>(key),
      delete: (key) => meta.delete(key),
    },
  }
}

/** 载入含两个资源的项目夹具。 */
function loadTwoResources(): void {
  const project = createDefaultProject() as ProjectFile
  project.resources.push({
    kind: 'resource',
    id: 'r1',
    order: 1,
    name: '矿石',
    description: '基础资源',
    icon: { kind: 'builtin', value: 'gem' },
    visible: true,
    initial: '0',
    max: 'Infinity',
  })
  project.resources.push({
    kind: 'resource',
    id: 'r2',
    order: 2,
    name: '金属',
    description: '',
    icon: { kind: 'builtin', value: 'ingot' },
    visible: true,
    initial: '0',
    max: 'Infinity',
  })
  useProjectStore.setState({ project, dirty: true, revision: 1 })
}

describe('布局与列表交互（PRD 工作页面一览、7.5）', () => {
  it('四分区与功能区顺序：资源/生成器/升级/页面/设置（PRD 左侧功能区）', async () => {
    const io = await makeIo()
    render(<App io={io} />)
    const nav = screen.getByRole('navigation')
    const labels = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim())
    expect(labels).toEqual(['资源0', '生成器0', '升级0', '页面1', '设置'])
    expect(screen.getByRole('banner')).toBeInTheDocument()
    // 未选中条目时中间工作区给出空态提示（7.6）
    expect(screen.getAllByText('暂无条目，点击右上角“添加”创建。').length).toBeGreaterThanOrEqual(1)
  })

  it('“添加”生成不冲突 id 并选中（14.2 列表用例）', async () => {
    const io = await makeIo()
    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('add-resource'))
    const project = useProjectStore.getState().project
    expect(project.resources.map((r) => r.id)).toEqual(['r1'])
    expect(screen.getByTestId('entry-r1')).toHaveAttribute('aria-selected', 'true')
  })

  it('改名称立即同步左侧列表（PRD 各编辑器第 2 条）', async () => {
    const io = await makeIo()
    loadTwoResources()
    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('entry-r1'))
    const nameInput = screen.getByLabelText('名称')
    fireEvent.change(nameInput, { target: { value: '矿石矿' } })
    expect(within(screen.getByTestId('entry-r1')).getByText('矿石矿')).toBeInTheDocument()
    expect(useProjectStore.getState().project.resources[0]!.name).toBe('矿石矿')
  })

  it('撤销“重命名”同步回退列表与表单（14.2 用例）', async () => {
    const io = await makeIo()
    loadTwoResources()
    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('entry-r1'))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新名' } })
    act(() => {
      undo()
    })
    expect(within(screen.getByTestId('entry-r1')).getByText('矿石')).toBeInTheDocument()
  })

  /**
   * 撤销/重做按钮的置灰必须跟着历史栈走（7.1）。
   *
   * 这条曾经被一个“聪明”的订阅写法坑过：标题栏订阅的是 `past.length + future.length`，
   * 而**撤销一步恰好让这个和不变**（past 减 1、future 加 1）——状态对了，按钮却停在旧值，
   * 于是“重做”永远是灰的，作者只能刷新页面才知道自己还能重做。
   */
  it('撤销后“重做”按钮立刻可用，重做后“撤销”立刻可用（7.1 的按钮置灰）', async () => {
    const io = await makeIo()
    loadTwoResources()
    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('entry-r1'))
    expect(screen.getByTestId('titlebar-undo')).toBeDisabled()
    expect(screen.getByTestId('titlebar-redo')).toBeDisabled()

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新名' } })
    expect(screen.getByTestId('titlebar-undo')).toBeEnabled()

    act(() => {
      undo()
    })
    expect(screen.getByTestId('titlebar-undo')).toBeDisabled()
    expect(screen.getByTestId('titlebar-redo')).toBeEnabled()

    act(() => {
      redo()
    })
    expect(screen.getByLabelText('名称')).toHaveValue('新名')
    expect(screen.getByTestId('titlebar-undo')).toBeEnabled()
    expect(screen.getByTestId('titlebar-redo')).toBeDisabled()
  })

  it('列表行的删除走二次确认并列出受影响引用（7.5、D-38）', async () => {
    const io = await makeIo()
    const project = createDefaultProject() as ProjectFile
    project.resources.push({
      kind: 'resource',
      id: 'r1',
      order: 1,
      name: '矿石',
      description: '',
      icon: { kind: 'builtin', value: 'gem' },
      visible: true,
      initial: '0',
      max: 'Infinity',
    })
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
    useProjectStore.setState({ project, dirty: true, revision: 1 })

    render(<App io={io} />)
    fireEvent.click(screen.getByLabelText('删除 矿石'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('矿机 · 购买价格[0]')).toBeInTheDocument()
    expect(useProjectStore.getState().project.resources).toHaveLength(1)
    fireEvent.click(screen.getByTestId('confirm-delete'))
    expect(useProjectStore.getState().project.resources).toHaveLength(0)
    // D-38：引用方保留原文本 -> 悬空引用交给保存时阻断
    expect(useProjectStore.getState().project.generators[0]!.costs[0]!.materialId).toBe('r1')
  })

  it('键盘可达：↑/↓ 选中、Alt+↑ 排序、Ctrl+D 复制（7.5 键盘可达行）', async () => {
    const io = await makeIo()
    loadTwoResources()
    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('entry-r1'))
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(useProjectStore.getState().project.resources.map((r) => r.id)).toEqual(['r1', 'r2'])
    fireEvent.keyDown(list, { key: 'ArrowUp', altKey: true })
    expect(useProjectStore.getState().project.resources.map((r) => r.id)).toEqual(['r2', 'r1'])
    fireEvent.keyDown(list, { key: 'd', ctrlKey: true })
    expect(useProjectStore.getState().project.resources).toHaveLength(3)
  })
})

describe('表达式字段（7.6 NumExprField、5.8、17.1）', () => {
  it('数量上限字段提供数值/表达式双模式（7.6 末条）', async () => {
    const io = await makeIo()
    loadTwoResources()
    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('entry-r1'))
    const modeGroup = screen.getByRole('group', { name: '数量上限' })
    expect(within(modeGroup).getByRole('button', { name: '数值' })).toBeInTheDocument()
    expect(within(modeGroup).getByRole('button', { name: '表达式' })).toBeInTheDocument()
  })

  it('价格表达式使用 rand() → 编译期 E_RAND_DISABLED（PRD 补充 1、17.1）', async () => {
    const io = await makeIo()
    const project = createDefaultProject() as ProjectFile
    project.resources.push({
      kind: 'resource',
      id: 'r1',
      order: 1,
      name: '矿石',
      description: '',
      icon: { kind: 'builtin', value: 'gem' },
      visible: true,
      initial: '0',
      max: 'Infinity',
    })
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
      costs: [{ materialId: 'r1', amount: '10 * rand()' }],
      produces: [],
    })
    useProjectStore.setState({ project, dirty: true, revision: 1 })

    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('nav-generators'))
    fireEvent.click(screen.getByTestId('entry-g1'))
    expect(await screen.findByText(/E_RAND_DISABLED/)).toBeInTheDocument()
  })

  it('写只读属性 → 编译期 E_READONLY_TARGET（14.2 用例）', async () => {
    const io = await makeIo()
    const project = createDefaultProject() as ProjectFile
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
      costs: [],
      produces: [{ materialId: 'r1', amount: 'gen.g1.perSec = 1' }],
    })
    useProjectStore.setState({ project, dirty: true, revision: 1 })
    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('nav-generators'))
    fireEvent.click(screen.getByTestId('entry-g1'))
    expect(await screen.findByText(/E_READONLY_TARGET|E_SIDE_EFFECT_FORBIDDEN/)).toBeInTheDocument()
  })
})

describe('升级工作区（PRD 升级编辑器 12、7.6、D-47）', () => {
  it('“效果数值”列只读：无输入框、有只读徽标与两条快捷插入模板（7.6 强制 UI 元素）', async () => {
    const io = await makeIo()
    const project = createDefaultProject() as ProjectFile
    project.upgrades.push({
      kind: 'upgrade',
      id: 'u1',
      order: 1,
      name: '双倍产量',
      description: '',
      icon: { kind: 'builtin', value: 'star' },
      visible: true,
      initial: '0',
      max: '1',
      disabled: false,
      perSecond: true,
      buyAmount: '1',
      buyDelay: 1,
      costs: [],
      conditions: [],
      effects: [{ condition: 'true', action: 'effValue = 0' }],
    })
    useProjectStore.setState({ project, dirty: true, revision: 1 })

    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('nav-upgrades'))
    fireEvent.click(screen.getByTestId('entry-u1'))

    const effect = screen.getByTestId('effect-0')
    const value = screen.getByTestId('effect-value-0')
    expect(value.tagName).toBe('OUTPUT')
    expect(value).toHaveTextContent('0')
    // 无可聚焦的数值输入元素（D-47：不提供初始值输入框）
    expect(effect.querySelector('input[type="number"]')).toBeNull()
    expect(within(effect).getByText('只读')).toBeInTheDocument()
    expect(within(effect).getByRole('button', { name: /effValue =/ })).toBeInTheDocument()
    expect(within(effect).getByRole('button', { name: /effectValues\[i\]/ })).toBeInTheDocument()
  })

  it('导出项目文件不含 effectValues（7.6/D-47）', async () => {
    const io = await makeIo()
    addEntry('upgrade')
    const json = await exportProject(io)
    expect(json).not.toContain('effectValues')
  })

  /**
   * 缺陷 1：“效果前提 / 效果内容”的显示区域过窄，编辑不便（要求加宽、改为上下排列）。
   *
   * jsdom 没有布局引擎，量不到像素，因此这一层断言**结构**：每条效果的编辑块是一条
   * 单列的纵向流（序号/删除行 -> 效果前提 -> 效果内容 -> 效果数值），两个表达式字段
   * 各自占一格而不是被塞进并排的两列。像素级的“够宽”由 `e2e/upgrade-effect-layout.spec.ts`
   * 在真浏览器里用 bounding box 断言。
   */
  it('每条效果是**单列纵向**的四段：序号行 → 效果前提 → 效果内容 → 效果数值', async () => {
    const io = await makeIo()
    const project = createDefaultProject() as ProjectFile
    project.upgrades.push({
      kind: 'upgrade',
      id: 'u1',
      order: 1,
      name: '维度提升',
      description: '',
      icon: { kind: 'builtin', value: 'star' },
      visible: true,
      initial: '0',
      max: '1',
      disabled: false,
      perSecond: false,
      buyAmount: '1',
      buyDelay: 1,
      costs: [],
      conditions: [],
      effects: [{ condition: 'true', action: 'effValue = 0' }],
    })
    useProjectStore.setState({ project, dirty: true, revision: 1 })

    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('nav-upgrades'))
    fireEvent.click(screen.getByTestId('entry-u1'))

    const effect = screen.getByTestId('effect-0')
    // 直接子节点恰为四段，且顺序是“序号行 → 前提 → 内容 → 数值”。
    const classes = [...effect.children].map((child) => child.className)
    expect(classes).toEqual(['effect-editor-head', 'numexpr', 'numexpr', 'effect-value'])
    // 序号与删除按钮在第一段里（原先删除按钮是并排四列中的第四格）。
    expect(within(effect.children[0] as HTMLElement).getByRole('button', { name: /移除|删除/ })).toBeInTheDocument()
    // 两个表达式字段各自是一段，且按 PRD 升级编辑器 12 的措辞给出标签。
    const segments = [...effect.children] as HTMLElement[]
    const condition = segments[1]!
    const action = segments[2]!
    expect(condition.className).toBe('numexpr')
    expect(condition.querySelector('textarea')).not.toBeNull()
    expect(condition.textContent).toContain('效果前提')
    expect(action.className).toBe('numexpr')
    expect(action.querySelector('textarea')).not.toBeNull()
    expect(action.textContent).toContain('效果内容')
    // textarea 仍在（表达式仍可编辑），只是不再被挤成两小格。
    expect(effect.querySelectorAll('textarea').length).toBeGreaterThanOrEqual(2)
  })

  it('`.effect-editor` 的 CSS 是**单列**（`minmax(0, 1fr)`），不再是并排四列', () => {
    // 布局规则本身也要有门禁：结构断言管不住 CSS 里的 `grid-template-columns`。
    // 路径用 `process.cwd()` 逐级向上找，而不是 `new URL(...)`：`test/setup.ts` 把全局
    // `URL` 换成了普通对象（给 `createObjectURL` 兜底），`new URL` 在这里已不可用。
    // vitest 的 `projects` 由仓库根配置展开，`cwd` 可能已经是根，因此两种相对形态都试。
    const relative = ['src/styles/editor.css', 'apps/editor/src/styles/editor.css']
    let dir = process.cwd()
    let css = ''
    for (let depth = 0; depth < 6 && css.length === 0; depth += 1) {
      for (const suffix of relative) {
        const candidate = join(dir, ...suffix.split('/'))
        if (existsSync(candidate)) {
          css = readFileSync(candidate, 'utf8')
          break
        }
      }
      dir = dirname(dir)
    }
    expect(css, '找不到 editor.css').not.toBe('')
    const rule = /\.effect-editor\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(rule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    // 四列并排（`1fr 1fr auto auto`）曾把两个表达式字段各压到一百多像素。
    expect(rule).not.toMatch(/1fr\s+1fr\s+auto\s+auto/)
  })
})

describe('页面工作区（PRD 页面编辑器 7/8、补充 7、D-41）', () => {
  it('分配条目到页面；重复分配被拒并提示原页面（PRD 补充 7）', async () => {
    const io = await makeIo()
    const project = createDefaultProject() as ProjectFile
    project.resources.push({
      kind: 'resource',
      id: 'r1',
      order: 1,
      name: '矿石',
      description: '',
      icon: { kind: 'builtin', value: 'gem' },
      visible: true,
      initial: '0',
      max: 'Infinity',
    })
    project.pages[0]!.entries.push({ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } })
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
    useProjectStore.setState({ project, dirty: true, revision: 1 })

    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined)
    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('nav-pages'))
    fireEvent.click(screen.getByTestId('entry-p2'))
    fireEvent.click(screen.getByTestId('assign-r1'))
    expect(alertSpy).toHaveBeenCalled()
    expect(useProjectStore.getState().project.pages[1]!.entries).toHaveLength(0)

    fireEvent.click(screen.getByTestId('entry-p1'))
    expect(screen.getByText('矿石')).toBeInTheDocument()
  })

  it('改列数即预览网格列数变化（PRD 页面编辑器 7）', async () => {
    const io = await makeIo()
    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('nav-pages'))
    fireEvent.click(screen.getByTestId('entry-p1'))
    fireEvent.change(screen.getByLabelText('页面布局（列数）'), { target: { value: '3' } })
    expect(useProjectStore.getState().project.pages[0]!.columns).toBe(3)
  })
})

describe('项目生命周期（7.9、10.2）', () => {
  it('保存写入 IndexedDB 并更新 modifiedAt/engineVersion（PRD 设置页 5）', async () => {
    const io = await makeIo()
    addEntry('resource')
    const result = await saveProject(io)
    expect(result.ok).toBe(true)
    const stored = await io.projects.get(useProjectStore.getState().projectId)
    expect(stored?.resources).toHaveLength(1)
    expect(stored?.meta.modifiedAt).not.toBe('')
    expect(useProjectStore.getState().dirty).toBe(false)
  })

  it('保存被校验阻断时列出问题位置（6.4、10.2）', async () => {
    const io = await makeIo()
    const project = createDefaultProject() as ProjectFile
    project.generators.push({
      kind: 'generator',
      id: 'g1',
      order: 1,
      name: '坏生成器',
      description: '',
      icon: { kind: 'builtin', value: 'factory' },
      visible: true,
      initial: '0',
      max: 'Infinity',
      disabled: false,
      isClicker: false,
      buyAmount: '1',
      buyDelay: 1,
      costs: [{ materialId: 'rNope', amount: '10' }],
      produces: [],
    })
    useProjectStore.setState({ project, dirty: true, revision: 1 })
    const result = await saveProject(io)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.code).toBe('E_DANGLING_REF')
    expect(result.issues[0]?.where).toBe('generators[0].costs[0].materialId')
  })

  it('导出 -> 导入（覆盖当前项目）往返一致（10.2、D-33）', async () => {
    const io = await makeIo()
    loadTwoResources()
    // 导出走与打包同一条序列化路径（10.1 末条、11.1）。
    const json = await exportProjectJson(useProjectStore.getState().project, io.assets)
    expect(json).toContain('"矿石"')

    // 未确认覆盖时只校验不落库（10.2 的“覆盖 / 取消”两步）。
    const dry = await importProject(io, json, false)
    expect(dry.validated?.resources).toHaveLength(2)
    expect(useProjectStore.getState().project.resources).toHaveLength(2)

    const done = await importProject(io, json, true)
    expect(done.ok).toBe(true)
    expect(useProjectStore.getState().project.resources.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('新建会清空历史栈并写入默认模板（7.9）', async () => {
    const io = await makeIo()
    loadTwoResources()
    addEntry('resource')
    newProject(io)
    const state = useProjectStore.getState()
    expect(state.project.resources).toHaveLength(0)
    expect(state.project.pages[0]?.name).toBe('主页面')
    expect(undo()).toBe(false)
  })

  it('未保存改动时新建先弹确认（7.9）', async () => {
    const io = await makeIo()
    loadTwoResources()
    render(<App io={io} />)
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(useProjectStore.getState().project.resources).toHaveLength(2)
  })
})

describe('持久化往返（10.1 的 meta 指针、10.2 的新建落盘）', () => {
  it('保存后重新载入同一个项目（刷新不丢进度）', async () => {
    const io = await makeIo()
    addEntry('resource')
    commitField('resource', useProjectStore.getState().project.resources[0]!.id, 'res-name', (draft) => void (draft.name = '矿石矿'))
    expect((await saveProject(io)).ok).toBe(true)

    // 模拟刷新：清空内存状态后按 7.9 的“载入上次项目”恢复。
    useProjectStore.setState({ project: createDefaultProject(), projectId: 'other', dirty: false, revision: 0, savedAt: null })
    await restoreLastProject(io)

    const project = useProjectStore.getState().project
    expect(project.resources.map((r) => r.name)).toEqual(['矿石矿'])
    expect(project.pages).toHaveLength(1)
  })

  it('库里没有项目时新建默认模板并落盘（10.2 表「新建项目」行）', async () => {
    const io = await makeIo()
    await restoreLastProject(io)
    const records = await io.projects.list()
    expect(records).toHaveLength(1)
    expect(records[0]?.project.pages[0]?.name).toBe('主页面')
    // 落盘的项目 id 与内存一致，且指针已写入 meta。
    expect(records[0]?.projectId).toBe(useProjectStore.getState().projectId)
    expect(await io.meta.get<string>('editor.currentProjectId')).toBe(useProjectStore.getState().projectId)
  })

  it('指针缺失时回落到最近修改的项目，而不是新建空模板', async () => {
    const io = await makeIo()
    addEntry('resource')
    await saveProject(io)
    await io.meta.delete('editor.currentProjectId')
    useProjectStore.setState({ project: createDefaultProject(), projectId: 'other', dirty: false, revision: 0, savedAt: null })

    await restoreLastProject(io)
    expect(useProjectStore.getState().project.resources).toHaveLength(1)
  })
})

describe('设置页面（7.7、PRD 设置页 5/6、D-22）', () => {
  it('四项只读字段不可编辑（PRD 设置页 5）', async () => {
    const io = await makeIo()
    const { container } = render(<App io={io} />)
    fireEvent.click(screen.getByTestId('nav-settings'))
    const page = screen.getByTestId('settings-page')
    // 只读字段用 <output> 渲染，不存在可输入控件（PRD 设置页 5「不可手动输入」）
    const outputs = page.querySelectorAll('output')
    expect(outputs.length).toBeGreaterThanOrEqual(4)
    expect(page.querySelector('input[type="text"][value*="1.0.0"]')).toBeNull()
    void container
  })

  it('游戏默认设置 6 项写入项目文件并带来源徽标（7.7、8.10）', async () => {
    const io = await makeIo()
    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('nav-settings'))
    fireEvent.change(screen.getByLabelText('逻辑帧率'), { target: { value: '30' } })
    expect(useProjectStore.getState().project.settings.tickRate).toBe(30)
    const badges = screen.getAllByText('项目默认')
    expect(badges.length).toBeGreaterThanOrEqual(6)
  })

  it('改项目名称立即同步顶部标题栏（PRD 设置页 2、7.7）', async () => {
    const io = await makeIo()
    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('nav-settings'))
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '示例：矿石工厂' } })
    expect(screen.getByText('示例：矿石工厂')).toBeInTheDocument()
  })

  it('“恢复默认设置”把 settings 复位到 DEFAULT_SETTINGS（7.7）', async () => {
    const io = await makeIo()
    render(<App io={io} />)
    fireEvent.click(screen.getByTestId('nav-settings'))
    fireEvent.change(screen.getByLabelText('逻辑帧率'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '恢复默认设置' }))
    expect(useProjectStore.getState().project.settings.tickRate).toBe(20)
  })
})

describe('预览区（7.1、D-42）', () => {
  it('模拟设置栏存在且不进入项目数据（7.1、D-14）', async () => {
    const io = await makeIo()
    render(<App io={io} />)
    const pane = document.querySelector('[data-preview-pane]')
    expect(pane).not.toBeNull()
    expect(within(pane as HTMLElement).getByRole('group', { name: '设备' })).toBeInTheDocument()
    expect(within(pane as HTMLElement).getByLabelText('时间倍速')).toBeInTheDocument()
    expect(within(pane as HTMLElement).getByRole('button', { name: '解锁全部' })).toBeInTheDocument()
    // 模拟设置栏是编辑器外壳状态：不进项目文件、不产生历史
    expect(undo()).toBe(false)
    await waitFor(() => expect(useProjectStore.getState().dirty).toBe(false))
  })

  it('设备档位切换只改容器宽度，不改页面 columns（D-41）', async () => {
    const io = await makeIo()
    render(<App io={io} />)
    const pane = document.querySelector('[data-preview-pane]') as HTMLElement
    fireEvent.click(within(pane).getByRole('button', { name: '手机' }))
    expect(within(pane).getByRole('button', { name: '手机' })).toHaveAttribute('aria-pressed', 'true')
    expect(useProjectStore.getState().project.pages[0]!.columns).toBe(1)
  })
})
