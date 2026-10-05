/**
 * 预览沙箱的 **postMessage 桥**（运行时侧，TECH_DESIGN 9.1、9.2、9.3、13 第 3 条、R-19）。
 *
 * ## 为什么必须是 `targetOrigin: '*'` 而不是同源
 *
 * 9.1 明确要求 **不加** `allow-same-origin`：iframe 处于**不透明源**（opaque origin），
 * 浏览器把它当作 `null` 源，而 `postMessage` 的 `targetOrigin` 只接受具体源或 `*`，
 * 不接受 `null`——因此这里只能用 `'*'`。安全性由另外三件事保证，而不是由 origin 匹配：
 *
 * 1. `sandbox` 不含 `allow-same-origin` → 运行时**读不到**编辑器的 DOM 与存储（9.1）；
 * 2. `sessionId` 每次挂载重新生成（随机 16 字节）→ 上一轮或同页其他脚本的伪造消息
 *    在 `acceptMessage()` 里被丢弃（`reason: 'session'`）；
 * 3. `kind` 白名单 + 方向校验 + 8MB 上限（9.2 末条）。
 *
 * 即“**传输**不需要保密（同源），**内容**必须可校验”。见 `protocol.ts` 的模块注释。
 *
 * ## 本文件只做收发与校验
 *
 * 状态推进全在 `GameController`。拆开的理由同 `protocol.ts`：协议（校验规则）能被协议测试
 * 独立覆盖，而“收到 `host:control{pause}` 后 tick 是否停止”属于状态机的断言。
 */
import { Diagnostics } from '@iforge/num'
import { acceptMessage, buildMessage, newSessionId, PROTOCOL_VERSION, REJECT_REASON_TEXT } from '@iforge/runtime'
import type { Envelope, GameKind, HostKind } from '@iforge/runtime'

import type { ControllerSink, GameController } from './controller.js'

/** 传输层依赖（可注入，便于测试用一对假通道而不是真 iframe）。 */
export interface HostTransport {
  post(message: unknown): void
  /** 监听来自宿主的 `message`；返回退订函数。 */
  subscribe(handler: (data: unknown) => void): () => void
}

/** 已建立的桥。 */
export interface Bridge {
  readonly sessionId: string
  /** 等待 `host:init`；`host:init` 到达时 resolve（9.3 第 1 步）。 */
  ready(): Promise<void>
  /** 关闭（解绑监听、停循环）。 */
  close(): void
}

/** 真实的 `window.parent` 传输（预览 iframe 的唯一通道）。 */
function windowTransport(self: Window): HostTransport {
  return {
    post: (message) => window.parent.postMessage(message, '*'),
    subscribe: (handler) => {
      const listener = (event: MessageEvent): void => handler(event.data)
      self.addEventListener('message', listener)
      return () => self.removeEventListener('message', listener)
    },
  }
}

/** 成对假通道（测试用）：`createChannelPair()` 给出互为对端的两个传输。 */
export function createChannelPair(): { host: HostTransport; game: HostTransport } {
  const hostHandlers = new Set<(data: unknown) => void>()
  const gameHandlers = new Set<(data: unknown) => void>()
  // 投递时**快照**监听器集合：处理过程中可能退订（如 `close()`），
  // 直接遍历同一个 Set 会让迭代器跳过元素。
  const deliver = (handlers: Set<(data: unknown) => void>, data: unknown): void => {
    for (const handler of [...handlers]) handler(data)
  }
  const host: HostTransport = {
    post: (message) => deliver(gameHandlers, message),
    subscribe: (handler) => {
      hostHandlers.add(handler)
      return () => {
        hostHandlers.delete(handler)
      }
    },
  }
  const game: HostTransport = {
    post: (message) => deliver(hostHandlers, message),
    subscribe: (handler) => {
      gameHandlers.add(handler)
      return () => {
        gameHandlers.delete(handler)
      }
    },
  }
  return { host, game }
}

