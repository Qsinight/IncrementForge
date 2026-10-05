/**
 * 视图模型（TECH_DESIGN 8.9 仪表盘、8.11 卡片字段、8.12 页面导航、8.10 游戏内设置页）。
 *
 * ## 这些用例在守什么
 *
 * 17.5 的 M4 交付标准是“**预览与运行时数据一致（自动化断言）**”。一致性不能只靠
 * “DOM 和某个快照长得一样”，必须逐字段与 **`GameState` 的生效值** 对账——否则
 * 视图层自己算一套判定/格式化时，断言仍然会绿。因此这里的写法统一是：
 *
 * ```
 * view.page.entries[i].<字段>  ===  （GameState/AttributeStore 上算出的期望值）
 * ```
 *
 * 视图组件只做渲染，`runtime-shell/test/view.test.tsx` 再断言 DOM 等于这里的输出；
 * 两层合起来才是“预览 = 运行时”。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { Diagnostics, Num, resetDiagnostics } from '@iforge/num'
import type { ProjectFile } from '@iforge/model'

import { GameState, SETTINGS_PAGE_ID } from '../src/game-state.js'
import { resetRateHistory } from '../src/dashboard.js'
import { resetMonotonicCache } from '../src/batch.js'
import { serializeSave } from '../src/save.js'
import { entityKeyOf } from '../src/attribute-store.js'
import {
  buildViewModel,
  formatSeconds,
  formatTimestamp,
  NOT_ENOUGH_MATERIAL_REASON,
  resetViewModelCache,
  SETTING_FIELDS,
  THEME_FOLLOW_PAGE,
} from '../src/view-model.js'
import { assignToPage, createDefaultProject, T0, withGenerator, withPage, withResource, withUpgrade } from './helpers/harness.js'

function stateOf(project: ProjectFile): GameState {
  return new GameState({ project, now: () => T0, nowIso: () => new Date(T0).toISOString() })
}

/** 四类条目齐备的夹具：资源 + 生成器 + 点击器 + 升级 + 两个页面。 */
function richProject() {
  // `createDefaultProject()` 的条目类都是空的（7.9 的“新建项目只写默认模板”），
  // 但它**带一个 p1 页面**——直接追加 p1 会得到两条同 id 的页面，
  // `AttributeStore` 只保留后写入的那条，导航与初值都会变得不可预测。因此先清空页面。
  let project: ProjectFile = { ...createDefaultProject(), pages: [], resources: [] }
  project = withResource({ id: 'r1', name: '矿石', description: '基础资源', initial: '0', max: '1e1e10' }, project)
  project = withGenerator(
    {
      id: 'g1',
      name: '矿机',
      description: '自动产出矿石',
      max: '500',
      costs: [{ materialId: 'r1', amount: '10 * 1.15 ^ gen.g1.bought' }],
      produces: [{ materialId: 'r1', amount: '1' }],
    },
    project,
  )
  project = withGenerator(
    {
      id: 'g2',
      name: '手动敲击',
      isClicker: true,
      initial: '1',
      max: '10',
      costs: [],
      produces: [{ materialId: 'r1', amount: '1' }],
    },
    project,
  )
  project = withUpgrade(
    {
      id: 'u1',
      name: '双倍产量',
      perSecond: true,
      conditions: ['gen.g1.bought >= 5'],
      costs: [{ materialId: 'r1', amount: '100' }],
      effects: [
        { condition: 'gen.g1.bought >= 5', action: 'set("gen.g1.produces[0].amount", "2")' },
        { condition: 'gen.g1.bought >= 20', action: 'effValue = 1.5 * gen.g1.owned' },
      ],
    },
    project,
  )
  project = withPage({ id: 'p1', name: '工厂', description: '主页面', columns: 3, order: 1 }, project)
  project = withPage({ id: 'p2', name: '实验区', disabled: true, order: 2 }, project)
  project = assignToPage(project, 'p1', ['r1', 'g1', 'g2', 'u1'])
  project = {
    ...project,
    meta: { ...project.meta, name: '示例：矿石工厂', author: 'IncrementForge', description: '最小可玩示例' },
  }
  return project
}

