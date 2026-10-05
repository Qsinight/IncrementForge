/**
 * 产出结算与点击（TECH_DESIGN 8.3 第 3~4 步、8.5 `click`、D-30、R-26、D-07）。
 *
 * 覆盖 14.2 的两条硬用例：
 * - **产出结算不含 `owned²`**（R-26）：`owned` 只乘一次；
 * - **产出目标可以是生成器**（8.3 第 3 步）：加到其 `owned`、**不动** `bought`（不影响价格）。
 *
 * 以及 D-07 的容错口径：一行坏产出/坏材料不该让整个产出阶段停摆。
 *
 * 注意：所有夹具都必须把条目**分配进页面**（`assignToPage`）。未归属的条目是孤儿动态条目，
 * `pageOf` 返回 `undefined`，`isVisible` 一律判假（8.7），于是所有交互都会被 `E_HIDDEN` 拒掉——
 * 这会让本应测“产出公式”的用例退化成“可见性判定”的用例。
 */
import { describe, expect, it } from 'vitest'

import { ForgeError, Num } from '@iforge/num'
import type { GeneratorDef, PageDef, ProjectFile, ResourceDef, UpgradeDef } from '@iforge/model'

import { applyProduces, click, produceOnce, unitRate } from '../src/production.js'
import { Harness, minimalProject, withGenerator, withUpgrade, assignToPage } from './helpers/harness.js'

/** 累加一个资源。 */
function addResource(p: ProjectFile, def: Partial<ResourceDef> & { id: string }): ProjectFile {
  const full: ResourceDef = {
    kind: 'resource',
    order: p.resources.length + 1,
    name: def.id,
    description: '',
    icon: { kind: 'builtin', value: 'gem' },
    initial: '0',
    max: 'Infinity',
    visible: true,
    ...def,
  }
  return { ...p, resources: [...p.resources, full] }
}

/** 累加一个生成器。 */
function addGenerator(p: ProjectFile, def: Partial<GeneratorDef> & { id: string }): ProjectFile {
  return withGenerator(def, p)
}

/** 累加一个升级。 */
function addUpgrade(p: ProjectFile, def: Partial<UpgradeDef> & { id: string }): ProjectFile {
  return withUpgrade(def, p)
}

interface BuildSpec {
  resources?: Array<Partial<ResourceDef> & { id: string }>
  generators?: Array<Partial<GeneratorDef> & { id: string }>
  upgrades?: Array<Partial<UpgradeDef> & { id: string }>
  page?: Partial<PageDef> | false
}

/**
 * 构造一个**条目已全部归入页面 `p1`** 的项目。
 *
 * 条目归属是这些用例的前提：页面禁用/不可见要能通过 `pageOf` 传到条目上，
 * 否则测到的只是孤儿条目的兜底分支。
 *
 * `createDefaultProject()`（7.9 模板）**自带一个 `p1`**，所以这里必须**替换**它而不是追加——
 * 追加会产生两个同 id 的 `p1`，`pageOfEntry`（遍历找归属）与 `attrs.find`（按键取页面）
 * 会命中不同那一个，页面禁用/可见的改动就会“看起来没生效”。
 */
function buildProject(spec: BuildSpec): ProjectFile {
  let p: ProjectFile = minimalProject()
  p.resources = []
  for (const r of spec.resources ?? []) p = addResource(p, r)
  for (const g of spec.generators ?? []) p = addGenerator(p, g)
  for (const u of spec.upgrades ?? []) p = addUpgrade(p, u)
  const page: PageDef = {
    kind: 'page',
    id: 'p1',
    order: 1,
    name: '主页面',
    description: '',
    icon: { kind: 'builtin', value: 'grid' },
    visible: true,
    disabled: false,
    theme: { kind: 'builtin', value: 'page-dark' },
    columns: 1,
    entries: [],
    ...(spec.page ?? {}),
  }
  p = { ...p, pages: [page] }
  const entryIds = [...p.resources.map((r) => r.id), ...p.generators.map((g) => g.id), ...p.upgrades.map((u) => u.id)]
  return assignToPage(p, 'p1', entryIds)
}

/** 最常用夹具：r1 + 产出 r1 的 g1（单件速率 1，`owned` 初始 10）。 */
function oreProject(): ProjectFile {
  return buildProject({
    resources: [{ id: 'r1', name: '矿石' }],
    generators: [
      {
        id: 'g1',
        initial: '10',
        produces: [{ materialId: 'r1', amount: '1' }],
        costs: [{ materialId: 'r1', amount: '10' }],
      },
    ],
  })
}

