/**
 * 预览运行时的装配入口（TECH_DESIGN 9.3 生命周期、ADR-05、11.1）。
 *
 * ## 两种启动方式、同一套代码
 *
 * | 方式 | 触发条件 | 传输 | 用途 |
 * | --- | --- | --- | --- |
 * **预览** | `window.parent !== window` 且宿主会发 `host:init` | `postMessage`（9.2） | 编辑器右侧预览（9.1 的不透明源 iframe） |
 * **直挂** | `window.__IFORGE_BOOTSTRAP__` 存在（17.3 的打包模板注入） | 无（直接读写 `localStorage`） | M5 的单文件打包产物（ADR-05：不用 iframe） |
 *
 * 两条路径最终都得到**同一个** `GameController` + **同一棵** `AppView` 组件树，
 * 所以“预览与成品行为不一致”（R-12）没有发生的可能——差异只在 I/O 边界上。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

import { Diagnostics } from '@iforge/num'
import { createDefaultProject, ENGINE_VERSION } from '@iforge/model'
import type { ProjectFile, SaveFile } from '@iforge/model'

import { createBridge, createWindowBridge, newSessionId } from './bridge.js'
import type { Bridge, HostTransport } from './bridge.js'
import { GameController } from './controller.js'
import type { ControllerOptions } from './controller.js'
import {
  createLocalStorageSink,
  downloadSaveFile,
  installLifecycleAutosave,
  loadLocalSave,
  loadLocalSettings,
  loadLocalUi,
  localSaveKey,
  packagedProjectId,
} from './local-sink.js'
import type { StorageLike } from './local-sink.js'
import { GameApp } from './app.js'

/** 装配结果。 */
export interface PreviewRuntime {
  controller: GameController
  bridge: Bridge | null
  root: Root
  /** 直挂模式下挂载的根元素（预览模式由 iframe 的 `body` 提供）。 */
  element: HTMLElement
  /** 卸载（释放 tick、解绑监听）。 */
  dispose(): void
}

/** 宿主注入的引导数据（17.3 的 `window.__IFORGE_BOOTSTRAP__`）。 */
export interface Bootstrap {
  project: ProjectFile
  save?: SaveFile | null
  settings?: Record<string, unknown>
  /**
   * 界面偏好（当前只有会话级页面主题覆盖，8.10）。
   *
   * 与 `settings` 分开的原因见 `local-sink.ts` 的 `LOCAL_UI_PREFIX`：它不属于
   * `ProjectSettings`，混进 `settings` 会让项目默认值凭空多出一个字段。
   */
  ui?: { theme?: string }
  /** 引擎版本（打包产物元信息，11.1 末条）。 */
  engineVersion?: string
  /**
   * 产物元信息（17.3 的 `"meta": { engineVersion, builtAt, fingerprint }`）。
   *
   * `fingerprint` 不参与运行时逻辑，但 `slotId` 要用：11.1 末条说它“用于存档兼容判断”，
   * 而存档的键（10.1）按 `projectId` 分——打包态没有 IndexedDB 的 `projectId`，
   * 因此由指纹派生（`local-sink.ts` 的 `packagedProjectId`）。
   */
  meta?: {
    engineVersion?: string
    builtAt?: string
    fingerprint?: string
    /** 存档位（V1.0 固定 `main`，PRD 补充 8）。 */
    slotId?: string
  }
}

/** `window` 上的引导全局（17.3）。 */
declare global {
  interface Window {
    __IFORGE_BOOTSTRAP__?: Bootstrap
  }
}

/** 装配选项（全部可注入，便于测试不依赖真实 rAF/时钟）。 */
export interface MountOptions {
  /** 挂载点；省略时用 `document.body`。 */
  element?: HTMLElement
  /** 传输层；省略时按“直挂 or 预览”自动选择。 */
  transport?: HostTransport
  /** 引导数据；直挂模式必须给。 */
  bootstrap?: Bootstrap
  /** 会话级页面主题覆盖（8.10）；缺省时直挂态从 `localStorage` 读回。 */
  themeOverride?: string
  /**
   * 宿主下发的会话 id（9.3 第 1 步、R-19）。
   *
   * 预览模式下**必须**与宿主一致：两端各生成一个随机值的话，运行时会把宿主的
   * `host:init` 当成伪造消息丢掉（`reason: 'session'`），表现是“预览永远停在连接中”。
   */
  sessionId?: string
  projectId?: string
  slotId?: string
  /** 引擎版本（`game:ready` 与存档用）。 */
  engineVersion?: string
  wallClock?: () => number
  now?: () => number
  requestFrame?: (callback: (now: number) => void) => number
  cancelFrame?: (handle: number) => void
  /**
   * 直挂模式的持久化存储（10.3）。
   *
   * 省略时按 `window.localStorage` 取；**显式传 `null`** 表示禁用持久化
   * （E2E/单测里要断言“每次都是全新开局”时用，避免上一条用例的存档漏进来）。
   */
  storage?: StorageLike | null
  /** 直挂模式的存档导出（打包版的“导出存档”按钮，PRD 预览区 9）。 */
  download?: (save: SaveFile) => void
}

