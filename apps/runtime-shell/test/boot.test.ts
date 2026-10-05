/**
 * `mountGameRuntime()` 的装配契约（TECH_DESIGN 9.3 生命周期、11.1 直挂、ADR-05）。
 *
 * ## 为什么这条文件必须存在
 *
 * `boot.ts` 里曾经有一个只有**真正执行注入物**才会暴露的缺陷：它在判断“直挂还是预览”
 * 之前就无条件读 `bootstrap.project`，于是预览模式（没有 `__IFORGE_BOOTSTRAP__`）必崩。
 * 其它用例全都在 `mountGameRuntime` 之外直接 new `GameController`、并且都传了 `bootstrap`，
 * 所以 80 条用例全绿而预览区一片空白。这里把两条启动路径都钉住。
 */
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'

import { Diagnostics } from '@iforge/num'
import { createDefaultProject } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'
import { buildMessage } from '@iforge/runtime'
import type { Envelope } from '@iforge/runtime'

import { mountGameRuntime } from '../src/boot.js'
import { createChannelPair } from '../src/bridge.js'
import type { HostTransport } from '../src/bridge.js'

const SESSION = 'a'.repeat(32)

function envelope(kind: string, payload: unknown, sessionId = SESSION): Envelope {
  const built = buildMessage(sessionId, kind as never, payload)
  if (!built.ok) throw new Error(`buildMessage(${kind}) 被拒：${built.reason}`)
  return built.message
}

/** 与宿主同构的项目（一个资源 + 一个生成器 + 一个页面）。 */
function demoProject(): ProjectFile {
  const project = createDefaultProject()
  project.meta.name = '装配项目'
  project.resources = [
    {
      kind: 'resource',
      id: 'r1',
      order: 1,
      name: '矿石',
      description: '基础资源',
      icon: { kind: 'builtin', value: 'gem' },
      initial: '0',
      max: 'Infinity',
      visible: true,
    },
  ]
  project.pages = []
  project.pages.push({
    kind: 'page',
    id: 'p1',
    order: 1,
    name: '工厂',
    description: '主页面',
    icon: { kind: 'builtin', value: 'grid' },
    visible: true,
    disabled: false,
    theme: { kind: 'builtin', value: 'page-dark' },
    columns: 2,
    entries: [{ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } }],
  })
  return project
}

/** 收集 `game:*` 出站信封，并提供入站投递。 */
function fakeHost(): { host: HostTransport; outbox: Envelope[]; send(kind: string, payload: unknown, id?: string): void } {
  const pair = createChannelPair()
  const outbox: Envelope[] = []
  const originalPost = pair.host.post
  pair.host.post = (message) => {
    outbox.push(message as Envelope)
    originalPost(message)
  }
  return {
    host: pair.host,
    outbox,
    send: (kind, payload, id) => pair.game.post(envelope(kind, payload, id)),
  }
}

