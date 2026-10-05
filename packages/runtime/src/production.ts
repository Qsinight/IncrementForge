/**
 * 产出结算（TECH_DESIGN 8.3 第 3~4 步、8.5 `click`、D-30、R-26）。
 *
 * ## `produces[i].amount` 是**单件产出速率**（D-30）
 *
 * 总产出 = `owned × Σ produces[i].amount`，`owned` **只乘一次**。这条最容易出错的��径是
 * 表达式里已经乘过 `owned`，结算时又乘一遍 → 数值按 `owned²` 膨胀（R-26）。
 * 因此 `applyProduces` 的入参是“单件速率之和”，乘 `owned` 只在函数内部发生一次。
 *
 * ## 产出目标可以是资源，也可以是其它生成器
 *
 * 资源加 `amount`（受 `max` 约束）；生成器加 `owned`（受其 `max` 约束，**不影响价格**——
 * 不动 `bought`，8.3 第 3 步）。
 *
 * ## 点击器（8.3 第 4 步）
 *
 * 不参与自动产出；点击**即时**结算一次产出，公式与自动产出同式（单次点击即一个 dt）。
 */
import { Diagnostics, ForgeError, Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'

import type { AttributeStore, EntryState } from './attribute-store.js'
import { entityKeyOf, producesOf } from './attribute-store.js'
import type { ExpressionRuntime } from './expression-runtime.js'
import type { VisibilityJudge } from './visibility.js'

/** 产出结算所需的依赖。 */
export interface ProductionDeps {
  attrs: AttributeStore
  runtime: ExpressionRuntime
  judge: VisibilityJudge
}

/**
 * 求某个生成器的 `Σ produces[i].amount`（单件速率之和）。
 *
 * 逐行独立求值：某一行报错（last-good）不影响其它行，`rate` 为 0。
 */
export function unitRate(deps: ProductionDeps, state: EntryState): Decimal {
  if (state.kind !== 'generator') return Num.fromNumber(0)
  const produces = producesOf(state)
  if (produces.length === 0) return Num.fromNumber(0)
  let sum = Num.fromNumber(0)
  produces.forEach((_, index) => {
    const where = `gen.${state.id}.produces[${index}].amount`
    try {
      const text = deps.attrs.textOr(state, `produces[${index}].amount`)
      sum = Num.add(sum, deps.runtime.evaluateNumber(text, 'production', where))
    } catch {
      // D-07：该行取 last-good（本 tick 已由求值器处理），不中断产出结算。
    }
  })
  return sum
}

/**
 * 解析产出目标：资源 -> `res.<id>`，生成器 -> `gen.<id>`。
 *
 * 产出可指向资源**或生成器**（8.3 第 3 步：加到其 `owned`，不影响价格）。
 * 悬空目标记 `E_DANGLING_REF` 并跳过该行——一行坏产出不该让整个产出阶段停摆（D-07）。
 */
function produceTargets(deps: ProductionDeps, state: EntryState): string[] {
  if (state.kind !== 'generator') return []
  const targets: string[] = []
  producesOf(state).forEach((_, index) => {
    const materialId = deps.attrs.textOr(state, `produces[${index}].materialId`)
    const resourceKey = entityKeyOf('resource', materialId)
    if (deps.attrs.find(resourceKey)) {
      targets.push(resourceKey)
      return
    }
    const generatorKey = entityKeyOf('generator', materialId)
    if (deps.attrs.find(generatorKey)) {
      targets.push(generatorKey)
      return
    }
    Diagnostics.record('E_DANGLING_REF', `gen.${state.id}.produces[${index}].materialId`, `产出目标 "${materialId}" 不存在`)
  })
  return targets
}

/**
 * 把 `delta` 加到某个产出目标上（受 `max` 约束，4.4 第 4 条）。
 *
 * 资源写 `amount`、生成器写 `owned`；两者都经 `writeQuantity` 走同一套
 * `clampLower0 + applyCap`，因此数量上限语义在任何写入路径上完全一致。
 */
function addToTarget(deps: ProductionDeps, targetKey: string, delta: Decimal): void {
  const target = deps.attrs.find(targetKey)
  if (!target) return
  if (target.kind === 'resource') {
    const next = Num.add(deps.attrs.value(target, 'amount'), delta)
    deps.attrs.writeQuantity(target, 'amount', next, targetKey, '<production>')
  } else if (target.kind === 'generator') {
    const next = Num.add(deps.attrs.value(target, 'owned'), delta)
    deps.attrs.writeQuantity(target, 'owned', next, targetKey, '<production>')
  }
}

/**
 * `applyProduces(generator, delta)`：把一次产出的**总量**加到各产出目标上。
 *
 * @param delta 已乘好的增量。**不要再乘一次速率**——`owned × Σ produces[i].amount × dt`
 *   由调用方算好（8.3 第 3 步），公式里的 `Σ` 正是为此存在的：多个产出行时
 *   **每个目标都拿这同一份总量**，而不是各自只拿自己那一行的份额。
 *
 * 把乘法留在调用点是刻意的：8.3 第 3 步的自动产出与 8.5 `click` 的单次点击用**同一个公式**，
 * 差别只在 `dt`。公式只有一处实现就不会走样（D-30；R-26 反复强调的“只乘一次”）。
 */
export function applyProduces(deps: ProductionDeps, state: EntryState, delta: Decimal): void {
  if (!delta.gt(0)) return
  for (const targetKey of produceTargets(deps, state)) {
    addToTarget(deps, targetKey, delta)
  }
}

/**
 * 一次产出的完整结算（8.3 第 3 步的 `owned × Σ` 口径）。
 *
 * @param owned 当前拥有数量（由调用方传入，保证“判定快照”语义：阶段内 `owned` 变化不重入）
 */
export function produceOnce(deps: ProductionDeps, state: EntryState, owned: Decimal, dtSeconds: Decimal): void {
  if (!owned.gt(0)) return
  const rate = unitRate(deps, state)
  if (!rate.gt(0)) return
  // `owned × Σ rate × dt`：`owned` 只乘一次（D-30）。
  applyProduces(deps, state, Num.mul(owned, Num.mul(rate, dtSeconds)))
}

/**
 * 点击器点击（8.5 `click`）。
 *
 * 点击不是购买：不走 `buyable`，也不报 `E_CLICKER_NOT_BUYABLE`（D-28）。
 * 不可见/禁用（含页面）时拒绝；`owned >= max` 报 `E_CAP`。
 *
 * @returns 本次获得的量（`owned × Σ 单件速率`，即一次点击的收益）
 */
export function click(deps: ProductionDeps, state: EntryState): Decimal {
  if (!deps.judge.isVisible(state)) {
    Diagnostics.record('E_HIDDEN', `gen.${state.id}`, '条目不可见，点击被拒绝')
    throw new ForgeError('E_HIDDEN', { where: `gen.${state.id}`, message: '条目不可见' })
  }
  if (deps.judge.isDisabled(state)) {
    Diagnostics.record('E_DISABLED', `gen.${state.id}`, '条目已禁用，点击被拒绝')
    throw new ForgeError('E_DISABLED', { where: `gen.${state.id}`, message: '条目已禁用' })
  }
  const owned = deps.attrs.value(state, 'owned')
  const cap = deps.attrs.capOf(state)
  if (owned.gte(cap)) {
    Diagnostics.record('E_CAP', `gen.${state.id}`, '已达数量上限')
    throw new ForgeError('E_CAP', { where: `gen.${state.id}`, message: '已达数量上限' })
  }
  const rate = unitRate(deps, state)
  const gained = Num.mul(owned, rate)
  // `owned >= 1` 才会产出（D-19：点击器的 `owned` 初始为 `initial`）。
  applyProduces(deps, state, gained)
  return gained
}
