/**
 * 游戏视图的 DOM 断言（TECH_DESIGN 8.11 的组件树、8.12 导航、8.10 设置页、
 * 8.8 离线提示条、PRD 预览区 1–9）。
 *
 * ## 这些用例在守什么
 *
 * `packages/runtime/test/view-model.test.ts` 已证明“视图模型 = 运行时生效值”。
 * 这里证明第二段：**DOM = 视图模型**。两段合起来才是 M4 交付标准里的“一致”——
 * 只要视图组件自己再算一遍判定或格式化（而不是照抄 `CardView`），这一层就会红。
 */
import { describe, beforeEach, expect, it } from 'vitest'
import { act } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Num } from '@iforge/num'
import { Diagnostics, resetDiagnostics } from '@iforge/num'
import type { ProjectFile } from '@iforge/model'
import { SETTINGS_PAGE_ID, THEME_FOLLOW_PAGE, buildViewModel } from '@iforge/runtime'

import { GameApp } from '../src/app.js'
import { RecordingSink } from './helpers/fixture.js'
import { makeController } from './helpers/fixture.js'
import type { ControllerFixture } from './helpers/fixture.js'

/** 与 `controller.test.ts` 同构的夹具：资源 + 生成器 + 点击器 + 升级 + 两个页面。 */
function demoProject(): ProjectFile {
  return {
    format: 'incrementforge-project',
    version: 1,
    engineVersion: '1.0.0',
    meta: {
      name: '示例：矿石工厂',
      author: 'IncrementForge',
      description: '最小可玩示例',
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
        max: '1e1e10',
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
    upgrades: [
      {
        kind: 'upgrade',
        id: 'u1',
        order: 1,
        name: '双倍产量',
        description: '矿机产量 ×2',
        icon: { kind: 'builtin', value: 'star' },
        initial: '0',
        max: '1',
        visible: true,
        disabled: false,
        perSecond: false,
        buyAmount: '1',
        buyDelay: 1,
        conditions: ['gen.g1.bought >= 1'],
        costs: [{ materialId: 'r1', amount: '100' }],
        effects: [{ condition: 'true', action: 'effValue = 1' }],
      },
    ],
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
          { id: 'u1', order: 4, theme: { kind: 'builtin', value: 'entry-dark' } },
        ],
      },
      {
        kind: 'page',
        id: 'p2',
        order: 2,
        name: '实验区',
        description: '被禁用的页面',
        icon: { kind: 'builtin', value: 'lab' },
        visible: true,
        disabled: true,
        theme: { kind: 'builtin', value: 'page-dark' },
        columns: 1,
        entries: [],
      },
    ],
    assets: {},
  }
}

/** 挂载游戏视图。 */
function mount(fixture: ControllerFixture) {
  return render(<GameApp controller={fixture.controller} />)
}

function cardOf(id: string): HTMLElement {
  return screen.getAllByTestId(/^card-/).find((node) => node.dataset['entry'] === id) as HTMLElement
}

describe('PRD 预览区 2：数据仪表盘的边界', () => {
  it('仪表盘页脚**不再**渲染 tick 耗时 / 帧率 / 诊断角标（它们只在编辑器的诊断面板）', () => {
    // 这三项与 `PreviewPane` 在预览框正下方显示的那一份完全是同一份数据
    // （都来自 `game:stats`），在游戏视图里再渲染一遍纯属重复；打包产物里则是
    // 玩家无从处置的作者向信息。
    const fixture = makeController({ project: demoProject() })
    const { container } = mount(fixture)
    expect(screen.queryByTestId('perf')).toBeNull()
    expect(screen.queryByTestId('game-error-count')).toBeNull()
    for (const label of ['tick 耗时', '帧率', '诊断']) {
      expect(container.textContent ?? '', `仪表盘里不应出现「${label}」`).not.toContain(label)
    }
  })

  it('收回/展开：收回后只剩标题行，正文从 DOM 里消失', async () => {
    const user = userEvent.setup()
    mount(makeController({ project: demoProject() }))
    const toggle = screen.getByTestId('dashboard-toggle')
    const dashboard = screen.getByTestId('game-dashboard')
    expect(dashboard).toHaveAttribute('data-collapsed', 'false')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('dashboard-body')).toBeInTheDocument()

    await user.click(toggle)
    expect(dashboard).toHaveAttribute('data-collapsed', 'true')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // 收回后仪表盘不再把资源列表撑高，条目区因此拿回高度：正文用 `hidden` 收起
    // （不占布局），CSS 里展开态另有 `max-height: 40vh` 的封顶，见 `game.css`。
    expect(screen.getByTestId('dashboard-body')).not.toBeVisible()
    expect(screen.queryByTestId('resource-amount')).not.toBeVisible()

    await user.click(toggle)
    expect(dashboard).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByTestId('resource-amount')).toBeVisible()
  })

  it('收回状态在切页后保持（作者看一眼仪表盘不会被“顺手收起来”）', async () => {
    const user = userEvent.setup()
    mount(makeController({ project: demoProject() }))
    await user.click(screen.getByTestId('dashboard-toggle'))
    await user.click(screen.getAllByTestId('nav-item').find((node) => node.dataset['pageId'] === 'p2')!)
    expect(screen.getByTestId('game-dashboard')).toHaveAttribute('data-collapsed', 'true')
  })

  it('动态条目角标与“已暂停”徽标仍留在页脚（它们不是重复信息）', () => {
    const fixture = makeController({ project: demoProject() })
    act(() => {
      fixture.controller.state.flags.paused = true
      fixture.controller.refresh()
    })
    mount(fixture)
    expect(screen.getByTestId('paused-badge')).toBeInTheDocument()
  })
})

