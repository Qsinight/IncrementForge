/**
 * 预览区状态（TECH_DESIGN 7.2 `previewStore`、7.1 模拟设置栏、9.2 消息协议、D-16/D-22/D-31/D-41）。
 *
 * ## M4 的范围
 *
 * M3 只交付“模拟设置栏的状态归属”，M4 起这层状态**真正驱动**协议：控件的每一次点击
 * 都会变成一条 `host:control`（9.2），而 `previewStore` 是它与 iframe 之间的镜像。
 * 因此这里仍然只存**状态**，不存 iframe 引用——iframe 的生命周期由 `features/preview` 的
 * `PreviewFrame` 持有（React 组件负责 DOM，store 负责数据，两者不互相持有）。
 *
 * ## 协议常量从 `@iforge/runtime` 再导出
 *
 * 9.2 的 `kind` 枚举是宿主与运行时的**共同契约**（R-19）。M3 时它定义在本文件里，
 * M4 起改为从 `@iforge/runtime` 再导出：这样运行时（`apps/runtime-shell`）与宿主引用的是
 * **同一个对象**，不存在“两份看起来差不多的枚举”。再导出的名字保持不变，调用方无需改动。
 *
 * ## 设置覆盖不进历史、不写项目（D-22、R-24）
 *
 * `settingsOverride` 是玩家在**游戏内设置页**改出来的会话偏好。它既不进 `historyStore`
 * （D-14：撤销只覆盖项目数据），也不进 `projectStore`（PRD 中它们是“游戏默认设置”，
 * 玩一次预览不该改写作者的设计默认值）。
 */
import { create } from 'zustand'

import { GAME_KINDS, HOST_KINDS, MESSAGE_KINDS, PROTOCOL_VERSION } from '@iforge/runtime'
import type { GameKind, HostKind, MessageKind, StatsPayload } from '@iforge/runtime'

// ---- 9.2 的协议常量（再导出，见文件头说明）----
export { GAME_KINDS, HOST_KINDS, MESSAGE_KINDS, PROTOCOL_VERSION }
export type { GameKind, HostKind, MessageKind }

/** 设备档位（D-41）。 */
export type DeviceMode = 'phone' | 'tablet' | 'auto'

/** 设备档位的视口宽度（D-41 表；`auto` = 容器宽度）。 */
export const DEVICE_WIDTH: Readonly<Record<DeviceMode, number | null>> = { phone: 390, tablet: 834, auto: null }

/**
 * 设备档位的**断点列数上限**（9.1 表 + D-41）。
 *
 * `auto` 由宿主按容器宽度折算成具体档位后再算列数，因此这里给的是**默认**值
 * （容器宽度未知时按 `desktop`），实际列数仍由运行时的 `maxColumns` 与
 * `min(page.columns, 断点列数)` 共同决定（D-41「不改 `columns` 定义」）。
 */
export const DEVICE_MAX_COLUMNS: Readonly<Record<DeviceMode, number>> = { phone: 1, tablet: 2, auto: 3 }

/** 时间倍速档位（D-31）。 */
export const SPEEDS = [1, 2, 5, 10] as const
export type Speed = (typeof SPEEDS)[number]

/** 连接状态（9.3 生命周期）。 */
export type PreviewStatus = 'idle' | 'connecting' | 'ready' | 'error'

/** 一条诊断明细（7.1 诊断角标展开后的列表、8.7 的孤儿动态条目入口）。 */
export interface PreviewDiagnostic {
  code: string
  /** 错误位置（`generators[3].costs[0].amount` 形态）。 */
  where?: string
  message: string
  /** 次数（同一错误反复出现时只折叠计数）。 */
  count: number
  /** 最近一次出现时的 tick。 */
  tick?: number
}

interface PreviewState {
  status: PreviewStatus
  /** 与预览的会话 id（9.2 的安全校验用；每次挂载重新生成）。 */
  sessionId: string
  device: DeviceMode
  paused: boolean
  speed: Speed
  /** “解锁全部”已执行（D-16：一次性动作，后续仍可被表达式覆盖）。 */
  unlocked: boolean
  /** 诊断角标：按错误码聚合计数（7.1 末条）。 */
  diagnostics: Record<string, number>
  /** 诊断明细列表（按出现顺序，最多 50 条）。 */
  diagnosticLog: PreviewDiagnostic[]
  /** 最近一次 `game:stats`（8.9 仪表盘数据）。 */
  stats: StatsPayload | null
  /** 离线收益提示条的内容（8.8 末条）；`null` = 未显示。 */
  offlineNotice: { rawSeconds: number; settledSeconds: number; approximate: boolean; truncated: boolean; clockRollback: boolean } | null
  /**
   * 游戏内设置页产生的**会话覆盖**（D-22、8.10）。
   *
   * 只在预览态存在：不写 `projectStore`、不写项目文件、不进撤销栈（D-14）。
   * 设置页的来源徽标据此显示“项目默认 / 本会话覆盖”（R-24）。
   */
  settingsOverride: Partial<Record<string, unknown>>
  /** 孤儿动态条目（`pageId` 已失效，8.7）：不渲染但可从诊断面板丢弃。 */
  orphans: string[]
  /**
   * 需要提示作者改写价格形状的实体键（8.6 末条）。
   *
   * 由运行时的 `game:event{type:'discard'}` 之外的路径送达：`GameState.rewriteAdvice()`
   * 经 `ViewModelContext` 落到**卡片**上；这里是同一份信息的宿主侧副本，
   * 用于在诊断面板里按条目列出（卡片提示只覆盖当前页面）。
   */
  adviceEntities: string[]
  /** 最近一次打包的结果（11.1/11.2）；`null` = 本会话未打包或上次失败。 */
  packaging: PackagingResult | null

