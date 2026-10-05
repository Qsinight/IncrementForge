/**
 * 打包态的存档与会话设置持久化（TECH_DESIGN 10.3、11.1、ADR-05、D-22）。
 *
 * ## 为什么打包态要另写一份存储适配
 *
 * | | 预览（`sandbox="allow-scripts"` 的不透明源 iframe） | 打包产物（单文件 HTML） |
 * | --- | --- | --- |
 * | 存档去向 | `game:save` -> 宿主 -> IndexedDB（10.1） | **直接写 `localStorage`** |
 * | 会话覆盖 | `game:event{settings}` -> 宿主 `previewStore`（D-22） | **`localStorage`**，刷新后仍在 |
 * | 导出存档 | 宿主下载（沙箱没有 `allow-downloads`，浏览器会拦） | 运行时自己下载 |
 *
 * 关键约束是 9.1：预览 iframe **没有 `allow-same-origin`**，它的文档属于不透明源，
 * `localStorage` 访问会抛 `SecurityError`。因此“把 `localStorage` 兜底写进 `boot.ts`”
 * 这种写法会让**预览**在每次存档时炸掉。两条路径必须显式分开：
 *
 * - 预览：`bridge.ts` 建桥 → 全部消息出去，`sink` 只做转发；
 * - 直挂：`createLocalStorageSink()` 接管 `save` 与 `settings`，桥不存在。
 *
 * ## 键的命名（10.1 的 `incrementforge.save.<projectId>`）
 *
 * 存档键带 `projectId` 是为多存档预留位（PRD 补充 8）：V1.0 的 `projectId` 由产物指纹派生，
 * 同一份打包产物的键恒定；换一个项目打包就是另一个键，两份进度不会互相覆盖。
 */
import { saveFileSchema } from '@iforge/model'
import type { ProjectFile, ProjectSettings, SaveFile } from '@iforge/model'
import type { ControllerSink } from './controller.js'
import type { GameController } from './controller.js'

/** 存档键前缀（10.1：`incrementforge.save.<projectId>`）。 */
export const LOCAL_SAVE_PREFIX = 'incrementforge.save.'

/** 会话覆盖键前缀（D-22：打包态的“本会话覆盖”刷新后仍在）。 */
export const LOCAL_SETTINGS_PREFIX = 'incrementforge.settings.'

/**
 * 界面偏好键前缀（`incrementforge.ui.<projectId>`）。
 *
 * **单独一个键**而不是塞进 `incrementforge.settings.`：后者读回来直接当
 * `settingsOverride`（`Partial<ProjectSettings>`）用，多一个键就等于让
 * `effectiveSettings()` 长出一个项目文件里不存在的字段。界面偏好不属于
 * `ProjectSettings`（8.10 的 `settings` 是游戏默认值），因此有自己的键。
 */
export const LOCAL_UI_PREFIX = 'incrementforge.ui.'

/** 界面偏好（当前只有页面主题，8.10）。 */
export interface LocalUiState {
  /** 会话级页面主题覆盖（`THEME_FOLLOW_PAGE`/缺省 = 跟随作者设定）。 */
  theme?: string
}

/** 存档键。 */
export function localSaveKey(projectId: string): string {
  return `${LOCAL_SAVE_PREFIX}${projectId}`
}

/** 会话覆盖键。 */
export function localSettingsKey(projectId: string): string {
  return `${LOCAL_SETTINGS_PREFIX}${projectId}`
}

/** 界面偏好键。 */
export function localUiKey(projectId: string): string {
  return `${LOCAL_UI_PREFIX}${projectId}`
}

/** 最小 `Storage` 形状（便于测试注入桩；`window.localStorage` 天然满足）。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * 读回本地存档（10.3）。
 *
 * 三重防御，缺一就会出现“刷新后游戏崩在白屏”：
 * 1. `getItem` 抛（隐私模式、无痕窗口、`file://` 下部分浏览器的 `SecurityError`）-> 视为无存档；
 * 2. 不是合法 JSON -> 丢弃并**继续新开局**（玩家还能玩，只是丢了一局）；
 * 3. Zod 校验不过（6.3 的结构变了/手改过）-> 丢弃并继续。
 *
 * **不抛错**是刻意的：存档读不出来是“这一局的进度没了”，不是“游戏起不来”。
 * 反过来（抛错）会让一次手滑的 JSON 编辑把整份打包产物变成一块砖。
 */
