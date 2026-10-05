/**
 * 预览桥的协议往返（TECH_DESIGN 9.2、9.3、13 第 3 条、R-19、`E_MSG_INVALID`）。
 *
 * 门禁盯住 R-19 的三条防线（`sessionId` / `kind` 白名单 / 长度上限）在**运行时侧**同样生效：
 * 一个“宿主发来的、看起来合法但其实不是本会话”的消息，必须既不改状态、也留下诊断。
 */
import { describe, expect, it } from 'vitest'

import { Diagnostics, Num } from '@iforge/num'
import { PROTOCOL_VERSION, buildMessage } from '@iforge/runtime'
import type { Envelope, MessageKind } from '@iforge/runtime'

import { createBridge, createChannelPair } from '../src/bridge.js'
import type { HostTransport } from '../src/bridge.js'
import { makeController } from './helpers/fixture.js'

function demoProject() {
  return {
    format: 'incrementforge-project' as const,
    version: 1 as const,
    engineVersion: '1.0.0',
    meta: {
      name: '桥接测试',
      author: '',
      description: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
    },
    settings: {
      numberFormat: 'standard' as const,
      tickRate: 20,
      maxFrameStep: 250,
      autosaveInterval: 30,
      offlineEnabled: true,
      offlineCap: 8,
    },
    resources: [
      {
        kind: 'resource' as const,
        id: 'r1',
        order: 1,
        name: '矿石',
        description: '',
        icon: { kind: 'builtin' as const, value: 'gem' },
        initial: '0',
        max: 'Infinity',
        visible: true,
      },
    ],
    generators: [],
    upgrades: [],
    pages: [
      {
        kind: 'page' as const,
        id: 'p1',
        order: 1,
        name: '主页面',
        description: '',
        icon: { kind: 'builtin' as const, value: 'grid' },
        visible: true,
        disabled: false,
        theme: { kind: 'builtin' as const, value: 'page-dark' },
        columns: 1,
        entries: [{ id: 'r1', order: 1, theme: { kind: 'builtin' as const, value: 'entry-dark' } }],
      },
    ],
    assets: {},
  }
}

/** 宿主与运行时各持一端，并记录“运行时 -> 宿主”的全部信封。 */
function connected() {
  const { host, game } = createChannelPair()
  const received: Record<string, unknown>[] = []
  // 记录必须挂在 **game 端**：`createBridge` 拿到的是运行时这一侧的传输，
  // 它的 `post` 才是出站方向（宿主往运行时发消息走的是 `host.post`）。
  const originalPost = game.post
  game.post = (message) => {
    received.push(message as Record<string, unknown>)
    originalPost(message)
  }
  const fixture = makeController({ project: demoProject() })
  const bridge = createBridge(fixture.controller, game as HostTransport, 'session-under-test')
  return { host, game, received, fixture, bridge }
}

/** 记录中指定 kind 的信封。 */
function ofKind(received: Record<string, unknown>[], kind: string): Record<string, unknown>[] {
  return received.filter((message) => message['kind'] === kind)
}

/**
 * 造一条 `host:*` 消息。
 *
 * `buildMessage()` 返回 `{ ok, message } | { ok, reason }`（9.2 的构造侧校验），
 * 测试里需要 `.message`，因此这里统一收窄一次——散落写 `if (!built.ok) throw` 会把
 * 20 处协议样板淹没真正的断言。
 */
function envelope<K extends MessageKind, P>(sessionId: string, kind: K, payload: P): Envelope<K, P> {
  const built = buildMessage(sessionId, kind, payload)
  if (!built.ok) throw new Error(`构造 ${kind} 失败：${built.reason}`)
  return built.message
}

