/**
 * 升级效果的结算（TECH_DESIGN 8.7、D-06、D-23、D-43、8.3 第 2 步）。
 *
 * 伪码（8.7）：
 *
 * ```
 * applyEffect(upgrade):
 *   if upgrade.owned <= 0 → return                     // 生效前提：必须已拥有（D-43）
 *   for i, e of upgrade.effects:
 *     if evaluate(e.condition, ctx=condition):
 *       bucket = effects.startBucket(upgrade, i)       // 本条效果独占一个分桶
 *       scope.effValue = upgrade.effectValues[i]       // 载入该效果持久化的数值（默认 0）
 *       run(e.action, ctx=effect)                      // set/create/destroy 入 EffectSink
 *       bucket.commitEffValue(scope.effValue)          // 登记写回（提交阶段才落地）
 *     // 前提不满足 → 跳过本条，继续判断下一条；不 break、不短路
 * ```
 *
 * ## 三条不可省的语义
 *
 * 1. **`owned > 0` 前置**（D-43、R-34）：`initial = 0`、未购买、`condition` 默认为真的升级
 *    若无条件判定，开局就会每秒改写全局状态。判定用 `owned` 而非 `bought`，
 *    才覆盖“被其它升级产出的升级”。
 * 2. **不 `break`**（D-23）：PRD 明确要求每个效果都要判断，满足前提的**全部**生效。
 * 3. **`effValue` 写回与所在分桶同生共死**（5.6、8.7）：`action` 抛错 → 写回与其收集的其它副作用
 *    一并丢弃；未对 `effValue` 赋值 → **不登记写回**、也不递增该属性 `version`（否则每次
 *    “每秒生效”都制造无意义的缓存失效，R-06）。
 */
import { Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'

import type { AttributeStore, EntryState } from './attribute-store.js'
import { entityKeyOf, upgradeDefOf } from './attribute-store.js'
import type { ExpressionRuntime } from './expression-runtime.js'

/** `applyEffect` 所需的依赖（比 `PurchaseDeps` 更窄，便于 `upgrade-effect` 与 `purchase` 互不循环依赖）。 */
export interface EffectDeps {
  attrs: AttributeStore
  runtime: ExpressionRuntime
}

/** 一条效果结算后的可观测结果。 */
export interface EffectOutcome {
  /** 本次实际执行了动作的效果条数（前提为真且求值成功）。 */
  applied: number
  /** 前提为假而跳过的条数。 */
  skipped: number
  /** 动作求值失败而回滚的条数（该条的效果数值保持上次成功值）。 */
  failed: number
}

const EMPTY_OUTCOME: EffectOutcome = { applied: 0, skipped: 0, failed: 0 }

/**
 * 结算一个升级的全部效果（8.7 的三个触发点共用这一个入口）。
 *
 * @param visibleAndEnabled 调用方已按 8.4 过滤（可见 ∧ 未禁用）时可传 `true` 跳过重复判定；
 *   每秒生效阶段传 `true`，购买结算传 `false`（购买已在 `buyable` 里判过）。
 */
export function applyEffect(deps: EffectDeps, state: EntryState, alreadyGated = false): EffectOutcome {
  // 触发前提：必须已拥有（D-43）。`owned` 实时读取，不缓存——
  // 同一 tick 内被别的升级把 `owned` 置正后，下一个触发点立刻能看到。
  const owned = deps.attrs.value(state, 'owned')
  if (!owned.gt(0)) return EMPTY_OUTCOME

  const def = upgradeDefOf(state)
  const entity = entityKeyOf('upgrade', state.id)
  let outcome: EffectOutcome = EMPTY_OUTCOME

  def.effects.forEach((effect, index) => {
    // 前提默认为真（PRD 升级编辑器 8）；空串等同 `true`，让作者可以只填动作。
    const conditionText = deps.attrs.textOr(state, `effects[${index}].condition`) || 'true'
    let holds: boolean
    try {
      holds = deps.runtime.evaluateBoolean(conditionText, 'condition', `up.${state.id}.effects[${index}].condition`)
    } catch {
      holds = false // 8.7：前提求值失败按“不成立”处理该条
    }
    if (!holds) {
      outcome = { ...outcome, skipped: outcome.skipped + 1 }
      return
    }

    const actionText = deps.attrs.textOr(state, `effects[${index}].action`)
    const current = effectValue(deps, state, index)
    const result = deps.runtime.runEffectAction(`${entity}#effects[${index}]`, actionText, `up.${state.id}.effectValues[${index}]`, current)
    outcome = result.ok ? { ...outcome, applied: outcome.applied + 1 } : { ...outcome, failed: outcome.failed + 1 }
  })

  void alreadyGated
  return outcome
}

/** 读取 `effectValues[i]`（默认 `0`，PRD 升级编辑器 12“默认为零”）。 */
export function effectValue(deps: EffectDeps, state: EntryState, index: number): Decimal {
  const stored = state.values.get(`effectValues[${index}]`)
  return stored ?? Num.fromNumber(0)
}
