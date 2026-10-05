import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'

import { buildMessage, PROTOCOL_VERSION } from '@iforge/runtime'

import { buildSrcdoc, PREVIEW_SANDBOX } from '../src/features/preview/session.js'
import { iforgeRuntimeShell, invalidateRuntimeShellCache } from '../vite/iforge-runtime-shell'

/**
 * **端到端**：把真正的 esbuild 产物注入 `srcdoc`，在 jsdom 里执行，断言游戏视图出现。
 *
 * ## 为什么必须真的执行产物
 *
 * M4 的交付标准是“预览与运行时数据一致”。前面两组用例已经分别证明了
 * “视图模型 = 运行时”与“DOM = 视图模型”，但它们都**绕开了**注入物——
 * 如果注入物本身有问题（IIFE 里残留 ESM 语法、挂载点 id 不匹配、握手等不到
 * `host:init`），这些用例照样全绿，而真机上预览区是一片空白。
 *
 * 这条用例把整条链路串起来：`buildSrcdoc(esbuild 产物)` → jsdom 执行 → 注入 `host:init`
 * → 断言 iframe 内部渲染出了运行时算出来的数字。
 */
/**
 * 把真正的 esbuild 产物作为**顶层文档**跑起来，并按 9.1/9.2 的方式与它对话。
 *
 * ## 为什么不是 `new JSDOM(hostHtmlWithIframeSrcdoc)`
 *
 * jsdom 不实现 iframe 的 `srcdoc`（会给出一个空的 `about:blank`），因此这条路走不通。
 * 这里退一步：把 `srcdoc` 的内容直接当主文档加载，并替换两处**传输**：
 * - 出站：`window.parent.postMessage` 被换成收集器（顶层窗口的 `parent` 就是自己，
 *   不换的话运行时的每条 `game:*` 都会被自己的监听器当成“方向不对”拒掉）；
 * - 入站：直接 `dispatchEvent(new MessageEvent('message', …))`，与 `postMessage` 投递
 *   到同一监听器完全等价。
 *
 * 被跳过的是**浏览器自己的 postMessage 管线**（不是我们的代码），而它由编辑器的单测
 * （`test/preview.test.tsx` 替换 `iframe.contentWindow` 并断言出站信封）覆盖。
 * 这里守的是另一段同样容易断的链路：注入物能执行、样式进了文档、挂载点对得上、
 * 握手能完成、视图渲染出来。
 */
async function mountedFrame(project: unknown, sessionId = 'e2e-session') {
  invalidateRuntimeShellCache()
  const plugin = iforgeRuntimeShell()
  const resolveId = plugin.resolveId as (id: string) => string | undefined
  const load = plugin.load as (id: string) => Promise<string | undefined>
  const resolved = resolveId.call(plugin as never, 'virtual:iforge-runtime-shell')
  const module = await load.call(plugin as never, resolved as string)
  const script = JSON.parse((module as string).slice('export default '.length).trim()) as string

  // `sessionId` 写进 `srcdoc`（见 `session.ts` 的说明）：两端必须共用同一个 id，
  // 否则运行时会把宿主的 `host:init` 当成伪造消息丢掉（`reason: 'session'`）。
  const dom = new JSDOM(buildSrcdoc(script, sessionId), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://preview.test/',
  })
  const outbox: Record<string, unknown>[] = []
  // 顶层窗口的 `parent === window`，不替换的话出站消息会被运行时自己拒收（方向校验）。
  const collect = (message: unknown): void => {
    outbox.push(message as Record<string, unknown>)
  }
  dom.window.postMessage = collect as unknown as typeof dom.window.postMessage

  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  await settle(60)

  const envelope = (kind: string, payload: unknown, id = sessionId): unknown => {
    const built = buildMessage(id, kind as never, payload)
    if (!built.ok) throw new Error(`buildMessage(${kind}) 被拒：${built.reason}`)
    return built.message
  }
  const send = (kind: string, payload: unknown, id?: string): void => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: envelope(kind, payload, id),
      }),
    )
  }

  send('host:init', { project, projectId: 'e2e' })
  await settle(200)
  return { dom, win: dom.window, doc: dom.window.document, outbox, send, settle }
}