describe('9.2/9.3：握手', () => {
  it('ready() 在 host:init 到达后 resolve，控制器随之装入项目', async () => {
    const { host, fixture, bridge } = connected()
    const init = bridge.ready()
    host.post(
      envelope('session-under-test', 'host:init', {
        project: demoProject(),
        settings: { tickRate: 30 },
        projectId: 'p',
      }),
    )
    await init
    expect(fixture.controller.state.effectiveSettings().tickRate).toBe(30)
    expect(fixture.controller.getView().title).toBe('桥接测试')
  })

  it('host:init 带存档时按 6.3 读档顺序重建，并结算离线（8.8）', async () => {
    const { host, fixture, bridge } = connected()
    const source = makeController({ project: demoProject() })
    source.controller.state.attrs.write('res.r1.amount', Num.fromNumber(500), '<test>')
    const save = source.controller.exportSave()
    // 让存档看起来是 1 小时前的。
    const stale = { ...save, savedAt: '2025-12-31T23:00:00.000Z', lastSeenAt: '2025-12-31T23:00:00.000Z' }

    const init = bridge.ready()
    host.post(envelope('session-under-test', 'host:init', { project: demoProject(), save: stale }))
    await init
    expect(fixture.controller.state.attrs.value(fixture.controller.state.attrs.find('res.r1')!, 'amount').toNumber()).toBe(500)
  })

  it('出站消息带 v / sessionId / kind / payload（9.2 的逐字格式）', async () => {
    const { host, received, fixture, bridge } = connected()
    const init = bridge.ready()
    host.post(envelope('session-under-test', 'host:init', { project: demoProject() }))
    await init
    fixture.controller.start()
    const ready = ofKind(received, 'game:ready')
    expect(ready).toHaveLength(1)
    expect(ready[0]!['v']).toBe(PROTOCOL_VERSION)
    expect(ready[0]!['sessionId']).toBe('session-under-test')
    expect(ready[0]!['payload']).toMatchObject({ engineVersion: '1.0.0' })
  })
})

describe('R-19：伪造与错序消息一律丢弃并计数', () => {
  it('错误 sessionId 的 host:init 被丢弃，项目不变', async () => {
    const { host, fixture, bridge } = connected()
    const other = demoProject()
    other.meta.name = '伪造的项目'
    host.post(envelope('someone-else', 'host:init', { project: other }))
    await Promise.resolve()
    expect(fixture.controller.getView().title).not.toBe('伪造的项目')
    expect(Diagnostics.count('E_MSG_INVALID')).toBeGreaterThan(0)
    void bridge
  })

  it('运行时只接受 host:*：收到 game:* 被丢弃', async () => {
    const { host, fixture, bridge } = connected()
    host.post(envelope('session-under-test', 'game:ready', {}))
    await Promise.resolve()
    expect(Diagnostics.count('E_MSG_INVALID')).toBeGreaterThan(0)
    void fixture
    void bridge
  })

  it('未知 kind 被丢弃且不抛异常', async () => {
    const { host, bridge } = connected()
    // 绕过 `buildMessage` 直接投一个信封——攻击者就是这么干的（伪造信封而不是构造合法消息）。
    expect(() => host.post({ v: PROTOCOL_VERSION, sessionId: 'session-under-test', kind: 'host:hack', payload: {} })).not.toThrow()
    await Promise.resolve()
    expect(Diagnostics.count('E_MSG_INVALID')).toBeGreaterThan(0)
    void bridge
  })

  it('非对象消息被丢弃', async () => {
    const { host, bridge } = connected()
    host.post('hello')
    host.post(null)
    await Promise.resolve()
    expect(Diagnostics.count('E_MSG_INVALID')).toBeGreaterThan(0)
    void bridge
  })
})