/** 依赖三件套：`ProductionDeps` 就是 `{attrs, runtime, judge}`，与 `GameState` 同形。 */
function deps(h: Harness) {
  return { attrs: h.state.attrs, runtime: h.state.runtime, judge: h.state.judge }
}

describe('unitRate()：单件速率之和（8.3 第 3 步的口径）', () => {
  it('单行产出：返回该行单件速率', () => {
    const h = new Harness({ project: oreProject() })
    expect(unitRate(deps(h), h.generator('g1')).eq(Num.fromNumber(1))).toBe(true)
  })

  it('多行产出：返回各行之和', () => {
    const p = oreProject()
    p.generators[0]!.produces = [
      { materialId: 'r1', amount: '1' },
      { materialId: 'r1', amount: '2' },
      { materialId: 'r1', amount: '4' },
    ]
    const h = new Harness({ project: p })
    expect(unitRate(deps(h), h.generator('g1')).eq(Num.fromNumber(7))).toBe(true)
  })

  it('`amount` 是表达式时按 `production` 上下文求值', () => {
    const p = oreProject()
    p.generators[0]!.produces = [{ materialId: 'r1', amount: 'gen.g1.owned / 5' }]
    const h = new Harness({ project: p })
    // `owned` 初始 10 -> 10/5 = 2。
    expect(unitRate(deps(h), h.generator('g1')).eq(Num.fromNumber(2))).toBe(true)
  })

  it('无产出行为 0', () => {
    const p = oreProject()
    p.generators[0]!.produces = []
    const h = new Harness({ project: p })
    expect(unitRate(deps(h), h.generator('g1')).eq(Num.fromNumber(0))).toBe(true)
  })

  it('非生成器恒返回 0（资源/页面没有“单件速率”这个概念）', () => {
    const h = new Harness({ project: oreProject() })
    expect(unitRate(deps(h), h.state.attrs.find('res.r1')!).eq(Num.fromNumber(0))).toBe(true)
    expect(unitRate(deps(h), h.page('p1')).eq(Num.fromNumber(0))).toBe(true)
  })

  it('D-07：一行编译失败不影响其它行，该行按 0 计入', () => {
    const p = oreProject()
    p.generators[0]!.produces = [
      { materialId: 'r1', amount: '1 +' }, // 语法错误 -> 编译期抛 E_PARSE
      { materialId: 'r1', amount: '3' },
    ]
    const h = new Harness({ project: p })
    // 坏行被 catch 吞掉，好行仍生效（产出阶段不中断）。
    expect(unitRate(deps(h), h.generator('g1')).eq(Num.fromNumber(3))).toBe(true)
  })
})

describe('applyProduces()：把总量加到各产出目标（D-30「只乘一次」）', () => {
  it('资源目标：加到 `amount`', () => {
    const h = new Harness({ project: oreProject() })
    h.grant('r1', 0)
    applyProduces(deps(h), h.generator('g1'), Num.fromNumber(5))
    expect(h.resource('r1').eq(Num.fromNumber(5))).toBe(true)
  })

  it('非正增量直接返回，不写任何目标', () => {
    const h = new Harness({ project: oreProject() })
    h.grant('r1', 100)
    applyProduces(deps(h), h.generator('g1'), Num.fromNumber(0))
    applyProduces(deps(h), h.generator('g1'), Num.fromNumber(-3))
    expect(h.resource('r1').eq(Num.fromNumber(100))).toBe(true)
  })

  it('多个产出行时每个目标都拿**同一份**总量（不是各自份额）', () => {
    const p = buildProject({
      resources: [
        { id: 'r1', name: '矿石' },
        { id: 'r2', name: '木材' },
      ],
      generators: [
        {
          id: 'g1',
          produces: [
            { materialId: 'r1', amount: '1' },
            { materialId: 'r2', amount: '9' },
          ],
        },
      ],
    })
    const h = new Harness({ project: p })
    applyProduces(deps(h), h.generator('g1'), Num.fromNumber(7))
    expect(h.resource('r1').eq(Num.fromNumber(7))).toBe(true)
    expect(h.resource('r2').eq(Num.fromNumber(7))).toBe(true)
  })

  it('资源 `max` 生效：加到上限后被夹住（4.4 第 4 条）', () => {
    const p = oreProject()
    p.resources[0]!.max = '10'
    const h = new Harness({ project: p })
    applyProduces(deps(h), h.generator('g1'), Num.fromNumber(999))
    expect(h.resource('r1').eq(Num.fromNumber(10))).toBe(true)
  })

  it('`max = "Infinity"` 不钳制（D-46 无上限）', () => {
    const h = new Harness({ project: oreProject() })
    applyProduces(deps(h), h.generator('g1'), Num.fromString('1e10'))
    expect(h.resource('r1').gte(Num.fromString('1e10'))).toBe(true)
  })

  it('`addToTarget` 对不存在的目标直接返回（防御性：目标在遍历后被移除）', () => {
    const h = new Harness({ project: oreProject() })
    h.grant('r1', 7)
    // 直接调 addToTarget 的可达路径：目标键合法但实体缺失时不抛错。
    applyProduces(deps(h), h.generator('g1'), Num.fromNumber(1))
    expect(h.resource('r1').eq(Num.fromNumber(8))).toBe(true)
  })

  it('D-07：产出目标不存在记 `E_DANGLING_REF` 并跳过该行，不影响好行', () => {
    const p = oreProject()
    p.generators[0]!.produces = [
      { materialId: 'rNope', amount: '1' },
      { materialId: 'r1', amount: '1' },
    ]
    const h = new Harness({ project: p })
    applyProduces(deps(h), h.generator('g1'), Num.fromNumber(4))
    expect(h.resource('r1').eq(Num.fromNumber(4))).toBe(true)
    expect(h.diagnosticCount('E_DANGLING_REF')).toBeGreaterThan(0)
  })

  it('非生成器不产出（`produceTargets` 直接返回空）', () => {
    const h = new Harness({ project: oreProject() })
    h.grant('r1', 0)
    applyProduces(deps(h), h.page('p1'), Num.fromNumber(5))
    expect(h.resource('r1').eq(Num.fromNumber(0))).toBe(true)
  })
})