describe('9.3 / 11.1：两种启动方式、同一套代码', () => {
  it('挂载时把 .iforge-game 挂到 body（game.css 的作用域，漏了则全部规则不生效）', () => {
    const element = document.createElement('div')
    document.body.append(element)
    const runtime = mountGameRuntime({
      element,
      bootstrap: { project: demoProject() },
      requestFrame: () => 1,
      cancelFrame: () => undefined,
    })
    // 样式是否“注入了”由 `iframe-entry.ts` 负责，**是否命中**由这个类负责；
    // 少了它，功能全对但排版退化成浏览器默认样式，功能测试完全看不出来。
    expect(document.body.classList.contains('iforge-game')).toBe(true)
    runtime.dispose()
    element.remove()
    document.body.classList.remove('iforge-game')
  })

  /**
   * 装配时必须把真实 `document` 交给控制器（PRD 预览区 9 的“导入存档”）。
   *
   * 漏掉它的症状特别隐蔽：游戏内设置页的“导入存档”按钮点了**什么都不发生**
   * （控制器只记一条 `E_MSG_INVALID` 就返回），而单测全都直接调 `applyImportSaveText()`
   * 或自带 document，于是这条链路从未被覆盖过——只有真的在浏览器里点那个按钮才会发现。
   */
  it('控制器拿到真实 document：请求导入存档会创建文件选择器', () => {
    const element = document.createElement('div')
    document.body.append(element)
    const created: HTMLInputElement[] = []
    const originalCreate = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const node = originalCreate(tag)
      if (tag === 'input') created.push(node as HTMLInputElement)
      return node
    })

    const runtime = mountGameRuntime({
      element,
      bootstrap: { project: demoProject() },
      requestFrame: () => 1,
      cancelFrame: () => undefined,
    })
    runtime.controller.requestImportSave()

    expect(created).toHaveLength(1)
    expect(created[0]!.type).toBe('file')
    spy.mockRestore()
    runtime.dispose()
    element.remove()
    document.body.classList.remove('iforge-game')
  })

  it('预览模式：没有 bootstrap 也不崩，且在 host:init 之前不挂载任何东西', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const link = fakeHost()

    // 关键回归点：这里**不传** `bootstrap`。早先的实现在这里就抛
    // `TypeError: Cannot read properties of undefined (reading 'project')`。
    const runtime = mountGameRuntime({
      element,
      transport: link.host,
      sessionId: SESSION,
      projectId: 'p-1',
      requestFrame: () => 1,
      cancelFrame: () => undefined,
    })

    // 还没有项目 -> 没有可显示的状态 -> 一个节点都不该出现（9.3 第 1 步前）。
    expect(element.querySelector('[data-testid="game-root"]')).toBeNull()
    expect(link.outbox).toHaveLength(0)

    link.send('host:init', { project: demoProject(), projectId: 'p-1' })
    await act(async () => {
      await Promise.resolve()
    })

    expect(element.querySelector('[data-testid="game-root"]')).not.toBeNull()
    expect(element.querySelector('[data-testid="game-title"]')?.textContent).toBe('装配项目')
    // 9.3 第 2 步：握手完成后回 `game:ready`，信封带宿主给的同一个 sessionId。
    expect(link.outbox[0]?.kind).toBe('game:ready')
    expect(link.outbox[0]?.sessionId).toBe(SESSION)

    runtime.dispose()
    element.remove()
  })

  it('预览模式：sessionId 与宿主不一致时整条 host:* 都被丢弃（R-19）', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const link = fakeHost()

    const runtime = mountGameRuntime({
      element,
      transport: link.host,
      // 故意给一个与宿主不同的 id。
      sessionId: 'b'.repeat(32),
      requestFrame: () => 1,
      cancelFrame: () => undefined,
    })

    link.send('host:init', { project: demoProject(), projectId: 'p-1' })
    await act(async () => {
      await Promise.resolve()
    })

    expect(element.querySelector('[data-testid="game-root"]')).toBeNull()
    expect(link.outbox.map((message) => message.kind)).toEqual(['game:error'])
    expect(Diagnostics.countsSnapshot()['E_MSG_INVALID']).toBe(1)

    runtime.dispose()
    element.remove()
  })

  it('直挂模式：有 bootstrap 直接挂载并启动，不建桥也不等握手（17.3 / ADR-05）', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const frames: number[] = []
    const runtime = mountGameRuntime({
      element,
      bootstrap: { project: demoProject() },
      engineVersion: '1.0.0',
      requestFrame: (callback) => {
        frames.push(callback.length)
        return frames.length
      },
      cancelFrame: () => undefined,
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(runtime.bridge).toBeNull()
    expect(element.querySelector('[data-testid="game-title"]')?.textContent).toBe('装配项目')
    // 主循环已经排上了下一帧（直挂模式不需要握手）。
    expect(frames).toHaveLength(1)

    runtime.dispose()
    element.remove()
  })

  /**
   * 缺陷 3 的**结构**不变量：游戏必须挂在宿主/模板**已经给出的**挂载点里，
   * 而不是自己新建一个挂到 `body` 末尾。
   *
   * ## 为什么这条断言能挡住那一整屏空白
   *
   * 打包模板 `renderBundleHtml` 只在 `<body>` 里放 `<div id="app">`，并给它 `height: 100%`
   * （11.1/17.3）。若运行时把游戏挂到**另一个**新建的节点上，那个节点会排在 `#app`
   * **下方**：
   *
   * ```
   * #app                   top=0    bottom=941   height=941   <- 空的，整整一屏
   * 新建的挂载点            top=941  bottom=1882  height=941   <- 游戏在这里
   * ```
   *
   * 作者看到的就是“页面上半部分一大片留白、往下滚才看到游戏”，而数据、点击、导航、
   * 存档这类功能断言**全部通过**。因此这里断言“游戏节点是宿主给的节点的**后代**”，
   * 并顺带钉住“`body` 里不多出根节点”——它正是那条空白在 DOM 上的形状。
   */
  it('直挂模式：游戏挂在宿主给的挂载点内，`body` 里不多出根节点', async () => {
    // 按打包模板的形状搭 DOM：`<body>` 里**只有** `<div id="app">`。
    const app = document.createElement('div')
    app.id = 'app'
    document.body.append(app)

    const runtime = mountGameRuntime({
      element: app,
      bootstrap: { project: demoProject() },
      requestFrame: () => 1,
      cancelFrame: () => undefined,
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(app.querySelector('[data-testid="game-root"]'), '游戏必须挂在 #app 里').not.toBeNull()
    // `body` 里除 `#app` 与脚本/样式外不多出任何挂载点。
    const roots = [...document.body.children].filter((node) => node.tagName === 'DIV' && node !== app)
    expect(
      roots.map((node) => node.id),
      '不得另起挂载点',
    ).toEqual([])

    runtime.dispose()
    app.remove()
  })
})
