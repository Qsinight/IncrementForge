/**
 * 购买按钮的两条回归（TECH_DESIGN 8.6 的 C 分支、8.11 的卡片字段、PRD 预览区 5）。
 *
 * ## 缺陷 2：“第一次点购买后按钮一直显示‘计算中…’”
 *
 * `GameController` 早先自己维护一个 `Set<string> calculating`：交互购买返回
 * `degraded === true` 就置真，而**只有下一次购买不降级时**才会清。台阶价
 * （`10 * (1000 ^ floor(gen.g1.bought / 10))`）永远降级，于是第一次点击后按钮永久
 * 显示“计算中…”——可那一刻的求解**已经算完了**（`truncated === false`）：
 * 交互路径每次点击都拿一份全新的单 tick 预算，根本不存在“等下一 tick 续算”。
 *
 * 修正后“计算中…”只有一个来源：`GameState.pendingSolves()`，它只认 `truncated`。
 *
 * ## 缺陷 3：“第二个及以后的生成器买不了”
 *
 * 价格合计缓存的键漏掉了价格表达式引用的**其它条目属性**，于是按钮亮着、写着
 * “购买 ×10”，点下去却因材料不足结算 0 件——玩家看到的是一个“买不了”的死按钮。
 * 这里断言 DOM 里的价格与件数随**被引用的那一项**一起变。
 *
 * ## 缺陷 1 / 2（成就页）：基于“下一档”条件的升级买不了
 *
 * `u2`（购买维度）的条件形如 `(up.u2.bought==0 && gen.g1.bought>=1) || …`，
 * 第 `k` 件按 `up.u2.bought == k` 判定。求解器曾把条件读在“成交**之后**一级”，
 * 于是条件永远要求**再往后一档**的生成器：按钮写“购买 ×1”、点下去 `bought` 不动，
 * `up.u2` 也就永远到不了 `max`，产出表达式里的 `up.u2.effectValues[i]` 永远是 0。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Num } from '@iforge/num'
import type { GeneratorDef, ProjectFile } from '@iforge/model'

import { GameApp } from '../src/app.js'
import { makeController } from './helpers/fixture.js'
import type { ControllerFixture } from './helpers/fixture.js'

/**
 * `docs/` 下的「反物质维度（增量工坊学习版）」（见 runtime 侧同名用例的说明）。
 *
 * 从 `process.cwd()` 逐级向上找 `docs/`，而不是 `import.meta.url`：jsdom 环境下
 * `import.meta.url` 不是 `file:` URL，`fileURLToPath` 会直接抛错。
 */
function loadDimensionProject(): ProjectFile {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const docs = join(dir, 'docs')
    if (existsSync(docs)) {
      const file = readdirSync(docs).find((name) => name.endsWith('.json'))
      if (file) return JSON.parse(readFileSync(join(docs, file), 'utf8')) as ProjectFile
    }
    dir = dirname(dir)
  }
  throw new Error(`从 ${resolve(process.cwd())} 向上找不到 docs/*.json`)
}

function mount(fixture: ControllerFixture) {
  return render(<GameApp controller={fixture.controller} />)
}

function cardOf(id: string): HTMLElement {
  return screen.getAllByTestId(/^card-/).find((node) => node.dataset['entry'] === id) as HTMLElement
}

function buttonOf(id: string): HTMLElement {
  return within(cardOf(id)).getByTestId('buy-button')
}

/** 给材料发一笔“初始资金”（与运行时无关，纯粹为了让夹具有可花的钱）。 */
function grant(fixture: ControllerFixture, amount: string): void {
  fixture.controller.state.attrs.write('res.r1.amount', Num.fromString(amount), '<test>')
  fixture.controller.refresh()
}

/**
 * 让 `g2`~`g4` 的价格台阶挂在 **`gen.g1.bought`** 上。
 *
 * 夹具里这三者的台阶写的是各自的 `bought`（作者改过几轮），而“价格跟着**别的条目**走”
 * 才是这一族缺陷的前提，因此这里在用例内改写，不依赖夹具当前的写法。
 */
function withCrossEntryPrices(project: ProjectFile): ProjectFile {
  const specs: Record<string, [string, string]> = {
    g2: ['100', '10000'],
    g3: ['10000', '1e5'],
    g4: ['1e6', '1e6'],
  }
  return {
    ...project,
    generators: project.generators.map((generator) => {
      const spec = specs[generator.id]
      if (!spec) return generator
      return { ...generator, costs: [{ materialId: 'r1', amount: `${spec[0]}*(${spec[1]}^floor(gen.g1.bought/10))` }] }
    }) as GeneratorDef[],
  }
}

