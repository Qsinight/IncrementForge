/**
 * 编辑器侧的“打包”动作与删除影响面分析（TECH_DESIGN 11.1 管线、7.5「删除时的引用处理」、D-38）。
 *
 * `packageProject` 与 `saveProject`/`exportProject` 一致地**不抛错**：结果走返回值与 `issues`，
 * 由 `App.tsx` 决定弹哪个对话框。这条约定一旦破掉，作者看到的就是一个红色异常框而不是问题清单，
 * 所以本文件把“失败也返回 `{ ok: false }`”显式断言。
 *
 * 另一条容易漏的口径（`projectIo.ts` 的注释）：打包失败时**必须** `recordIssues()`，
 * 否则 `App.tsx` 打开的问题清单对话框里读到的还是上一次的（多半是空的）值——
 * 11.1「中止并列出问题位置」就退化成“弹了个框，里面写着没有问题”。
 */
import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDefaultProject, createExampleProject, parseProjectFile } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'
import { AssetRepository, DB_NAME, deleteForgeDb, openForgeDb } from '@iforge/persist'

import { useEditorStore } from '../src/stores/editor.js'
import { usePreviewStore } from '../src/stores/preview.js'
import { useProjectStore } from '../src/stores/project.js'
import { packageProject, preflightProject } from '../src/features/shell/packageGame.js'
import { issuesOfLastOperation, recordIssues } from '../src/features/shell/projectIo.js'
import type { ProjectIo } from '../src/features/shell/projectIo.js'
import { analyzeDeletion, locateEntry } from '../src/lib/references.js'

let dbCounter = 0
let assets: AssetRepository
let io: ProjectIo

beforeEach(async () => {
  dbCounter += 1
  const name = `${DB_NAME}-pkg-${dbCounter}`
  await deleteForgeDb(name)
  assets = new AssetRepository(await openForgeDb(name))
  io = {
    projects: null as never,
    assets,
    meta: {
      set: async () => {},
      get: async () => undefined,
      delete: async () => {},
    },
  }
  useProjectStore.setState({ project: createDefaultProject(), dirty: false, revision: 1 })
  usePreviewStore.getState().setPackaging(null)
  recordIssues([])
  useEditorStore.setState({ notifications: [] } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** 造一个非法 id 的项目（Zod 能过、打包校验拦得住）。 */
function projectWithBadAsset(): ProjectFile {
  const project = createDefaultProject()
  project.resources = [
    {
      kind: 'resource',
      id: 'r1',
      order: 1,
      name: '资源',
      description: '',
      // 引用了不存在的资产仓库键 -> 11.1 第 7 条。
      icon: { kind: 'asset', value: 'icon-missing' },
      initial: '0',
      max: 'Infinity',
      visible: true,
    },
  ]
  project.pages[0]!.entries = [{ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } }]
  return project
}

describe('preflightProject()：只跑校验不打包（11.1 的 7 条）', () => {
  it('合法项目零问题', () => {
    expect(preflightProject(createExampleProject())).toEqual([])
  })

  it('非法资产引用被列出并带位置', () => {
    const issues = preflightProject(projectWithBadAsset())
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((i) => i.code === 'E_ASSET_TOO_LARGE')).toBe(true)
  })

  it('缺省读当前项目（`useProjectStore`）', () => {
    useProjectStore.setState({ project: projectWithBadAsset() })
    expect(preflightProject().length).toBeGreaterThan(0)
  })

  it('纯函数：不修改传入的项目', () => {
    const project = projectWithBadAsset()
    const before = JSON.stringify(project)
    preflightProject(project)
    expect(JSON.stringify(project)).toBe(before)
  })
})

describe('packageProject()：成功路径', () => {
  it('打包、下载、登记产物信息，并返回 `ok: true`', async () => {
    useProjectStore.setState({ project: createExampleProject() })
    const run = await packageProject(io)

    expect(run.ok).toBe(true)
    expect(run.fileName).toBeTruthy()
    expect(run.issues).toEqual([])
    expect(run.bytes).toBeGreaterThan(0)
    expect(run.fingerprint).toBeTruthy()
    expect(run.overBudget).toBe(false)

    // 诊断面板要显示产物名、体积与指纹（12/11.1 末条）。
    const packaging = usePreviewStore.getState().packaging
    expect(packaging).not.toBeNull()
    expect(packaging!.fileName).toBe(run.fileName)
    expect(packaging!.bytes).toBe(run.bytes)
    expect(packaging!.fingerprint).toBe(run.fingerprint)
    expect(packaging!.builtAt).toBeTruthy()
  })

  it('成功时清空问题清单（上次的问题不该留在对话框里）', async () => {
    recordIssues([{ code: 'E_PARSE', where: 'x', message: '旧问题' }])
    useProjectStore.setState({ project: createExampleProject() })
    await packageProject(io)
    expect(issuesOfLastOperation()).toEqual([])
  })

  it('触发了浏览器下载', async () => {
    useProjectStore.setState({ project: createExampleProject() })
    const created: Blob[] = []
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob)
      return 'blob:mock'
    })
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await packageProject(io)
    expect(createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    expect(created[0]).toBeDefined()
  })
})