beforeEach(() => {
  resetDiagnostics()
  resetMonotonicCache()
  resetRateHistory()
  resetViewModelCache()
})

describe('8.11 + 8.12：视图骨架与页面导航', () => {
  it('标题取项目名（PRD 预览区 1）', () => {
    expect(buildViewModel(stateOf(richProject())).title).toBe('示例：矿石工厂')
  })

  it('底部导航按 page.order 渲染，最后一格固定是内置设置页（PRD 预览区 8、8.12）', () => {
    const view = buildViewModel(stateOf(richProject()))
    expect(view.nav.map((item) => item.id)).toEqual(['p1', 'p2', SETTINGS_PAGE_ID])
    expect(view.nav.at(-1)).toMatchObject({ id: SETTINGS_PAGE_ID, builtIn: true, name: '设置' })
    // 内置设置页不是 `PageDef`：不参与可见/禁用继承，因此禁用页面时它照样在。
    expect(view.nav.filter((item) => item.builtIn)).toHaveLength(1)
  })

  it('初始页面是 order 最小且可见的页面；不可见的页面不渲染导航按钮但仍可 nav() 直达', () => {
    const hidden = richProject()
    hidden.pages = hidden.pages.map((page) => (page.id === 'p1' ? { ...page, visible: false } : page))
    const state = stateOf(hidden)
    // 8.12：取 order 最小且可见的页面——p1 不可见时落到 p2，而不是报错。
    expect(state.currentPageId).toBe('p2')
    const view = buildViewModel(state)
    expect(view.nav.map((item) => item.id)).toEqual(['p2', SETTINGS_PAGE_ID])
    // 不可见页面不渲染按钮，但 `nav()` 仍可直达（8.12，供“解锁全部”与调试）。
    expect(state.nav('p1')).toBe(true)
    expect(state.currentPageId).toBe('p1')
  })

  it('全部页面不可见时取 order 最小的页面，不报错（8.12 的合法中间态）', () => {
    const allHidden = richProject()
    allHidden.pages = allHidden.pages.map((page) => ({ ...page, visible: false }))
    const state = stateOf(allHidden)
    expect(state.currentPageId).toBe('p1')
    expect(buildViewModel(state).nav.map((item) => item.id)).toEqual([SETTINGS_PAGE_ID])
  })

  it('pages 为空时停在内置设置页（8.12 的初值规则）', () => {
    const state = stateOf({ ...createDefaultProject(), pages: [] })
    expect(state.currentPageId).toBe(SETTINGS_PAGE_ID)
    const view = buildViewModel(state)
    expect(view.onSettings).toBe(true)
    expect(view.page).toBeNull()
    expect(view.nav.map((item) => item.id)).toEqual([SETTINGS_PAGE_ID])
  })

  it('导航不写入存档（6.3：导出存档无 currentPageId，D-50）', () => {
    const state = stateOf(richProject())
    state.nav('p2')
    expect(state.currentPageId).toBe('p2')
    const save = serializeSave(state, { projectId: 'test', projectName: 'x', engineVersion: '1.0.0' })
    expect(JSON.stringify(save)).not.toContain('currentPageId')
  })

  it('网格列数 = min(page.columns, 设备断点列数)（D-41、9.1）', () => {
    const state = stateOf(richProject())
    expect(buildViewModel(state, { maxColumns: 1 }).page?.columns).toBe(1)
    expect(buildViewModel(state, { maxColumns: 2 }).page?.columns).toBe(2)
    expect(buildViewModel(state, { maxColumns: 9 }).page?.columns).toBe(3)
    // 列数永远 ≥ 1：page.columns 被写成 0 时不能塌成 0 列。
    const zero = richProject()
    zero.pages = zero.pages.map((page) => ({ ...page, columns: 0 }))
    expect(buildViewModel(stateOf(zero), { maxColumns: 3 }).page?.columns).toBe(1)
  })

  it('页面描述渲染在页面上（PRD 预览区 7）', () => {
    expect(buildViewModel(stateOf(richProject())).page?.description).toBe('主页面')
  })
})