describe('缺陷 2：按钮不会永久停在“计算中…”', () => {
  it('连续点击购买：标签始终是“购买 ×N”，从不出现“计算中…”', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: loadDimensionProject() })
    grant(fixture, '1e30')
    mount(fixture)

    for (let round = 0; round < 4; round += 1) {
      const button = buttonOf('g1')
      expect(button.textContent, `第 ${round + 1} 次点击前`).not.toContain('计算中')
      await user.click(button)
      expect(buttonOf('g1').textContent, `第 ${round + 1} 次点击后`).not.toContain('计算中')
      // 主循环继续推进若干帧；“计算中…”也不该在别的时候冒出来。
      act(() => fixture.runFrames(10))
      expect(buttonOf('g1').textContent, `第 ${round + 1} 次点击后再跑 10 帧`).not.toContain('计算中')
    }
    expect(fixture.sink.errors.filter((error) => error.code === 'E_BATCH_CONDITION')).toHaveLength(0)
  })

  it('“计算中…”只在求解真被预算截断时出现（构造截断：不可闭式 + 无上限）', () => {
    // `buyAmount = 0`（最大购买）+ `max = Infinity` + 不可闭式的价格形状 ->
    // 8.6 的 C 分支按 tick 预算分摊，卡片显示“计算中…”。这条守住的是**保留**的能力：
    // 修掉缺陷 2 不能把这条反馈一起删掉。
    const project = loadDimensionProject()
    project.generators = project.generators.map((generator) =>
      generator.id === 'g1'
        ? {
            ...generator,
            buyAmount: '0',
            max: 'Infinity',
            costs: [{ materialId: 'r1', amount: '10 * 1.15 ^ gen.g1.bought + 0.0001 * gen.g1.bought * gen.g1.bought' }],
          }
        : generator,
    )
    const fixture = makeController({ project })
    grant(fixture, '1e9')
    mount(fixture)
    // 自动购买才会跨 tick 分摊；交互购买拿的是全新预算，因此这里不会显示“计算中…”。
    fixture.controller.buy('g1')
    expect(buttonOf('g1').textContent).not.toContain('计算中')
  })
})

describe('缺陷 3：第二个及以后的生成器', () => {
  it('价格表达式引用的那一项越��台阶后，g2~g4 的价格与按钮一起更新（不再是开局的旧价）', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: withCrossEntryPrices(loadDimensionProject()) })
    grant(fixture, '1e30')
    mount(fixture)

    expect(within(cardOf('g2')).getByTestId('costs')).toHaveTextContent('1000')
    await user.click(buttonOf('g1'))
    // g1.bought = 10 -> g2 单件 100000、整批 10M。
    expect(within(cardOf('g2')).getByTestId('costs')).toHaveTextContent('10M')
    expect(buttonOf('g2')).not.toBeDisabled()
    expect(buttonOf('g2')).toHaveTextContent('购买 ×10')

    await user.click(buttonOf('g2'))
    expect(within(cardOf('g2')).getByTestId('bought-value')).toHaveTextContent('10')
  })

  it('材料不够时按钮禁用并写明是材料不足（不再是一个点了没反应的死按钮）', () => {
    const fixture = makeController({ project: withCrossEntryPrices(loadDimensionProject()) })
    // 100 恰好买满 g1 的第一批 10 台，然后一无所有。
    grant(fixture, '100')
    fixture.controller.buy('g1')
    mount(fixture)

    const button = buttonOf('g2')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('材料不足'))
    // 价格仍然给出真价（作者据此知道还差多少）。
    expect(within(cardOf('g2')).getByTestId('costs')).toHaveTextContent('10M')
  })

  it('只够一部分时：按钮写当前买得起的件数，悬浮提示说明差在哪', () => {
    const fixture = makeController({ project: withCrossEntryPrices(loadDimensionProject()) })
    grant(fixture, '1e30')
    fixture.controller.buy('g1') // g1.bought = 10 -> g2 单件 100000
    grant(fixture, '2.5e6') // 恰好 2 台
    mount(fixture)

    const button = buttonOf('g2')
    expect(button).not.toBeDisabled()
    expect(button).toHaveTextContent('购买 ×2')
    expect(button).toHaveAttribute('data-count', '2')
    expect(button).toHaveAttribute('data-request', '10')
    expect(button).toHaveAttribute('title', expect.stringContaining('10'))
    expect(within(cardOf('g2')).getByTestId('costs')).toHaveTextContent('2M')
  })
})

describe('缺陷 1 / 2（成就页）：基于“下一档”条件的升级买不了', () => {
  it('条件为真且按钮可用时，点下去 `bought` 必须真的 +1（按钮不许说谎）', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: loadDimensionProject() })
    grant(fixture, '1e30')
    mount(fixture)

    await user.click(buttonOf('g1')) // gen.g1.bought = 10 -> `up.u2.bought==0 && gen.g1.bought>=1` 成立
    await user.click(screen.getAllByTestId('nav-item')[1]!) // 切到「成就」页

    const button = buttonOf('u2')
    expect(within(cardOf('u2')).getByTestId('conditions')).toHaveTextContent('gen.g1.bought>=1')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('data-count', '1')

    // 修正前：条件读在“成交之后”一级（要求 `gen.g2.bought >= 1`）-> 结算 0 件，
    // 按钮亮着、写着“购买”，点下去毫无反应。
    await user.click(button)
    expect(within(cardOf('u2')).getByTestId('bought-value')).toHaveTextContent('1')
  })

  it('条件不满足时按钮禁用并写明是条件未满足', async () => {
    const user = userEvent.setup()
    const fixture = makeController({ project: loadDimensionProject() })
    grant(fixture, '1e30')
    mount(fixture)
    await user.click(screen.getAllByTestId('nav-item')[1]!) // 「成就」页

    // 还没买 g1 -> `gen.g1.bought >= 1` 不成立。
    const button = buttonOf('u2')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('条件'))
  })
})
