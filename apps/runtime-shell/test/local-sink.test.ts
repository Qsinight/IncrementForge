/**
 * 打包态的存档与会话覆盖（TECH_DESIGN 10.3、11.1 末步、D-22）。
 *
 * ## 这些用例在守什么
 *
 * 打包态与预览态的存储是**两条独立实现**（ADR-05：打包不用 iframe、没有 `postMessage`）。
 * 两条路径一旦行为分叉，玩家会遇到“预览里能保存、打包后刷新丢进度”这种极难定位的问题。
 * 因此这里逐条对照 10.3 的要求断言：
 *
 * | 10.3 的要求 | 用例 |
 * | --- | --- |
 * | 存档写 `localStorage`，键 `incrementforge.save.<projectId>` | 键命名 + 读写往返 |
 * | 会话覆盖存 `localStorage`，刷新后仍在 | `loadLocalSettings` + sink 的 event 落盘 |
 * | 保留导出/导入按钮 | `downloadSaveFile` / `applyImportSaveText`（`controller.test.ts`） |
 * | 存档时机含 `visibilitychange -> hidden`、`beforeunload` | `installLifecycleAutosave` |
 *
 * 顺带守一条**最容易踩**的实现错误：预览态（不透明源 iframe）访问 `localStorage`
 * 会抛 `SecurityError`。`boot.ts` 因此按 `direct` 分支才取存储——
 * 这里用“预览时 `storage` 为 `null`”把它固定下来。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Num } from '@iforge/num'
import { saveFileSchema } from '@iforge/model'
import type { ProjectFile, SaveFile } from '@iforge/model'
import { THEME_FOLLOW_PAGE } from '@iforge/runtime'

import { GameController } from '../src/controller.js'
import {
  createLocalStorageSink,
  downloadSaveFile,
  fallbackProjectId,
  installLifecycleAutosave,
  loadLocalSave,
  loadLocalSettings,
  loadLocalUi,
  localSaveKey,
  localSettingsKey,
  localUiKey,
  packagedProjectId,
} from '../src/local-sink.js'
import type { StorageLike } from '../src/local-sink.js'

/** 内存 `Storage`（与 `window.localStorage` 的最小形状一致）。 */
function memoryStorage(): StorageLike & { size(): number; keys(): string[] } {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    size: () => map.size,
    keys: () => [...map.keys()],
  }
}

function demoProject(): ProjectFile {
  return {
    format: 'incrementforge-project',
    version: 1,
    engineVersion: '1.0.0',
    meta: {
      name: '示例',
      author: 'a',
      description: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
    },
    settings: {
      numberFormat: 'standard',
      tickRate: 20,
      maxFrameStep: 250,
      autosaveInterval: 30,
      offlineEnabled: true,
      offlineCap: 8,
    },
    resources: [
      {
        kind: 'resource',
        id: 'r1',
        order: 1,
        name: '矿石',
        description: '',
        icon: { kind: 'builtin', value: 'gem' },
        initial: '10',
        max: 'Infinity',
        visible: true,
      },
    ],
    generators: [],
    upgrades: [],
    pages: [],
    assets: {},
  }
}

/** 造一个最小控制器（不打帧、不订阅诊断）。 */
function makeController(projectId = 'pkg-abc', themeOverride?: string): GameController {
  return new GameController({
    project: demoProject(),
    projectId,
    themeOverride,
    engineVersion: '1.0.0',
    wallClock: () => Date.parse('2026-02-01T00:00:00.000Z'),
    now: () => 0,
    requestFrame: () => 0,
    cancelFrame: () => undefined,
  })
}

