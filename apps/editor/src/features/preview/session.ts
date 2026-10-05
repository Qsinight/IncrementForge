/**
 * 预览沙箱的 **宿主侧**（TECH_DESIGN 9.1、9.2、9.3、7.4、7.2 的 `previewStore`）。
 *
 * ## 职责边界
 *
 * | 模块 | 做什么 |
 * | --- | --- |
 * 本文件 | 建 iframe、注入 `srcdoc`、生成 `sessionId`、收发消息、校验、按 `revision` 派发 `host:patch` |
 * `packages/runtime/src/protocol.ts` | 消息信封与校验规则（与运行时**共用同一份**，9.2/R-19） |
 * `@iforge/runtime-shell` 的 `bridge.ts` | 运行时侧的收发与校验 |
 *
 * ## 为什么校验规则不各写一份
 *
 * 9.2 的 `kind`/方向/体积校验如果宿主与运行时各写一次，迟早出现“宿主认为合法、运行时丢弃”
 * 的静默不同步——表现是某个功能在某个版本后悄悄失效。因此两端都从
 * `@iforge/runtime` 的 `acceptMessage()` / `buildMessage()` 取（3.2 允许 `editor → runtime` 的依赖）。
 *
 * ## 生命周期（9.3）
 *
 * 1. 挂载 → 建 iframe（`sandbox="allow-scripts allow-pointer-lock"`，**不加** `allow-same-origin`）→ `host:init`；
 * 2. 收到 `game:ready` → 状态置 `ready`，解锁交互与“打包”按钮；
 * 3. 编辑器改动 → `host:patch`；运行时 `game:error` → 诊断角标；
 * 4. 卸载 → 销毁 iframe（释放 tick）。
 */
import { Diagnostics } from '@iforge/num'
import type { ProjectFile, SaveFile } from '@iforge/model'
import { acceptMessage, buildMessage, diffProject, newSessionId, REJECT_REASON_TEXT } from '@iforge/runtime'
import type {
  Envelope,
  GameErrorPayload,
  GameEventPayload,
  GameSavePayload,
  HostControlAction,
  HostKind,
  ReadyPayload,
  StatsPayload,
} from '@iforge/runtime'

import { usePreviewStore } from '../../stores/preview.js'
import { useProjectStore } from '../../stores/project.js'

/** 预览 iframe 的 `srcdoc` 骨架（9.1）。 */

/**
 * 挂载点 id。
 *
 * 必须与 `apps/runtime-shell/src/iframe-entry.ts` 的 `ROOT_ID` 一致——两边是**契约**：
 * 宿主在 `srcdoc` 里放这个空 div，运行时找它挂载 React。写错了的表现是运行时自己新建
 * 一个 div 并挂到 `body`，功能正常但样式作用域（`.iforge-game`）可能不生效，很难一眼看出。
 */
const ROOT_ID = 'iforge-root'

/** 预览 iframe 的 `sandbox` 取值（9.1 逐字）：**不加** `allow-same-origin`。 */
export const PREVIEW_SANDBOX = 'allow-scripts allow-pointer-lock'

/**
 * 构造 `srcdoc`（9.1）。
 *
 * 三段内容：`<!doctype>` + 根节点 + 编译产物。运行时脚本自带 CSS（`?inline` 注入 `<style>`），
 * 因此这里**不需要**额外内联样式——这也是把运行时打成单文件的意义。
 *
 * 产物里的 `</script>` 序列必须转义：HTML 解析器只认字面的 `</script`，而 React DOM 里有
 * 这个字符串。转义成 `<\/script` 后，HTML 侧不会提前闭合 `<script>`，JS 侧 `\/` 与 `/` 等价。
 *
 * ## 为什么 `sessionId` 要写进 `srcdoc`
 *
 * `sessionId` 由**宿主**生成（9.1、R-19），但运行时也得知道它才能校验入站信封。
 * 没有第二个注入口：`srcdoc` 与 `src` 互斥，`postMessage` 又发生在运行时注册监听**之前**，
 * 两条路都不可用。于是把它写进挂载点的 `data-session-id`——宿主能写、运行时在
 * `DOMContentLoaded` 时读得到，且它是纯数据（32 位十六进制），不构成额外信任面：
 * 运行时拿到错误 id 的后果只是“收不到任何 host 消息”，与被伪造无异。
 */
export function buildSrcdoc(script: string, sessionId = ''): string {
  const safe = script.replace(/<\/script/gi, '<\\/script')
  const sessionAttr = sessionId ? ` data-session-id="${escapeAttribute(sessionId)}"` : ''
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>预览</title></head>',
    `<body><div id="${ROOT_ID}"${sessionAttr}></div>`,
    `<script>${safe}</script>`,
    '</body></html>',
  ].join('')
}