describe('产出目标是生成器：加 `owned` 且**不影响价格**（8.3 第 3 步）', () => {
  function twoGenerators(): ProjectFile {
    return buildProject({
      resources: [{ id: 'r1', name: '矿石' }],
      generators: [
        { id: 'g1', initial: '10', produces: [{ materialId: 'g2', amount: '1' }], costs: [] },
        { id: 'g2', initial: '0', produces: [], costs: [{ materialId: 'r1', amount: '5' }] },
      ],
    })
  }

  it('加到目标生成器的 `owned`，不动 `bought`（价格因此不变）', () => {
    const h = new Harness({ project: twoGenerators() })
    const beforeBought = h.count('generator', 'g2', 'bought')
    applyProduces(deps(h), h.generator('g1'), Num.fromNumber(6))
    expect(h.count('generator', 'g2', 'owned').eq(Num.fromNumber(6))).toBe(true)
    expect(h.count('generator', 'g2', 'bought').eq(beforeBought)).toBe(true)
  })

  it('目标生成器的 `max` 同样生效', () => {
    const p = twoGenerators()
    p.generators[1]!.max = '4'
    const h = new Harness({ project: p })
    applyProduces(deps(h), h.generator('g1'), Num.fromNumber(50))
    expect(h.count('generator', 'g2', 'owned').eq(Num.fromNumber(4))).toBe(true)
  })

  it('可见性只约束**产出方**，不约束产出目标：目标不可见照样接收增量', () => {
    // 判定在 tick 的产出阶段做（`runProductionPhase` 对**产出方**取 `snapshot.canSettle`），
    // `applyProduces` 本身不二次检查目标。把它写成断言，避免以后有人“顺手补一个”检查
    // 而悄悄改变存档语义（目标的 `owned` 会突然不再随来源生成器增长）。
    const p = twoGenerators()
    p.generators[1]!.visible = false
    const h = new Harness({ project: p })
    applyProduces(deps(h), h.generator('g1'), Num.fromNumber(6))
    expect(h.count('generator', 'g2', 'owned').eq(Num.fromNumber(6))).toBe(true)
  })

  it('产出方自身不可见时不产出（tick 阶段按产出方判定）', () => {
    const p = twoGenerators()
    p.generators[0]!.visible = false
    const h = new Harness({ project: p })
    expect(h.state.judge.canProduce(h.generator('g1'))).toBe(false)
    expect(h.state.judge.canProduce(h.generator('g2'))).toBe(true)
  })
})

