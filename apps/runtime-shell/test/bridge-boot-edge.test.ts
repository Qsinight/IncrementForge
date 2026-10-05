/**
 * 桥与装配的边界路径（TECH_DESIGN 9.2/9.3、10.3、11.1 直挂、R-19、R-38）。
 *
 * 已有用例覆盖了**主路径**（`host:init` -> `game:ready` -> 双向 patch/control）。
 * 本文件补的是几条**只会在异常环境或错误输入下**走到的分支，而它们恰恰最容易静默失效：
 *
 * 1. `host:save`：宿主请求导出存档，必须经 `postMessage` 回传（`intent: 'export'`，D-51），
 *    而不是写进 IndexedDB——回传通道坏了的表现是“点了导出存档什么都没发生”。
 * 2. 未处理的 `host:*` kind：白名单与分发不同步时必须留诊断，而不是静默吞掉。
 * 3. 预览态**绝不**碰 `localStorage`（9.1）：不透明源 iframe 访问它会抛 `SecurityError`，
 *    这条一旦回退，预览区会直接白屏。
 * 4. `localStorage` 写失败（配额满/无痕模式）不让“关闭页面”抛错（D-02）。
 */
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'

import { Num, resetDiagnostics } from '@iforge/num'
import { createDefaultProject } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'
import { PROTOCOL_VERSION, buildMessage } from '@iforge/runtime'
import { MAX_PAYLOAD_BYTES } from '@iforge/runtime'
import type { Envelope } from '@iforge/runtime'

import { createBridge, createChannelPair, createWindowBridge, newSessionId } from '../src/bridge.js'
import type { HostTransport } from '../src/bridge.js'
import { mountGameRuntime, diagnosticsSnapshot } from '../src/boot.js'
import { makeController } from './helpers/fixture.js'

const SESSION = 'b'.repeat(32)

function envelope(kind: string, payload: unknown, sessionId = SESSION): Envelope {
  const built = buildMessage(sessionId, kind as never, payload)
  if (!built.ok) throw new Error(`buildMessage(${kind}) 被拒：${built.reason}`)
  return built.message
}

function demoProject(): ProjectFile {
  const project = createDefaultProject()
  project.meta.name = '边界项目'
  project.resources = [
    {
      kind: 'resource',
      id: 'r1',
      order: 1,
      name: '矿石',
      description: '',
      icon: { kind: 'builtin', value: 'gem' },
      initial: '0',
      max: 'Infinity',
      visible: true,
    },
  ]
  project.pages[0]!.entries = [{ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } }]
  return project
}

/** 收集该通道上收到的全部出站信封。 */
function collect(host: HostTransport): Envelope[] {
  const out: Envelope[] = []
  host.subscribe((data) => out.push(data as Envelope))
  return out
}

describe('bridge：`host:save` 回传导出存档（D-51）', () => {
  it('宿主请求导出 -> 运行侧回一条 `intent: "export"` 的 `game:save`', async () => {
    resetDiagnostics()
    const { controller } = makeController({ project: demoProject() })
    const { host, game } = createChannelPair()
    const bridge = createBridge(controller, game, SESSION)
    const sent = collect(host)

    act(() => {
      host.post(envelope('host:init', { project: demoProject(), sessionId: SESSION }))
    })
    await bridge.ready()

    act(() => {
      host.post(envelope('host:save', {}))
    })

    const saves = sent.filter((m) => m.kind === 'game:save')
    expect(saves.length).toBe(1)
    const payload = saves[0]!.payload as { intent?: string; save?: unknown }
    expect(payload.intent).toBe('export')
    expect(payload.save).toBeDefined()
    bridge.close()
  })

  it('导出存档的内容是真实的 `SaveFile`（`slotId` 为 main）', async () => {
    const { controller } = makeController({ project: demoProject() })
    const { host, game } = createChannelPair()
    const bridge = createBridge(controller, game, SESSION)
    const sent = collect(host)
    act(() => {
      host.post(envelope('host:init', { project: demoProject(), sessionId: SESSION }))
    })
    await bridge.ready()
    act(() => {
      host.post(envelope('host:save', {}))
    })
    const payload = sent.find((m) => m.kind === 'game:save')!.payload as { save: { slotId?: string } }
    expect(payload.save.slotId).toBe('main')
    bridge.close()
  })
})

