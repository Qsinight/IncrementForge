/**
 * 编辑器 -> 预览的增量热更新（TECH_DESIGN 7.4、D-25、PRD 补充 6、R-08）。
 *
 * ## 这组用例守的是 M4 最容易做错的一件事
 *
 * 7.4 要求“编辑器改动 → 条目级 patch → 运行时热更新”。如果热更新走了整表重载，
 * 作者改一个名字就会把玩家刚买的 200 台矿机清零——而且**看不出任何错误**。
 * 因此这里逐项断言热更新之后：
 * - **进度类数值**（`amount`/`bought`/`owned`/`effectValues`）原样保留；
 * - **结构/文本**换成项目的新值；
 * - **被运行期赋值过的字段**保留运行期值（否则作者永远改不回被表达式写坏的字段）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { Diagnostics, Num, resetDiagnostics } from '@iforge/num'
import type { GeneratorDef, ProjectFile } from '@iforge/model'

import { GameState } from '../src/game-state.js'
import { entityKeyOf } from '../src/attribute-store.js'
import { applyProjectPatch, applyProjectPatches, diffProject } from '../src/patch.js'
import { buildViewModel } from '../src/view-model.js'
import { assignToPage, createDefaultProject, T0, withGenerator, withPage, withResource, withUpgrade } from './helpers/harness.js'

function baseProject(): ProjectFile {
  let project: ProjectFile = { ...createDefaultProject(), pages: [], resources: [] }
  project = withResource({ id: 'r1', name: '矿石' }, project)
  project = withGenerator(
    { id: 'g1', name: '矿机', costs: [{ materialId: 'r1', amount: '10' }], produces: [{ materialId: 'r1', amount: '1' }] },
    project,
  )
  project = withPage({ id: 'p1', name: '工厂' }, project)
  return assignToPage(project, 'p1', ['r1', 'g1'])
}

function stateOf(project = baseProject()): GameState {
  return new GameState({ project, now: () => T0, nowIso: () => new Date(T0).toISOString() })
}

/** 已购 5 台矿机、花掉 50 矿石的“进行中的一局”。 */
function progressed(): GameState {
  const state = stateOf()
  state.attrs.write('res.r1.amount', Num.fromNumber(50), '<test>')
  state.attrs.write('gen.g1.bought', Num.fromNumber(5), '<test>')
  state.attrs.write('gen.g1.owned', Num.fromNumber(5), '<test>')
  return state
}

beforeEach(() => resetDiagnostics())

describe('7.4：diffProject 产出条目级最小补丁', () => {
  it('无改动时没有补丁（不该每次编辑都发一条空消息）', () => {
    const project = baseProject()
    expect(diffProject(project, project)).toEqual([])
  })

  it('改名 -> 一条 generators 的 upsert（PRD 各编辑器第 2 条要求立即同步）', () => {
    const before = baseProject()
    const after = { ...before, generators: before.generators.map((g) => ({ ...g, name: '矿机 II' })) }
    expect(diffProject(before, after)).toEqual([{ op: 'upsert', target: 'generators', id: 'g1', data: after.generators[0] }])
  })

  it('新增 / 删除条目分别产出 upsert / remove', () => {
    const before = baseProject()
    const added = withGenerator({ id: 'g2', name: '新机器' }, before)
    const kinds = diffProject(before, added).map((patch) => `${patch.op}:${patch.id}`)
    expect(kinds).toEqual(['upsert:g2'])

    const removed = { ...before, generators: before.generators.filter((g) => g.id !== 'g1') }
    expect(diffProject(before, removed).map((patch) => `${patch.op}:${patch.id}`)).toEqual(['remove:g1'])
  })

  it('改项目信息与游戏默认设置分别产出 meta / settings', () => {
    const before = baseProject()
    const after = {
      ...before,
      meta: { ...before.meta, name: '改名了' },
      settings: { ...before.settings, tickRate: 60 },
    }
    const ops = diffProject(before, after).map((patch) => patch.op)
    expect(ops).toEqual(['meta', 'settings'])
  })
})

