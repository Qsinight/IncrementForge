/**
 * 有效状态：可见性与禁用的页面层级继承（TECH_DESIGN 8.4、PRD 页面编辑 4/5/6）。
 *
 * 8.4 的核心是**页面继承**：`isVisible` 与 `isDisabled` 都要看页面，
 * 而可见性/禁用是**两级独立**的——页面不可见与页面禁用是两种不同的失效原因，
 * UI 必须能分别提示（PRD 页面编辑 4/5/6）。
 *
 * 另外覆盖 8.4 的“判定时机”：**阶段内取一次快照**，同 tick 内半途改页面不改结算。
 */
import { describe, expect, it } from 'vitest'

import { Num } from '@iforge/num'
import { createExampleProject } from '@iforge/model'

import { Harness } from './helpers/harness.js'

/** 示例项目（`p1` 挂着 `r1`/`g1`/`g2`/`u1`）。 */
function twoPages(): Harness {
  return new Harness({ project: createExampleProject() })
}

describe('8.4 有效可见性 `isVisible`', () => {
  it('条目自身 `visible = true` 且页面可见 -> 可见', () => {
    const h = twoPages()
    expect(h.state.judge.isVisible(h.generator('g1'))).toBe(true)
  })

  it('条目自身 `visible = false` -> 不可见（与页面无关）', () => {
    const h = twoPages()
    h.state.attrs.write('gen.g1.visible', 'false', '<test>')
    expect(h.state.judge.isVisible(h.generator('g1'))).toBe(false)
  })

  it('页面 `visible = false` -> 页面内所有条目不可见（PRD 页面编辑 5）', () => {
    const h = twoPages()
    h.state.attrs.write('page.p1.visible', 'false', '<test>')
    expect(h.state.judge.isVisible(h.generator('g1'))).toBe(false)
    expect(h.state.judge.isVisible(h.state.attrs.require('res.r1'))).toBe(false)
    expect(h.state.judge.isVisible(h.upgrade('u1'))).toBe(false)
  })

  it('父页面不可见时，条目自己 `visible = true` 也救不回来', () => {
    const h = twoPages()
    h.state.attrs.write('gen.g1.visible', 'true', '<test>')
    h.state.attrs.write('page.p1.visible', 'false', '<test>')
    expect(h.state.judge.isVisible(h.generator('g1'))).toBe(false)
  })
})

describe('8.4 有效禁用 `isDisabled`', () => {
  it('条目 `disabled = false` 且页面未禁用 -> 未禁用', () => {
    const h = twoPages()
    expect(h.state.judge.isDisabled(h.generator('g1'))).toBe(false)
  })

  it('条目自身 `disabled = true` -> 禁用（生成器/升级/页面支持，资源不支持）', () => {
    const h = twoPages()
    h.state.attrs.write('gen.g1.disabled', 'true', '<test>')
    expect(h.state.judge.isDisabled(h.generator('g1'))).toBe(true)
    h.state.attrs.write('up.u1.disabled', 'true', '<test>')
    expect(h.state.judge.isDisabled(h.upgrade('u1'))).toBe(true)
    h.state.attrs.write('page.p1.disabled', 'true', '<test>')
    expect(h.state.judge.isDisabled(h.page('p1'))).toBe(true)
  })

  it('页面禁用 -> 页面内所有条目禁用（PRD 页面编辑 6）', () => {
    const h = twoPages()
    h.state.attrs.write('page.p1.disabled', 'true', '<test>')
    expect(h.state.judge.isDisabled(h.generator('g1'))).toBe(true)
    expect(h.state.judge.isDisabled(h.upgrade('u1'))).toBe(true)
  })

  it('可见性与禁用互相独立：不可见 != 禁用', () => {
    const h = twoPages()
    h.state.attrs.write('gen.g1.visible', 'false', '<test>')
    // 不可见的条目**没有**被禁用——UI 要能区分“不给看”和“灰掉不能买”。
    expect(h.state.judge.isVisible(h.generator('g1'))).toBe(false)
    expect(h.state.judge.isDisabled(h.generator('g1'))).toBe(false)
  })

  it('资源没有 `disabled` 属性（D-20）：写它报 `E_UNKNOWN_ATTR`', () => {
    const h = twoPages()
    expect(h.state.attrs.write('res.r1.disabled', 'true', '<test>')).toBe(false)
    expect(h.state.diagnosticCount('E_UNKNOWN_ATTR')).toBe(1)
  })
})

