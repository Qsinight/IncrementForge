/**
 * `GameController`（TECH_DESIGN 8.2 主循环、8.3 单 tick 顺序、8.3.1 交互与 tick 边界、
 * 9.2 协议入站、9.3 生命周期、8.8 离线结算、10.3 存档时机）。
 *
 * 这些用例是 M4 交付标准“预览与运行时数据一致”的**行为侧**：
 * 视图断言（`view.test.tsx`）证明“画出来的是运行时算的”，这里证明“运行时按 8.x 的时序算”。
 */
import { describe, beforeEach, expect, it } from 'vitest'

import { Diagnostics, Num, resetDiagnostics } from '@iforge/num'
import type { ProjectFile, SaveFile } from '@iforge/model'
import { SETTINGS_PAGE_ID, THEME_FOLLOW_PAGE, diffProject, serializeSave } from '@iforge/runtime'

import { FRAME_MS, makeController } from './helpers/fixture.js'

// `Diagnostics` 是模块级全局（`num` 包）：复位后才好断言“这一次记了一条”。
beforeEach(() => resetDiagnostics())

/** 资源 + 生成器 + 点击器 + 升级（含 `set()` 效果）的夹具。 */
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
        costs: [{ materialId: 'r1', amount: '10 + 5 * gen.g1.bought' }],
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
        name: '强化',
        description: '把矿机速率改成 4',
        icon: { kind: 'builtin', value: 'star' },
        initial: '0',
        max: '1',
        visible: true,
        disabled: false,
        perSecond: false,
        buyAmount: '1',
        buyDelay: 1,
        conditions: ['gen.g1.bought >= 1'],
        costs: [{ materialId: 'r1', amount: '5' }],
        effects: [{ condition: 'gen.g1.bought >= 1', action: 'set("gen.g1.produces[0].amount", "4")' }],
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
    ],
    assets: {},
  }
}

describe('9.3：生命周期', () => {
  it('start() 发出 game:ready 并开始请求下一帧', () => {
    const fixture = makeController({ project: demoProject() })
    expect(fixture.sink.readyLog).toHaveLength(0)
    fixture.start()
    expect(fixture.sink.readyLog).toEqual([{ engineVersion: '1.0.0', warnings: [] }])
    expect(fixture.frames.pending).toBe(1)
  })

  it('stop() 之后不再请求帧（9.3 第 4 步：释放 tick）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.runFrames(3)
    fixture.controller.stop()
    expect(fixture.frames.pending).toBe(0)
    const before = fixture.controller.state.stats.tick
    fixture.runFrames(5)
    expect(fixture.controller.state.stats.tick).toBe(before)
  })

  it('dispose() 后视图不再重建（避免已销毁的 iframe 里继续跑）', () => {
    const fixture = makeController({ project: demoProject() })
    let notified = 0
    fixture.controller.subscribe(() => {
      notified += 1
    })
    fixture.start()
    fixture.controller.dispose()
    const snapshot = notified
    fixture.runFrames(3)
    expect(notified).toBe(snapshot)
  })
})