describe('8.11：组件树结构（PRD 预览区 1–9）', () => {
  it('顶部标题栏显示项目名称（PRD 预览区 1）', () => {
    const fixture = makeController({ project: demoProject() })
    mount(fixture)
    expect(screen.getByTestId('game-title')).toHaveTextContent('示例：矿石工厂')
  })

  it('数据仪表盘显示资源数量与增长速度（PRD 预览区 2）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.controller.state.attrs.write('res.r1.amount', Num.fromNumber(1234), '<test>')
    fixture.controller.refresh()
    mount(fixture)
    const view = buildViewModel(fixture.controller.state)
    expect(screen.getByTestId('resource-amount')).toHaveTextContent(view.dashboard.resources[0]!.amount)
    // 无可购买条目时显示 `—` 并把原因放进 title（8.9 的 `—` 分支）。
    const next = screen.getByTestId('next-buy')
    expect(next).toHaveTextContent('—')
    expect(next).toHaveAttribute('title', view.dashboard.nextBuyHint)
  })

  it('页面描述与网格列数（PRD 预览区 7、D-41）', () => {
    const fixture = makeController({ project: demoProject() })
    mount(fixture)
    expect(screen.getByTestId('page-description')).toHaveTextContent('主页面')
    expect(screen.getByTestId('entry-grid')).toHaveStyle({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' })
  })

  it('底部导航：图标+名称，最后一格是内置设置页（PRD 预览区 8、8.12）', () => {
    const fixture = makeController({ project: demoProject() })
    mount(fixture)
    const items = screen.getAllByTestId('nav-item')
    expect(items.map((node) => node.dataset['pageId'])).toEqual(['p1', 'p2', SETTINGS_PAGE_ID])
    expect(items.at(-1)!.dataset['builtIn']).toBe('true')
    expect(items.at(-1)).toHaveTextContent('设置')
    // 当前页高亮。
    expect(items[0]).toHaveAttribute('aria-current', 'page')
  })

  it('禁用页面仍渲染导航按钮（PRD 页面编辑器 4：禁用仍可跳转）', () => {
    const fixture = makeController({ project: demoProject() })
    mount(fixture)
    const items = screen.getAllByTestId('nav-item')
    expect(items.map((node) => node.dataset['pageId'])).toContain('p2')
  })
})

describe('12 性能预算：卡片列表虚拟化（> 40 条目启用）', () => {
  /** 造一个单页含 N 个资源卡片的项目（用于跨虚拟化阈值）。 */
  function manyResources(count: number): ProjectFile {
    const project = demoProject()
    project.pages[0]!.entries = Array.from({ length: count }, (_, index) => ({
      id: `r${index + 1}`,
      order: index + 1,
      theme: { kind: 'builtin' as const, value: 'entry-dark' },
    }))
    project.resources = Array.from({ length: count }, (_, index) => ({
      kind: 'resource' as const,
      id: `r${index + 1}`,
      order: index + 1,
      name: `资源 ${index + 1}`,
      description: '',
      icon: { kind: 'builtin' as const, value: 'gem' },
      initial: '0',
      max: 'Infinity',
      visible: true,
    }))
    return project
  }

  it('未超过阈值时渲染全部卡片，且**不**套滚动容器（VIRTUALIZE_THRESHOLD = 40）', () => {
    const fixture = makeController({ project: manyResources(40) })
    mount(fixture)
    expect(screen.queryByTestId('entry-grid-scroll')).toBeNull()
    expect(screen.getByTestId('entry-grid')).toHaveAttribute('data-total', '40')
    expect(document.querySelectorAll('[data-entry]')).toHaveLength(40)
  })

  it('超过阈值时启用虚拟化：DOM 里只渲染视口附近的行，`data-total` 仍等于全部条目数', () => {
    const fixture = makeController({ project: manyResources(120) })
    mount(fixture)
    expect(screen.getByTestId('entry-grid-scroll')).toBeTruthy()
    const grid = screen.getByTestId('entry-grid')
    // 总数是 120，但 DOM 里只有首屏的若干行——这正是虚拟化的意义。
    expect(grid).toHaveAttribute('data-total', '120')
    const rendered = document.querySelectorAll('[data-entry]').length
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(120)
  })

  it('虚拟化不影响数值：首屏卡片的数量文本与视图模型一致（视图不算第二遍，8.11 末条）', () => {
    const fixture = makeController({ project: manyResources(120) })
    mount(fixture)
    const view = buildViewModel(fixture.controller.state)
    const first = view.page!.entries[0]!
    // 虚拟化后首屏仍有多张资源卡片，因此用 `getAllByTestId` 并逐个对齐视图模型。
    const rendered = screen.getAllByTestId('resource-value')
    expect(rendered.length).toBeGreaterThan(1)
    expect(rendered[0]!).toHaveTextContent(first.amount ?? '')
  })

  it('虚拟化不影响导航与设置页（只改条目网格，8.11）', () => {
    const fixture = makeController({ project: manyResources(120) })
    mount(fixture)
    expect(screen.getAllByTestId('nav-item')).toHaveLength(3)
  })
})

describe('8.11：卡片字段逐项等于视图模型', () => {
  it('资源卡片：图标｜名称｜描述｜右侧数量，且无购买按钮（D-20）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.controller.state.attrs.write('res.r1.amount', Num.fromNumber(5000), '<test>')
    fixture.controller.refresh()
    mount(fixture)
    const card = cardOf('r1')
    const view = buildViewModel(fixture.controller.state)
    const model = view.page!.entries.find((entry) => entry.id === 'r1')!
    expect(card).toHaveTextContent('矿石')
    expect(card).toHaveTextContent('基础资源')
    expect(within(card).getByTestId('resource-value')).toHaveTextContent(model.amount as string)
    expect(within(card).queryByTestId('buy-button')).toBeNull()
  })

  it('生成器卡片：产量｜价格｜已购买/拥有 + “购买”按钮', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.controller.state.attrs.write('gen.g1.bought', Num.fromNumber(3), '<test>')
    fixture.controller.state.attrs.write('gen.g1.owned', Num.fromNumber(3), '<test>')
    fixture.controller.state.attrs.write('res.r1.amount', Num.fromNumber(100), '<test>')
    fixture.controller.refresh()
    mount(fixture)

    const card = cardOf('g1')
    const model = buildViewModel(fixture.controller.state).page!.entries.find((entry) => entry.id === 'g1')!
    expect(within(card).getByTestId('output')).toHaveTextContent(model.output as string)
    expect(within(card).getByTestId('costs')).toHaveTextContent(model.costs![0]!.amount)
    expect(within(card).getByTestId('bought-value')).toHaveTextContent(model.bought as string)
    expect(within(card).getByTestId('owned-value')).toHaveTextContent(model.owned as string)
    expect(within(card).getByTestId('buy-button')).not.toBeDisabled()
  })

  it('点击器卡片只渲染“点击”，不渲染“购买”（D-28、R-25）', () => {
    const fixture = makeController({ project: demoProject() })
    mount(fixture)
    const card = cardOf('g2')
    expect(within(card).getByTestId('click-button')).toBeInTheDocument()
    expect(within(card).queryByTestId('buy-button')).toBeNull()
  })

  it('升级卡片：条件逐条显示真假，效果给出文本与数值（PRD 预览区 6）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.controller.state.attrs.write('gen.g1.bought', Num.fromNumber(1), '<test>')
    fixture.controller.state.attrs.write('res.r1.amount', Num.fromNumber(100), '<test>')
    fixture.controller.refresh()
    mount(fixture)

    const card = cardOf('u1')
    const model = buildViewModel(fixture.controller.state).page!.entries.find((entry) => entry.id === 'u1')!
    expect(within(card).getByTestId('conditions')).toHaveTextContent('gen.g1.bought >= 1')
    expect(within(card).getByTestId('conditions').firstElementChild).toHaveClass('true')
    expect(within(card).getByTestId('effects')).toHaveTextContent('effValue = 1')
    expect(within(card).getByTestId('effect-value')).toHaveTextContent(model.effects![0]!.value)
  })

  it('条件不满足的升级：条件标红且购买按钮禁用', () => {
    const fixture = makeController({ project: demoProject() })
    mount(fixture)
    const card = cardOf('u1')
    expect(within(card).getByTestId('conditions').firstElementChild).toHaveClass('false')
    expect(within(card).getByTestId('buy-button')).toBeDisabled()
    expect(within(card).getByTestId('buy-button')).toHaveAttribute('title', '购买条件未满足')
  })

  it('禁用条目保留卡片但置灰，且没有购买按钮（8.11「卡片显隐」）', () => {
    const project = demoProject()
    project.generators = project.generators.map((g) => (g.id === 'g1' ? { ...g, disabled: true } : g))
    const fixture = makeController({ project })
    mount(fixture)
    const card = cardOf('g1')
    expect(card).toHaveAttribute('data-disabled', 'true')
    expect(card).toHaveClass('disabled')
    expect(within(card).queryByTestId('buy-button')).toBeNull()
  })

  it('价格行无效（材料引用不存在/价格为占位值）时按钮禁用并说明原因（不能“免费购买”）', () => {
    const broken = demoProject()
    broken.generators = broken.generators.map((g) => (g.id === 'g1' ? { ...g, costs: [{ materialId: '', amount: '1' }] } : g))
    const fixture = makeController({ project: broken })
    mount(fixture)

    const button = within(cardOf('g1')).getByTestId('buy-button')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('E_DANGLING_REF'))
    // 坏引用下卡片没有价格行；这正是修复前“看不出为什么买不到/买了不花钱”的那半边。
    expect(within(cardOf('g1')).queryByTestId('costs')).toBeNull()
  })

  it('不可见的条目不渲染（PRD 页面编辑器 5）', () => {
    const project = demoProject()
    project.generators = project.generators.map((g) => (g.id === 'g1' ? { ...g, visible: false } : g))
    const fixture = makeController({ project })
    mount(fixture)
    expect(cardOf('g1')).toBeUndefined()
  })

  it('资源卡片不因页面禁用而置灰（8.4 的两条容易搞反的规则）', () => {
    const project = demoProject()
    project.pages = project.pages.map((p) => (p.id === 'p1' ? { ...p, disabled: true } : p))
    const fixture = makeController({ project })
    fixture.controller.refresh()
    mount(fixture)
    expect(cardOf('r1')).toHaveAttribute('data-disabled', 'false')
    expect(cardOf('g1')).toHaveAttribute('data-disabled', 'true')
  })

  it('已达数量上限时标记 data-capped 且按钮不可用（PRD 补充 3）', () => {
    const project = demoProject()
    project.generators = project.generators.map((g) => (g.id === 'g2' ? { ...g, max: '1' } : g))
    const fixture = makeController({ project })
    mount(fixture)
    const card = cardOf('g2')
    expect(card).toHaveAttribute('data-capped', 'true')
    expect(within(card).getByTestId('click-button')).toBeDisabled()
  })
})

