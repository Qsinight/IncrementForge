/**
 * 预览区（TECH_DESIGN 7.1 模拟设置栏、9.1 沙箱、9.2 协议宿主侧、9.3 生命周期、
 * 7.4 同步到预览、D-16/D-22/D-31/D-41/D-42）。
 *
 * jsdom 不实现 `srcdoc` iframe 的真实执行，因此这里**不**去断言 iframe 里的游戏内容
 * （那是 `apps/runtime-shell` 的职责）。这里守的是宿主侧的四件事：
 * 1. iframe 的 `sandbox` **不含** `allow-same-origin`（9.1 的硬要求）；
 * 2. 模拟设置栏的每个控件都变成一条 `host:control`（9.2）；
 * 3. 编辑器改动经 `host:patch` 同步且保留进度（7.4）；
 * 4. 游戏内改设置只写 `previewStore`，**不写项目文件**（D-22、R-24）。
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { PROTOCOL_VERSION, buildMessage } from '@iforge/runtime'
import type { Envelope, MessageKind } from '@iforge/runtime'
import { createDefaultProject } from '@iforge/model'

import { PreviewPane } from '../src/app/PreviewPane.js'
import { PREVIEW_SANDBOX, activeSession, requestSave, sendActiveControl } from '../src/features/preview/session.js'
import { usePreviewStore } from '../src/stores/preview.js'
import { useProjectStore } from '../src/stores/project.js'

/**
 * 抓取宿主发给运行时的全部消息。
 *
 * jsdom 里 `iframe.contentWindow` 是 `null`，`postMessage` 静默失败——因此这里用
 * `Object.defineProperty` 把它换成一个只记录不发送的假对象。用 `delete` 而不是
 * `restore()` 恢复，是因为 jsdom 上 `contentWindow` 是原型上的访问器而非自有属性。
 */
function captureOutbound(): { messages: Record<string, unknown>[]; of(kind: string): Record<string, unknown>[] } {
  const messages: Record<string, unknown>[] = []
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get() {
      return {
        postMessage(message: unknown) {
          messages.push(message as Record<string, unknown>)
        },
      }
    },
  })
  return {
    messages,
    of: (kind) => messages.filter((message) => message['kind'] === kind),
  }
}

function restoreOutbound(): void {
  delete (HTMLIFrameElement.prototype as unknown as Record<string, unknown>)['contentWindow']
}

/**
 * 造一条 `game:*` 信封（收窄 `buildMessage` 的 `{ ok, message } | { ok, reason }`）。
 *
 * 测试要关心的是**收上来的消息**长什么样，不是构造侧的校验分支，因此在**一个**地方
 * 收窄，其余调用点保持一行。
 */
function incoming<K extends MessageKind, P>(sessionId: string, kind: K, payload: P): Envelope<K, P> {
  const built = buildMessage(sessionId, kind, payload)
  if (!built.ok) throw new Error(`构造 ${kind} 失败：${built.reason}`)
  return built.message
}

describe('9.1：iframe 沙箱', () => {
  it('sandbox 不含 allow-same-origin（运行时必须处在不透明源）', () => {
    render(<PreviewPane />)
    const iframe = document.querySelector('iframe[title="game-preview"]')
    expect(iframe).not.toBeNull()
    const sandbox = iframe!.getAttribute('sandbox') ?? ''
    expect(sandbox).toBe(PREVIEW_SANDBOX)
    expect(sandbox).not.toContain('allow-same-origin')
    expect(sandbox).toContain('allow-scripts')
  })

  it('srcdoc 含运行时脚本与根节点（9.1 的“脚本注入 srcdoc”）', () => {
    render(<PreviewPane />)
    const iframe = document.querySelector('iframe[title="game-preview"]')!
    const srcdoc = iframe.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('id="iforge-root"')
    expect(srcdoc).toContain('<script>')
    expect(srcdoc.length).toBeGreaterThan(100)
  })

  it('srcdoc 的挂载点带 data-session-id（运行时据此校验入站信封，R-19）', async () => {
    render(<PreviewPane />)
    await waitFor(() => expect(activeSession()).not.toBeNull())
    const iframe = document.querySelector('iframe[title="game-preview"]')!
    const sessionId = usePreviewStore.getState().sessionId
    // 宿主与运行时必须共用一个 id：两端各生成一个的话，`host:init` 会被当成伪造消息丢掉。
    expect(iframe.getAttribute('srcdoc')).toContain(`data-session-id="${sessionId}"`)
    expect(iframe.getAttribute('data-session-id')).toBe(sessionId)
  })
})