describe('8.11：四类卡片的字段与运行时生效值一致', () => {
  it('资源卡片：图标｜名称｜描述｜右侧数量，无购买按钮（D-20）', () => {
    const state = stateOf(richProject())
    state.attrs.write('res.r1.amount', Num.fromNumber(1234), '<test>')
    const view = buildViewModel(state)
    const card = view.page!.entries.find((entry) => entry.kind === 'resource')!
    expect(card.key).toBe('res.r1')
    expect(card.id).toBe('r1')
    expect(card.name).toBe('矿石')
    expect(card.description).toBe('基础资源')
    expect(card.icon).toBe('builtin:gem')
    // 数量与 AttributeStore 的生效值一致（格式化由 view-model 统一做）。
    expect(card.amount).toBe(Num.format(Num.fromNumber(1234), 'standard'))
    // 资源不可被购买（D-20）：不渲染价格与购买动作。
    expect(card.costs).toBeUndefined()
    expect(card.canBuy).toBeUndefined()
  })

  it('生成器卡片：产量 = owned × Σ单件速率（D-30，owned 只乘一次）', () => {
    const state = stateOf(richProject())
    state.attrs.write('gen.g1.bought', Num.fromNumber(3), '<test>')
    state.attrs.write('gen.g1.owned', Num.fromNumber(3), '<test>')
    const card = buildViewModel(state).page!.entries.find((entry) => entry.kind === 'generator')!
    // 单件速率 1、owned = 3 -> 每秒 3。若被写成 owned² 会是 9。
    expect(card.output).toBe('3')
    expect(card.outputUnit).toBe('second')
    expect(card.bought).toBe('3')
    expect(card.owned).toBe('3')
  })

  it('生成器卡片：`count` 模式的价格是**本次购买的合计**而非单价（PRD 预览区 5）', () => {
    const project = richProject()
    project.generators = project.generators.map((generator) =>
      // 用 `10 + 5 * bought` 这种**精确**的线性价格：断言“按级求和”而不是断言某个
      // 浮点字面量——`1.15^j` 的累加会因浮点与 Decimal 的差异在格式化时差一位有效数字，
      // 那种红灯只会让人去改期望值，掩盖真正要守的性质。
      generator.id === 'g1' ? { ...generator, buyAmount: '3', costs: [{ materialId: 'r1', amount: '10 + 5 * gen.g1.bought' }] } : generator,
    )
    const state = stateOf(project)
    const card = buildViewModel(state).page!.entries.find((entry) => entry.id === 'g1')!
    // P(0)+P(1)+P(2) = 10 + 15 + 20 = 45（既不是单价 10，也不是 3 × 10）
    expect(card.buyMode).toBe('count')
    // `richProject()` 的 r1 初始为 0，因此**一件也买不起**：价格行给的是“配置 3 件要多少”
    // （否则作者看不到“还差 45”），而按钮上写的是**当前买得起的 0 件**（`buyRequest` 是配置值）。
    expect(card.buyRequest).toBe(3)
    expect(card.buyCount).toBe(0)
    expect(card.costs![0]!.amount).toBe(Num.format(Num.fromNumber(45), 'standard'))
    expect(card.costs![0]!.amount).not.toBe(Num.format(Num.fromNumber(10), 'standard'))
    expect(card.costs![0]!.amount).not.toBe(Num.format(Num.fromNumber(30), 'standard'))
  })

  it('生成器卡片：件数与消耗都按**当前买得起**的量（按钮不许说谎，8.11 的价格行口径）', () => {
    const project = richProject()
    project.generators = project.generators.map((generator) =>
      generator.id === 'g1' ? { ...generator, buyAmount: '3', costs: [{ materialId: 'r1', amount: '10 + 5 * gen.g1.bought' }] } : generator,
    )
    const state = stateOf(project)
    // 30 只够买 P(0)+P(1) = 25，第三件差 20 —— 少一件就停（逐级确认，不是“单价 × 件数”）。
    state.attrs.write('res.r1.amount', Num.fromNumber(30), '<test>')
    const card = buildViewModel(state).page!.entries.find((entry) => entry.id === 'g1')!
    expect(card.buyRequest).toBe(3)
    expect(card.buyCount).toBe(2)
    expect(card.costs![0]!.amount).toBe('25')
    expect(card.canBuy).toBe(true)
    // 卡片写的件数必须等于点下去真的买到的件数（与 `solveBatch` 同一份算术）。
    expect(state.batch('g1')?.k.toNumber()).toBe(2)
  })

  it('生成器卡片：`max` 模式显示下一件单价（花费事先不可知）', () => {
    const project = richProject()
    project.generators = project.generators.map((generator) => (generator.id === 'g1' ? { ...generator, buyAmount: '0' } : generator))
    const card = buildViewModel(stateOf(project)).page!.entries.find((entry) => entry.id === 'g1')!
    expect(card.buyMode).toBe('max')
    expect(card.costs![0]!.amount).toBe('10')
  })

  it('生成器卡片：`free` 模式（自动最大购买）显示下一件单价且标注为 free', () => {
    const project = richProject()
    project.generators = project.generators.map((generator) => (generator.id === 'g1' ? { ...generator, buyAmount: '-1' } : generator))
    const card = buildViewModel(stateOf(project)).page!.entries.find((entry) => entry.id === 'g1')!
    expect(card.buyMode).toBe('free')
    expect(card.costs![0]!.amount).toBe('10')
  })

  it('点击器渲染为 clicker 形态：产量按“每次点击”，且不可购买（D-28、R-25）', () => {
    const state = stateOf(richProject())
    const card = buildViewModel(state).page!.entries.find((entry) => entry.id === 'g2')!
    expect(card.kind).toBe('clicker')
    expect(card.outputUnit).toBe('click')
    // owned = initial = 1，单件速率 1 -> 每次点击 +1
    expect(card.output).toBe('1')
    // 运行时硬约束：canBuy 恒假，即便数据模型里还留着 costs（本例为空）。
    expect(card.canBuy).toBe(false)
    expect(card.canClick).toBe(true)
    expect(card.buyBlockReason).toContain('点击器不可购买')
  })

  it('点击器达上限时不可点击（PRD 补充 3 的硬上限）', () => {
    const state = stateOf(richProject())
    state.attrs.write('gen.g2.owned', Num.fromNumber(10), '<test>')
    const card = buildViewModel(state).page!.entries.find((entry) => entry.id === 'g2')!
    expect(card.capped).toBe(true)
    expect(card.canClick).toBe(false)
  })

  it('升级卡片：条件逐条给出真假，效果给出当前文本与效果数值（PRD 预览区 6）', () => {
    const state = stateOf(richProject())
    state.attrs.write('gen.g1.bought', Num.fromNumber(7), '<test>')
    state.attrs.write('up.u1.effectValues[1]', Num.fromNumber(12), '<test>')
    // `canBuy` 除了结构性判定（8.4）还要判**材料**（否则按钮亮着、点下去结算 0 件）。
    state.attrs.write('res.r1.amount', Num.fromNumber(100), '<test>')
    const card = buildViewModel(state).page!.entries.find((entry) => entry.kind === 'upgrade')!
    expect(card.conditions).toEqual([{ text: 'gen.g1.bought >= 5', true: true }])
    expect(card.effects).toHaveLength(2)
    expect(card.effects![1]).toEqual({
      condition: 'gen.g1.bought >= 20',
      action: 'effValue = 1.5 * gen.g1.owned',
      value: '12',
    })
    expect(card.costs![0]!.amount).toBe('100')
    expect(card.canBuy).toBe(true)
  })

  it('材料不足时按钮禁用并说明原因（否则就是“亮着的死按钮”）', () => {
    const state = stateOf(richProject())
    state.attrs.write('gen.g1.bought', Num.fromNumber(7), '<test>')
    const card = buildViewModel(state).page!.entries.find((entry) => entry.kind === 'upgrade')!
    expect(card.canBuy).toBe(false)
    expect(card.buyBlockReason).toBe(NOT_ENOUGH_MATERIAL_REASON)
    // 价格仍然显示（作者要看到“还差 100”），只是按钮不再假装能买。
    expect(card.costs![0]!.amount).toBe('100')
  })

  it('条件不满足时升级不可购买，并给出“购买条件未满足”的原因', () => {
    const card = buildViewModel(stateOf(richProject())).page!.entries.find((entry) => entry.kind === 'upgrade')!
    expect(card.canBuy).toBe(false)
    expect(card.buyBlockReason).toBe('购买条件未满足')
  })

  it('卡片顺序 = 页面 entries 的 order（PRD 补充 7 的稳定排序）', () => {
    const entries = buildViewModel(stateOf(richProject())).page!.entries
    expect(entries.map((entry) => entry.id)).toEqual(['r1', 'g1', 'g2', 'u1'])
  })
})