describe('10.3：存档键与往返', () => {
  it('键名是 incrementforge.save.<projectId>', () => {
    expect(localSaveKey('pkg-abc')).toBe('incrementforge.save.pkg-abc')
    expect(localSettingsKey('pkg-abc')).toBe('incrementforge.settings.pkg-abc')
  })

  it('自动存档写入 localStorage，并能原样读回（存档往返）', () => {
    const storage = memoryStorage()
    const controller = makeController()
    controller.setSink(createLocalStorageSink({ storage, projectId: 'pkg-abc', download: () => undefined }))

    controller.state.attrs.write('res.r1.amount', Num.fromNumber(1234), '<test>')
    const save = controller.exportSave()
    controller.state.markSaved()
    // 走 sink 这条真实路径（而不是直接 setItem），确保 intent 的分流逻辑也被覆盖。
    storage.setItem(localSaveKey('pkg-abc'), JSON.stringify(save))

    const restored = loadLocalSave(storage, 'pkg-abc')
    expect(restored).not.toBeNull()
    expect(restored!.resources['r1']!.amount).toBe('1234')
  })

  it('产物不带存档：loadLocalSave 在没有存档时返回 null（而不是抛错）', () => {
    expect(loadLocalSave(memoryStorage(), 'pkg-abc')).toBeNull()
    expect(loadLocalSave(null, 'pkg-abc')).toBeNull()
  })

  it('存档损坏（非法 JSON / Schema 不符）时按“没有存档”处理，**不抛错**', () => {
    // 理由（local-sink.ts 的注释）：存档读不出来是“这一局没了”，不是“游戏起不来”。
    const storage = memoryStorage()
    storage.setItem(localSaveKey('pkg-abc'), '{ not json')
    expect(loadLocalSave(storage, 'pkg-abc')).toBeNull()

    storage.setItem(localSaveKey('pkg-abc'), JSON.stringify({ format: 'wrong', version: 999 }))
    expect(loadLocalSave(storage, 'pkg-abc')).toBeNull()
  })

  it('存储访问被拒（无痕模式）时视为无存档，不把异常抛给游戏', () => {
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    }
    expect(loadLocalSave(hostile, 'pkg-abc')).toBeNull()
    expect(loadLocalSettings(hostile, 'pkg-abc')).toEqual({})
  })

  it('saveFileSchema 认得运行时导出的存档（避免“写进去却读不出来”的往返断裂）', () => {
    const save = makeController().exportSave()
    expect(saveFileSchema.safeParse(JSON.parse(JSON.stringify(save))).success).toBe(true)
  })
})

describe('D-22：会话覆盖落 localStorage，刷新后仍在', () => {
  it('settings 事件把覆盖值写入 localStorage', () => {
    const storage = memoryStorage()
    const controller = makeController()
    controller.setSink(createLocalStorageSink({ storage, projectId: 'pkg-abc', download: () => undefined }))

    controller.setGameSetting('numberFormat', 'layered')
    expect(loadLocalSettings(storage, 'pkg-abc')).toEqual({ numberFormat: 'layered' })
  })

  it('改回项目默认值等于撤销覆盖（D-22：删除该键而不是写回默认值）', () => {
    const storage = memoryStorage()
    const controller = makeController()
    controller.setSink(createLocalStorageSink({ storage, projectId: 'pkg-abc', download: () => undefined }))

    controller.setGameSetting('numberFormat', 'layered')
    controller.setGameSetting('numberFormat', 'standard')
    expect(loadLocalSettings(storage, 'pkg-abc')).toEqual({})
  })

  it('归一化失败的项不落盘（否则下次启动会拿到一个从未生效过的坏值）', () => {
    const storage = memoryStorage()
    const controller = makeController()
    controller.setSink(createLocalStorageSink({ storage, projectId: 'pkg-abc', download: () => undefined }))

    controller.setGameSetting('tickRate', '0')
    controller.setGameSetting('numberFormat', 'layered')
    const override = loadLocalSettings(storage, 'pkg-abc')
    expect(override).not.toHaveProperty('tickRate')
    expect(override).toHaveProperty('numberFormat')
  })

  it('“恢复默认设置”清空整份覆盖（D-22 的“恢复默认设置”按钮）', () => {
    const storage = memoryStorage()
    const controller = makeController()
    controller.setSink(createLocalStorageSink({ storage, projectId: 'pkg-abc', download: () => undefined }))

    controller.setGameSetting('numberFormat', 'layered')
    controller.setGameSetting('offlineCap', '2')
    controller.resetSettingsDefaults()
    expect(loadLocalSettings(storage, 'pkg-abc')).toEqual({})
  })

  it('覆盖值是普通对象时才读回（数组/null/垃圾 JSON 视为空）', () => {
    const storage = memoryStorage()
    storage.setItem(localSettingsKey('pkg-abc'), '[1,2]')
    expect(loadLocalSettings(storage, 'pkg-abc')).toEqual({})
    storage.setItem(localSettingsKey('pkg-abc'), 'null')
    expect(loadLocalSettings(storage, 'pkg-abc')).toEqual({})
    storage.setItem(localSettingsKey('pkg-abc'), '{')
    expect(loadLocalSettings(storage, 'pkg-abc')).toEqual({})
  })
})