describe('8.11 / 8.7：动态条目的“丢弃”按钮', () => {
  it('动态条目带丢弃按钮，静态条目不带（PRD 预览区 6）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.controller.state.dynamic.create('upgrade', { id: 'uTmp', name: '临时强化', page: 'p1' })
    fixture.controller.refresh()
    mount(fixture)
    expect(within(cardOf('uTmp')).getByTestId('discard')).toBeInTheDocument()
    expect(within(cardOf('u1')).queryByTestId('discard')).toBeNull()
  })

  it('点“丢弃”后卡片立刻消失（8.3.1：立即生效且不经 EffectSink）', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: demoProject() })
    fixture.controller.state.dynamic.create('upgrade', { id: 'uTmp', name: '临时强化', page: 'p1' })
    fixture.controller.refresh()
    mount(fixture)
    expect(cardOf('uTmp')).toBeDefined()

    await user.click(within(cardOf('uTmp')).getByTestId('discard'))
    expect(cardOf('uTmp')).toBeUndefined()
    expect(fixture.controller.state.dynamicCount()).toBe(0)
  })
})

describe('8.3.1：交互在 DOM 上的即时反馈', () => {
  it('点击“点击”后资源数量立刻变化（不经 tick）', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: demoProject() })
    mount(fixture)
    expect(screen.getByTestId('resource-amount')).toHaveTextContent('0')
    await user.click(within(cardOf('g2')).getByTestId('click-button'))
    expect(screen.getByTestId('resource-amount')).toHaveTextContent('1')
  })

  it('点“购买”后已购买数量立刻 +1、材料立刻扣减', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: demoProject() })
    fixture.controller.state.attrs.write('res.r1.amount', Num.fromNumber(100), '<test>')
    fixture.controller.refresh()
    mount(fixture)

    await user.click(within(cardOf('g1')).getByTestId('buy-button'))
    expect(within(cardOf('g1')).getByTestId('bought-value')).toHaveTextContent('1')
    expect(within(cardOf('g1')).getByTestId('owned-value')).toHaveTextContent('1')
    expect(screen.getByTestId('resource-amount')).toHaveTextContent('90')
  })

  it('批量购买按钮的标签体现 buyAmount 三态（8.6）', () => {
    const base = demoProject()
    const count = { ...base, generators: base.generators.map((g) => (g.id === 'g1' ? { ...g, buyAmount: '12' } : g)) }
    const fixture = makeController({ project: count })
    mount(fixture)
    expect(within(cardOf('g1')).getByTestId('buy-button')).toHaveTextContent('购买 ×12')

    const max = { ...base, generators: base.generators.map((g) => (g.id === 'g1' ? { ...g, buyAmount: '0' } : g)) }
    const maxFixture = makeController({ project: max })
    const maxView = render(<GameApp controller={maxFixture.controller} />)
    const button = maxView.container.querySelector('[data-entry="g1"] [data-testid="buy-button"]')
    expect(button?.textContent).toBe('最大购买')

    const free = { ...base, generators: base.generators.map((g) => (g.id === 'g1' ? { ...g, buyAmount: '-1' } : g)) }
    const freeFixture = makeController({ project: free })
    const freeView = render(<GameApp controller={freeFixture.controller} />)
    const freeButton = freeView.container.querySelector('[data-entry="g1"] [data-testid="buy-button"]')
    expect(freeButton?.textContent).toBe('免费购买')
  })
})