describe('7.4：热更新保留本局进度', () => {
  it('改名称：文本换新值，进度原样保留', () => {
    const state = progressed()
    const renamed = stateOf({
      ...state.project,
      generators: state.project.generators.map((g) => ({ ...g, name: '矿机 II' })),
    })
    // 用“同一份项目文件”的前后对比构造补丁，再打到**已有进度**的 state 上。
    const previous = state.project
    applyProjectPatch(state, diffProject(previous, renamed.project)[0]!)

    const entry = state.attrs.find(entityKeyOf('generator', 'g1'))!
    expect(entry.def.name).toBe('矿机 II')
    expect(state.attrs.value(entry, 'bought').toNumber()).toBe(5)
    expect(state.attrs.value(entry, 'owned').toNumber()).toBe(5)
    expect(state.attrs.value(state.attrs.find(entityKeyOf('resource', 'r1'))!, 'amount').toNumber()).toBe(50)
  })

  it('改价格表达式：文本换成项目的新值，且**不**改 bought', () => {
    const state = progressed()
    const next: ProjectFile = {
      ...state.project,
      generators: state.project.generators.map((g) => ({
        ...g,
        costs: [{ materialId: 'r1', amount: '20 + 2 * gen.g1.bought' }],
      })),
    }
    applyProjectPatches(state, diffProject(state.project, next))
    const entry = state.attrs.find(entityKeyOf('generator', 'g1'))!
    expect(state.attrs.textOr(entry, 'costs[0].amount')).toBe('20 + 2 * gen.g1.bought')
    expect(state.attrs.value(entry, 'bought').toNumber()).toBe(5)
  })

  it('运行期赋值过的文本字段保留运行期值；未赋值过的采用项目新值', () => {
    const state = progressed()
    // 运行期把价格热替换成了 "999"（PRD 升级编辑器 12 / 5.9.3）。
    state.attrs.write('gen.g1.costs[0].amount', '999', 'upgrade.action')
    const next: ProjectFile = {
      ...state.project,
      generators: state.project.generators.map((g) => ({
        ...g,
        costs: [
          { materialId: 'r1', amount: '20' }, // 被赋值过 -> 保留 999
          { materialId: 'r1', amount: '5' }, // 新增的一行 -> 采用项目值
        ],
      })),
    }
    applyProjectPatches(state, diffProject(state.project, next))
    const entry = state.attrs.find(entityKeyOf('generator', 'g1'))!
    expect(state.attrs.textOr(entry, 'costs[0].amount')).toBe('999')
    expect(state.attrs.textOr(entry, 'costs[1].amount')).toBe('5')
  })

  it('运行期赋值过的布尔/字符串属性保留运行期值', () => {
    const state = progressed()
    state.attrs.write('gen.g1.visible', false, 'upgrade.action')
    state.attrs.write('gen.g1.description', '已被升级改名', 'upgrade.action')
    const next: ProjectFile = {
      ...state.project,
      generators: state.project.generators.map((g) => ({ ...g, visible: true, description: '作者写的描述' })),
    }
    applyProjectPatches(state, diffProject(state.project, next))
    const entry = state.attrs.find(entityKeyOf('generator', 'g1'))!
    expect(entry.visible).toBe(false)
    expect(entry.description).toBe('已被升级改名')
  })

  it('新增条目按 8.5 的初始化表给初值（热更新不能给出第二套规则）', () => {
    const state = progressed()
    const next = withGenerator({ id: 'g5', name: '新机器', initial: '7', max: 'Infinity' }, state.project)
    applyProjectPatches(state, diffProject(state.project, next))
    const entry = state.attrs.find(entityKeyOf('generator', 'g5'))!
    expect(state.attrs.value(entry, 'bought').toNumber()).toBe(7)
    expect(state.attrs.value(entry, 'owned').toNumber()).toBe(7)
  })

  it('新增点击器条目：bought = 0、owned = initial（D-19 的点击器规则）', () => {
    const state = progressed()
    const next = withGenerator({ id: 'g6', name: '新点击器', isClicker: true, initial: '3' }, state.project)
    applyProjectPatches(state, diffProject(state.project, next))
    const entry = state.attrs.find(entityKeyOf('generator', 'g6'))!
    expect(state.attrs.value(entry, 'bought').toNumber()).toBe(0)
    expect(state.attrs.value(entry, 'owned').toNumber()).toBe(3)
  })
})

/**
 * 7.4 的热更新必须与 5.9.3 的写入口径一致：**坏表达式不落进求值器**。
 *
 * 编辑器允许保存写坏了的表达式（只有导出/打包才拦），因此这条路径是常态而不是非法输入。
 * 在补上校验之前，作者把价格写成 `10 * (1 +` 会得到两个后果，且都**静默**：
 * `buildViewModel()` 求值时抛 `E_PARSE` 穿出视图重建（浏览器里预览停摆、主循环停摆），
 * 同时错误码没进 `Diagnostics`，诊断面板一个字都不显示。
 */