/** 四类条目齐备的最小项目（与 runtime-shell 的视图用例同构）。 */
function demoProject() {
  return {
    format: 'incrementforge-project',
    version: 1,
    engineVersion: '1.0.0',
    meta: {
      name: '端到端项目',
      author: 'IncrementForge',
      description: '注入物冒烟',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
    },
    settings: {
      numberFormat: 'standard',
      tickRate: 20,
      maxFrameStep: 250,
      autosaveInterval: 30,
      offlineEnabled: true,
      offlineCap: 8,
    },
    resources: [
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
    ],
    generators: [
      {
        kind: 'generator',
        id: 'g1',
        order: 1,
        name: '矿机',
        description: '自动产出矿石',
        icon: { kind: 'builtin', value: 'factory' },
        initial: '0',
        max: 'Infinity',
        visible: true,
        disabled: false,
        isClicker: false,
        buyAmount: '1',
        buyDelay: 1,
        costs: [{ materialId: 'r1', amount: '10' }],
        produces: [{ materialId: 'r1', amount: '1' }],
      },
      {
        kind: 'generator',
        id: 'g2',
        order: 2,
        name: '手动敲击',
        description: '点击获得矿石',
        icon: { kind: 'builtin', value: 'hand' },
        initial: '1',
        max: '10',
        visible: true,
        disabled: false,
        isClicker: true,
        buyAmount: '1',
        buyDelay: 1,
        costs: [],
        produces: [{ materialId: 'r1', amount: '1' }],
      },
    ],
    upgrades: [],
    pages: [
      {
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
        entries: [
          { id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } },
          { id: 'g1', order: 2, theme: { kind: 'builtin', value: 'entry-dark' } },
          { id: 'g2', order: 3, theme: { kind: 'builtin', value: 'entry-dark' } },
        ],
      },
    ],
    assets: {},
  }
}

