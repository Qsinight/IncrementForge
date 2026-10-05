/**
 * 消息协议（TECH_DESIGN 9.2、9.3、R-19、13 第 3 条、`E_MSG_INVALID`）。
 *
 * 门禁聚焦在 9.2 末段的四条丢弃规则上：**未知 kind / 错误 sessionId / 方向不对 /
 * 超大 payload 一律丢弃并计数**。这四条是 9.1 的“不透明源 iframe + `targetOrigin: '*'`”
 * 唯一的安全屏障——传输不需要保密，内容必须可校验（R-19）。
 */
import { describe, expect, it } from 'vitest'

import {
  acceptMessage,
  buildMessage,
  directionOf,
  GAME_KINDS,
  HOST_KINDS,
  isMessageKind,
  MAX_PAYLOAD_BYTES,
  MESSAGE_KINDS,
  newSessionId,
  PROTOCOL_VERSION,
  REJECT_REASON_TEXT,
  SESSION_ID_BYTES,
} from '../src/protocol.js'

const SESSION = 'a'.repeat(32)

describe('9.2：消息信封', () => {
  it('构造的消息带 v/sessionId/kind/payload 四个字段（9.2 的逐字格式）', () => {
    const built = buildMessage(SESSION, 'host:control', { action: 'pause' })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.message.v).toBe(PROTOCOL_VERSION)
    expect(built.message.sessionId).toBe(SESSION)
    expect(built.message.kind).toBe('host:control')
    expect(built.message.payload).toEqual({ action: 'pause' })
  })

  it('kind 枚举与 9.2 表的九个一致（宿主 4 + 运行时 5）', () => {
    expect([...HOST_KINDS]).toEqual(['host:init', 'host:patch', 'host:control', 'host:save'])
    expect([...GAME_KINDS]).toEqual(['game:ready', 'game:stats', 'game:event', 'game:save', 'game:error'])
    expect(MESSAGE_KINDS).toHaveLength(9)
  })

  it('方向表与 9.2 的 H→R / R→H 一致（宿主只收 game:*、运行时只收 host:*）', () => {
    for (const kind of HOST_KINDS) expect(directionOf(kind)).toBe('host')
    for (const kind of GAME_KINDS) expect(directionOf(kind)).toBe('game')
  })

  it('空 sessionId / 未知 kind 在构造侧就被拒（9.2 的白名单不是只在接收侧生效）', () => {
    expect(buildMessage('', 'host:init', {})).toEqual({ ok: false, reason: 'session' })
    const bogus = buildMessage(SESSION, 'game:hack' as never, {})
    expect(bogus).toEqual({ ok: false, reason: 'kind' })
  })

  it('超大 payload 在构造侧就被拒，避免把一个必然被丢的消息塞进 postMessage', () => {
    const huge = { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 10) }
    expect(buildMessage(SESSION, 'host:init', huge)).toEqual({ ok: false, reason: 'payload-size' })
  })

  it('循环引用载荷按“超限”处理（不可序列化的东西宁可丢弃也不抛给调用方）', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(buildMessage(SESSION, 'host:init', cyclic)).toEqual({ ok: false, reason: 'payload-size' })
  })

  it('isMessageKind 覆盖 `__proto__` 之类的原型链键（5.6 的无原型污染路径）', () => {
    expect(isMessageKind('__proto__')).toBe(false)
    expect(isMessageKind('constructor')).toBe(false)
    expect(isMessageKind('toString')).toBe(false)
    expect(isMessageKind('host:init')).toBe(true)
  })
})

describe('9.2：接收校验（丢弃并计数）', () => {
  const good = { v: PROTOCOL_VERSION, sessionId: SESSION, kind: 'game:ready' as const, payload: {} }

  it('合法信封按期望方向放行', () => {
    expect(acceptMessage(good, SESSION, 'game').ok).toBe(true)
    expect(acceptMessage({ ...good, kind: 'host:init' }, SESSION, 'host').ok).toBe(true)
  })

  it('错误 sessionId 被丢弃（上一轮预览的迟到消息，R-19）', () => {
    const result = acceptMessage({ ...good, sessionId: 'stale' }, SESSION, 'game')
    expect(result).toEqual({ ok: false, reason: 'session' })
  })

  it('未知 kind 被丢弃', () => {
    expect(acceptMessage({ ...good, kind: 'game:hack' }, SESSION, 'game')).toEqual({ ok: false, reason: 'kind' })
  })

  it('方向不对被丢弃：宿主不接受 host:*, 运行时不接受 game:*', () => {
    expect(acceptMessage(good, SESSION, 'host')).toEqual({ ok: false, reason: 'direction' })
    expect(acceptMessage({ ...good, kind: 'host:init' }, SESSION, 'game')).toEqual({ ok: false, reason: 'direction' })
  })

  it('版本不符被丢弃（协议升级时不会静默按旧语义解析）', () => {
    expect(acceptMessage({ ...good, v: 2 }, SESSION, 'game')).toEqual({ ok: false, reason: 'version' })
  })

  it('结构不对（非对象/缺 sessionId）被丢弃', () => {
    expect(acceptMessage(null, SESSION, 'game')).toEqual({ ok: false, reason: 'shape' })
    expect(acceptMessage('hello', SESSION, 'game')).toEqual({ ok: false, reason: 'shape' })
    expect(acceptMessage({ v: 1, kind: 'game:ready' }, SESSION, 'game')).toEqual({ ok: false, reason: 'shape' })
  })

  it('超大 payload 在接收侧同样被丢弃', () => {
    const result = acceptMessage({ ...good, payload: { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 10) } }, SESSION, 'game')
    expect(result).toEqual({ ok: false, reason: 'payload-size' })
  })

  it('每种拒绝原因都有可展示的文案（17.1 的 `E_MSG_INVALID` 提示方向）', () => {
    for (const reason of ['version', 'session', 'kind', 'direction', 'payload-size', 'shape'] as const) {
      expect(REJECT_REASON_TEXT[reason].length).toBeGreaterThan(0)
    }
  })
})

describe('9.1：sessionId', () => {
  it('是 16 字节（32 个十六进制字符），且两次生成不同', () => {
    const a = newSessionId()
    const b = newSessionId()
    expect(SESSION_ID_BYTES).toBe(16)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(b).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })
})