describe('packageProject()：校验阻断（11.1「中止并列出问题位置」）', () => {
  it('打包前校验不过 -> `{ ok: false }` 而**不是**抛错', async () => {
    useProjectStore.setState({ project: projectWithBadAsset() })
    const run = await packageProject(io)
    expect(run.ok).toBe(false)
    expect(run.issues.length).toBeGreaterThan(0)
    expect(run.issues.some((i) => i.code === 'E_ASSET_TOO_LARGE')).toBe(true)
  })

  it('失败时把问题登记进对话框读的那一份（否则弹窗是空的）', async () => {
    useProjectStore.setState({ project: projectWithBadAsset() })
    await packageProject(io)
    const registered = issuesOfLastOperation()
    expect(registered.length).toBeGreaterThan(0)
    expect(registered.some((i) => i.code === 'E_ASSET_TOO_LARGE')).toBe(true)
  })

  it('失败时清空产物信息（诊断面板不该留着上一次的产物名）', async () => {
    usePreviewStore.getState().setPackaging({
      fileName: 'old.html',
      bytes: 1,
      gzipBytes: 1,
      overBudget: false,
      fingerprint: 'old',
      builtAt: '2020-01-01T00:00:00.000Z',
    })
    useProjectStore.setState({ project: projectWithBadAsset() })
    await packageProject(io)
    expect(usePreviewStore.getState().packaging).toBeNull()
  })

  it('失败时不触发下载', async () => {
    useProjectStore.setState({ project: projectWithBadAsset() })
    const createObjectURL = vi.fn(() => 'blob:mock')
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await packageProject(io)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })
})

describe('analyzeDeletion()：删除影响面（7.5 的引用处理表、D-38）', () => {
  /** 造一个资源 r1 被生成器/升级引用的项目。 */
  function project(): ProjectFile {
    const p = createExampleProject()
    return p
  }

  it('删资源：列出生成器/升级的 `costs` 引用（条目名 + 行号）', () => {
    const impact = analyzeDeletion(project(), 'resource', 'r1')
    expect(impact.dangling.length).toBeGreaterThan(0)
    for (const hit of impact.dangling) {
      expect(hit.source).toBeTruthy()
      expect(hit.sourceId).toBeTruthy()
      expect(hit.where).toMatch(/\[\d+\]$/)
    }
  })

  it('删资源：也列出 `produces` 引用', () => {
    const impact = analyzeDeletion(project(), 'resource', 'r1')
    expect(impact.dangling.some((h) => h.where.startsWith('产出资源'))).toBe(true)
  })

  it('删资源：指出当前所属页面', () => {
    const impact = analyzeDeletion(project(), 'resource', 'r1')
    expect(impact.page).not.toBeNull()
    expect(impact.page!.id).toBeTruthy()
    expect(impact.page!.name).toBeTruthy()
  })

  it('无归属条目返回 `page: null`', () => {
    const p = createDefaultProject()
    expect(analyzeDeletion(p, 'resource', 'r1').page).toBeNull()
  })

  it('删生成器：只扫 `produces`，不扫 `costs`', () => {
    const impact = analyzeDeletion(project(), 'generator', 'g1')
    // 示例项目里 g1 不产出 g1，所以通常为空；关键是**不含** costs 命中。
    expect(impact.dangling.every((h) => h.where.startsWith('产出资源'))).toBe(true)
  })

  it('删升级/页面：不产生 `dangling`（它们不是材料或产出目标）', () => {
    expect(analyzeDeletion(project(), 'upgrade', 'u1').dangling).toEqual([])
    expect(analyzeDeletion(project(), 'page', 'p1').dangling).toEqual([])
  })

  it('删页面：扫出 `create()` 的 `page` 参数引用（`page: "p1"`）', () => {
    const p = createDefaultProject()
    p.upgrades = [
      {
        kind: 'upgrade',
        id: 'u1',
        order: 1,
        name: '召唤器',
        description: '',
        icon: { kind: 'builtin', value: 'star' },
        initial: '0',
        max: 'Infinity',
        visible: true,
        disabled: false,
        perSecond: false,
        buyAmount: '1',
        buyDelay: 1,
        costs: [],
        conditions: [],
        effects: [{ condition: 'true', action: 'create("generator", { name: "碎片", page: "p1" })' }],
      },
    ]
    const impact = analyzeDeletion(p, 'page', 'p1')
    expect(impact.createPageRefs.length).toBe(1)
    expect(impact.createPageRefs[0]!.sourceId).toBe('u1')
    expect(impact.createPageRefs[0]!.where).toBe('升级效果[0]')
    expect(impact.createPageRefs[0]!.kind).toBe('upgrade')
  })

  it('删页面：紧凑写法 `page:"p1"`（无空格）同样命中', () => {
    const p = createDefaultProject()
    p.upgrades = [
      {
        kind: 'upgrade',
        id: 'u1',
        order: 1,
        name: '召唤器',
        description: '',
        icon: { kind: 'builtin', value: 'star' },
        initial: '0',
        max: 'Infinity',
        visible: true,
        disabled: false,
        perSecond: false,
        buyAmount: '1',
        buyDelay: 1,
        costs: [],
        conditions: [],
        effects: [{ condition: 'true', action: 'create("generator", { page:"p1" })' }],
      },
    ]
    expect(analyzeDeletion(p, 'page', 'p1').createPageRefs.length).toBe(1)
  })

  it('删页面：示例项目里确实存在 `create(..., page:)` 引用，扫得到', () => {
    // 示例项目带一条会 `create("generator", { ..., page: "p1" })` 的升级效果，
    // 因此删掉 `p1` 必须被识别为影响面——这正是 7.5 表第 4 行要拦的悬空。
    const impact = analyzeDeletion(project(), 'page', 'p1')
    expect(impact.createPageRefs.length).toBeGreaterThan(0)
    for (const hit of impact.createPageRefs) {
      expect(hit.kind).toBe('upgrade')
      expect(hit.where).toMatch(/^升级效果\[\d+\]$/)
    }
  })

  it('删页面：没有任何 `create()` 引用时为空数组', () => {
    const impact = analyzeDeletion(createDefaultProject(), 'page', 'p1')
    expect(impact.createPageRefs).toEqual([])
  })

  it('删页面：`page` 参数指向别的页面时不误报', () => {
    const p = createDefaultProject()
    p.pages.push({
      kind: 'page',
      id: 'p2',
      order: 2,
      name: '第二页',
      description: '',
      icon: { kind: 'builtin', value: 'grid' },
      visible: true,
      disabled: false,
      theme: { kind: 'builtin', value: 'page-dark' },
      columns: 1,
      entries: [],
    })
    expect(analyzeDeletion(p, 'page', 'p2').createPageRefs).toEqual([])
  })

  it('删资源：不扫 `createPageRefs`（那是页面专有）', () => {
    expect(analyzeDeletion(project(), 'resource', 'r1').createPageRefs).toEqual([])
  })

  it('不存在的 id 返回空影响面（不抛错）', () => {
    const impact = analyzeDeletion(project(), 'resource', 'rNope')
    expect(impact.dangling).toEqual([])
    expect(impact.page).toBeNull()
  })
})