describe('7.4：热更新里的坏表达式按 last-good 兜住（5.9.3、5.7 的 D-07）', () => {
  it('坏价格：保留旧文本、记 E_PARSE，视图重建不抛', () => {
    const state = progressed()
    const next: ProjectFile = {
      ...state.project,
      generators: state.project.generators.map((g) => ({ ...g, costs: [{ materialId: 'r1', amount: '10 * (1 +' }] })),
    }
    expect(() => applyProjectPatches(state, diffProject(state.project, next))).not.toThrow()

    const entry = state.attrs.find(entityKeyOf('generator', 'g1'))!
    expect(state.attrs.textOr(entry, 'costs[0].amount')).toBe('10')
    expect(Diagnostics.count('E_PARSE')).toBe(1)
    // 视图重建能用上一份合法价格继续跑（本例的报价就是 10）。
    expect(() => buildViewModel(state, {})).not.toThrow()
    expect(Diagnostics.countsSnapshot()['E_PARSE']).toBe(1)
  })

  it('价格上下文里的随机函数按 E_RAND_DISABLED 拦下（PRD 补充 1）', () => {
    const state = progressed()
    const next: ProjectFile = {
      ...state.project,
      generators: state.project.generators.map((g) => ({ ...g, costs: [{ materialId: 'r1', amount: '10 * rand()' }] })),
    }
    applyProjectPatches(state, diffProject(state.project, next))
    expect(Diagnostics.count('E_RAND_DISABLED')).toBe(1)
    const entry = state.attrs.find(entityKeyOf('generator', 'g1'))!
    expect(state.attrs.textOr(entry, 'costs[0].amount')).toBe('10')
  })

  it('坏条件/坏效果同样被拦下：条件换中性 false、动作换中性 0', () => {
    const state = stateOf(
      assignToPage(withGenerator({ id: 'g1', name: '矿机', costs: [], produces: [{ materialId: 'r1', amount: '1' }] }, baseProject()), 'p1', [
        'r1',
        'g1',
      ]),
    )
    // 先装一条**合法**的升级，再由 patch 把它改成坏文本——这样“退回上一份文本”才有意义。
    state.loadProject(
      withUpgrade(
        {
          id: 'u1',
          name: '升级',
          costs: [{ materialId: 'r1', amount: '1' }],
          conditions: ['gen.g1.bought >= 5'],
          effects: [{ condition: 'true', action: 'effValue = 1' }],
        },
        state.project,
      ),
    )
    const next = structuredClone(state.project)
    next.upgrades[0]!.conditions[0] = 'gen.g1.bought >='
    next.upgrades[0]!.effects[0]!.action = 'set('
    applyProjectPatches(state, diffProject(state.project, next))

    const entry = state.attrs.find(entityKeyOf('upgrade', 'u1'))!
    expect(state.attrs.textOr(entry, 'conditions[0]')).toBe('gen.g1.bought >= 5')
    expect(state.attrs.textOr(entry, 'effects[0].action')).toBe('effValue = 1')
    expect(Diagnostics.count('E_PARSE')).toBe(2)
  })

  it('项目文件本身带坏表达式时，`loadProject` 同样兜住（host:init 拿的是编辑器内存里那份）', () => {
    const broken = withGenerator(
      { id: 'g8', name: '坏机器', costs: [{ materialId: 'r1', amount: '1 +' }], produces: [{ materialId: 'r1', amount: '1' }] },
      baseProject(),
    )
    const state = stateOf(broken)
    const entry = state.attrs.find(entityKeyOf('generator', 'g8'))!
    expect(state.attrs.textOr(entry, 'costs[0].amount')).toBe('0')
    expect(Diagnostics.count('E_PARSE')).toBe(1)
    expect(() => buildViewModel(state, {})).not.toThrow()
  })

  it('新增条目没有旧文本可退回时用中性值（坏价格变 0，而不是让视图重建抛异常）', () => {
    const state = progressed()
    const next = withGenerator(
      { id: 'g7', name: '坏新机器', costs: [{ materialId: 'r1', amount: '1 +' }], produces: [{ materialId: 'r1', amount: '1' }] },
      state.project,
    )
    expect(() => applyProjectPatches(state, diffProject(state.project, next))).not.toThrow()
    const entry = state.attrs.find(entityKeyOf('generator', 'g7'))!
    expect(state.attrs.textOr(entry, 'costs[0].amount')).toBe('0')
    expect(Diagnostics.count('E_PARSE')).toBe(1)
  })
})