/** HTML 属性值转义（`sessionId` 目前只有十六进制字符，这里是纵深防御）。 */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** 宿主侧的预览会话。 */
export interface PreviewSession {
  sessionId: string
  iframe: HTMLIFrameElement
  /** 向运行时发消息；失败记 `E_MSG_INVALID`（9.2 末条）。 */
  send(kind: HostKind, payload: unknown): boolean
  /** 销毁 iframe 并释放 tick（9.3 第 4 步）。 */
  dispose(): void
}

/** 建会话的选项。 */
export interface StartSessionOptions {
  /** 运行时脚本文本（esbuild 产物，见 `vite/iforge-runtime-shell.ts`）。 */
  script: string
  /** 容器元素（宿主把 iframe 插进去）。 */
  container: HTMLElement
  /** 初始存档（预览态从 IndexedDB 读，10.1）。 */
  save?: SaveFile | null
  /** 会话覆盖（游戏内设置页产生的，8.10/D-22）。 */
  settingsOverride?: Record<string, unknown>
  projectId: string
  slotId?: string
  /** 收到 `game:save`（自动存档或导出）时回调；`intent` 区分去向（D-51）。 */
  onSave?: (payload: GameSavePayload) => void
  /** 收到 `game:event` 时回调。 */
  onEvent?: (payload: GameEventPayload) => void
  /** 收到 `game:error` 时回调（诊断角标，9.3 第 3 步）。 */
  onError?: (payload: GameErrorPayload) => void
  /** 收到 `game:ready` 时回调（9.3 第 2 步）。 */
  onReady?: (payload: ReadyPayload) => void
  /** 收到 `game:stats` 时回调（≤10Hz）。 */
  onStats?: (payload: StatsPayload) => void
}

/** 建立预览会话（9.3 第 1 步）。 */
export function startPreviewSession(options: StartSessionOptions): PreviewSession {
  const sessionId = newSessionId()
  const store = usePreviewStore.getState()

  const iframe = document.createElement('iframe')
  iframe.title = 'game-preview'
  // 9.1 逐字：allow-scripts + allow-pointer-lock；**不加** allow-same-origin。
  iframe.setAttribute('sandbox', PREVIEW_SANDBOX)
  iframe.setAttribute('srcdoc', buildSrcdoc(options.script, sessionId))
  iframe.setAttribute('data-session-id', sessionId)
  // 稳定的定位点：容器 div 与 iframe 都是 `preview-frame` 的后代，测试要区分二者
  // （`frameLocator` 必须指向 iframe 本身，指向容器会报 “resolved to <div>, <iframe> was expected”）。
  iframe.setAttribute('data-testid', 'preview-iframe')
  options.container.append(iframe)

  const send = (kind: HostKind, payload: unknown): boolean => {
    const built = buildMessage(sessionId, kind, payload)
    if (!built.ok) {
      Diagnostics.record('E_MSG_INVALID', `out:${kind}`, `出站消息被拒：${REJECT_REASON_TEXT[built.reason]}`)
      store.reportError('E_MSG_INVALID')
      return false
    }
    iframe.contentWindow?.postMessage(built.message, '*')
    return true
  }

  const onMessage = (event: MessageEvent): void => {
    // 9.2 的校验：只接受本会话、`game:*` 方向的合法信封；其余一律丢弃并计数。
    const accepted = acceptMessage(event.data, sessionId, 'game')
    if (!accepted.ok) {
      Diagnostics.record('E_MSG_INVALID', 'in', `入站消息被拒：${REJECT_REASON_TEXT[accepted.reason]}`)
      store.reportError('E_MSG_INVALID')
      return
    }
    handleGameMessage(accepted.message, options)
  }
  window.addEventListener('message', onMessage)

  // 9.3 第 1 步：`host:init` 紧随 iframe 创建发出，**并在 `load` 时补发一次**。
  //
  // 为什么要补发：`append` 之后 `iframe.contentWindow` 立刻可用（指向同步创建的
  // `about:blank`），而 `srcdoc` 文档的解析与脚本执行在后续任务里才发生。此时
  // `postMessage` 投递到的是那个即将被替换掉的空文档——运行时**听不到**，表现为
  // “预览一直显示连接中”。`load` 保证脚本已执行，补发的消息一定送得进去。
  // 重复送达是幂等的：`applyInit()` 整体重置本局（8.5），补发只发生在启动窗口内。
  const sendInit = (): void => {
    send('host:init', {
      project: useProjectStore.getState().project,
      save: options.save ?? null,
      settings: options.settingsOverride ?? {},
      theme: document.documentElement.dataset.theme ?? 'dark',
      locale: 'zh-CN',
      projectId: options.projectId,
      slotId: options.slotId ?? 'main',
    })
  }
  sendInit()
  iframe.addEventListener('load', sendInit, { once: true })

  return {
    sessionId,
    iframe,
    send,
    dispose() {
      iframe.removeEventListener('load', sendInit)
      window.removeEventListener('message', onMessage)
      iframe.remove()
    },
  }
}