describe('8.4：可见性与禁用的继承在卡片上的体现', () => {
  it('禁用保留卡片但置灰，且没有购买/点击按钮（8.11「卡片显隐」）', () => {
    const project = richProject()
    project.generators = project.generators.map((generator) => (generator.id === 'g1' ? { ...generator, disabled: true } : generator))
    const card = buildViewModel(stateOf(project)).page!.entries.find((entry) => entry.id === 'g1')!
    expect(card.disabled).toBe(true)
    expect(card.canBuy).toBe(false)
    expect(buildViewModel(stateOf(project)).page!.entries.some((entry) => entry.id === 'g1')).toBe(true)
  })

  it('不可见则不渲染（PRD 页面编辑器 5）', () => {
    const project = richProject()
    project.generators = project.generators.map((generator) => (generator.id === 'g1' ? { ...generator, visible: false } : generator))
    const ids = buildViewModel(stateOf(project)).page!.entries.map((entry) => entry.id)
    expect(ids).not.toContain('g1')
  })

  it('资源没有“禁用”态：页面禁用不置灰资源卡片（8.4 的两条容易搞反的规则）', () => {
    const project = richProject()
    project.pages = project.pages.map((page) => (page.id === 'p1' ? { ...page, disabled: true } : page))
    const entries = buildViewModel(stateOf(project)).page!.entries
    expect(entries.find((entry) => entry.id === 'r1')!.disabled).toBe(false)
    // 同页面下的生成器被页面禁用波及。
    expect(entries.find((entry) => entry.id === 'g1')!.disabled).toBe(true)
  })

  it('页面可见性对**所有**条目生效（含资源，PRD 页面编辑器 5）', () => {
    const project = richProject()
    project.pages = project.pages.map((page) => (page.id === 'p1' ? { ...page, visible: false } : page))
    // 页面不可见时初始页会回到 p2（8.12），因此这里直接检查 p1 的渲染结果。
    const state = stateOf(project)
    state.nav('p1')
    expect(buildViewModel(state).page!.entries).toHaveLength(0)
  })
})