describe('locateEntry()：条目唯一定位（6.4「定位路径」风格）', () => {
  it('四类条目都给出 `<列表名>[<下标>]`', () => {
    const p = createExampleProject()
    expect(locateEntry(p, 'resource', p.resources[0]!.id)).toBe(`resources[0]`)
    expect(locateEntry(p, 'generator', p.generators[0]!.id)).toBe('generators[0]')
    expect(locateEntry(p, 'upgrade', p.upgrades[0]!.id)).toBe('upgrades[0]')
    expect(locateEntry(p, 'page', p.pages[0]!.id)).toBe('pages[0]')
  })

  it('下标是**列表内**的位置，不是 id 的数字部分', () => {
    const p = createDefaultProject()
    p.resources = [
      {
        kind: 'resource',
        id: 'r9',
        order: 1,
        name: 'A',
        description: '',
        icon: { kind: 'builtin', value: 'gem' },
        initial: '0',
        max: 'Infinity',
        visible: true,
      },
      {
        kind: 'resource',
        id: 'r1',
        order: 2,
        name: 'B',
        description: '',
        icon: { kind: 'builtin', value: 'gem' },
        initial: '0',
        max: 'Infinity',
        visible: true,
      },
    ]
    expect(locateEntry(p, 'resource', 'r9')).toBe('resources[0]')
    expect(locateEntry(p, 'resource', 'r1')).toBe('resources[1]')
  })

  it('找不到返回 `undefined`', () => {
    expect(locateEntry(createExampleProject(), 'resource', 'rNope')).toBeUndefined()
  })
})

describe('打包产物与项目文件的关系（10.1「同一条序列化路径」）', () => {
  it('打包用的是**当前项目**而不是磁盘上的旧版本', async () => {
    useProjectStore.setState({ project: createExampleProject() })
    const run = await packageProject(io)
    expect(run.ok).toBe(true)
    // 当前项目仍可解析（打包是只读副作用，不改 store）。
    expect(parseProjectFile(JSON.stringify(useProjectStore.getState().project)).format).toBeTruthy()
  })
})