describe('8.10：游戏内设置页（PRD 预览区 9）', () => {
  it('点击底部导航的设置页进入内置设置页', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: demoProject() })
    mount(fixture)
    await user.click(screen.getAllByTestId('nav-item').at(-1)!)
    expect(screen.getByTestId('settings-title')).toBeInTheDocument()
    expect(fixture.controller.state.currentPageId).toBe(SETTINGS_PAGE_ID)
  })

  it('来源徽标逐行存在（8.10 的强制 UI 元素、R-24 的界面侧防线）', () => {
    const fixture = makeController({ project: demoProject() })
    mount(fixture)
    // 直接进设置页。
    act(() => fixture.controller.navigate(SETTINGS_PAGE_ID))
    const rows = screen.getAllByTestId('settings-row')
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      const badge = within(row).getByTestId('settings-source-badge')
      expect(badge).toHaveAttribute('data-source', 'project')
      expect(badge).toHaveTextContent('项目默认')
    }
  })

  it('会话覆盖后该行徽标变成“本会话覆盖”并高亮', () => {
    const fixture = makeController({ project: demoProject() })
    mount(fixture)
    act(() => {
      fixture.controller.navigate(SETTINGS_PAGE_ID)
      fixture.controller.setGameSetting('tickRate', '60')
    })
    const row = screen.getAllByTestId('settings-row').find((node) => node.dataset['key'] === 'tickRate')!
    expect(row).toHaveClass('overridden')
    const badge = within(row).getByTestId('settings-source-badge')
    expect(badge).toHaveAttribute('data-source', 'session')
    expect(badge).toHaveTextContent('本会话覆盖')
    // 提示里带上项目默认值，作者才知道原值是多少。
    expect(badge).toHaveAttribute('title', expect.stringContaining('20'))
  })

  it('只读信息显示项目名/作者/描述与游戏时间（PRD 预览区 9）', () => {
    const fixture = makeController({ project: demoProject() })
    act(() => fixture.controller.navigate(SETTINGS_PAGE_ID))
    mount(fixture)
    expect(screen.getByTestId('info-name')).toHaveTextContent('示例：矿石工厂')
    expect(screen.getByTestId('info-author')).toHaveTextContent('IncrementForge')
    expect(screen.getByTestId('info-description')).toHaveTextContent('最小可玩示例')
    expect(screen.getByTestId('info-gametime')).toHaveTextContent('0')
  })

  it('导出/导入/重新开始三个按钮都在（PRD 预览区 9）', () => {
    const fixture = makeController({ project: demoProject() })
    act(() => fixture.controller.navigate(SETTINGS_PAGE_ID))
    mount(fixture)
    expect(screen.getByTestId('settings-export-save')).toBeInTheDocument()
    expect(screen.getByTestId('settings-import-save')).toBeInTheDocument()
    expect(screen.getByTestId('settings-restart')).toBeInTheDocument()
    expect(screen.getByTestId('settings-restore-defaults')).toBeInTheDocument()
  })

  it('“导出存档”回传给宿主的是 export 意图（D-51）', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: demoProject() })
    mount(fixture)
    act(() => fixture.controller.navigate(SETTINGS_PAGE_ID))
    await user.click(screen.getByTestId('settings-export-save'))
    expect(fixture.sink.saves.at(-1)?.intent).toBe('export')
  })

  it('暂停时给出“副作用待恢复后提交”的提示（8.3.1 末条）', () => {
    const fixture = makeController({ project: demoProject() })
    act(() => {
      fixture.controller.navigate(SETTINGS_PAGE_ID)
      fixture.controller.applyControl('pause')
    })
    mount(fixture)
    expect(screen.getByTestId('settings-paused-hint')).toBeInTheDocument()
  })
})