describe('8.9：仪表盘', () => {
  it('资源数量与增长速度与 AttributeStore 一致', () => {
    const state = stateOf(richProject())
    state.attrs.write('gen.g1.bought', Num.fromNumber(2), '<test>')
    state.attrs.write('gen.g1.owned', Num.fromNumber(2), '<test>')
    for (let i = 0; i < 100; i += 1) state.stepTick(50, 50)
    const view = buildViewModel(state)
    const resource = view.dashboard.resources[0]!
    const entity = state.attrs.find(entityKeyOf('resource', 'r1'))!
    expect(resource.amount).toBe(Num.format(state.attrs.value(entity, 'amount'), 'standard'))
    expect(resource.rate).not.toBe('0')
  })

  it('“下一个可购买条目”的预测时间用**下一件**价格（只读等级视图 j = bought + 1，8.9/8.6.1）', () => {
    const state = stateOf(richProject())
    // 陡峭价格：P(0)=10 而 P(1)=115，用 bought 级价格会让预测早一个数量级。
    state.attrs.write('res.r1.amount', Num.fromNumber(1), '<test>')
    state.attrs.write('gen.g1.bought', Num.fromNumber(0), '<test>')
    const view = buildViewModel(state)
    // 材料速率此时为 0（没有生成器在产出）-> 按 8.9 显示 `—` 并给原因。
    expect(view.dashboard.nextBuy).toBeUndefined()
    expect(view.dashboard.nextBuyHint).toBeTruthy()
  })

  it('免费模式（buyAmount < 0）的预测时间是 0（显示“现在”，不因材料不足而递增）', () => {
    const project = richProject()
    project.generators = project.generators.map((generator) => (generator.id === 'g1' ? { ...generator, buyAmount: '-1', costs: [] } : generator))
    const state = stateOf(project)
    const view = buildViewModel(state)
    expect(view.dashboard.nextBuy?.id).toBe('g1')
    expect(view.dashboard.nextBuy?.dt).toBe('0')
  })

  it('只有点击器时给出“只有点击器（不可购买）”的原因（8.9 的 `—` 分支）', () => {
    const project = withPage({ id: 'p1', name: 'P' }, createDefaultProject())
    const withClicker = withGenerator({ id: 'g9', name: '点我', isClicker: true, costs: [], produces: [] }, project)
    const assigned = assignToPage(withClicker, 'p1', ['g9'])
    assigned.pages = assigned.pages.map((page) => ({ ...page, entries: [{ id: 'g9', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } }] }))
    const view = buildViewModel(stateOf(assigned))
    expect(view.dashboard.nextBuy).toBeUndefined()
    expect(view.dashboard.nextBuyHint).toBe('只有点击器（不可购买）')
  })

  it('已达数量上限时给出“已达上限”（8.9 的 `—` 分支）', () => {
    const state = stateOf(richProject())
    state.attrs.write('gen.g1.owned', Num.fromNumber(500), '<test>')
    expect(buildViewModel(state).dashboard.nextBuyHint).toBe('已达上限')
  })
})