describe('8.2：主循环', () => {
  it('按 tickRate 推进 tick，而不是按帧率', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    // 20 tick/s、16ms/帧 -> 约 31 帧推进 1 秒 -> 约 20 个 tick。
    fixture.runFrames(63, FRAME_MS)
    const tick = fixture.controller.state.stats.tick
    expect(tick).toBeGreaterThanOrEqual(19)
    expect(tick).toBeLessThanOrEqual(21)
  })

  it('暂停时 tick 与产出都不再增长，但视图仍然可用', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.controller.state.attrs.write('gen.g1.owned', Num.fromNumber(1), '<test>')
    fixture.runFrames(30)
    fixture.controller.applyControl('pause')
    const tick = fixture.controller.state.stats.tick
    const resource = fixture.controller.state.attrs.find('res.r1')!
    const amount = fixture.controller.state.attrs.value(resource, 'amount')
    fixture.runFrames(60)
    expect(fixture.controller.state.stats.tick).toBe(tick)
    expect(fixture.controller.state.attrs.value(resource, 'amount').eq(amount)).toBe(true)
    // 恢复后继续推进，且不会因为暂停期间堆积的时间而爆发（8.2 的丢弃积压）。
    fixture.controller.applyControl('resume')
    fixture.runFrames(30)
    expect(fixture.controller.state.stats.tick).toBeGreaterThan(tick)
  })

  it('暂停期间交互即时结算，副作用待恢复后的第一个 tick（8.3.1）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    const state = fixture.controller.state
    state.attrs.write('res.r1.amount', Num.fromNumber(1000), '<test>')
    fixture.controller.applyControl('pause')
    fixture.controller.buy('g1')

    const generator = state.attrs.find('gen.g1')!
    // 状态字段即时结算（8.3.1 第一行）。
    expect(state.attrs.value(generator, 'bought').toNumber()).toBe(1)
    // 升级 u1 的条件此刻已为真——但购买时收集的副作用（`set(...)`）
    // 必须等到恢复后的第一个 tick 的第 6 步才提交。
    expect(state.attrs.textOr(generator, 'produces[0].amount')).toBe('1')

    // 购买 u1：同样即时推进 bought/owned，但它的 `set()` 也仍在队列里。
    fixture.controller.buy('u1')
    expect(state.attrs.value(state.attrs.find('up.u1')!, 'bought').toNumber()).toBe(1)
    expect(state.attrs.textOr(generator, 'produces[0].amount')).toBe('1')

    fixture.controller.applyControl('resume')
    // 20 tick/s 需要累计 50ms 才推进一个 tick，3 帧 × 16ms = 48ms 恰好不够；
    // 跑满 10 帧以确保**至少**进入过一次提交阶段（8.3 第 6 步）。
    fixture.runFrames(10)
    expect(state.attrs.textOr(generator, 'produces[0].amount')).toBe('4')
  })

  it('倍速只放大游戏内时间，不改变 tickRate（D-31）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.controller.applyControl('speed', 10)
    fixture.runFrames(63)
    const tick = fixture.controller.state.stats.tick
    // 10 倍速：同样帧数下推进的 tick 约为 10 倍。
    expect(tick).toBeGreaterThanOrEqual(150)
    expect(fixture.controller.state.effectiveSettings().tickRate).toBe(20)
  })

  it('game:stats 按 10Hz 节流上报（9.2）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.runFrames(60, FRAME_MS)
    const emitted = fixture.sink.statsLog.length
    expect(emitted).toBeGreaterThan(0)
    // 60 帧 ≈ 960ms -> 最多 10 条。
    expect(emitted).toBeLessThanOrEqual(11)
  })
})