describe('produceOnce()：`owned × Σ rate × dt`，`owned` 只乘一次（R-26）', () => {
  it('单件速率 1、`owned = 10`、10 tick -> 增量 100（不是 1000）', () => {
    const h = new Harness({ project: oreProject() })
    h.grant('r1', 0)
    for (let i = 0; i < 10; i += 1) {
      produceOnce(deps(h), h.generator('g1'), Num.fromNumber(10), Num.fromNumber(1))
    }
    expect(h.resource('r1').eq(Num.fromNumber(100))).toBe(true)
  })

  it('14.2 反例：把 `produces[0].amount` 热替换为 `2` 后增量翻倍（而非按 owned 平方缩放）', () => {
    const h = new Harness({ project: oreProject() })
    h.grant('r1', 0)
    produceOnce(deps(h), h.generator('g1'), Num.fromNumber(10), Num.fromNumber(1))
    expect(h.resource('r1').eq(Num.fromNumber(10))).toBe(true)

    h.state.attrs.writeText(h.generator('g1'), 'produces[0].amount', '2', '<test>')
    produceOnce(deps(h), h.generator('g1'), Num.fromNumber(10), Num.fromNumber(1))
    expect(h.resource('r1').eq(Num.fromNumber(30))).toBe(true)
  })

  it('`owned = 0` 直接返回', () => {
    const h = new Harness({ project: oreProject() })
    h.grant('r1', 0)
    produceOnce(deps(h), h.generator('g1'), Num.fromNumber(0), Num.fromNumber(5))
    expect(h.resource('r1').eq(Num.fromNumber(0))).toBe(true)
  })

  it('速率为 0 直接返回', () => {
    const p = oreProject()
    p.generators[0]!.produces = []
    const h = new Harness({ project: p })
    h.grant('r1', 0)
    produceOnce(deps(h), h.generator('g1'), Num.fromNumber(10), Num.fromNumber(5))
    expect(h.resource('r1').eq(Num.fromNumber(0))).toBe(true)
  })

  it('`dt = 0` 时增量为 0', () => {
    const h = new Harness({ project: oreProject() })
    h.grant('r1', 0)
    produceOnce(deps(h), h.generator('g1'), Num.fromNumber(10), Num.fromNumber(0))
    expect(h.resource('r1').eq(Num.fromNumber(0))).toBe(true)
  })

  it('饱和数值下结果仍有限且不抛错（4.4 `NUM_MAX` 语义）', () => {
    const h = new Harness({ project: oreProject() })
    h.grant('r1', 0)
    const huge = Num.fromString('1e1e10')
    expect(() => produceOnce(deps(h), h.generator('g1'), huge, huge)).not.toThrow()
    expect(h.resource('r1').isNan()).toBe(false)
  })
})

describe('click()：点击器点击（8.5，D-28「点击不是购买」）', () => {
  function clickerProject(initial = '4'): ProjectFile {
    return buildProject({
      resources: [{ id: 'r1', name: '矿石' }],
      generators: [
        {
          id: 'g1',
          isClicker: true,
          initial,
          produces: [{ materialId: 'r1', amount: '3' }],
          costs: [],
        },
      ],
    })
  }

  it('即时结算：返回 `owned × Σ 单件速率`，并写进资源', () => {
    const h = new Harness({ project: clickerProject() })
    h.grant('r1', 0)
    // owned = 4，单件速率 3 -> 12。
    expect(click(deps(h), h.generator('g1')).eq(Num.fromNumber(12))).toBe(true)
    expect(h.resource('r1').eq(Num.fromNumber(12))).toBe(true)
  })

  it('与自动产出同式：一次点击 == 一个 dt 的 `owned × Σ`（D-30 单一实现）', () => {
    const h = new Harness({ project: clickerProject() })
    h.grant('r1', 0)
    const byClick = click(deps(h), h.generator('g1'))
    h.grant('r1', 0)
    produceOnce(deps(h), h.generator('g1'), Num.fromNumber(4), Num.fromNumber(1))
    expect(h.resource('r1').eq(byClick)).toBe(true)
  })

  it('点击**不**推进 `bought`/`owned`（点击不是购买）', () => {
    const h = new Harness({ project: clickerProject() })
    const b = h.count('generator', 'g1', 'bought')
    const o = h.count('generator', 'g1', 'owned')
    click(deps(h), h.generator('g1'))
    expect(h.count('generator', 'g1', 'bought').eq(b)).toBe(true)
    expect(h.count('generator', 'g1', 'owned').eq(o)).toBe(true)
  })

  it('不可见 -> 抛 `E_HIDDEN`（不产生产出）', () => {
    const p = clickerProject()
    p.generators[0]!.visible = false
    const h = new Harness({ project: p })
    h.grant('r1', 0)
    expect(() => click(deps(h), h.generator('g1'))).toThrow(ForgeError)
    expect(h.resource('r1').eq(Num.fromNumber(0))).toBe(true)
    expect(h.diagnosticCount('E_HIDDEN')).toBeGreaterThan(0)
  })

  it('已禁用 -> 抛 `E_DISABLED`', () => {
    const p = clickerProject()
    p.generators[0]!.disabled = true
    const h = new Harness({ project: p })
    h.grant('r1', 0)
    expect(() => click(deps(h), h.generator('g1'))).toThrow(ForgeError)
    expect(h.resource('r1').eq(Num.fromNumber(0))).toBe(true)
    expect(h.diagnosticCount('E_DISABLED')).toBeGreaterThan(0)
  })

  it('`owned >= max` -> 抛 `E_CAP`', () => {
    const p = clickerProject()
    p.generators[0]!.max = '4'
    const h = new Harness({ project: p })
    h.grant('r1', 0)
    expect(() => click(deps(h), h.generator('g1'))).toThrow(ForgeError)
    expect(h.resource('r1').eq(Num.fromNumber(0))).toBe(true)
    expect(h.diagnosticCount('E_CAP')).toBeGreaterThan(0)
  })

  it('`max = Infinity` 时永不上限（D-46）', () => {
    const h = new Harness({ project: clickerProject() })
    h.grant('r1', 0)
    expect(() => click(deps(h), h.generator('g1'))).not.toThrow()
  })

  it('点击器 `owned = 0`（`initial = 0`）时收益为 0，且**不**报错', () => {
    const h = new Harness({ project: clickerProject('0') })
    h.grant('r1', 0)
    expect(click(deps(h), h.generator('g1')).eq(Num.fromNumber(0))).toBe(true)
    expect(h.resource('r1').eq(Num.fromNumber(0))).toBe(true)
  })

  it('点击器无产出行时收益为 0', () => {
    const p = clickerProject()
    p.generators[0]!.produces = []
    const h = new Harness({ project: p })
    h.grant('r1', 0)
    expect(click(deps(h), h.generator('g1')).eq(Num.fromNumber(0))).toBe(true)
  })

  it('非点击器也走同一公式（`click()` 不判 `isClicker`）', () => {
    const h = new Harness({ project: oreProject() })
    h.grant('r1', 0)
    // g1 是普通生成器，`owned` 初始 10、单件速率 1。
    expect(click(deps(h), h.generator('g1')).eq(Num.fromNumber(10))).toBe(true)
  })
})