describe('9.3：host:init 在 load 时补发一次', () => {
  it('load 之前发出的 host:init 可能落进空的 about:blank，补发保证送达', async () => {
    const outbound = captureOutbound()
    try {
      render(<PreviewPane />)
      await waitFor(() => expect(outbound.of('host:init')).toHaveLength(1))
      // jsdom 不真正加载 srcdoc，这里手动触发一次 load。
      document.querySelector('iframe[title="game-preview"]')!.dispatchEvent(new Event('load'))
      await waitFor(() => expect(outbound.of('host:init')).toHaveLength(2))
      // 补发必须带**同一个** sessionId，否则运行时照样拒收。
      expect(outbound.of('host:init').map((message) => message['sessionId'])).toEqual([
        usePreviewStore.getState().sessionId,
        usePreviewStore.getState().sessionId,
      ])
    } finally {
      restoreOutbound()
    }
  })

  it('会话销毁后不再补发（load 监听被摘掉）', async () => {
    const outbound = captureOutbound()
    try {
      const view = render(<PreviewPane />)
      await waitFor(() => expect(outbound.of('host:init')).toHaveLength(1))
      view.unmount()
      const iframe = document.createElement('iframe')
      iframe.title = 'game-preview'
      document.body.append(iframe)
      iframe.dispatchEvent(new Event('load'))
      expect(outbound.of('host:init')).toHaveLength(1)
      iframe.remove()
    } finally {
      restoreOutbound()
    }
  })
})

describe('9.3：host:init 紧随 iframe 创建发出', () => {
  it('挂载后发出带当前项目的 host:init', async () => {
    const outbound = captureOutbound()
    try {
      useProjectStore.setState({ project: { ...createDefaultProject(), meta: { ...createDefaultProject().meta, name: '测试项目' } } })
      render(<PreviewPane />)
      await waitFor(() => expect(outbound.of('host:init')).toHaveLength(1))
      const init = outbound.of('host:init')[0]!
      expect(init['v']).toBe(PROTOCOL_VERSION)
      expect(init['sessionId']).toBe(usePreviewStore.getState().sessionId)
      expect((init['payload'] as { project: { meta: { name: string } } }).project.meta.name).toBe('测试项目')
    } finally {
      restoreOutbound()
    }
  })

  it('每条出站消息都带同一个 sessionId（R-19 的会话屏障）', async () => {
    const outbound = captureOutbound()
    try {
      render(<PreviewPane />)
      await waitFor(() => expect(outbound.messages.length).toBeGreaterThan(0))
      const sessionIds = new Set(outbound.messages.map((message) => message['sessionId']))
      expect(sessionIds.size).toBe(1)
    } finally {
      restoreOutbound()
    }
  })
})

/** 只取指定 action 的 `host:control` payload。 */
function controlsOf(outbound: { of(kind: string): Record<string, unknown>[] }, action: string): unknown[] {
  return outbound
    .of('host:control')
    .map((message) => message['payload'] as { action: string; value?: unknown })
    .filter((payload) => payload.action === action)
}