export function loadLocalSave(storage: StorageLike | null, projectId: string): SaveFile | null {
  if (!storage) return null
  let raw: string | null
  try {
    raw = storage.getItem(localSaveKey(projectId))
  } catch {
    return null
  }
  if (raw === null || raw.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const result = saveFileSchema.safeParse(parsed)
    return result.success ? (result.data as SaveFile) : null
  } catch {
    return null
  }
}

/**
 * 读回本会话的设置覆盖（D-22）。
 *
 * 与存档不同，覆盖值**不参与 Zod 校验**：它由 `GameController.coerceSetting` 逐项归一化，
 * 而归一化失败的项在写进去之前就被拒了。读回来时做一次“必须是普通对象”的最小检查即可。
 */
export function loadLocalSettings(storage: StorageLike | null, projectId: string): Partial<ProjectSettings> {
  if (!storage) return {}
  let raw: string | null
  try {
    raw = storage.getItem(localSettingsKey(projectId))
  } catch {
    return {}
  }
  if (raw === null || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Partial<ProjectSettings>
  } catch {
    return {}
  }
}

/**
 * 读回界面偏好（8.10 的页面主题覆盖）。
 *
 * 与设置覆盖同样的三重防御：读不到 / 不是 JSON / 结构不对，一律按“无偏好”继续——
 * 偏好读不出来只是丢一次观感设置，绝不能让打包产物变成一块砖。
 */
export function loadLocalUi(storage: StorageLike | null, projectId: string): LocalUiState {
  if (!storage) return {}
  let raw: string | null
  try {
    raw = storage.getItem(localUiKey(projectId))
  } catch {
    return {}
  }
  if (raw === null || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const theme = (parsed as Record<string, unknown>)['theme']
    return typeof theme === 'string' ? { theme } : {}
  } catch {
    return {}
  }
}

/** 打包态的出站通道实现（`ControllerSink`）。 */
export interface LocalSinkOptions {
  storage: StorageLike | null
  projectId: string
  /** 触发下载（玩家点“导出存档”，PRD 预览区 9）。打包态有用户手势，可直接下载。 */
  download: (save: SaveFile) => void
  /** 下载不可用（例如没有 `document`）时的兜底回调。 */
  onDownloadUnavailable?: () => void
}

/**
 * 打包态的 `ControllerSink`（11.1 末步「直挂 -> localStorage 存档」）。
 *
 * `ready` / `stats` / `event` 三条出站在直挂模式下**没有对端**（没有 `postMessage`），
 * 因此只做两件事：`stats` 不发（视图从 `GameViewModel` 自己拿），`event{settings}`
 * 把覆盖值落盘（D-22 要求打包态刷新后仍在）。其余丢弃——**不是漏实现**，
 * 而是对端不存在；把它们接上会凭空多出一条消息通道。
 */
export function createLocalStorageSink(options: LocalSinkOptions): ControllerSink {
  const save = (payload: { save: SaveFile; intent?: 'autosave' | 'export' }): void => {
    if (!options.storage) return
    try {
      if (payload.intent === 'export') {
        options.download(payload.save)
        return
      }
      options.storage.setItem(localSaveKey(options.projectId), JSON.stringify(payload.save))
    } catch {
      // 配额写满 / 无痕模式：`localStorage.setItem` 会抛。存档写不进去不该让游戏崩，
      // 玩家还能玩到关页面为止（D-02 的同款处理：饱和而非抛错）。
    }
  }

  return {
    ready: () => undefined,
    stats: () => undefined,
    event: (event) => {
      if (!options.storage) return
      if (event.type === 'theme') {
        const payload = event.payload ?? {}
        // `rejected: true` = 覆盖值没通过 `coerceThemeOverride`，没有写入（controller 的 ② 步），
        // 此时不落盘：否则下次启动会拿到一个从未生效过的坏值。
        if (payload['rejected'] === true) return
        const theme = payload['theme']
        if (typeof theme !== 'string') return
        try {
          // 空串 = “跟随页面” = 没有偏好：**删键**而不是写 `{}`，
          // 否则键会永远留在那儿，而“键存在”这件事本身没有含义。
          if (theme.length === 0) options.storage.removeItem(localUiKey(options.projectId))
          else options.storage.setItem(localUiKey(options.projectId), JSON.stringify({ theme }))
        } catch {
          // 落盘失败不阻断游戏（配额写满 / 无痕模式）。
        }
        return
      }
      if (event.type !== 'settings') return
      const payload = event.payload ?? {}
      try {
        if (payload['reset'] === true) {
          options.storage.removeItem(localSettingsKey(options.projectId))
          return
        }
        // `rejected: true` 表示这一项没通过归一化、没有写入覆盖（controller 的 ①② 步），
        // 此时**不落盘**——否则下次启动会拿到一个从未生效过的坏值。
        if (payload['rejected'] === true) return
        const current = loadLocalSettings(options.storage, options.projectId)
        // `removed` 列出的键表示“覆盖被撤销”（改回项目默认值了），必须**删掉**而不是
        // 把默认值写回去——两者在运行时等价（`settings ⊕ override`），但在存档里
        // 不是一回事：写回默认值会让“本会话覆盖”在刷新后仍然显示为已覆盖。
        const removed = asStringArray(payload['removed'])
        for (const key of removed) delete current[key as keyof ProjectSettings]
        for (const [key, value] of Object.entries(payload)) {
          if (key === 'reset' || key === 'rejected' || key === 'removed') continue
          // 被撤销的键**不能**再写回：payload 里同时带着 `{key: 默认值}` 与 `removed`，
          // 顺序上 `removed` 先删、再写回就等于什么都没撤销。
          if (removed.includes(key)) continue
          current[key as keyof ProjectSettings] = value as never
        }
        options.storage.setItem(localSettingsKey(options.projectId), JSON.stringify(current))
      } catch {
        // 同上：落盘失败不阻断游戏。
      }
    },
    save,
    error: () => undefined,
  }
}