describe('9.1 + 9.2：注入物端到端（产物真的能被执行、能渲染出运行时数据）', () => {
  it('sandbox 属性与 9.1 逐字一致（allow-scripts + pointer-lock，无 same-origin）', () => {
    expect(PREVIEW_SANDBOX).toBe('allow-scripts allow-pointer-lock')
    expect(PREVIEW_SANDBOX).not.toContain('allow-same-origin')
  })

  it('收到 host:init 后渲染出游戏视图，数字与运行时一致（9.2/9.3）', async () => {
    const { dom, doc, outbox } = await mountedFrame(demoProject())

    // 运行时挂在了宿主给的根节点里。
    expect(doc.querySelector('[data-testid="game-root"]')).not.toBeNull()
    // 顶部标题栏（PRD 预览区 1）。
    expect(doc.querySelector('[data-testid="game-title"]')?.textContent).toBe('端到端项目')
    // 仪表盘的资源数量（PRD 预览区 2），与项目的 `initial = 0` 一致。
    expect(doc.querySelector('[data-testid="resource-amount"]')?.textContent).toBe('0')
    // 本页有的三类卡片（PRD 预览区 3/4/5）。
    expect(doc.querySelectorAll('[data-entry]')).toHaveLength(3)
    expect(doc.querySelector('[data-entry="g2"]')?.getAttribute('data-testid')).toBe('card-clicker')
    // 点击器**没有**购买按钮（D-28、R-25）。
    const clicker = doc.querySelector('[data-entry="g2"]')!
    expect(clicker.querySelector('[data-testid="click-button"]')).not.toBeNull()
    expect(clicker.querySelector('[data-testid="buy-button"]')).toBeNull()
    // 底部导航（PRD 预览区 8），最后一格是内置设置页。
    const nav = [...doc.querySelectorAll('[data-testid="nav-item"]')].map((node) => node.getAttribute('data-page-id'))
    expect(nav).toEqual(['p1', '__settings__'])
    // 注入的样式也进了文档（否则预览里是一堆裸文字）。
    expect(doc.getElementById('iforge-game-style')?.textContent).toContain('.iforge-game')
    // ……而且**命中了**：`.iforge-game` 的作用域类必须在 `body` 上。只断言 `<style>`
    // 存在是不够的——选择器全部匹配不到时界面照样渲染得出，只是没有样式，
    // 功能断言全绿、真机上是一堆裸文字。
    expect(doc.body.classList.contains('iforge-game')).toBe(true)
    const sheet = doc.getElementById('iforge-game-style') as HTMLStyleElement
    const sheetDoc = sheet.sheet as CSSStyleSheet
    const selectors = [...sheetDoc.cssRules].map((rule) => rule.selectorText).filter((text): text is string => typeof text === 'string')
    expect(selectors.length).toBeGreaterThan(20)
    const matched = selectors.filter((selector) => {
      try {
        return doc.querySelector(selector) !== null
      } catch {
        return false
      }
    })
    // 仪表盘、卡片网格、底部导航三类结构都必须被样式表选中。
    for (const key of ['.iforge-game .game-dashboard', '.iforge-game .game-main', '.iforge-game .bottom-nav']) {
      expect(matched, `样式表里没有命中 ${key}`).toContain(key)
    }
    // 9.3 第 2 步：握手完成后发出 game:ready（信封带 v 与同一个 sessionId）。
    const ready = outbox.find((message) => message['kind'] === 'game:ready')
    expect(ready).toBeTruthy()
    expect(ready!['v']).toBe(PROTOCOL_VERSION)
    expect(ready!['sessionId']).toBe('e2e-session')

    dom.window.close()
  }, 30_000)

  it('模拟设置栏不属于游戏内容（D-42、R-32）：产物里没有设备/暂停/倍速/解锁全部', async () => {
    const { dom, doc } = await mountedFrame(demoProject())
    const text = doc.body.textContent ?? ''
    expect(text).toContain('矿石')
    for (const forbidden of ['解锁全部', '时间倍速', '自适应']) {
      expect(text).not.toContain(forbidden)
    }
    dom.window.close()
  }, 30_000)

  it('错误 sessionId 的消息被丢弃、界面不崩（R-19）', async () => {
    const { dom, send, settle, outbox, doc } = await mountedFrame(demoProject())
    const before = outbox.length
    send('host:control', { action: 'pause' }, 'wrong-session')
    await settle(80)
    const after = outbox.slice(before)
    // 界面仍在（没有被一条伪造消息搞崩），且伪造消息没生效：
    // 只记了一条 `game:error`，`host:control` 没有变成任何 `game:event`。
    expect(doc.querySelector('[data-testid="game-root"]')).not.toBeNull()
    expect(doc.querySelector('.badge.warn')).toBeNull()
    expect(after.filter((message) => message['kind'] === 'game:error')).toHaveLength(1)
    expect(after.filter((message) => message['kind'] === 'game:event')).toHaveLength(0)
    dom.window.close()
  }, 30_000)

  it('合法 sessionId 的 host:control 生效（pause 后仪表盘显示“已暂停”）', async () => {
    const { dom, doc, send, settle } = await mountedFrame(demoProject())
    send('host:control', { action: 'pause' })
    await settle(80)
    expect(doc.querySelector('.badge.warn')?.textContent).toBe('已暂停')
    dom.window.close()
  }, 30_000)
})

