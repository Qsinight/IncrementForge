/**
 * 预览 iframe 容器（TECH_DESIGN 9.1 沙箱、9.2 协议、9.3 生命周期、7.4 同步到预览）。
 *
 * ## 三条同步路径，一个信号源
 *
 * | 触发 | 发出 | 语义 |
 * | --- | --- | --- |
 * 首次挂载 / 换项目 | `host:init`（带存档） | **整表重建**，按 8.5 重置——“新建/导入/打开另一个项目” |
 * `projectStore.revision` 变化 | `host:patch`（7.4 的条目级 diff） | **热更新**，保留本局进度 |
 * 模拟设置栏 / 设置页 | `host:control` | 暂停/倍速/解锁/设备/会话覆盖 |
 *
 * `revision` 是**唯一**的编辑器改动信号（`projectStore` 的注释明确这一点），
 * 因此不存在“改一个字段”和“改一个条目”两条不同步的通道（7.4）。
 *
 * ## 为什么用 `useEffect` + `useRef` 而不是 store 中间件
 *
 * iframe 的创建/销毁是**副作用**（浏览器资源），放进 zustand action 会得到一个
 * “持有 DOM 元素的 store”，测试时无法替换。把 DOM 生命周期留在 React、协议逻辑留在
 * `session.ts`，两边都能独立测；组件之间通过 `session.ts` 的“当前会话”登记通信，
 * 而不是层层透传 ref（同一时刻只有一个会话，见 `setActiveSession` 的注释）。
 */
import { useCallback, useEffect, useRef } from 'react'

import type { ProjectFile, SaveFile } from '@iforge/model'
import type { GameErrorPayload, GameEventPayload, GameSavePayload } from '@iforge/runtime'

import runtimeShellSource from 'virtual:iforge-runtime-shell'

import { usePreviewStore } from '../../stores/preview.js'
import { useProjectStore } from '../../stores/project.js'
import type { PreviewSession } from './session.js'
import { sendControl, sendPatches, setActiveSession, startPreviewSession } from './session.js'

export interface PreviewFrameProps {
  /** 存档读取器（10.1 的 `saves` 仓储）；省略表示“本项目尚无存档”。 */
  loadSave?: (projectId: string) => Promise<SaveFile | null>
  /** 存档落库（自动存档，10.3）。 */
  persistSave?: (save: SaveFile) => Promise<void>
  /** 导出存档为文件（PRD 预览区 9 的“导出存档”，D-51 的 `intent: 'export'`）。 */
  downloadSave?: (save: SaveFile) => void
  /** 设备档位（9.1 的设备模拟）。 */
  device: 'phone' | 'tablet' | 'auto'
}

export function PreviewFrame({ loadSave, persistSave, downloadSave, device }: PreviewFrameProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<PreviewSession | null>(null)
  /** 上一次 `host:init` 用的项目文件（`host:patch` 的 diff 基准，7.4）。 */
  const lastProjectRef = useRef<ProjectFile | null>(null)

  const projectId = useProjectStore((state) => state.projectId)
  const revision = useProjectStore((state) => state.revision)
  const paused = usePreviewStore((state) => state.paused)
  const speed = usePreviewStore((state) => state.speed)
  const unlocked = usePreviewStore((state) => state.unlocked)

  const setStatus = usePreviewStore((state) => state.setStatus)
  const setSessionId = usePreviewStore((state) => state.setSessionId)
  const reportError = usePreviewStore((state) => state.reportError)
  const setSettingsOverride = usePreviewStore((state) => state.setSettingsOverride)

  const onSave = useCallback(
    (payload: GameSavePayload) => {
      // D-51：自动存档 -> 落库；玩家点“导出存档”-> 下载文件。两者都必须处理，
      // 否则自动存档会弹下载框，或者“导出存档”按钮什么都不发生。
      if (payload.intent === 'export') {
        downloadSave?.(payload.save)
        return
      }
      void persistSave?.(payload.save)
    },
    [downloadSave, persistSave],
  )

  const onEvent = useCallback(
    (event: GameEventPayload) => {
      // 8.10/D-22/R-24：游戏内改设置只写 `previewStore` 的会话覆盖，**不写项目文件**。
      if (event.type === 'settings' && event.payload) setSettingsOverride(event.payload)
    },
    [setSettingsOverride],
  )

  const onError = useCallback(
    (error: GameErrorPayload) => reportError(error.code, { where: error.where, message: error.message, tick: error.tick }),
    [reportError],
  )

  // ---- 会话生命周期（9.3 第 1 步 + 第 4 步）----
  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    let cancelled = false
    setStatus('connecting')

    void (async () => {
      const save = loadSave ? await loadSave(projectId) : null
      // 读存档是异步的：期间可能已经卸载或换了项目Id——两种情况下都不能再建 iframe，
      // 否则会留下一个“没人管的会话”在跑 tick（9.3 第 4 步的清理会被跳过）。
      if (cancelled || !containerRef.current) return
      const session = startPreviewSession({
        script: runtimeShellSource,
        container: containerRef.current,
        save,
        settingsOverride: usePreviewStore.getState().settingsOverride,
        projectId,
        onSave,
        onEvent,
        onError,
      })
      sessionRef.current = session
      setActiveSession(session)
      setSessionId(session.sessionId)
      lastProjectRef.current = useProjectStore.getState().project
    })()

    // 9.3 第 4 步：卸载时销毁 iframe，释放 tick（否则每次打开编辑器都留一个死循环）。
    return () => {
      cancelled = true
      sessionRef.current?.dispose()
      sessionRef.current = null
      setActiveSession(null)
      setStatus('idle')
      setSessionId('')
    }
    // 会话只随 `projectId` 重建；项目内容变化走 `host:patch`（见下）。
  }, [projectId, onSave, onEvent, onError, loadSave, setStatus, setSessionId])

  // ---- `host:patch`（7.4）----
  // 首次渲染不发（`lastProjectRef` 刚被 `host:init` 建立），此后每次 `revision` +1 派发一次。
  useEffect(() => {
    const session = sessionRef.current
    const previous = lastProjectRef.current
    const next = useProjectStore.getState().project
    if (!session || !previous) return
    if (previous === next) return
    sendPatches(session, previous, next)
    lastProjectRef.current = next
  }, [revision])

  // ---- 模拟设置栏 -> `host:control`（9.2、D-31/D-41/D-16）----
  useEffect(() => {
    const session = sessionRef.current
    if (!session) return
    sendControl(session, paused ? 'pause' : 'resume')
  }, [paused])

  useEffect(() => {
    const session = sessionRef.current
    if (!session) return
    sendControl(session, 'speed', speed)
  }, [speed])

  useEffect(() => {
    const session = sessionRef.current
    if (!session || !unlocked) return
    // D-16：一次性动作；重复下发只是把已经为真的值再写一遍，语义等价。
    sendControl(session, 'unlockAll')
  }, [unlocked])

  useEffect(() => {
    const session = sessionRef.current
    if (!session) return
    // 9.1：设备模拟只改宿主容器宽度与 `pointer: coarse`，不参与任何结算；
    // 这里仍下发，让运行时把 `coarse` 施加到自己的根节点（9.1 的行为定义）。
    sendControl(session, 'device', device)
  }, [device])

  return <div className="preview-frame" ref={containerRef} data-testid="preview-frame" data-device={device} />
}