describe('8.10：内置设置页的“页面主题”开关（主题不匹配 + 切换入口）', () => {
  // `Diagnostics` 是模块级全局（见 `app.tsx` 的注释）：复位后才好断言“这一次记了一条”。
  beforeEach(() => resetDiagnostics())

  /** `p1` 设定为 `page-light` 的项目（其余与 demoProject 相同）。 */
  function lightProject(): ProjectFile {
    const project = demoProject()
    project.pages = project.pages.map((p) => (p.id === 'p1' ? { ...p, theme: { kind: 'builtin' as const, value: 'page-light' } } : p))
    return project
  }

  it('设置页提供主题下拉：默认“跟随页面”，并列出 17.4 的三档内置页面主题', () => {
    const fixture = makeController({ project: lightProject() })
    act(() => fixture.controller.navigate(SETTINGS_PAGE_ID))
    mount(fixture)

    const select = screen.getByTestId('settings-theme-input') as HTMLSelectElement
    expect(select.value).toBe(THEME_FOLLOW_PAGE)
    const values = [...select.options].map((option) => option.value)
    expect(values).toEqual([THEME_FOLLOW_PAGE, 'builtin:page-dark', 'builtin:page-light', 'builtin:page-midnight'])
    // 默认没有覆盖：徽标是“项目默认”（8.10 的强制 UI 元素、R-24）。
    expect(screen.getByTestId('settings-theme-source-badge')).toHaveAttribute('data-source', 'project')
  })

  it('选一档内置主题后整屏（含画布令牌）立刻变色，且徽标变成“本会话覆盖”', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: lightProject() })
    mount(fixture)
    act(() => fixture.controller.navigate(SETTINGS_PAGE_ID))

    await user.selectOptions(screen.getByTestId('settings-theme-input'), 'builtin:page-dark')

    const root = screen.getByTestId('game-root')
    expect(root.style.getPropertyValue('--iforge-page-bg')).toBe('#14161a')
    expect(document.documentElement.style.getPropertyValue('--iforge-page-bg')).toBe('#14161a')
    expect(screen.getByTestId('settings-theme-source-badge')).toHaveAttribute('data-source', 'session')
  })

  it('切回“跟随页面”恢复作者设定的主题', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: lightProject() })
    mount(fixture)
    act(() => fixture.controller.navigate(SETTINGS_PAGE_ID))

    await user.selectOptions(screen.getByTestId('settings-theme-input'), 'builtin:page-dark')
    await user.selectOptions(screen.getByTestId('settings-theme-input'), THEME_FOLLOW_PAGE)

    expect(screen.getByTestId('game-root').style.getPropertyValue('--iforge-page-bg')).toBe('#f4f5f7')
    expect(screen.getByTestId('settings-theme-source-badge')).toHaveAttribute('data-source', 'project')
  })

  it('覆盖跨页生效并回传 theme 事件（9.2 的 `game:event`）', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: lightProject() })
    mount(fixture)
    act(() => fixture.controller.navigate(SETTINGS_PAGE_ID))
    await user.selectOptions(screen.getByTestId('settings-theme-input'), 'builtin:page-midnight')

    expect(fixture.sink.events.at(-1)).toMatchObject({ type: 'theme', payload: { theme: 'builtin:page-midnight' } })

    // 回到游戏页：覆盖仍在（它是整屏偏好，不是某一页的）。
    await user.click(screen.getAllByTestId('nav-item').find((node) => node.dataset['pageId'] === 'p1')!)
    expect(screen.getByTestId('game-root').style.getPropertyValue('--iforge-page-bg')).toBe('#070a14')
  })

  it('非法值（自定义主题 CSS）被拒：保持原主题并记诊断', () => {
    const fixture = makeController({ project: lightProject() })
    act(() => {
      fixture.controller.navigate(SETTINGS_PAGE_ID)
      fixture.controller.setThemeOverride(':root{--iforge-page-bg:#ff0000}')
    })
    mount(fixture)
    expect(screen.getByTestId('game-root').style.getPropertyValue('--iforge-page-bg')).toBe('#f4f5f7')
    expect(Diagnostics.countsSnapshot()['E_ASSIGN_TYPE']).toBeGreaterThan(0)
  })
})