/**
 * 样式表的**布局契约**：这些断言读的是注入物里那份真实的 `game.css`（不是副本）。
 *
 * ## 为什么断言 CSS 文本而不是 DOM
 *
 * jsdom 没有布局引擎：`scrollHeight`/`clientHeight` 恒为 0，滚不滚动在这里**测不出来**；
 * 而“条目多时能否上下拖动”恰恰是个纯布局问题。因此这里把布局条件拆成
 * **可以在无布局环境里判定的不变量**（滚动轴存在、没人裁掉溢出、定高参照齐全），
 * 真正的“能不能拖”交给真浏览器的 Playwright 用例（`e2e/gameplay.spec.ts`）。
 *
 * 这不是把断言降级——`overflow: hidden` 与 `overflow-y: auto` 的区别正是本条要守的东西：
 * 前者把溢出的卡片裁掉且无处可滚，后者才是页面区域唯一的滚动轴。
 */
describe('game.css 的布局契约：页面区域必须有一条能滚的轴（8.11、D-56）', () => {
  /** 注入物里那份 `game.css` 的**原文**（`textContent`，未经 CSSOM 解析）。 */
  async function styleRules(): Promise<CSSStyleSheet> {
    const { dom, doc } = await mountedFrame(demoProject())
    const sheet = doc.getElementById('iforge-game-style') as HTMLStyleElement
    expect(sheet, '注入的样式表必须在文档里').not.toBeNull()
    // 规则表在 `window.close()` 之后仍可读，但先取出来再关更符合直觉。
    const rules = sheet.sheet as CSSStyleSheet
    dom.window.close()
    return rules
  }

  /**
   * 样式表原文里的某条规则（CSSOM 会把重复属性合并掉，渐进增强的兜底那一条只剩原文里有）。
   *
   * esbuild 会把规则压成 `.sel{...}`（选择器与花括号之间**没有**空格），
   * 因此定位用正则而不是字符串拼接。
   *
   * **先剥全文注释再匹配**：`game.css` 的注释密度很高，且注释里也会写出
   * `.iforge-game .game-root { … }` 这样的片段——不剥掉的话第一个命中项可能是注释，
   * 断言就会读到一段与实际规则无关的文本（症状是“改了 CSS 用例却不红/一直红”）。
   */
  async function rawRule(selector: string): Promise<string> {
    const { dom, doc } = await mountedFrame(demoProject())
    const raw = (doc.getElementById('iforge-game-style') as HTMLStyleElement).textContent ?? ''
    dom.window.close()
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    const escaped = selector.replace(/[.[\]*]/g, (char) => `\\${char}`)
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(text)
    expect(match, `样式表里没有 ${selector}`).toBeTruthy()
    return match![1] ?? ''
  }

  /** 取某条选择器的声明。 */
  function declarationOf(sheet: CSSStyleSheet, selector: string): CSSStyleDeclaration {
    for (const rule of sheet.cssRules) {
      const styleRule = rule as CSSStyleRule
      if (styleRule.selectorText === selector) return styleRule.style
    }
    throw new Error(`样式表里没有 ${selector}`)
  }

  it('.game-main 是滚动容器：`overflow-y` 可见且**不是** `hidden`', async () => {
    const sheet = await styleRules()
    const main = declarationOf(sheet, '.iforge-game .game-main')
    // `hidden` 会把溢出的卡片裁掉：未虚拟化的页面**没有**自己的滚动容器（8.11/D-56），
    // 于是溢出既不可见也不可滚——症状就是“条目一多就只能看首屏”。
    expect(main.getPropertyValue('overflow-y')).toBe('auto')
    // 横向不滚：`overflow-y: auto` 会把 `x` 计算成 `auto`，需要显式关掉。
    expect(main.getPropertyValue('overflow-x')).toBe('hidden')
    // `flex: 1 + min-height: 0` 才是“有确定高度”的前提，缺一条 `max-height: 100%` 就退化成 none。
    expect(main.getPropertyValue('flex')).toBe('1')
    expect(main.getPropertyValue('min-height')).toBe('0')
  }, 30_000)

  it('.game-root / .game-page / .entry-grid-scroll 三级高度参照齐全', async () => {
    const sheet = await styleRules()
    // 根：视口高（百分比高度在 auto 高度的 html 上会退化）。
    //
    // 两条 `height` 是**渐进增强**：先 `100vh`（人人支持），再 `100dvh`（移动端地址栏
    // 收起时 `100vh` 大于可见视口，壳层会被顶出屏幕、底部导航看不见）。
    // CSSOM 会把重复属性合并掉，因此兜底那条只能从样式表**原文**里查——
    // 否则“只写 dvh、老浏览器全塌”这条回归不会被发现。
    const root = declarationOf(sheet, '.iforge-game .game-root')
    expect(root.getPropertyValue('height')).toBe('100dvh')
    // `rawRule` 已剥掉注释，这里直接按声明顺序取。
    // 单位形态是 `vh` 与 `dvh`（`100vh` / `100dvh`），正则要写成可选的 `d`。
    expect([...(await rawRule('.iforge-game .game-root')).matchAll(/height:\s*(100(?:d)?vh)/g)].map((match) => match[1])).toEqual(['100vh', '100dvh'])
    // 兜底那条配 `min-height: 100vh` 会把盒子重新撑回溢出——dvh 的意义正好相反。
    expect(root.getPropertyValue('min-height')).toBe('')
    // 页面节：定高 + flex 列，溢出才交给主区滚。
    const page = declarationOf(sheet, '.iforge-game .game-page')
    expect(page.getPropertyValue('height')).toBe('100%')
    expect(page.getPropertyValue('display')).toBe('flex')
    // 虚拟化容器：自己的滚动轴（> 40 张卡片时）。
    const scroll = declarationOf(sheet, '.iforge-game .entry-grid-scroll')
    expect(scroll.getPropertyValue('overflow-y')).toBe('auto')
    expect(scroll.getPropertyValue('max-height')).toBe('100%')
  }, 30_000)

  it('壳层的配色令牌全部读页面命名空间（顶部标题栏/仪表盘/底部导航跟随页面主题）', async () => {
    const sheet = await styleRules()
    const chrome = [
      '.iforge-game .game-title',
      '.iforge-game .game-dashboard',
      '.iforge-game .bottom-nav',
      '.iforge-game .nav-item',
      '.iforge-game .dashboard-name',
      '.iforge-game .dashboard-rate',
    ]
    for (const selector of chrome) {
      const style = declarationOf(sheet, selector)
      const text = style.cssText
      // 这些元素不是 `.game-page` 的后代，只继承**根节点**上的令牌。
      // 只要有一条读 `--iforge-*`（编辑器命名空间，永远不会被页面主题改写），
      // 换页面主题就换不动壳层——正是修复前的症状。
      expect(text, `${selector} 读了编辑器命名空间`).not.toMatch(/--iforge-(bg|surface|text|muted|border|accent|danger|ok|warning)\b/)
      expect(text, `${selector} 没有读页面命名空间`).toMatch(/--iforge-page-/)
    }
  }, 30_000)
})