/** 是否处于直挂（打包）模式：有引导全局且不是 iframe。 */
function isDirectMode(bootstrap?: Bootstrap): boolean {
  if (bootstrap) return true
  if (typeof window === 'undefined') return false
  return Boolean(window.__IFORGE_BOOTSTRAP__)
}

/**
 * 装配预览运行时：建控制器、建桥、挂载 React、启动主循环。
 *
 * 循环与 React 树都在 `host:init` 到达**之后**才启动/挂载（9.3 第 2 步：收到
 * `game:ready` 后启用交互）。直挂模式没有握手，直接挂载。
 *
 * ## 预览模式下没有 bootstrap 怎么办
 *
 * `GameController` 需要一个 `ProjectFile` 才能构造，但预览模式的真实项目是
 * `host:init` 带来的（9.3 第 1 步），此时还没有。因此：
 *
 * - **控制器**先用 `createDefaultProject()` 占位（它立刻会被 `applyInit()` 里的
 *   `loadProject()` + `reset()` 整体替换，8.5 的重置语义）；
 * - **React 树**干脆不挂载 —— 没有项目就没有可显示的东西，早挂一帧会闪一个空的
 *   “暂无资源/暂无条目”，而那不是运行时的任何真实状态。
 *
 * 早先的写法是在两条分支之前无条件读 `bootstrap!.project`，预览模式必崩
 * （`TypeError: Cannot read properties of undefined`），而单测全都传了 `bootstrap`，
 * 所以只有真正执行注入物的端到端用例能发现它。
 */