describe('8.3.1：交互事件的即时结算', () => {
  it('点击器点击立即增加资源数量并回传 click 事件', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.controller.click('g2')
    const resource = fixture.controller.state.attrs.find('res.r1')!
    // owned = initial = 1，单件速率 1 -> 每次点击 +1。
    expect(fixture.controller.state.attrs.value(resource, 'amount').toNumber()).toBe(1)
    expect(fixture.sink.events.at(-1)).toMatchObject({ type: 'click', target: 'g2', payload: { ok: true } })
  })

  it('购买推进 bought/owned、扣掉材料，并按 buyAmount 的模式结算', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    const state = fixture.controller.state
    state.attrs.write('res.r1.amount', Num.fromNumber(100), '<test>')
    state.attrs.write('gen.g1.buyAmount', '3', '<test>')

    fixture.controller.buy('g1')
    const generator = state.attrs.find('gen.g1')!
    expect(state.attrs.value(generator, 'bought').toNumber()).toBe(3)
    // 价格按级求和：10 + 15 + 20 = 45。
    expect(state.attrs.value(state.attrs.find('res.r1')!, 'amount').toNumber()).toBe(55)
  })

  it('材料不足时买不到任何件数（8.5 的 E_NOT_ENOUGH），且事件如实回传 k = 0', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.controller.buy('g1')
    const generator = fixture.controller.state.attrs.find('gen.g1')!
    expect(fixture.controller.state.attrs.value(generator, 'bought').toNumber()).toBe(0)
    expect(fixture.sink.events.at(-1)).toMatchObject({ type: 'buy', target: 'g1', payload: { k: '0' } })
  })

  it('点击器不可购买：buy() 无效（D-28 的运行时硬约束，不只是 UI 隐藏按钮）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    const state = fixture.controller.state
    state.attrs.write('res.r1.amount', Num.fromNumber(1000), '<test>')
    fixture.controller.buy('g2')
    expect(state.attrs.value(state.attrs.find('gen.g2')!, 'bought').toNumber()).toBe(0)
  })

  it('丢弃动态条目立即生效（不经 EffectSink），下一次渲染卡片就消失', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    const state = fixture.controller.state
    state.dynamic.create('upgrade', { id: 'uTmp', name: '临时', page: 'p1' })
    fixture.controller.refresh()
    expect(fixture.controller.getView().page!.entries.some((entry) => entry.id === 'uTmp')).toBe(true)

    fixture.controller.discard('uTmp')
    expect(state.dynamicCount()).toBe(0)
    expect(fixture.controller.getView().page!.entries.some((entry) => entry.id === 'uTmp')).toBe(false)
    expect(fixture.sink.events.at(-1)).toMatchObject({ type: 'discard', target: 'uTmp' })
  })

  it('页面跳转经 nav()，禁用页面也能跳转（8.12、PRD 页面编辑器 4）', () => {
    const project = demoProject()
    project.pages = [...project.pages, { ...project.pages[0]!, id: 'p2', order: 2, name: '实验区', disabled: true, entries: [] }]
    const fixture = makeController({ project })
    fixture.start()
    fixture.controller.navigate('p2')
    expect(fixture.controller.state.currentPageId).toBe('p2')
    expect(fixture.sink.events.at(-1)).toMatchObject({ type: 'nav', target: 'p2', payload: { ok: true } })
  })

  it('导航到不存在的页面报 E_PAGE_UNKNOWN 且不改变当前页（8.12）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    const before = fixture.controller.state.currentPageId
    fixture.controller.navigate('pNope')
    expect(fixture.controller.state.currentPageId).toBe(before)
    expect(fixture.sink.events.at(-1)).toMatchObject({ payload: { ok: false } })
  })
})

describe('8.4 / D-16：解锁全部', () => {
  it('一次性把页面与条目的 visible 置真、disabled 置假', () => {
    const project = demoProject()
    project.resources = project.resources.map((r) => ({ ...r, visible: false }))
    project.pages = project.pages.map((p) => ({ ...p, disabled: true }))
    const fixture = makeController({ project })
    fixture.start()
    fixture.controller.applyControl('unlockAll')
    const state = fixture.controller.state
    expect(state.attrs.find('res.r1')!.visible).toBe(true)
    expect(state.attrs.find('page.p1')!.disabled).toBe(false)
    expect(state.judge.isDisabled(state.attrs.find('gen.g1')!)).toBe(false)
    // 当前页面因不可见而被复位到别处，这里重新选一个可见页面（8.4）。
    expect(state.currentPageId).toBe('p1')
  })

  it('forceUnlock 不写入存档也不写项目文件（8.4 末条、D-16）', () => {
    const project = demoProject()
    project.resources = project.resources.map((r) => ({ ...r, visible: false }))
    const fixture = makeController({ project })
    fixture.start()
    fixture.controller.applyControl('unlockAll')
    const save = serializeSave(fixture.controller.state, {
      projectId: 'test-project',
      projectName: 'x',
      engineVersion: '1.0.0',
    })
    expect(JSON.stringify(save)).not.toContain('forceUnlock')
    expect(JSON.stringify(fixture.controller.state.project)).not.toContain('forceUnlock')
  })

  it('重新开始后强制解锁标记清空（此后再次“解锁全部”才重新置位）', () => {
    const project = demoProject()
    project.resources = project.resources.map((r) => ({ ...r, visible: false }))
    const fixture = makeController({ project })
    fixture.start()
    fixture.controller.applyControl('unlockAll')
    expect(fixture.controller.state.isForceUnlocked('res.r1')).toBe(true)
    fixture.controller.applyControl('restart')
    expect(fixture.controller.state.isForceUnlocked('res.r1')).toBe(false)
  })
})