describe('页面禁用/不可见对产出的影响（R-21 的收敛判定）', () => {
  function clickable(over: Partial<GeneratorDef> = {}): ProjectFile {
    return buildProject({
      resources: [{ id: 'r1', name: '矿石' }],
      // `...over` 在前、`id` 在后：让覆盖项改不了 id（避免被静默覆盖成别的 id 后
      // 下面 `h.generator('g1')` 取不到条目）。
      generators: [{ ...over, id: 'g1', initial: '2', produces: [{ materialId: 'r1', amount: '1' }], costs: [] }],
    })
  }

  it('页面禁用 -> 点击被拒（不另开即时旁路）', () => {
    const p = clickable({})
    p.pages[0]!.disabled = true
    const h = new Harness({ project: p })
    h.grant('r1', 0)
    expect(() => click(deps(h), h.generator('g1'))).toThrow(ForgeError)
  })

  it('页面不可见 -> 点击被拒', () => {
    const p = clickable({})
    p.pages[0]!.visible = false
    const h = new Harness({ project: p })
    h.grant('r1', 0)
    expect(() => click(deps(h), h.generator('g1'))).toThrow(ForgeError)
  })

  it('页面禁用时 `produceOnce` 仍按公式算，但目标页面不可见不改变资源增长口径（资源无禁用态）', () => {
    // 8.4「资源没有禁用态」：页面禁用只让生成器/升级置灰，资源 `amount` 仍随存量生成器增长。
    // 这里只固定“资源自身不被 disabled 判定拦下”这一点。
    const p = clickable({})
    p.pages[0]!.disabled = true
    const h = new Harness({ project: p })
    h.grant('r1', 0)
    expect(h.state.judge.isDisabled(h.state.attrs.find('res.r1')!)).toBe(false)
  })
})

describe('孤儿条目：pageId 失效的动态条目（8.7）', () => {
  it('无归属条目的 `isVisible` 为假且记 `E_PAGE_UNKNOWN`（不渲染、不产出）', () => {
    // 故意不 assignToPage：条目成为孤儿。
    const p = oreProject()
    p.pages[0]!.entries = []
    const h = new Harness({ project: p })
    const g = h.generator('g1')
    expect(h.state.judge.isVisible(g)).toBe(false)
    expect(h.diagnosticCount('E_PAGE_UNKNOWN')).toBeGreaterThan(0)
    // 点击与产出都被拒。
    expect(() => click(deps(h), g)).toThrow(ForgeError)
  })
})