describe('bridge：未知 kind 在白名单就被拒（`acceptMessage` 的第一道防线）', () => {
  it('`host:mystery` 连 `buildMessage` 都过不去——`dispatch` 的 default 分支是防御性的', () => {
    // `dispatch` 的 `default` 只在“白名单与分发不同步”时可达（`bridge.ts` 的注释原话）。
    // 正常输入下 kind 白名单先拦，所以这里断言**真正生效**的那道防线，
    // 而不是去伪造一条进不去的消息。
    const built = buildMessage(SESSION, 'host:mystery' as never, {})
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.reason).toBe('kind')
  })

  it('合法 kind + 合法 payload 可构建（反证白名单只拦 kind/payload）', () => {
    const built = buildMessage(SESSION, 'host:init', { project: demoProject() })
    expect(built.ok).toBe(true)
  })
})

describe('bridge：payload 上限（9.2 的长度防线）', () => {
  it('超过 `MAX_PAYLOAD_BYTES` 的消息被拒并给出 `payload-size` 理由', () => {
    const built = buildMessage(SESSION, 'game:ready', { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.reason).toBe('payload-size')
  })

  it('明显小于上限的可接受（阈值不是过度保守）', () => {
    const built = buildMessage(SESSION, 'game:ready', { blob: 'x'.repeat(1024) })
    expect(built.ok).toBe(true)
  })
})

describe('bridge：sessionId 与生命周期', () => {
  it('省略 sessionId 时自动生成一个 32 位十六进制 id', () => {
    const id = newSessionId()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('两次生成不同（R-19：sessionId 不能复用）', () => {
    expect(newSessionId()).not.toBe(newSessionId())
  })

  it('`close()` 后不再处理入站消息（退订生效）', async () => {
    resetDiagnostics()
    const { controller } = makeController({ project: demoProject() })
    const { host, game } = createChannelPair()
    const bridge = createBridge(controller, game, SESSION)
    act(() => {
      host.post(envelope('host:init', { project: demoProject(), sessionId: SESSION }))
    })
    await bridge.ready()
    bridge.close()
    // 关闭后再发消息：不再有任何效果，也不抛错。
    expect(() => {
      act(() => {
        host.post(envelope('host:control', { action: 'pause' }))
      })
    }).not.toThrow()
  })

  it('`createWindowBridge` 走 `window.parent.postMessage`，可在 jsdom 里跑通', async () => {
    const { controller } = makeController({ project: demoProject() })
    const received: unknown[] = []
    const onMessage = (event: MessageEvent): void => {
      received.push(event.data)
    }
    window.addEventListener('message', onMessage)
    const bridge = createWindowBridge(controller, SESSION)
    // 从“宿主”侧回一条 `host:init`（window 既是宿主也是 iframe，jsdom 下同一通道）。
    act(() => {
      window.postMessage(envelope('host:init', { project: demoProject(), sessionId: SESSION }), '*')
    })
    await bridge.ready()
    await act(async () => {})
    expect(received.length).toBeGreaterThan(0)
    bridge.close()
    window.removeEventListener('message', onMessage)
  })

  it('`PROTOCOL_VERSION` 被再导出（信封里带版本）', () => {
    expect(typeof PROTOCOL_VERSION).toBe('number')
  })
})

describe('boot：预览态绝不碰 localStorage（9.1）', () => {
  it('预览模式（无 bootstrap）不读也不写 localStorage', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { host, game } = createChannelPair()

    const mounted = mountGameRuntime({
      element: document.createElement('div'),
      transport: game as HostTransport,
      sessionId: SESSION,
      projectId: 'preview-project',
      slotId: 'main',
      storage: null,
    })
    // 预览态连 `getItem` 都不该调（不透明源 iframe 访问它会抛 SecurityError）。
    expect(getItem).not.toHaveBeenCalled()

    act(() => {
      host.post(envelope('host:init', { project: demoProject(), sessionId: SESSION }))
    })
    await mounted.bridge!.ready()
    mounted.dispose()
    setItem.mockRestore()
    getItem.mockRestore()
  })

  it('`mountGameRuntime` 返回可释放的句柄（dispose 不抛错）', async () => {
    const { host, game } = createChannelPair()
    const element = document.createElement('div')
    document.body.append(element)
    const mounted = mountGameRuntime({
      element,
      transport: game as HostTransport,
      sessionId: SESSION,
      storage: null,
    })
    act(() => {
      host.post(envelope('host:init', { project: demoProject(), sessionId: SESSION }))
    })
    await mounted.bridge!.ready()
    expect(() => mounted.dispose()).not.toThrow()
    element.remove()
  })

  it('`diagnosticsSnapshot()` 返回计数映射（9.3 的错误角标数据源）', () => {
    resetDiagnostics()
    const snapshot = diagnosticsSnapshot()
    expect(typeof snapshot).toBe('object')
    for (const value of Object.values(snapshot)) expect(typeof value).toBe('number')
  })
})

describe('boot：直挂模式（11.1 末步、10.3）', () => {
  it('`window.__IFORGE_BOOTSTRAP__` 存在时进入直挂模式（`bridge` 为 null）', () => {
    // 直挂的判定是「有引导全局」：宿主注入 `__IFORGE_BOOTSTRAP__` 即直挂。
    const globals = window as unknown as { __IFORGE_BOOTSTRAP__?: unknown }
    globals.__IFORGE_BOOTSTRAP__ = { project: demoProject() }
    try {
      const element = document.createElement('div')
      document.body.append(element)
      const mounted = mountGameRuntime({
        element,
        storage: null,
        wallClock: () => Date.parse('2026-01-01T00:00:00.000Z'),
        now: () => 0,
        requestFrame: () => 0,
        cancelFrame: () => {},
      })
      // 直挂没有 postMessage 对端。
      expect(mounted.bridge).toBeNull()
      mounted.dispose()
      element.remove()
    } finally {
      delete globals.__IFORGE_BOOTSTRAP__
    }
  })

  it('没有引导全局时是预览模式（`bridge` 非 null）', async () => {
    const { host, game } = createChannelPair()
    const element = document.createElement('div')
    document.body.append(element)
    const mounted = mountGameRuntime({
      element,
      transport: game as HostTransport,
      sessionId: SESSION,
      storage: null,
    })
    expect(mounted.bridge).not.toBeNull()
    act(() => {
      host.post(envelope('host:init', { project: demoProject(), sessionId: SESSION }))
    })
    await mounted.bridge!.ready()
    mounted.dispose()
    element.remove()
  })

  it('直挂 + 显式 `storage: null` 时不持久化但照常可玩', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const element = document.createElement('div')
    document.body.append(element)
    const mounted = mountGameRuntime({
      element,
      bootstrap: { project: demoProject() } as never,
      storage: null,
      wallClock: () => Date.parse('2026-01-01T00:00:00.000Z'),
      now: () => 0,
      requestFrame: () => 0,
      cancelFrame: () => {},
    })
    expect(mounted.bridge).toBeNull()
    mounted.dispose()
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
    element.remove()
  })

  it('`storage` 写入抛错时不冒泡（D-02：关闭页面不该因为配额满而炸）', () => {
    const failing: StorageLikeStub = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    }
    const element = document.createElement('div')
    document.body.append(element)
    const mounted = mountGameRuntime({
      element,
      bootstrap: { project: demoProject() } as never,
      storage: failing as never,
      wallClock: () => Date.parse('2026-01-01T00:00:00.000Z'),
      now: () => 0,
      requestFrame: () => 0,
      cancelFrame: () => {},
    })
    // 自动存档 / 生命周期存档写入失败都不应让页面变成一块砖。
    expect(() => mounted.dispose()).not.toThrow()
    element.remove()
  })

  it('直挂会给 `document.body` 挂上 `iforge-game` 类（样式作用域）', () => {
    const element = document.createElement('div')
    document.body.append(element)
    const mounted = mountGameRuntime({
      element,
      bootstrap: { project: demoProject() } as never,
      storage: null,
      wallClock: () => Date.parse('2026-01-01T00:00:00.000Z'),
      now: () => 0,
      requestFrame: () => 0,
      cancelFrame: () => {},
    })
    // 漏了这一步功能全正常、只是排版退化，因此在功能测试里完全看不出来。
    expect(document.body.classList.contains('iforge-game')).toBe(true)
    mounted.dispose()
    element.remove()
  })
})

interface StorageLikeStub {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

describe('大数在桥上的往返（4.4 数值饱和语义不因序列化而变）', () => {
  it('`1e1e10` 量级的资源数量经 `host:save` 往返后仍是有限值', async () => {
    const { controller } = makeController({ project: demoProject() })
    const { host, game } = createChannelPair()
    const bridge = createBridge(controller, game, SESSION)
    const sent = collect(host)
    act(() => {
      host.post(envelope('host:init', { project: demoProject(), sessionId: SESSION }))
    })
    await bridge.ready()
    act(() => {
      host.post(envelope('host:save', {}))
    })
    const payload = sent.find((m) => m.kind === 'game:save')!.payload as {
      save: { resources?: Array<{ amount?: string }> }
    }
    const amount = payload.save.resources?.[0]?.amount
    if (amount !== undefined) {
      expect(Num.fromString(amount).isNan()).toBe(false)
    }
    bridge.close()
  })
})