describe('7.1 / 9.2：模拟设置栏 -> host:control', () => {
  it('挂载时会先把当前倍速/设备/暂停态告诉运行时（否则运行时不知道宿主的设置）', async () => {
    const outbound = captureOutbound()
    try {
      render(<PreviewPane />)
      await waitFor(() => expect(outbound.of('host:init')).toHaveLength(1))
      await waitFor(() => expect(controlsOf(outbound, 'speed')).not.toHaveLength(0))
      expect(controlsOf(outbound, 'speed')).toContainEqual({ action: 'speed', value: 1 })
      expect(controlsOf(outbound, 'device')).toContainEqual({ action: 'device', value: 'auto' })
      expect(controlsOf(outbound, 'resume')).toContainEqual({ action: 'resume', value: undefined })
    } finally {
      restoreOutbound()
    }
  })

  it('设备三选一改变预览容器宽度与断点列数（D-41 表）', async () => {
    const user = userEvent.setup()
    render(<PreviewPane />)
    const widthOf = () => (document.querySelector('.preview-device') as HTMLElement | null)?.style.maxWidth ?? ''

    await user.click(screen.getByTestId('preview-device-phone'))
    expect(widthOf()).toBe('390px')
    await user.click(screen.getByTestId('preview-device-tablet'))
    expect(widthOf()).toBe('834px')
    await user.click(screen.getByTestId('preview-device-auto'))
    // auto = 容器宽度：不设上限。
    expect(widthOf()).toBe('')
  })

  it('暂停/继续发出 pause / resume', async () => {
    const user = userEvent.setup()
    const outbound = captureOutbound()
    try {
      render(<PreviewPane />)
      await waitFor(() => expect(outbound.of('host:init')).toHaveLength(1))
      await user.click(screen.getByTestId('preview-pause'))
      await waitFor(() => expect(controlsOf(outbound, 'pause')).toHaveLength(1))
      await user.click(screen.getByTestId('preview-pause'))
      await waitFor(() => expect(controlsOf(outbound, 'resume')).toHaveLength(2))
    } finally {
      restoreOutbound()
    }
  })

  it('倍速下拉发出 speed（D-31 的四个档位）', async () => {
    const user = userEvent.setup()
    const outbound = captureOutbound()
    try {
      render(<PreviewPane />)
      await waitFor(() => expect(outbound.of('host:init')).toHaveLength(1))
      await user.selectOptions(screen.getByTestId('preview-speed'), '5')
      await waitFor(() => expect(controlsOf(outbound, 'speed')).toContainEqual({ action: 'speed', value: 5 }))
      // 档位集合固定为 1/2/5/10。
      expect(screen.getByTestId('preview-speed').querySelectorAll('option')).toHaveLength(4)
    } finally {
      restoreOutbound()
    }
  })

  it('“解锁全部”发出 unlockAll（D-16），重复点击仍只发一次（一次性动作）', async () => {
    const user = userEvent.setup()
    const outbound = captureOutbound()
    try {
      render(<PreviewPane />)
      await waitFor(() => expect(outbound.of('host:init')).toHaveLength(1))
      await user.click(screen.getByTestId('preview-unlock'))
      await user.click(screen.getByTestId('preview-unlock'))
      await waitFor(() => expect(controlsOf(outbound, 'unlockAll')).toHaveLength(1))
    } finally {
      restoreOutbound()
    }
  })

  it('“重新开始”需要二次确认，确认后才发 restart（D-18）', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const outbound = captureOutbound()
    try {
      render(<PreviewPane />)
      await waitFor(() => expect(outbound.of('host:init')).toHaveLength(1))
      await user.click(screen.getByTestId('preview-restart'))
      expect(confirmSpy).toHaveBeenCalled()
      expect(controlsOf(outbound, 'restart')).toHaveLength(0)

      confirmSpy.mockReturnValue(true)
      await user.click(screen.getByTestId('preview-restart'))
      await waitFor(() => expect(controlsOf(outbound, 'restart')).toHaveLength(1))
    } finally {
      confirmSpy.mockRestore()
      restoreOutbound()
    }
  })

  it('“导出存档”发出 host:save{silent:false}（9.2 的显式导出请求）', async () => {
    const user = userEvent.setup()
    const outbound = captureOutbound()
    try {
      render(<PreviewPane />)
      await waitFor(() => expect(outbound.of('host:init')).toHaveLength(1))
      await user.click(screen.getByTestId('preview-export-save'))
      await waitFor(() => expect(outbound.of('host:save')).toHaveLength(1))
      expect(outbound.of('host:save')[0]!['payload']).toEqual({ silent: false })
    } finally {
      restoreOutbound()
    }
  })

  it('无会话时 sendActiveControl 返回 false（UI 不该静默失败）', () => {
    expect(activeSession()).toBeNull()
    expect(sendActiveControl('pause')).toBe(false)
    expect(requestSave({ send: () => true } as never, true)).toBe(true)
  })
})

describe('7.4：编辑器改动 -> host:patch', () => {
  it('改动项目后发出条目级补丁，且保留运行时会话', async () => {
    const user = userEvent.setup()
    const outbound = captureOutbound()
    try {
      const project = createDefaultProject()
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
      useProjectStore.setState({ project, revision: 0 })
      render(<PreviewPane />)
      await waitFor(() => expect(outbound.of('host:init')).toHaveLength(1))

      useProjectStore.getState().commit('重命名', (draft) => {
        draft.resources[0]!.name = '矿石 II'
      })
      await waitFor(() => expect(outbound.of('host:patch')).toHaveLength(1))
      const patches = (outbound.of('host:patch')[0]!['payload'] as { patches: { op: string; target: string; id?: string }[] }).patches
      expect(patches).toEqual([{ op: 'upsert', target: 'resources', id: 'r1', data: expect.objectContaining({ name: '矿石 II' }) }])
      // 补丁**不**重置会话：sessionId 保持不变。
      expect(outbound.of('host:patch')[0]!['sessionId']).toBe(usePreviewStore.getState().sessionId)
      void user
    } finally {
      restoreOutbound()
    }
  })
})