describe('8.10 / D-22：游戏内设置的会话覆盖', () => {
  it('改设置只写会话覆盖，项目默认设置不变（R-24）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    const projectBefore = JSON.stringify(fixture.controller.state.project.settings)
    fixture.controller.setGameSetting('tickRate', '60')
    expect(fixture.controller.state.effectiveSettings().tickRate).toBe(60)
    expect(JSON.stringify(fixture.controller.state.project.settings)).toBe(projectBefore)
    // 回传 game:event{settings}，宿主只写 previewStore（见 editor/preview/session.ts）。
    expect(fixture.sink.events.at(-1)).toMatchObject({ type: 'settings', payload: { tickRate: '60' } })
  })

  it('改回项目默认值等价于撤销该覆盖（D-22 的“恢复默认设置”也是同一条路径）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.controller.setGameSetting('tickRate', '60')
    fixture.controller.setGameSetting('tickRate', '20')
    expect(fixture.controller.state.settingsOverride.tickRate).toBeUndefined()
    expect(fixture.controller.state.effectiveSettings().tickRate).toBe(20)
  })

  it('恢复默认设置清空全部覆盖，但不清游戏进度', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    const generator = fixture.controller.state.attrs.find('gen.g1')!
    fixture.controller.state.attrs.write('gen.g1.bought', Num.fromNumber(4), '<test>')
    fixture.controller.setGameSetting('tickRate', '60')
    fixture.controller.setGameSetting('offlineCap', '1')
    fixture.controller.resetSettingsDefaults()
    expect(fixture.controller.state.settingsOverride).toEqual({})
    expect(fixture.controller.state.attrs.value(generator, 'bought').toNumber()).toBe(4)
  })

  it('不能解析为数值的输入被拒：tickRate 保持上一次成功值（避免主循环变 NaN）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.controller.setGameSetting('tickRate', '60')
    fixture.controller.setGameSetting('tickRate', 'abc')
    // 归一化失败的字段不进入覆盖，last-good 仍是 60（与 5.9.3 的思路一致）。
    expect(fixture.controller.state.effectiveSettings().tickRate).toBe(60)
  })
})

describe('8.10：会话级页面主题覆盖', () => {
  it('改主题只写会话覆盖，回传 theme 事件，项目文件不变', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    const projectBefore = JSON.stringify(fixture.controller.state.project.pages[0]!.theme)
    fixture.controller.setThemeOverride('builtin:page-light')
    expect(fixture.controller.getView().pageTheme).toBe('builtin:page-light')
    expect(JSON.stringify(fixture.controller.state.project.pages[0]!.theme)).toBe(projectBefore)
    expect(fixture.sink.events.at(-1)).toMatchObject({ type: 'theme', payload: { theme: 'builtin:page-light' } })
  })

  it('`THEME_FOLLOW_PAGE` 清掉覆盖，回到作者设定的主题', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.controller.setThemeOverride('builtin:page-light')
    fixture.controller.setThemeOverride(THEME_FOLLOW_PAGE)
    expect(fixture.controller.getView().pageTheme).toBe('builtin:page-dark')
    expect(fixture.controller.getView().settings.theme.overridden).toBe(false)
  })

  it('构造时的 `themeOverride` 被接受（打包态从 localStorage 读回，D-22 同层）', () => {
    const fixture = makeController({ project: demoProject(), themeOverride: 'builtin:page-midnight' })
    fixture.start()
    expect(fixture.controller.getView().pageTheme).toBe('builtin:page-midnight')
  })

  it('自定义主题（CSS 文本）被拒：保持原主题并记诊断（13 第 5 条的安全过滤不被绕过）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.controller.setThemeOverride(':root{--iforge-page-bg:#ff0000}')
    expect(fixture.controller.getView().pageTheme).toBe('builtin:page-dark')
    expect(Diagnostics.countsSnapshot()['E_ASSIGN_TYPE']).toBeGreaterThan(0)
    // 被拒的值回传 `rejected`，打包态据此**不落盘**（否则下次启动拿到从未生效过的坏值）。
    expect(fixture.sink.events.at(-1)).toMatchObject({ type: 'theme', payload: { rejected: true } })
  })

  it('“恢复默认设置”连带清掉主题覆盖（都是玩家偏好层）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.controller.setThemeOverride('builtin:page-light')
    fixture.controller.resetSettingsDefaults()
    expect(fixture.controller.getView().pageTheme).toBe('builtin:page-dark')
    // 打包态的落盘侧据此删掉 `incrementforge.ui.*` 键，否则刷新后又变回覆盖值。
    expect(fixture.sink.events.at(-1)).toMatchObject({ type: 'theme', payload: { theme: THEME_FOLLOW_PAGE } })
  })
})