/** `string[]` 的收敛（`game:event` 的 `payload` 是 `Record<string, unknown>`，过桥后不可信）。 */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** 触发一次存档导出（打包态：直接下载 `*.save.json`）。 */
export function downloadSaveFile(save: SaveFile, doc: Document | undefined): boolean {
  if (!doc) return false
  const safe = (save.projectName || 'incrementforge').replace(/[\\/:*?"<>|]/g, '_')
  const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = doc.createElement('a')
  anchor.href = url
  anchor.download = `${safe}.save.json`
  doc.body.append(anchor)
  anchor.click()
  anchor.remove()
  // 立刻 revoke 会让部分浏览器（Firefox）取消尚未开始的下载；延后一拍是社区共识做法。
  //
  // `revokeObjectURL` 在 timer 回调里被调用，因此**必须**自带兜底：这行代码在
  // `downloadSaveFile` 返回之后才跑，调用方无法 try/catch，而 jsdom 等环境
  // 根本不实现这个 API——一次抛错会变成 unhandled error 把整条测试跑挂。
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url)
    } catch {
      // 环境不支持（或 url 已被回收）：下载已经触发，无需处理。
    }
  }, 0)
  return true
}

/**
 * 打包态的存档时机补充（10.3：`visibilitychange -> hidden`、`beforeunload`）。
 *
 * 自动存档按真实秒数计（8.3 第 8 步、D-31），因此**关闭页面时那一小段**通常还没攒够间隔：
 * 不补一次的话玩家玩 20 秒就关页面、回来从 0 开始。11.1 的“进入离线结算前”由
 * `restore()` 读档时的 `settleOffline` 覆盖，不在这里。
 */
export function installLifecycleAutosave(
  controller: GameController,
  write: () => void,
  target: Pick<Document, 'addEventListener'> & { defaultView?: unknown },
): () => void {
  const onHide = (): void => {
    // 只在“真的需要存档”时写：`write()` 内部会再判断一次，避免每次切标签页都序列化整份存档。
    if (!controller.state.shouldAutosave() && controller.state.stats.tick === 0) return
    write()
  }
  target.addEventListener('visibilitychange', () => {
    if ((target as Document).visibilityState === 'hidden') onHide()
  })
  const view = (target as Document & { defaultView?: Window | null }).defaultView
  view?.addEventListener('beforeunload', () => write())
  return () => {
    // iframe/页面整体销毁时无需解绑（打包态没有宿主会复用这个文档）；
    // 这里保留返回值是为了测试里能验证监听确实装上了。
  }
}

/**
 * 由产物元信息派生 `projectId`（打包态没有 IndexedDB 的 `projectId`）。
 *
 * 指纹缺失时退化为 `"unknown"`——键必须**稳定**：同一个产物两次打开要读到同一份存档，
 * 否则“刷新丢进度”会变成最难复现的一类问题。
 */
export function packagedProjectId(fingerprint: string): string {
  return `pkg-${(fingerprint || 'unknown').slice(0, 12)}`
}

/** 没有显式 `projectId` 时，从项目名 + 引擎版本派生一个（`main.ts` 调试页用）。 */
export function fallbackProjectId(project: ProjectFile): string {
  return packagedProjectId(`${project.meta.name}|${project.engineVersion}`)
}