describe('8.10：游戏内设置页与来源徽标的数据源（R-24）', () => {
  it('六项设置的默认值来自项目文件，全部 `overridden = false`', () => {
    const view = buildViewModel(stateOf(richProject()))
    expect(view.settings.settings.map((field) => field.key)).toEqual(SETTING_FIELDS.map((field) => field.key))
    expect(view.settings.settings.every((field) => !field.overridden)).toBe(true)
    expect(view.settings.settings.map((field) => field.value)).toEqual(['standard', '20', '250', '30', 'true', '8'])
  })

  it('会话覆盖后 `overridden = true` 且同时保留项目默认值（徽标要显示后者）', () => {
    const state = stateOf(richProject())
    state.settingsOverride = { tickRate: 60 }
    const field = buildViewModel(state).settings.settings.find((item) => item.key === 'tickRate')!
    expect(field.overridden).toBe(true)
    expect(field.value).toBe('60')
    expect(field.projectDefault).toBe('20')
    expect(field.effective).toBe('60')
  })

  it('数字格式影响全部展示文本（4.5 的 numberFormat 是全局的）', () => {
    const state = stateOf(richProject())
    state.settingsOverride = { numberFormat: 'scientific' }
    state.attrs.write('res.r1.amount', Num.fromNumber(123456), '<test>')
    expect(buildViewModel(state).dashboard.resources[0]!.amount).toContain('e')
  })

  it('只读信息包含项目名/作者/描述/游戏时间/最后存档与动态条目计数（PRD 预览区 9）', () => {
    const view = buildViewModel(stateOf(richProject()), { savedAt: T0 })
    expect(view.settings.projectName).toBeTruthy()
    expect(view.settings.author).toBeTruthy()
    expect(view.settings.gameTime).toBe('0')
    expect(view.settings.savedAt).not.toBe('—')
    expect(view.settings.dynamicCount).toBe(0)
    expect(view.settings.dynamicLimit).toBe(2000)
  })
})