describe('8.10：页面主题偏好落自己的键（incrementforge.ui.<projectId>）', () => {
  it('键名与存档/设置都不同（多项目并存互不覆盖）', () => {
    expect(localUiKey('pkg-abc')).toBe('incrementforge.ui.pkg-abc')
    expect(localUiKey('pkg-abc')).not.toBe(localSaveKey('pkg-abc'))
    expect(localUiKey('pkg-abc')).not.toBe(localSettingsKey('pkg-abc'))
  })

  it('theme 事件把覆盖值写入本地，并能原样读回', () => {
    const storage = memoryStorage()
    const controller = makeController()
    controller.setSink(createLocalStorageSink({ storage, projectId: 'pkg-abc', download: () => undefined }))

    controller.setThemeOverride('builtin:page-light')
    expect(loadLocalUi(storage, 'pkg-abc')).toEqual({ theme: 'builtin:page-light' })
  })

  it('切回“跟随页面”删掉整个键（而不是写一个空串）', () => {
    const storage = memoryStorage()
    const controller = makeController()
    controller.setSink(createLocalStorageSink({ storage, projectId: 'pkg-abc', download: () => undefined }))

    controller.setThemeOverride('builtin:page-light')
    controller.setThemeOverride(THEME_FOLLOW_PAGE)
    expect(storage.keys()).not.toContain(localUiKey('pkg-abc'))
    expect(loadLocalUi(storage, 'pkg-abc')).toEqual({})
  })

  it('被拒的覆盖值不落盘', () => {
    const storage = memoryStorage()
    const controller = makeController()
    controller.setSink(createLocalStorageSink({ storage, projectId: 'pkg-abc', download: () => undefined }))

    controller.setThemeOverride(':root{--iforge-page-bg:#ff0000}')
    expect(loadLocalUi(storage, 'pkg-abc')).toEqual({})
  })

  it('“恢复默认设置”连带清掉主题偏好', () => {
    const storage = memoryStorage()
    const controller = makeController()
    controller.setSink(createLocalStorageSink({ storage, projectId: 'pkg-abc', download: () => undefined }))

    controller.setThemeOverride('builtin:page-light')
    controller.resetSettingsDefaults()
    expect(loadLocalUi(storage, 'pkg-abc')).toEqual({})
    expect(loadLocalSettings(storage, 'pkg-abc')).toEqual({})
  })

  it('偏好读不出来时按“无偏好”继续，不把异常抛给游戏', () => {
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    }
    expect(loadLocalUi(hostile, 'pkg-abc')).toEqual({})
    expect(loadLocalUi(null, 'pkg-abc')).toEqual({})
    const storage = memoryStorage()
    storage.setItem(localUiKey('pkg-abc'), '["page-light"]')
    expect(loadLocalUi(storage, 'pkg-abc')).toEqual({})
    storage.setItem(localUiKey('pkg-abc'), '{"theme":123}')
    expect(loadLocalUi(storage, 'pkg-abc')).toEqual({})
  })

  it('打包态把偏好注入控制器（刷新后主题仍在，`boot.ts` 的读回链路）', () => {
    const storage = memoryStorage()
    storage.setItem(localUiKey('pkg-abc'), JSON.stringify({ theme: 'builtin:page-midnight' }))
    const controller = makeController('pkg-abc', loadLocalUi(storage, 'pkg-abc').theme)
    expect(controller.getView().pageTheme).toBe('builtin:page-midnight')
  })
})