/**
 * 建立预览桥。
 *
 * 生命周期（9.3）：
 * 1. 宿主 `host:init` → 控制器装入项目/存档；
 * 2. 控制器 `game:ready` → 宿主解锁交互与“打包”按钮；
 * 3. 之后是双向的 `host:patch`/`host:control` 与 `game:*`。
 */
export function createBridge(controller: GameController, transport: HostTransport, sessionId = newSessionId()): Bridge {
  let resolveInit: (() => void) | undefined
  const initPromise = new Promise<void>((resolve) => {
    resolveInit = resolve
  })

  const send = (kind: GameKind, payload: unknown): void => {
    const built = buildMessage(sessionId, kind, payload)
    if (!built.ok) {
      // 出站消息被自己的校验拒掉属于**编程错误**（kind 写错或 payload 超限），必须可见。
      Diagnostics.record('E_MSG_INVALID', `out:${kind}`, `出站消息被拒：${REJECT_REASON_TEXT[built.reason]}`)
      return
    }
    transport.post(built.message)
  }

  const sink: ControllerSink = {
    ready: (payload) => send('game:ready', payload),
    stats: (payload) => send('game:stats', payload),
    event: (payload) => send('game:event', payload),
    save: (payload) => send('game:save', payload),
    error: (payload) => send('game:error', payload),
  }
  controller.setSink(sink)

  const unsubscribe = transport.subscribe((data) => {
    const accepted = acceptMessage(data, sessionId, 'host')
    if (!accepted.ok) {
      // 9.2：未知 kind / 错误 sessionId / 超大 payload 一律**丢弃并计数**（`E_MSG_INVALID`）。
      Diagnostics.record('E_MSG_INVALID', 'in', `入站消息被拒：${REJECT_REASON_TEXT[accepted.reason]}`)
      return
    }
    dispatch(controller, accepted.message, sink, () => resolveInit?.())
  })

  return {
    sessionId,
    ready: () => initPromise,
    close() {
      unsubscribe()
      controller.dispose()
    },
  }
}

/**
 * 真实预览通道（iframe 内使用）。
 *
 * `sessionId` 必须由**宿主**给定（9.3 第 1 步）：`host:init` 自带这个 id，而运行时的
 * `acceptMessage` 会拿它比对入站信封。省略时自己生成一个（测试/直挂场景）。
 */
export function createWindowBridge(controller: GameController, sessionId = newSessionId()): Bridge {
  return createBridge(controller, windowTransport(window), sessionId)
}

/** 一条 `host:*` 消息的分发（9.2 的四个 kind）。 */
function dispatch(controller: GameController, message: Envelope, sink: ControllerSink, onInit: () => void): void {
  switch (message.kind) {
    case 'host:init':
      controller.applyInit(message.payload as Parameters<GameController['applyInit']>[0])
      onInit()
      return
    case 'host:patch': {
      const payload = message.payload as { patches?: Parameters<GameController['applyPatches']>[0] }
      controller.applyPatches(payload.patches ?? [])
      return
    }
    case 'host:control': {
      const payload = message.payload as { action?: Parameters<GameController['applyControl']>[0]; value?: unknown }
      if (payload.action) controller.applyControl(payload.action, payload.value)
      return
    }
    case 'host:save':
      // 9.2 的 `host:save`：宿主请求导出存档。经 postMessage 回传（`intent: 'export'`，
      // D-51）——宿主据此下载文件，而不是写进 IndexedDB。
      sink.save({ save: controller.exportSave(), intent: 'export' })
      return
    default:
      // `acceptMessage` 已按方向过滤，走到这里说明白名单与分发不同步。
      Diagnostics.record('E_MSG_INVALID', 'in', `未处理的 kind：${String((message as { kind: string }).kind)}`)
  }
}

export { PROTOCOL_VERSION, newSessionId }
export type { HostKind }