describe('9.2：host:control 的七个动作', () => {
  it('pause / resume 改变 flags.paused', async () => {
    const { host, fixture, bridge } = connected()
    const init = bridge.ready()
    host.post(envelope('session-under-test', 'host:init', { project: demoProject() }))
    await init
    host.post(envelope('session-under-test', 'host:control', { action: 'pause' }))
    expect(fixture.controller.state.flags.paused).toBe(true)
    host.post(envelope('session-under-test', 'host:control', { action: 'resume' }))
    expect(fixture.controller.state.flags.paused).toBe(false)
  })

  it('speed 只改 flags.speed，不改 tickRate（D-31）', async () => {
    const { host, fixture, bridge } = connected()
    const init = bridge.ready()
    host.post(envelope('session-under-test', 'host:init', { project: demoProject() }))
    await init
    host.post(envelope('session-under-test', 'host:control', { action: 'speed', value: 5 }))
    expect(fixture.controller.state.flags.speed).toBe(5)
    expect(fixture.controller.state.effectiveSettings().tickRate).toBe(20)
  })

  it('unlockAll 一次性解锁页面与条目（D-16）', async () => {
    const { host, fixture, bridge } = connected()
    const init = bridge.ready()
    host.post(envelope('session-under-test', 'host:init', { project: demoProject() }))
    await init
    fixture.controller.state.attrs.find('page.p1')!.visible = false
    host.post(envelope('session-under-test', 'host:control', { action: 'unlockAll' }))
    expect(fixture.controller.state.attrs.find('page.p1')!.visible).toBe(true)
  })

  it('restart 复位（8.10 的重新开始）', async () => {
    const { host, fixture, bridge } = connected()
    const init = bridge.ready()
    host.post(envelope('session-under-test', 'host:init', { project: demoProject() }))
    await init
    fixture.controller.state.attrs.write('res.r1.amount', 999 as never, '<test>')
    host.post(envelope('session-under-test', 'host:control', { action: 'restart' }))
    expect(fixture.controller.state.attrs.value(fixture.controller.state.attrs.find('res.r1')!, 'amount').toNumber()).toBe(0)
  })

  it('settings 下发会话覆盖（D-22）', async () => {
    const { host, fixture, bridge } = connected()
    const init = bridge.ready()
    host.post(envelope('session-under-test', 'host:init', { project: demoProject() }))
    await init
    host.post(envelope('session-under-test', 'host:control', { action: 'settings', value: { tickRate: 60 } }))
    expect(fixture.controller.state.effectiveSettings().tickRate).toBe(60)
  })

  it('device 只记录不参与结算（9.1：设备模拟只改宿主容器宽度）', async () => {
    const { host, fixture, bridge } = connected()
    const init = bridge.ready()
    host.post(envelope('session-under-test', 'host:init', { project: demoProject() }))
    await init
    const before = JSON.stringify(fixture.controller.state.project)
    host.post(envelope('session-under-test', 'host:control', { action: 'device', value: 'phone' }))
    expect(JSON.stringify(fixture.controller.state.project)).toBe(before)
    expect(fixture.controller.state.flags.paused).toBe(false)
  })
})

describe('9.2：host:patch 与 host:save', () => {
  it('host:patch 应用条目级补丁并保留进度（7.4）', async () => {
    const { host, fixture, bridge } = connected()
    const init = bridge.ready()
    host.post(envelope('session-under-test', 'host:init', { project: demoProject() }))
    await init
    fixture.controller.state.attrs.write('res.r1.amount', Num.fromNumber(42), '<test>')
    const next = demoProject()
    next.resources = next.resources.map((r) => ({ ...r, name: '新矿石' }))
    host.post(envelope('session-under-test', 'host:patch', { patches: [{ op: 'upsert', target: 'resources', id: 'r1', data: next.resources[0] }] }))
    expect(fixture.controller.getView().page!.entries[0]!.name).toBe('新矿石')
    expect(fixture.controller.state.attrs.value(fixture.controller.state.attrs.find('res.r1')!, 'amount').toNumber()).toBe(42)
  })

  it('host:save 回传存档并带 export 意图（D-51）', async () => {
    const { host, received, bridge } = connected()
    const init = bridge.ready()
    host.post(envelope('session-under-test', 'host:init', { project: demoProject() }))
    await init
    host.post(envelope('session-under-test', 'host:save', { silent: false }))
    const saves = ofKind(received, 'game:save')
    expect(saves).toHaveLength(1)
    expect(saves[0]!['payload']).toMatchObject({ intent: 'export' })
  })
})

describe('close()', () => {
  it('关闭后不再处理消息、不再请求帧', async () => {
    const { host, fixture, bridge } = connected()
    const init = bridge.ready()
    host.post(envelope('session-under-test', 'host:init', { project: demoProject() }))
    await init
    fixture.controller.start()
    expect(fixture.frames.pending).toBe(1)
    bridge.close()
    expect(fixture.frames.pending).toBe(0)
    const before = Diagnostics.count('E_MSG_INVALID')
    host.post(envelope('session-under-test', 'host:control', { action: 'pause' }))
    expect(Diagnostics.count('E_MSG_INVALID')).toBe(before)
  })
})