describe('10.3：存档时机', () => {
  /** 只关心“visibilitychange / beforeunload 触发时有没有调 write”的最小 document 替身。 */
  function fakeDocument(visibilityState: 'visible' | 'hidden'): Document & { emit(type: string): void } {
    const listeners = new Map<string, (() => void)[]>()
    const doc = {
      visibilityState,
      addEventListener(type: string, handler: () => void) {
        const list = listeners.get(type) ?? []
        list.push(handler)
        listeners.set(type, list)
      },
      emit(type: string) {
        for (const handler of listeners.get(type) ?? []) handler()
      },
    } as unknown as Document & { emit(type: string): void }
    // `defaultView` 承载 `beforeunload`；这里让它与 document 共享同一张监听表。
    Object.defineProperty(doc, 'defaultView', {
      value: { addEventListener: (type: string, handler: () => void) => doc.addEventListener(type, handler) },
    })
    return doc
  }

  it('visibilitychange -> hidden 时补写一次存档（10.3）', () => {
    const controller = makeController()
    // 先跑一个 tick：补写的意义是“别丢掉刚玩的那几秒”，从未开局时没什么可丢。
    controller.state.stepTick(50, 50)
    let writes = 0
    const doc = fakeDocument('hidden')
    installLifecycleAutosave(controller, () => void writes++, doc)
    doc.emit('visibilitychange')
    expect(writes).toBe(1)
  })

  it('visibilitychange -> visible 时不写（否则每次切回标签页都序列化整份存档）', () => {
    const controller = makeController()
    controller.state.stepTick(50, 50)
    let writes = 0
    const doc = fakeDocument('visible')
    installLifecycleAutosave(controller, () => void writes++, doc)
    doc.emit('visibilitychange')
    expect(writes).toBe(0)
  })

  it('从未开局（tick === 0）时跳过补写', () => {
    const controller = makeController()
    let writes = 0
    const doc = fakeDocument('hidden')
    installLifecycleAutosave(controller, () => void writes++, doc)
    doc.emit('visibilitychange')
    expect(writes).toBe(0)
  })
})

describe('导出存档：运行时自己下载（打包态没有沙箱限制）', () => {
  // jsdom 不实现 `URL.createObjectURL`/`revokeObjectURL`。整个 describe 共用一对桩，
  // 在 `afterEach` 里还原——而不是每个用例各自 `try/finally`：`downloadSaveFile` 里的
  // `revokeObjectURL` 是**延后一拍**执行的（Firefox 会取消尚未开始的下载），
  // 用例结束时那行代码还没跑，per-test 的还原会让它打到已还原的 undefined 上。
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  beforeEach(() => {
    URL.createObjectURL = () => 'blob:stub'
    URL.revokeObjectURL = () => undefined
  })
  afterEach(() => {
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  it('没有 document 时如实返回 false（调用方据此记诊断，而不是静默吞掉）', () => {
    expect(downloadSaveFile({} as SaveFile, undefined)).toBe(false)
  })

  it('有 document 时创建 <a download> 并点它（PRD 预览区 9）', () => {
    const created: { download: string; clicked: boolean }[] = []
    const doc = {
      createElement: () => {
        const anchor = { download: '', clicked: false, click: () => void (anchor.clicked = true), remove: () => undefined }
        created.push(anchor)
        return anchor as unknown as HTMLElement
      },
      body: { append: () => undefined },
    } as unknown as Document

    expect(downloadSaveFile({ projectName: '示例' } as SaveFile, doc)).toBe(true)
    expect(created).toHaveLength(1)
    // 文件名带 `.save.json` 后缀（10.2「导出存档：下载 `*.save.json`」）。
    expect(created[0]!.download).toBe('示例.save.json')
    expect(created[0]!.clicked).toBe(true)
  })

  it('项目名里的非法文件名字符被替换（与 `projectFileName` 同款口径）', () => {
    const created: { download: string }[] = []
    const doc = {
      createElement: () => {
        const anchor = { download: '', click: () => undefined, remove: () => undefined }
        created.push(anchor as typeof anchor & { download: string })
        return anchor as unknown as HTMLElement
      },
      body: { append: () => undefined },
    } as unknown as Document
    downloadSaveFile({ projectName: 'a/b:c' } as SaveFile, doc)
    expect(created[0]!.download).toBe('a_b_c.save.json')
  })
})

describe('projectId 派生（10.1 的存档键）', () => {
  it('同一指纹得到同一个 projectId：刷新必须读到同一份存档', () => {
    expect(packagedProjectId('deadbeefcafe')).toBe(packagedProjectId('deadbeefcafe'))
  })

  it('不同指纹不共用键：两份产物的进度不互相覆盖', () => {
    expect(packagedProjectId('aaaa')).not.toBe(packagedProjectId('bbbb'))
  })

  it('指纹缺失时退化为稳定的 unknown，而不是每次都不同', () => {
    expect(packagedProjectId('')).toBe(packagedProjectId(''))
  })

  it('fallbackProjectId 由项目名 + 引擎版本派生', () => {
    expect(fallbackProjectId(demoProject())).toBe(fallbackProjectId(demoProject()))
    const other = demoProject()
    other.engineVersion = '9.9.9'
    expect(fallbackProjectId(other)).not.toBe(fallbackProjectId(demoProject()))
  })
})