describe('7.4：删除条目', () => {
  it('移除状态与项目定义，并清理页面归属（PRD 补充 7 的唯一归属）', () => {
    const state = progressed()
    const next: ProjectFile = { ...state.project, generators: state.project.generators.filter((g) => g.id !== 'g1') }
    applyProjectPatches(state, diffProject(state.project, next))
    expect(state.attrs.find(entityKeyOf('generator', 'g1'))).toBeUndefined()
    expect(state.project.generators.some((g) => g.id === 'g1')).toBe(false)
    expect(state.project.pages.every((page) => page.entries.every((entry) => entry.id !== 'g1'))).toBe(true)
  })

  it('悬空的价格/产出引用被**保留**并记 E_DANGLING_REF（D-38：不做级联删除）', () => {
    const project = baseProject()
    project.generators = project.generators.map((g) => (g.id === 'g1' ? { ...g, produces: [{ materialId: 'r1', amount: '1' }] } : g))
    const state = stateOf(project)
    // 删除资源 r1：g1 的价格与产出都指向它。
    const next: ProjectFile = { ...state.project, resources: [] }
    applyProjectPatches(state, diffProject(state.project, next))

    expect(state.attrs.find(entityKeyOf('resource', 'r1'))).toBeUndefined()
    // 引用文本原样保留（否则作者的表达式会无声变形），并记诊断。
    const entry = state.attrs.find(entityKeyOf('generator', 'g1'))!
    expect(state.attrs.textOr(entry, 'costs[0].materialId')).toBe('r1')
    expect(Diagnostics.count('E_DANGLING_REF')).toBeGreaterThan(0)
  })

  it('删除当前页面时回到 8.12 的初始页面，不停在不存在的页面上', () => {
    const state = progressed()
    state.nav('p1')
    const next: ProjectFile = { ...state.project, pages: [] }
    applyProjectPatches(state, diffProject(state.project, next))
    expect(state.currentPageId).toBe('__settings__')
  })
})

describe('7.4：meta / settings 补丁', () => {
  it('改项目名立即同步到运行时（PRD 设置页 2 与标题栏）', () => {
    const state = progressed()
    applyProjectPatch(state, { op: 'meta', target: 'meta', data: { ...state.project.meta, name: '新名字' } })
    expect(state.project.meta.name).toBe('新名字')
  })

  it('改游戏默认设置会重配时钟，但不碰会话覆盖（D-22）', () => {
    const state = progressed()
    state.settingsOverride = { offlineCap: 1 }
    applyProjectPatch(state, {
      op: 'settings',
      target: 'settings',
      data: { ...state.project.settings, tickRate: 60, maxFrameStep: 500 },
    })
    expect(state.clock.current().tickRate).toBe(60)
    expect(state.clock.current().maxFrameStep).toBe(500)
    // 玩家在游戏内设置的偏好仍在（作者改默认值不该抹掉玩家的选择）。
    expect(state.effectiveSettings().offlineCap).toBe(1)
  })
})

describe('补丁的健壮性（13 第 6 条：外来数据必须再校验一次）', () => {
  it('data 不是合法条目定义时报 E_SCHEMA 且不落库', () => {
    const state = progressed()
    const before = state.project.generators.length
    const applied = applyProjectPatch(state, { op: 'upsert', target: 'generators', id: 'gX', data: { nope: true } })
    expect(applied).toBe(false)
    expect(state.project.generators).toHaveLength(before)
    expect(Diagnostics.count('E_SCHEMA')).toBe(1)
  })

  it('未知 target / 缺 id 的补丁被忽略', () => {
    const state = progressed()
    expect(applyProjectPatch(state, { op: 'upsert', target: 'assets', id: 'a1', data: {} })).toBe(false)
    expect(applyProjectPatch(state, { op: 'remove', target: 'generators' })).toBe(false)
  })

  it('移除不存在的条目返回 false（不抛异常，编辑器不会因一次撤销而崩）', () => {
    const state = progressed()
    expect(applyProjectPatch(state, { op: 'remove', target: 'generators', id: 'gNope' })).toBe(false)
  })

  it('热更新后的条目仍能正常结算（结构与存储没有分叉）', () => {
    const state = progressed()
    const next: ProjectFile = {
      ...state.project,
      generators: state.project.generators.map((g) =>
        g.id === 'g1' ? ({ ...g, produces: [{ materialId: 'r1', amount: '3' }] } as GeneratorDef) : g,
      ),
    }
    applyProjectPatches(state, diffProject(state.project, next))
    const before = state.attrs.value(state.attrs.find(entityKeyOf('resource', 'r1'))!, 'amount')
    for (let i = 0; i < 20; i += 1) state.stepTick(50, 50)
    const after = state.attrs.value(state.attrs.find(entityKeyOf('resource', 'r1'))!, 'amount')
    // owned = 5、单件速率 3 -> 每秒 15，1 秒共 20 tick -> 增量 15。
    expect(after.sub(before).toNumber()).toBeCloseTo(15, 6)
  })
})