describe('8.4 `canProduce` / `canBuy` / `canTick`', () => {
  it('`canProduce` 要求可见、未禁用、非点击器', () => {
    const h = twoPages()
    const g1 = h.generator('g1')
    expect(h.state.judge.canProduce(g1)).toBe(true)
    h.state.attrs.write('gen.g1.visible', 'false', '<test>')
    expect(h.state.judge.canProduce(g1)).toBe(false)
    h.state.attrs.write('gen.g1.visible', 'true', '<test>')
    h.state.attrs.write('gen.g1.disabled', 'true', '<test>')
    expect(h.state.judge.canProduce(g1)).toBe(false)
    h.state.attrs.write('gen.g1.disabled', 'false', '<test>')
    h.state.attrs.write('gen.g1.isClicker', 'true', '<test>')
    expect(h.state.judge.canProduce(g1)).toBe(false)
  })

  it('`canBuy` 要求可见、未禁用、不是点击器、`owned < max`、升级条件全为真', () => {
    const h = twoPages()
    const g1 = h.generator('g1')
    expect(h.state.judge.canBuy(g1)).toBe(true)

    // 点击器恒不可购买（D-28、R-25）。
    h.state.attrs.write('gen.g1.isClicker', 'true', '<test>')
    expect(h.state.judge.canBuy(g1)).toBe(false)
    h.state.attrs.write('gen.g1.isClicker', 'false', '<test>')

    // 达到 `max`。
    h.state.attrs.write('gen.g1.max', '1', '<test>')
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(1), '<test>')
    expect(h.state.judge.canBuy(g1)).toBe(false)

    // 升级：条件不为真即不可购买（PRD 补充 4 的 AND 判定）。
    const u1 = h.upgrade('u1')
    expect(h.state.judge.canBuy(u1)).toBe(false)
    h.state.attrs.write('gen.g1.bought', Num.fromNumber(5), '<test>')
    expect(h.state.judge.canBuy(u1)).toBe(true)
  })

  it('`canTick` 要求可见且未禁用（不检查点击器与数量上限）', () => {
    const h = twoPages()
    const g1 = h.generator('g1')
    expect(h.state.judge.canTick(g1)).toBe(true)
    h.state.attrs.writeText(g1, 'max', '0', '<test>')
    // `max` 兜底为 1，`owned = 0 < 1`，仍然可 tick。
    expect(h.state.judge.canTick(g1)).toBe(true)
    h.state.attrs.write('page.p1.visible', 'false', '<test>')
    expect(h.state.judge.canTick(g1)).toBe(false)
  })

  it('`ownsUpgrade` 只看 `owned > 0`，不看 `bought`（D-43）', () => {
    const h = twoPages()
    const u1 = h.upgrade('u1')
    expect(h.state.judge.ownsUpgrade(u1)).toBe(false)
    h.state.attrs.write('up.u1.bought', Num.fromNumber(3), '<test>')
    expect(h.state.judge.ownsUpgrade(u1)).toBe(false)
    h.state.attrs.write('up.u1.owned', Num.fromNumber(1), '<test>')
    expect(h.state.judge.ownsUpgrade(u1)).toBe(true)
  })
})

describe('8.4 判定快照：阶段内取一次', () => {
  it('快照在生成后**不再变化**：半途改页面可见性不影响本 tick 已取到的判定', () => {
    const h = twoPages()
    const entries = [...h.state.attrs.listByKind('generator'), ...h.state.attrs.listByKind('upgrade')]
    const snapshot = h.state.judge.snapshot(entries)
    expect(snapshot.canSettle('generator', 'g1')).toBe(true)

    // 阶段进行到一半：页面被关掉、生成器被禁用。
    h.state.attrs.write('page.p1.visible', 'false', '<test>')
    h.state.attrs.write('gen.g1.disabled', 'true', '<test>')

    // 快照仍是阶段开始时的判定；实时判定则已经变了。
    expect(snapshot.canSettle('generator', 'g1')).toBe(true)
    expect(h.state.judge.canTick(h.generator('g1'))).toBe(false)
    // 下一个 tick 重新取快照后才生效。
    expect(h.state.judge.snapshot(entries).canSettle('generator', 'g1')).toBe(false)
  })

  it('`canSettle` 同时要求可见与未禁用（不可见也停止结算）', () => {
    const h = twoPages()
    const entries = [...h.state.attrs.listByKind('generator')]
    h.state.attrs.write('gen.g1.visible', 'false', '<test>')
    expect(h.state.judge.snapshot(entries).canSettle('generator', 'g1')).toBe(false)
    h.state.attrs.write('gen.g1.visible', 'true', '<test>')
    h.state.attrs.write('gen.g1.disabled', 'true', '<test>')
    expect(h.state.judge.snapshot(entries).canSettle('generator', 'g1')).toBe(false)
  })

  it('快照在整条 tick 流水线里一致：先禁用页面，本 tick 的所有阶段都看不到该条目', () => {
    const h = twoPages()
    h.state.attrs.write('page.p1.disabled', 'true', '<test>')
    const before = h.resource('r1').toNumber()
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(10), '<test>')
    h.runSeconds(1)
    expect(h.resource('r1').toNumber()).toBe(before)
  })
})

describe('8.4 结算被跳过时的诊断', () => {
  it('不可见/禁用的条目不参与结算，但**不**报错（PRD 页面编辑 6）', () => {
    const h = twoPages()
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(10), '<test>')
    h.state.attrs.write('page.p1.visible', 'false', '<test>')
    const snapshot = h.state.diagnosticsSnapshot()
    h.runSeconds(2)
    expect(h.state.attrs.value(h.generator('g1'), 'owned').toNumber()).toBe(10)
    // 不产生新诊断：隐藏/禁用是**设计行为**，不是错误。
    expect(h.state.diagnosticsSnapshot()).toEqual(snapshot)
  })
})