describe('D-22 / R-24：游戏内设置的会话覆盖只落在 previewStore', () => {
  it('收到 game:event{settings} 时只更新会话覆盖，项目文件不变', async () => {
    render(<PreviewPane />)
    await waitFor(() => expect(activeSession()).not.toBeNull())
    const projectBefore = JSON.stringify(useProjectStore.getState().project.settings)
    const sessionId = usePreviewStore.getState().sessionId

    window.dispatchEvent(
      new MessageEvent('message', {
        data: incoming(sessionId, 'game:event', { type: 'settings', payload: { tickRate: 60 } }),
      }),
    )
    await waitFor(() => expect(usePreviewStore.getState().settingsOverride['tickRate']).toBe(60))
    expect(JSON.stringify(useProjectStore.getState().project.settings)).toBe(projectBefore)
  })

  it('非法信封被丢弃并计数（E_MSG_INVALID、R-19）', async () => {
    render(<PreviewPane />)
    await waitFor(() => expect(activeSession()).not.toBeNull())
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { v: 1, sessionId: 'wrong-session', kind: 'game:ready', payload: {} },
      }),
    )
    await waitFor(() => expect(usePreviewStore.getState().diagnostics['E_MSG_INVALID']).toBeGreaterThan(0))
  })

  it('game:error 累积诊断明细，角标可展开（7.1 末条、9.3 第 3 步）', async () => {
    const user = userEvent.setup()
    render(<PreviewPane />)
    await waitFor(() => expect(activeSession()).not.toBeNull())
    const sessionId = usePreviewStore.getState().sessionId

    window.dispatchEvent(
      new MessageEvent('message', {
        data: incoming(sessionId, 'game:error', {
          code: 'E_PARSE',
          message: '语法错误',
          where: 'gen.g1.costs[0].amount',
          tick: 7,
        }),
      }),
    )
    // 断言按**错误码**计数，而不是角标总数：总数还会包含别的码（如本文件里其它用例
    // 触发的 E_MSG_INVALID），用它做断言会让红灯指向错误的改动。
    await waitFor(() => expect(usePreviewStore.getState().diagnostics['E_PARSE']).toBe(1))
    const badge = await screen.findByTestId('preview-diagnostics')
    await user.click(badge)
    expect(screen.getByTestId('preview-diagnostics-panel')).toBeInTheDocument()
    const row = screen.getByTestId('diagnostic-row')
    expect(row).toHaveTextContent('E_PARSE')
    expect(row).toHaveTextContent('gen.g1.costs[0].amount')
    expect(row).toHaveTextContent('语法错误')
  })

  it('game:ready 把连接状态切到 ready（9.3 第 2 步：解锁交互与打包按钮）', async () => {
    render(<PreviewPane />)
    await waitFor(() => expect(activeSession()).not.toBeNull())
    expect(screen.getByTestId('preview-status')).toBeInTheDocument()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: incoming(usePreviewStore.getState().sessionId, 'game:ready', { engineVersion: '1.0.0', warnings: [] }),
      }),
    )
    await waitFor(() => expect(usePreviewStore.getState().status).toBe('ready'))
    expect(screen.queryByTestId('preview-status')).toBeNull()
  })

  it('game:stats 记入 previewStore（≤10Hz 的节流由运行时负责，宿主只镜像）', async () => {
    render(<PreviewPane />)
    await waitFor(() => expect(activeSession()).not.toBeNull())
    window.dispatchEvent(
      new MessageEvent('message', {
        data: incoming(usePreviewStore.getState().sessionId, 'game:stats', {
          rates: [{ id: 'r1', amount: '1.5K', rate: '12' }],
          nextBuy: { id: 'g1', name: '矿机', dt: '3.5' },
          tickMs: 0.42,
          fps: 59.4,
        }),
      }),
    )
    await waitFor(() => expect(usePreviewStore.getState().stats).not.toBeNull())
    expect(screen.getByTestId('preview-stats')).toHaveTextContent('0.42ms')
  })
})

describe('D-42 / R-32：模拟设置栏属于编辑器外壳', () => {
  it('模拟设置栏在预览面板内（不是游戏内容）', () => {
    render(<PreviewPane />)
    expect(screen.getByTestId('preview-pause')).toBeInTheDocument()
    expect(screen.getByTestId('preview-unlock')).toBeInTheDocument()
    expect(screen.getByTestId('preview-speed')).toBeInTheDocument()
  })

  it('折叠面板后不渲染 iframe（面板宽度/折叠属 UI 偏好，不进历史）', async () => {
    const user = userEvent.setup()
    render(<PreviewPane />)
    expect(document.querySelector('iframe')).not.toBeNull()
    await user.click(screen.getByTestId('preview-collapse'))
    expect(document.querySelector('iframe')).toBeNull()
  })
})