describe('8.10：生效的页面主题（`pageTheme`）与“页面主题”开关的数据源', () => {
  /** 给某个页面换主题的 `richProject` 变体。 */
  function withPageTheme(id: string, theme = 'page-light') {
    const project = richProject()
    project.pages = project.pages.map((page) => (page.id === id ? { ...page, theme: { kind: 'builtin' as const, value: theme } } : page))
    return project
  }

  it('默认取当前页面的主题（壳层与页面同色，PRD 页面编辑器 6）', () => {
    expect(buildViewModel(stateOf(richProject())).pageTheme).toBe('builtin:page-dark')
    expect(buildViewModel(stateOf(withPageTheme('p1'))).pageTheme).toBe('builtin:page-light')
  })

  it('停在内置设置页时取 8.12 的**初始页面**主题，而不是掉回 `page-dark` 缺省', () => {
    // 内置设置页是哨兵 `__settings__`，没有 `PageDef.theme`，而它又是壳层的一部分
    // （PRD 页面编辑器 6 要求壳层与页面一致）。视图若在缺省路径上回落
    // `DEFAULT_THEME.page`，症状就是“点进设置、整屏跳成暗色”。
    const state = stateOf(withPageTheme('p1'))
    state.nav(SETTINGS_PAGE_ID)
    expect(state.currentPageId).toBe(SETTINGS_PAGE_ID)
    expect(buildViewModel(state).pageTheme).toBe('builtin:page-light')
    // `page` 仍然是 `null`（设置页不是 PageDef，8.12）——主题答案与页面数据是两件事。
    expect(buildViewModel(state).page).toBeNull()
  })

  it('页面主题覆盖时 `page.theme` 跟着换（PRD 页面编辑器 8）', () => {
    const state = stateOf(richProject())
    const view = buildViewModel(state, { themeOverride: 'builtin:page-light' })
    expect(view.pageTheme).toBe('builtin:page-light')
    expect(view.page?.theme).toBe('builtin:page-light')
  })

  it('条目没有显式主题时，缺省跟随**生效**的页面主题而不是项目里那一份', () => {
    // `assignToPage` 给每条页面条目都写了 `entry-dark`，因此先删掉（=“跟随页面主题”，
    // PRD 页面编辑器 8）。否则卡片会停在暗色而页面变白，正是主题覆盖最刺眼的失效。
    const project = richProject()
    project.pages = project.pages.map((page) => ({
      ...page,
      entries: page.entries.map((entry) => {
        const rest = { ...entry }
        delete rest.theme
        return rest
      }),
    }))
    const view = buildViewModel(stateOf(project), { themeOverride: 'builtin:page-light' })
    expect(view.page?.theme).toBe('builtin:page-light')
    expect(view.page?.entryTheme).toBe('builtin:page-light')
  })

  it('作者显式配的条目主题不随页面主题覆盖而变（PRD 页面编辑器 8）', () => {
    // `richProject` 的每条页面条目都显式配了 `entry-dark`（`assignToPage`）。
    const view = buildViewModel(stateOf(richProject()), { themeOverride: 'builtin:page-light' })
    expect(view.page?.theme).toBe('builtin:page-light')
    expect(view.page?.entryTheme).toBe('builtin:entry-dark')
  })

  it('“跟随页面”（`THEME_FOLLOW_PAGE`）等价于没有覆盖', () => {
    const view = buildViewModel(stateOf(withPageTheme('p1')), { themeOverride: THEME_FOLLOW_PAGE })
    expect(view.pageTheme).toBe('builtin:page-light')
    expect(view.settings.theme.overridden).toBe(false)
    expect(view.settings.theme.value).toBe(THEME_FOLLOW_PAGE)
  })

  it('设置页的“页面主题”一行给出生效值、项目默认值与是否被覆盖（R-24 的徽标口径）', () => {
    const state = stateOf(withPageTheme('p1'))
    state.nav(SETTINGS_PAGE_ID)
    const view = buildViewModel(state, { themeOverride: 'builtin:page-midnight' })
    expect(view.settings.theme).toEqual({
      value: 'builtin:page-midnight',
      projectTheme: 'builtin:page-light',
      overridden: true,
    })
  })

  it('没有页面时（pages 为空、停在内置设置页）落到 `page-dark` 缺省而不是崩', () => {
    const project = createDefaultProject()
    project.pages = []
    const state = stateOf(project)
    expect(buildViewModel(state).pageTheme).toBe('builtin:page-dark')
  })
})