describe('9.2 入站：host:init / host:patch / host:save', () => {
  it('applyInit 装入新项目并复位（新建/打开另一个项目走这条路径）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.controller.state.attrs.write('gen.g1.bought', Num.fromNumber(7), '<test>')

    const other = demoProject()
    other.meta.name = '另一个项目'
    fixture.controller.applyInit({ project: other })

    expect(fixture.controller.getView().title).toBe('另一个项目')
    const generator = fixture.controller.state.attrs.find('gen.g1')!
    expect(fixture.controller.state.attrs.value(generator, 'bought').toNumber()).toBe(0)
  })

  it('applyPatches 热更新保留本局进度（7.4）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    const state = fixture.controller.state
    state.attrs.write('res.r1.amount', Num.fromNumber(100), '<test>')
    fixture.controller.buy('g1')
    expect(state.attrs.value(state.attrs.find('gen.g1')!, 'bought').toNumber()).toBe(1)

    const next = demoProject()
    next.generators = next.generators.map((g) => (g.id === 'g1' ? { ...g, name: '矿机 II' } : g))
    fixture.controller.applyPatches(diffProject(state.project, next))

    expect(fixture.controller.getView().page!.entries.find((e) => e.id === 'g1')!.name).toBe('矿机 II')
    expect(state.attrs.value(state.attrs.find('gen.g1')!, 'bought').toNumber()).toBe(1)
    expect(state.attrs.value(state.attrs.find('res.r1')!, 'amount').toNumber()).toBe(90)
  })

  it('applyControl(restart) 清空进度、动态条目与离线报告（D-18）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    const state = fixture.controller.state
    state.attrs.write('gen.g1.bought', Num.fromNumber(3), '<test>')
    state.dynamic.create('upgrade', { id: 'uTmp', name: '临时', page: 'p1' })
    fixture.controller.applyControl('restart')
    const generator = state.attrs.find('gen.g1')!
    expect(state.attrs.value(generator, 'bought').toNumber()).toBe(0)
    expect(state.dynamicCount()).toBe(0)
    expect(fixture.controller.offline()).toBeNull()
  })

  it('exportSave 不含 currentPageId 与游戏内设置（6.3、D-50、D-22）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    fixture.controller.setGameSetting('tickRate', '60')
    fixture.controller.navigate(SETTINGS_PAGE_ID)
    const save = fixture.controller.exportSave()
    expect(JSON.stringify(save)).not.toContain('currentPageId')
    expect(JSON.stringify(save)).not.toContain('settingsOverride')
  })

  it('“导出存档”回传 intent: export（D-51），自动存档回传 autosave', () => {
    const project = demoProject()
    project.settings = { ...project.settings, autosaveInterval: 1 }
    const fixture = makeController({ project })
    fixture.start()
    fixture.controller.requestExportSave()
    expect(fixture.sink.saves.at(-1)?.intent).toBe('export')

    fixture.runFrames(120, FRAME_MS)
    expect(fixture.sink.saves.some((entry) => entry.intent === 'autosave')).toBe(true)
  })

  it('导入存档：校验失败不改动任何状态（10.2）', () => {
    const fixture = makeController({ project: demoProject() })
    fixture.start()
    const generator = fixture.controller.state.attrs.find('gen.g1')!
    const before = fixture.controller.state.attrs.value(generator, 'bought').toString()
    fixture.controller.applyImportSaveText('{ not json')
    fixture.controller.applyImportSaveText(JSON.stringify({ format: 'wrong' }))
    expect(fixture.controller.state.attrs.value(generator, 'bought').toString()).toBe(before)
    expect(fixture.sink.errors.some((error) => error.code === 'E_SCHEMA')).toBe(true)
  })

  it('导入合法存档会覆盖当前进度并重建动态条目（6.3 的读档顺序）', () => {
    const source = makeController({ project: demoProject() })
    source.start()
    source.controller.state.attrs.write('res.r1.amount', Num.fromNumber(100), '<test>')
    source.controller.state.dynamic.create('upgrade', {
      id: 'uTmp',
      name: '临时强化',
      page: 'p1',
      costs: [{ materialId: 'r1', amount: '1' }],
    })
    source.controller.buy('g1')
    const save: SaveFile = source.controller.exportSave()

    const target = makeController({ project: demoProject() })
    target.start()
    target.controller.applyImportSaveText(JSON.stringify(save))
    expect(target.controller.state.dynamicCount()).toBe(1)
    const generator = target.controller.state.attrs.find('gen.g1')!
    expect(target.controller.state.attrs.value(generator, 'bought').toNumber()).toBe(1)
  })
})