  setStatus(status: PreviewStatus): void
  setSessionId(sessionId: string): void
  setDevice(device: DeviceMode): void
  setPaused(paused: boolean): void
  togglePause(): void
  setSpeed(speed: Speed): void
  setUnlocked(unlocked: boolean): void
  reportError(code: string, detail?: Omit<PreviewDiagnostic, 'code' | 'count'>): void
  setStats(stats: StatsPayload): void
  setOfflineNotice(notice: PreviewState['offlineNotice']): void
  setSettingsOverride(patch: Record<string, unknown>): void
  clearSettingsOverride(): void
  setOrphans(orphans: string[]): void
  setAdviceEntities(entities: string[]): void
  setPackaging(result: PackagingResult | null): void
  reset(): void
}

/**
 * 打包结果（11.1 末条 + 11.2 的体积预算）。
 *
 * 单独放在 `previewStore` 而不是塞进 toast：toast 会自动消失，而产物体积/指纹是作者
 * 在把文件发给别人之前会想再确认一次的信息（11.2 的预算判定尤其如此）。
 */
export interface PackagingResult {
  fileName: string
  bytes: number
  /** gzip 字节数；`0` 表示运行环境拿不到 `zlib`（浏览器内打包）。 */
  gzipBytes: number
  overBudget: boolean
  fingerprint: string
  builtAt: string
}

/** 诊断明细上限（对齐 7.3 的撤销栈上限做法：给无界日志一个硬顶）。 */
const DIAGNOSTIC_LOG_LIMIT = 50

export const usePreviewStore = create<PreviewState>((set) => ({
  status: 'idle',
  sessionId: '',
  device: 'auto',
  paused: false,
  speed: 1,
  unlocked: false,
  diagnostics: {},
  diagnosticLog: [],
  stats: null,
  offlineNotice: null,
  settingsOverride: {},
  orphans: [],
  adviceEntities: [],
  packaging: null,

  setStatus: (status) => set({ status }),
  setSessionId: (sessionId) => set({ sessionId }),
  setDevice: (device) => set({ device }),
  setPaused: (paused) => set({ paused }),
  togglePause: () => set((state) => ({ paused: !state.paused })),
  setSpeed: (speed) => set({ speed }),
  setUnlocked: (unlocked) => set({ unlocked }),
  reportError: (code, detail) =>
    set((state) => {
      const count = (state.diagnostics[code] ?? 0) + 1
      const index = state.diagnosticLog.findIndex((item) => item.code === code && item.where === detail?.where)
      const log = [...state.diagnosticLog]
      if (index >= 0) {
        log[index] = { ...log[index]!, count, message: detail?.message ?? log[index]!.message, tick: detail?.tick ?? log[index]!.tick }
      } else {
        log.push({ code, count, where: detail?.where, message: detail?.message ?? '', tick: detail?.tick })
        while (log.length > DIAGNOSTIC_LOG_LIMIT) log.shift()
      }
      return { diagnostics: { ...state.diagnostics, [code]: count }, diagnosticLog: log }
    }),
  setStats: (stats) => set({ stats }),
  setOfflineNotice: (offlineNotice) => set({ offlineNotice }),
  setSettingsOverride: (patch) => set((state) => ({ settingsOverride: { ...state.settingsOverride, ...patch } })),
  clearSettingsOverride: () => set({ settingsOverride: {} }),
  setOrphans: (orphans) => set({ orphans }),
  setAdviceEntities: (adviceEntities) => set({ adviceEntities }),
  setPackaging: (packaging) => set({ packaging }),
  reset: () =>
    set({
      status: 'idle',
      sessionId: '',
      device: 'auto',
      paused: false,
      speed: 1,
      unlocked: false,
      diagnostics: {},
      diagnosticLog: [],
      stats: null,
      offlineNotice: null,
      settingsOverride: {},
      orphans: [],
      adviceEntities: [],
      packaging: null,
    }),
}))

/**
 * “解锁全部”的宿主侧动作（D-16）。
 *
 * 真正的落地在运行时（`GameState.unlockAll()`，8.4），宿主这里只记录“已执行”以便 UI 显示；
 * `forceUnlock` 标记本身是**纯内存态**、不写项目文件也不写存档（8.4 末条）。
 */
export function requestUnlockAll(): void {
  usePreviewStore.getState().setUnlocked(true)
}

/** 诊断总数（角标）。 */
export function totalDiagnostics(state: Pick<PreviewState, 'diagnostics'>): number {
  return Object.values(state.diagnostics).reduce((sum, value) => sum + value, 0)
}