describe('8.8：离线收益提示条', () => {
  it('显示离线时长、各资源增量，以及“离线不含随机/每秒生效/自动购买”的固定文案（R-14）', () => {
    const first = makeController({ project: demoProject() })
    first.start()
    first.controller.state.attrs.write('gen.g1.bought', Num.fromNumber(1), '<test>')
    first.controller.state.attrs.write('gen.g1.owned', Num.fromNumber(1), '<test>')
    first.runFrames(60)
    const save = first.controller.exportSave()

    const later = makeController({
      project: demoProject(),
      save,
      startWallAt: Date.parse(save.savedAt) + 7_200_000,
    })
    mount(later)
    const notice = screen.getByTestId('offline-notice')
    expect(within(notice).getByTestId('offline-note')).toHaveTextContent('离线不含随机、每秒生效与自动购买')
    expect(notice).toHaveTextContent('矿石')
    expect(notice).toHaveTextContent('2小时')
  })

  it('墙钟回拨时只显示回拨提示，不显示时长与收益（R-20）', () => {
    const first = makeController({ project: demoProject() })
    first.start()
    first.runFrames(30)
    const save = first.controller.exportSave()

    // 墙钟被改到存档之前：8.8 伪码第 2 行 -> 不结算、记 E_CLOCK_ROLLBACK。
    const rolled = makeController({
      project: demoProject(),
      save,
      startWallAt: Date.parse(save.savedAt) - 60_000,
    })
    mount(rolled)
    expect(screen.getByTestId('offline-rollback')).toHaveTextContent('本次未结算任何离线收益')
  })

  it('关闭提示条后消失（结算已完成、不可撤销）', async () => {
    const user = userEvent.setup()
    const first = makeController({ project: demoProject() })
    first.start()
    first.controller.state.attrs.write('gen.g1.owned', Num.fromNumber(1), '<test>')
    first.runFrames(60)
    const save = first.controller.exportSave()
    const later = makeController({
      project: demoProject(),
      save,
      startWallAt: Date.parse(save.savedAt) + 3_600_000,
    })
    mount(later)
    expect(screen.getByTestId('offline-notice')).toBeInTheDocument()
    await user.click(within(screen.getByTestId('offline-notice')).getByRole('button', { name: '关闭' }))
    expect(screen.queryByTestId('offline-notice')).toBeNull()
  })
})