export function mountGameRuntime(options: MountOptions = {}): PreviewRuntime {
  const element = options.element ?? document.body
  const direct = isDirectMode(options.bootstrap)
  const bootstrap = options.bootstrap ?? (typeof window !== 'undefined' ? window.__IFORGE_BOOTSTRAP__ : undefined)
  if (direct && !bootstrap) {
    throw new Error('直挂模式需要 bootstrap（window.__IFORGE_BOOTSTRAP__，17.3）')
  }

  // 样式作用域（`game.css` 的每一条规则都以 `.iforge-game` 开头）。
  //
  // 由 `boot.ts` 统一挂到 `document.body`，而不是指望宿主/入口各自记得加：漏了这一步
  // 的话**功能全部正常**（数据、点击、导航都对），只是排版退化成浏览器默认样式——
  // 这种失效在功能测试里完全看不出来，作者却会以为“游戏视图没接好”。
  document.body.classList.add('iforge-game')

  // 直挂态的持久化（10.3）：先读回存档与会话覆盖，再构造控制器。
  //
  // 顺序是刻意的：`GameController` 的构造函数里就会 `restore(save)` 并结算离线收益（8.8），
  // 读档晚一步就等于把“离线 8 小时”的收益算在一个从 0 开始的项目上。
  const projectId = options.projectId ?? (direct && bootstrap ? packagedProjectId(bootstrap.meta?.fingerprint ?? '') : undefined)
  const storage = resolveStorage(direct, options.storage)
  const localSave = direct && projectId && storage !== null ? loadLocalSave(storage, projectId) : null
  const localSettings = direct && projectId && storage !== null ? loadLocalSettings(storage, projectId) : {}
  // 界面偏好（页面主题覆盖）：同样只在直挂态读——预览 iframe 是 9.1 的不透明源，
  // 访问 `localStorage` 会抛 `SecurityError`（见本文件的 `resolveStorage` 注释）。
  const localUi = direct && projectId && storage !== null ? loadLocalUi(storage, projectId) : {}

  const controllerOptions: ControllerOptions = {
    project: bootstrap?.project ?? createDefaultProject(),
    save: bootstrap?.save ?? localSave,
    // 引导数据里的 `settings` 优先（产物显式注入时用它）；否则回落到本机会话覆盖（D-22）。
    settingsOverride: (bootstrap?.settings ?? localSettings) as ControllerOptions['settingsOverride'],
    // 同上：引导数据里的 `ui.theme` 优先，否则回落到本机偏好。
    themeOverride: options.themeOverride ?? bootstrap?.ui?.theme ?? localUi.theme,
    projectId,
    slotId: options.slotId ?? bootstrap?.meta?.slotId,
    engineVersion: options.engineVersion ?? bootstrap?.engineVersion ?? bootstrap?.meta?.engineVersion ?? ENGINE_VERSION,
    wallClock: options.wallClock ?? (() => Date.now()),
    now: options.now ?? (() => performance.now()),
    requestFrame: options.requestFrame ?? ((callback) => requestAnimationFrame(callback)),
    cancelFrame: options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle)),
    // 游戏内设置页的“导入存档”要一个真实 `document`（`controller.requestImportSave`）。
    // 漏了它那条按钮就只会记一条 `E_MSG_INVALID`——PRD 预览区 9 的“导入存档”整条链路是死的，
    // 而它在单测里看不出来：单测要么直接调 `applyImportSaveText()`，要么注入了自己的 document。
    document: typeof document === 'undefined' ? undefined : document,
  }
  const controller = new GameController(controllerOptions)

  const root = createRoot(element)
  let rendered = false
  const render = (): void => {
    if (rendered) return
    rendered = true
    root.render(createElement(GameApp, { controller }))
  }

  if (direct) {
    // 直挂没有 `postMessage` 对端：`sink` 由 `localStorage` 接管（10.3、11.1 末步）。
    const effectiveProjectId = projectId ?? packagedProjectId('')
    const doc = typeof document === 'undefined' ? undefined : document
    controller.setSink(
      createLocalStorageSink({
        storage,
        projectId: effectiveProjectId,
        download: (save) => {
          if (options.download) options.download(save)
          else if (!downloadSaveFile(save, doc)) {
            // 没有 `document`（SSR / 纯 Node 测试）时如实记诊断，而不是静默吞掉：
            // “导出存档”点了没反应是最难排查的一类问题。
            Diagnostics.record('E_MSG_INVALID', 'exportSave', '当前环境没有 document，无法导出存档')
          }
        },
      }),
    )
    // 10.3：`visibilitychange -> hidden` / `beforeunload` 各补一次存档。
    // 自动存档按真实秒数计（8.3 第 8 步），关页面前那一小段通常还没攒够间隔。
    if (doc && storage) installLifecycleAutosave(controller, () => writeNow(controller, effectiveProjectId, storage), doc)
    render()
    controller.start()
    return { controller, bridge: null, root, element, dispose: () => disposeAll(controller, root) }
  }

  const bridge = options.transport
    ? createBridge(controller, options.transport, options.sessionId ?? newSessionId())
    : createWindowBridge(controller, options.sessionId)
  void bridge.ready().then(() => {
    render()
    controller.start()
  })
  return { controller, bridge, root, element, dispose: () => disposeAll(controller, root, bridge) }
}

/**
 * 预览态**绝不**碰 `localStorage`（9.1：不透明源 iframe 访问它会抛 `SecurityError`）。
 *
 * 只有直挂态才尝试取；取不到（无 `window` / 访问被拒）一律退化为 `null`（= 不持久化），
 * 游戏照常可玩——存档写不出去不能让页面变成一块砖。
 */
function resolveStorage(direct: boolean, explicit: StorageLike | null | undefined): StorageLike | null {
  if (!direct) return null
  if (explicit !== undefined) return explicit
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** 直挂态的出站通道（10.3：存档/覆盖写 `localStorage`，导出走下载）。 */
function writeNow(controller: GameController, projectId: string, storage: StorageLike): void {
  try {
    storage.setItem(localSaveKey(projectId), JSON.stringify(controller.exportSave()))
    controller.state.markSaved()
  } catch {
    // 配额写满 / 无痕模式：存档写不进去不该让关闭页面这个动作抛错（D-02 的同款处理）。
  }
}

function disposeAll(controller: GameController, root: Root, bridge?: Bridge): void {
  bridge?.close()
  controller.dispose()
  // React 19：卸载必须包在 act 之外由调用方决定；这里同步卸载即可（预览 iframe 整体销毁时）。
  root.unmount()
}

/** 诊断计数快照（宿主/测试读取；9.3 的错误角标数据源）。 */
export function diagnosticsSnapshot(): Record<string, number> {
  return Diagnostics.countsSnapshot()
}