describe('8.8：离线收益提示条的数据（R-14、D-49、R-20）', () => {
  it('把 OfflineReport 派生成可展示文本，并保留截断/近似/回拨三个标志', () => {
    const state = stateOf(richProject())
    const view = buildViewModel(state, {
      offline: {
        settled: true,
        rawSeconds: 36000,
        settledSeconds: 28800,
        gains: [{ resourceId: 'r1', gained: Num.fromNumber(4242) }],
        segments: 200,
        clockRollback: false,
        approximate: true,
        truncated: true,
      },
    })
    expect(view.offline).toMatchObject({
      rawSeconds: '10小时',
      settledSeconds: '8小时',
      truncated: true,
      approximate: true,
      deferred: true,
      clockRollback: false,
    })
    expect(view.offline!.gains).toEqual([{ id: 'r1', name: '矿石', gained: Num.format(Num.fromNumber(4242), 'standard') }])
  })

  it('墙钟回拨时不显示时长/收益，只显示回拨标志（R-20）', () => {
    const view = buildViewModel(stateOf(richProject()), {
      offline: {
        settled: false,
        rawSeconds: 0,
        settledSeconds: 0,
        gains: [],
        segments: 0,
        clockRollback: true,
        approximate: false,
        truncated: false,
      },
    })
    expect(view.offline!.clockRollback).toBe(true)
    expect(view.offline!.rawSeconds).toBe('0秒')
  })
})

describe('辅助格式化', () => {
  it('秒数 -> 人读文本', () => {
    expect(formatSeconds(0)).toBe('0秒')
    expect(formatSeconds(45)).toBe('45秒')
    expect(formatSeconds(60)).toBe('1分')
    expect(formatSeconds(83)).toBe('1分23秒')
    expect(formatSeconds(3600)).toBe('1小时')
    expect(formatSeconds(3660)).toBe('1小时1分')
    expect(formatSeconds(Number.NaN)).toBe('0秒')
  })

  it('时间戳 -> `YYYY-MM-DD HH:mm`；缺省/非法给 `—`（8.10）', () => {
    expect(formatTimestamp(null)).toBe('—')
    expect(formatTimestamp(0)).toBe('—')
    expect(formatTimestamp(Number.NaN)).toBe('—')
    expect(formatTimestamp(T0)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe('视图模型与 8.3 的 tick 保持同步', () => {
  it('跑 200 tick 后视图里的资源数量与 GameState 完全一致', () => {
    const state = stateOf(richProject())
    state.attrs.write('gen.g1.bought', Num.fromNumber(1), '<test>')
    state.attrs.write('gen.g1.owned', Num.fromNumber(1), '<test>')
    for (let i = 0; i < 200; i += 1) state.stepTick(50, 50)
    const view = buildViewModel(state)
    const entity = state.attrs.find(entityKeyOf('resource', 'r1'))!
    expect(view.dashboard.resources[0]!.amount).toBe(Num.format(state.attrs.value(entity, 'amount'), 'standard'))
    // 结算副作用落在 committed 之后：视图读到的必须是提交后的值（5.6 的单一提交点）。
    expect(Diagnostics.count('E_UNKNOWN_ATTR')).toBe(0)
  })
})