describe('8.12：页面跳转经 nav()', () => {
  it('点导航按钮切页，切页不重置任何条目状态', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: demoProject() })
    fixture.controller.state.attrs.write('gen.g1.bought', Num.fromNumber(4), '<test>')
    fixture.controller.state.attrs.write('res.r1.amount', Num.fromNumber(50), '<test>')
    fixture.controller.refresh()
    mount(fixture)

    const p2 = screen.getAllByTestId('nav-item').find((node) => node.dataset['pageId'] === 'p2')!
    await user.click(p2)
    expect(fixture.controller.state.currentPageId).toBe('p2')
    expect(fixture.sink.events.at(-1)).toMatchObject({ type: 'nav', target: 'p2' })
    // 切页只是换了渲染的 PageView，进度不变（8.12「切换副作用」）。
    const generator = fixture.controller.state.attrs.find('gen.g1')!
    expect(fixture.controller.state.attrs.value(generator, 'bought').toNumber()).toBe(4)
    expect(fixture.controller.state.attrs.value(fixture.controller.state.attrs.find('res.r1')!, 'amount').toNumber()).toBe(50)
  })

  it('被禁用的页面其条目置灰且没有按钮，但资源仍正常显示（8.4）', async () => {
    const user = userEvent.setup()
    const project = demoProject()
    // g2 只能属于一个页面（PRD 补充 7）：把它从 p1 移到 p2，否则 `pageOf()` 会返回 p1，
    // 页面禁用继承就完全不生效——那样的红灯会指向“继承实现有 bug”，而真因是夹具非法。
    project.pages = project.pages.map((p) =>
      p.id === 'p1'
        ? { ...p, entries: p.entries.filter((entry) => entry.id !== 'g2') }
        : p.id === 'p2'
          ? { ...p, entries: [{ id: 'g2', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } }] }
          : p,
    )
    const fixture = makeController({ project })
    mount(fixture)
    await user.click(screen.getAllByTestId('nav-item').find((node) => node.dataset['pageId'] === 'p2')!)
    expect(cardOf('g2')).toHaveAttribute('data-disabled', 'true')
    expect(within(cardOf('g2')).queryByTestId('click-button')).toBeNull()
  })
})