describe('页面主题落在根节点：壳层与页面同色（PRD 页面编辑器 6、17.4、8.11）', () => {
  /** 一个 `p1 = page-light` 的项目。 */
  function lightProject() {
    const project = demoProject() as ReturnType<typeof demoProject> & {
      pages: { theme: { kind: string; value: string } }[]
    }
    project.pages[0]!.theme = { kind: 'builtin', value: 'page-light' }
    return project
  }

  it('`--iforge-page-*` 内联在 `.game-root` 上（不是页面节）', async () => {
    const { dom, doc } = await mountedFrame(lightProject())
    const root = doc.querySelector('[data-testid="game-root"]') as HTMLElement
    // 17.4 的 `page-light` 底色。
    expect(root.style.getPropertyValue('--iforge-page-bg')).toBe('#f4f5f7')
    expect(root.style.getPropertyValue('--iforge-page-text')).toBe('#1b1e24')
    dom.window.close()
  }, 30_000)

  it('标题栏/仪表盘/底部导航都是根节点的**后代**，因此与页面同色', async () => {
    const { dom, doc } = await mountedFrame(lightProject())
    const root = doc.querySelector('[data-testid="game-root"]')!
    // 壳层三件套与 `.game-page` 是**兄弟**关系；只有令牌在根节点上时四者才会同时变。
    for (const selector of ['.game-title', '.game-dashboard', '.bottom-nav', '.game-page']) {
      const node = root.querySelector(selector)
      expect(node, `找不到 ${selector}`).not.toBeNull()
      expect(root.contains(node!), `${selector} 必须挂在 .game-root 之下`).toBe(true)
    }
    // 页面节不再自己内联页面令牌（只继承），条目令牌仍在网格容器上（PRD 页面编辑器 8）。
    const section = doc.querySelector('.game-page') as HTMLElement
    expect(section.style.getPropertyValue('--iforge-page-bg')).toBe('')
    const grid = doc.querySelector('.entry-grid') as HTMLElement
    expect(grid.style.getPropertyValue('--iforge-entry-surface')).not.toBe('')
    dom.window.close()
  }, 30_000)

  it('内置设置页没有 `PageDef.theme`：壳层**沿用**当前页面的主题，而不是掉回 `page-dark` 缺省', async () => {
    const { dom, doc, settle } = await mountedFrame(lightProject())
    // 先确认当前是浅色页面，免得下面这条断言因为“本来就没人改过”而空转。
    const light = doc.querySelector('[data-testid="game-root"]') as HTMLElement
    expect(light.style.getPropertyValue('--iforge-page-bg')).toBe('#f4f5f7')

    // 内置设置页是哨兵 `__settings__`（8.12），不是 `PageDef`，因此没有 `theme`。
    // 导航走底部导航按钮（8.12「入口收敛」），而不是 `host:control`——后者没有 `nav` 动作。
    const settingsButton = doc.querySelector('[data-page-id="__settings__"]') as HTMLElement
    expect(settingsButton).not.toBeNull()
    settingsButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await settle(80)
    expect(doc.querySelector('[data-testid="settings-title"]')).not.toBeNull()

    const root = doc.querySelector('[data-testid="game-root"]') as HTMLElement
    // 17.4 的 `page-light` 底色（`ui-kit` 的 `BUILTIN_TOKENS.light`）。
    //
    // 设置页是壳层的一部分（PRD 页面编辑器 6 要求壳层与页面一致），因此停在这里时
    // 生效主题要取 8.12 的**初始页面**主题；早先的实现让 `view.page` 为 `null` 时
    // 回落到 `DEFAULT_THEME.page`（`page-dark`），症状是“点进设置、整屏跳成暗色”。
    expect(root.style.getPropertyValue('--iforge-page-bg')).toBe('#f4f5f7')
    dom.window.close()
  }, 30_000)

  it('页面令牌同时落在文档外壳的**两处**上（画布与 body 各自的取值来源）', async () => {
    const { dom, doc } = await mountedFrame(lightProject())
    // 1. `documentElement`：模板给 `html` 写了背景 → body 的背景不再向画布传播，
    //    画布（超出 body 盒子的区域）因此由 `html` 决定。
    // 2. `body`（`.iforge-game`）：`game.css` 里它的 `background` 读 `--iforge-page-bg`，
    //    而它自己声明了同名变量的暗色缺省值，会盖住从 `html` 继承来的值。
    // 少写一处，另一处就是暗色——症状是根节点内边距那一圈黑边。
    for (const target of [doc.documentElement, doc.body]) {
      expect(target.style.getPropertyValue('--iforge-page-bg')).toBe('#f4f5f7')
      expect(target.style.getPropertyValue('--iforge-page-text')).toBe('#1b1e24')
    }
    dom.window.close()
  }, 30_000)
})