describe('8.8 / 10.3：离线结算与自动存档', () => {
  it('载入带 savedAt 的存档时结算离线收益并给出提示条（8.8 末条）', () => {
    const first = makeController({ project: demoProject() })
    first.start()
    first.controller.state.attrs.write('gen.g1.bought', Num.fromNumber(1), '<test>')
    first.controller.state.attrs.write('gen.g1.owned', Num.fromNumber(1), '<test>')
    first.runFrames(120)
    const save = first.controller.exportSave()

    // 第二个会话在 1 小时后打开同一个存档。
    const later = makeController({
      project: demoProject(),
      save,
      startWallAt: Date.parse(save.savedAt) + 3_600_000,
    })
    later.start()
    const report = later.controller.offline()
    expect(report).not.toBeNull()
    expect(report!.settled).toBe(true)
    expect(report!.settledSeconds).toBeGreaterThan(0)
    const view = later.controller.getView()
    expect(view.offline).not.toBeNull()
    expect(view.offline!.gains.length).toBeGreaterThan(0)
  })

  it('离线跳过“每秒生效”与自动购买（PRD 设置页 9 给出的“低于在线”的真正依据）', () => {
    const first = makeController({ project: demoProject() })
    first.start()
    first.controller.state.attrs.write('gen.g1.owned', Num.fromNumber(1), '<test>')
    first.runFrames(60)
    const save = first.controller.exportSave()

    const later = makeController({
      project: demoProject(),
      save,
      startWallAt: Date.parse(save.savedAt) + 600_000,
    })
    later.start()
    // 离线期间不产生任何副作用：升级 u1 的效果文本没有被改写。
    const generator = later.controller.state.attrs.find('gen.g1')!
    expect(later.controller.state.attrs.textOr(generator, 'produces[0].amount')).toBe('1')
  })

  it('自动存档按真实秒数触发（D-31：不随倍速加速）', () => {
    const project = demoProject()
    project.settings = { ...project.settings, autosaveInterval: 1 }
    const fixture = makeController({ project })
    fixture.start()
    fixture.runFrames(120, FRAME_MS)
    expect(fixture.sink.saves.some((entry) => entry.intent === 'autosave')).toBe(true)
  })
})