describe('PRD 页面编辑器 6 / 17.4：页面主题落在根节点，壳层与页面同色', () => {
  /** 把 `p1` 的页面主题换成指定的内置 id。 */
  function themed(id: string) {
    const project = demoProject()
    project.pages = project.pages.map((p) => (p.id === 'p1' ? { ...p, theme: { kind: 'builtin' as const, value: id } } : p))
    return project
  }

  it('`--iforge-page-*` 内联在 `.game-root` 上，标题栏/仪表盘/底部导航因此一起变色', () => {
    mount(makeController({ project: themed('page-light') }))
    const root = screen.getByTestId('game-root')
    // 17.4 的 `page-light`：页面与壳层读的是同一份变量。
    expect(root.style.getPropertyValue('--iforge-page-bg')).toBe('#f4f5f7')
    expect(root.style.getPropertyValue('--iforge-page-text')).toBe('#1b1e24')
    // 壳层三件套都是根节点的子节点 —— 令牌只在根节点上时它们才吃得到。
    expect(root.querySelector('.game-title')).not.toBeNull()
    expect(root.querySelector('.game-dashboard')).not.toBeNull()
    expect(root.querySelector('.bottom-nav')).not.toBeNull()
  })

  it('页面节不再自己内联页面令牌（只继承根节点），条目令牌仍在网格容器上', () => {
    mount(makeController({ project: themed('page-light') }))
    const section = document.querySelector('.game-page') as HTMLElement
    expect(section.style.getPropertyValue('--iforge-page-bg')).toBe('')
    const grid = screen.getByTestId('entry-grid')
    expect(grid.style.getPropertyValue('--iforge-entry-surface')).not.toBe('')
  })

  it('切到主题不同的页面时根节点跟着换（8.12：主题是页面级表现，随导航重算）', async () => {
    const user = userEvent.setup()
    const project = demoProject()
    project.pages = project.pages.map((p) =>
      p.id === 'p1'
        ? { ...p, theme: { kind: 'builtin' as const, value: 'page-dark' } }
        : { ...p, theme: { kind: 'builtin' as const, value: 'page-light' } },
    )
    mount(makeController({ project }))

    const root = screen.getByTestId('game-root')
    expect(root.style.getPropertyValue('--iforge-page-bg')).toBe('#14161a')
    await user.click(screen.getAllByTestId('nav-item').find((node) => node.dataset['pageId'] === 'p2')!)
    expect(root.style.getPropertyValue('--iforge-page-bg')).toBe('#f4f5f7')
  })

  it('内置设置页没有 `PageDef.theme`：壳层**沿用**当前页面的主题，而不是掉回 `page-dark` 缺省', () => {
    const fixture = makeController({ project: themed('page-light') })
    mount(fixture)
    act(() => fixture.controller.navigate(SETTINGS_PAGE_ID))
    expect(screen.getByTestId('settings-title')).toBeInTheDocument()
    // 设置页是壳层的一部分（PRD 页面编辑器 6 要求壳层与页面一致）。早先的实现让
    // `view.page` 为 `null` 时回落到 `DEFAULT_THEME.page`（`page-dark`），症状是
    // “点进设置、整屏跳成暗色”——设置页与游戏页主题不匹配。
    expect(screen.getByTestId('game-root').style.getPropertyValue('--iforge-page-bg')).toBe('#f4f5f7')
  })

  it('页面令牌同时落到文档外壳两处：`documentElement` 与 `body`（黑边的两个来源）', () => {
    // `.game-root` 不是文档根。`.game-root` 之外还有两处底色，各有各的取值来源：
    // 1. **画布**（`html`）：17.3 的模板给 `html` 写了背景，于是 `body` 的背景不再
    //    向画布传播；画布上任何超出 body 盒子的区域由 `html` 决定。
    // 2. **`body`**（`.iforge-game`）：`game.css` 里它的 `background` 读
    //    `--iforge-page-bg`，而它**自己**声明了这份变量的缺省值（永远是暗色），
    //    从 `html` 继承来的同名令牌会被自己盖住。
    // 只写其中一处，另一处仍是暗色——症状就是根节点 8px 内边距那一圈黑边。
    mount(makeController({ project: themed('page-light') }))
    for (const target of [document.documentElement, document.body]) {
      expect(target.style.getPropertyValue('--iforge-page-bg')).toBe('#f4f5f7')
      expect(target.style.getPropertyValue('--iforge-page-text')).toBe('#1b1e24')
    }
  })

  it('卸载时清掉自己写在文档外壳上的令牌（同一文档会挂载多棵树）', () => {
    const { unmount } = mount(makeController({ project: themed('page-light') }))
    expect(document.documentElement.style.getPropertyValue('--iforge-page-bg')).toBe('#f4f5f7')
    unmount()
    for (const target of [document.documentElement, document.body]) {
      expect(target.style.getPropertyValue('--iforge-page-bg')).toBe('')
    }
  })

  it('深色页面主题下文档外壳的令牌是深色那一档（不会漏回默认）', () => {
    mount(makeController({ project: themed('page-dark') }))
    expect(document.documentElement.style.getPropertyValue('--iforge-page-bg')).toBe('#14161a')
    expect(document.body.style.getPropertyValue('--iforge-page-bg')).toBe('#14161a')
  })
})

describe('D-42 / R-32：模拟设置栏不在游戏视图里', () => {
  it('游戏视图不含设备/暂停/倍速/解锁全部控件（它们属于编辑器外壳）', () => {
    const fixture = makeController({ project: demoProject() })
    const { container } = mount(fixture)
    const text = container.textContent ?? ''
    for (const forbidden of ['手机', '平板', '自适应', '解锁全部', '暂停', '继续']) {
      expect(text).not.toContain(forbidden)
    }
  })
})

describe('订阅：控制器重建视图后组件自动更新', () => {
  it('不经过任何交互，控制器 refresh 也会让 DOM 同步', () => {
    const fixture = makeController({ project: demoProject() })
    mount(fixture)
    expect(within(cardOf('g1')).getByTestId('bought-value')).toHaveTextContent('0')
    act(() => {
      fixture.controller.state.attrs.write('gen.g1.bought', Num.fromNumber(6), '<test>')
      fixture.controller.refresh()
    })
    expect(within(cardOf('g1')).getByTestId('bought-value')).toHaveTextContent('6')
  })
})

/** 供未来用例复用的记录器（避免每个文件重复实现）。 */
export { RecordingSink }