/**
 * 一条 `game:*` 消息的分发（9.2 的下行五个）。
 *
 * **每种消息只被处理一次**：给了对应回调就交给回调，没给才落 `previewStore` 的默认值。
 * 两边都做（早先的写法）会让同一条 `game:error` 被计两次——诊断角标从“1 条错误”显示成
 * “2 条”，而且排查时会以为运行时真的报了两次。
 */
function handleGameMessage(message: Envelope, options: StartSessionOptions): void {
  const store = usePreviewStore.getState()
  switch (message.kind) {
    case 'game:ready': {
      // 9.3 第 2 步：连接建立。状态由 store 统一持有，UI 与“打包”按钮都订阅它。
      store.setStatus('ready')
      options.onReady?.(message.payload as ReadyPayload)
      return
    }
    case 'game:stats': {
      const stats = message.payload as StatsPayload
      if (options.onStats) options.onStats(stats)
      else store.setStats(stats)
      // 孤儿列表与性能采样走**默认**镜像，不进 `onStats` 回调：它们是宿主侧 UI 的输入，
      // 与调用方“要不要自己处理 stats”无关。旧运行时不带这两个字段时保持原值不动，
      // 因此对 M4 之前的注入物是向后兼容的（与 `game:save.intent` 的可选策略一致，D-51）。
      if (stats.orphans) store.setOrphans(stats.orphans)
      if (stats.advice) store.setAdviceEntities(stats.advice)
      return
    }
    case 'game:event': {
      const event = message.payload as GameEventPayload
      if (options.onEvent) {
        options.onEvent(event)
        return
      }
      // 默认镜像：8.10/D-22/R-24——游戏内改设置只写会话覆盖，绝不写项目文件。
      if (event.type === 'settings' && event.payload) store.setSettingsOverride(event.payload)
      return
    }
    case 'game:save':
      options.onSave?.(message.payload as GameSavePayload)
      return
    case 'game:error': {
      const error = message.payload as GameErrorPayload
      // 诊断角标（7.1 末条）。给了 onError 就由它带 `where`/`tick` 的明细写入。
      if (options.onError) options.onError(error)
      else store.reportError(error.code)
      return
    }
    default:
      return
  }
}

/**
 * 按编辑器改动派发 `host:patch`（7.4）。
 *
 * 与 `host:init` 的差别正是 7.4 要解决的：**结构/文本热更新不重置本局进度**
 * （`patch.ts` 里逐字段仲裁：进度类数值永远保留，表达式文本按“是否被运行期赋值过”仲裁）。
 */
export function sendPatches(session: PreviewSession, previous: ProjectFile, next: ProjectFile): number {
  const patches = diffProject(previous, next)
  if (patches.length === 0) return 0
  return session.send('host:patch', { patches }) ? patches.length : 0
}

/** 下发一条 `host:control`（9.2 的模拟设置栏）。 */
export function sendControl(session: PreviewSession, action: HostControlAction, value?: unknown): boolean {
  return session.send('host:control', { action, value })
}

// ---------------------------------------------------------------------------
// 当前会话
// ---------------------------------------------------------------------------
//
// 模拟设置栏（`PreviewPane`）与 iframe 容器（`PreviewFrame`）是两个 React 组件，
// 但前者必须能把 `host:control` 发给后者创建的会话。用模块级“当前会话”登记
// 而不是 prop 透传，是因为：**同一时刻只允许一个预览**（9.1 一个 iframe = 一个会话，
// 重建时会换 `sessionId`），多会话场景（15 的“多项目管理”）才需要改成按 id 索引。

let active: PreviewSession | null = null

/** 登记/注销当前会话（由 `PreviewFrame` 在创建/销毁时调用）。 */
export function setActiveSession(session: PreviewSession | null): void {
  active = session
}

/** 当前会话；未建立时为 `null`（此时任何 `host:*` 都不发，UI 应显示“连接中”）。 */
export function activeSession(): PreviewSession | null {
  return active
}

/** 向当前会话下发一条 `host:control`；无会话时返回 `false`。 */
export function sendActiveControl(action: HostControlAction, value?: unknown): boolean {
  return active ? sendControl(active, action, value) : false
}

/** 请求运行时导出存档（9.2 的 `host:save{silent}`）。 */
export function requestSave(session: PreviewSession, silent = true): boolean {
  return session.send('host:save', { silent })
}
