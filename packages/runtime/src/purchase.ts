/**
 * 购买结算（TECH_DESIGN 8.5、8.6、D-06、D-28、D-30）。
 *
 * ## 价格求值的两个入口
 *
 * | 入口 | 用途 | 语义 |
 * | --- | --- | --- |
 * | `evaluateCostsAt(state, j)` | 批量求解器逐级求 `P(j)` | `j` 是**只读等级视图**下的 `bought`（8.6.1），绝不修改存储 |
 * | `evaluateSingleCost(state)` | `buyOne` 的即时结算 | 用真实 `bought` 求单件价格 |
 *
 * 两者共用同一份价格表达式求值，区别只在“`bought` 读作多少”——这正是 8.6.1 的设计要点：
 * 求解器必须能“看见”一个临时等级值，而**不是**真的把 `bought` 改掉。
 *
 * ## 点击器不可购买是硬约束（D-28、R-25）
 *
 * `isClicker === true` 的生成器 `canBuy` 恒假，`buyOne`/`solveBatch`/自动购买三条路径
 * **各自显式拒绝**并报 `E_CLICKER_NOT_BUYABLE`。UI 只渲染无“购买”按钮的 `ClickerCard`
 * 是表现层结果，不能当成“路径已被堵死”。
 *
 * ## 价格行不可用 ≠ “没有价格”（D-38、`priceRowsUsable`）
 *
 * `evaluateCostAt` 对坏行是**跳过**（记 `E_DANGLING_REF`，D-07「一行坏数据不中断结算」）。
 * 这在**展示**口径上没问题，但**结算**口径上是致命的：`deductCosts([])` 因为
 * “没有要扣的材料”而返回 `true`，于是 `buyOne` 把生成器白送出去。
 *
 * 现实触发路径很朴素：编辑器里点“+ 购买价格”新增一行，`materialId` 初始是空串；
 * 作者忘了选材料（`RefPicker` 曾经没有“未设置”这个选项，空值时浏览器自动选中第一个候选，
 * 看上去像选好了）。于是卡片上看不到任何价格、按钮可点、买了不花钱；
 * 产出侧同样悬空（`produceTargets` 也跳过该行），所以资源也不涨。
 *
 * 同一个原则还有另一半：**装载/热更新时被换成中性值的价格文本也不是作者写的**
 * （坏表达式 -> 占位 `'0'`，5.7 的 last-good），按 0 结算同样是白送，
 * 因此 `EntryState.neutralized` 里的键也判为不可用。
 *
 * 因此把“价格行是否全部可用”提成显式判定 `priceRowsUsable()`：**声明了价格行
 * 却一行都不可用 = 拒绝购买**，绝不能退化成“没有价格”。`free` 模式（自动最大购买）
 * 同样要过这道闸——PRD 要求它“仍要满足最后一件的购买价格”，算不出价格就无法校验。
 */
import { Diagnostics, ForgeError, Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'
import { levelOverlayKey, levelOverlayReader } from '@iforge/expr'
import type { Value } from '@iforge/expr'

import type { AttributeStore, EntryState } from './attribute-store.js'
import { entityKeyOf, costsOf, conditionsOf } from './attribute-store.js'
import type { ExpressionRuntime } from './expression-runtime.js'
import type { VisibilityJudge } from './visibility.js'
import { applyEffect } from './upgrade-effect.js'

/** 购买结算所需的依赖。 */
export interface PurchaseDeps {
  attrs: AttributeStore
  runtime: ExpressionRuntime
  judge: VisibilityJudge
}

/** 单种材料的单件价格。 */
export interface CostQuote {
  /** 材料资源键（`res.r1`）。 */
  materialKey: string
  materialId: string
  /** 单件价格（`price` 上下文求值，PRD 补充 1 禁随机）。 */
  price: Decimal
}

/** 一次价格求值的可观测结果。 */
export interface CostEvaluation {
  quotes: CostQuote[]
  /** 有几行因求值失败而按 0 处理（诊断用）。 */
  failed: number
}

/**
 * 只读等级视图下求单件价格（8.6.1）。
 *
 * @param level 该条目的 `bought` 在本次求值中被“看作”的等级值
 *
 * **不递增属性 `version`、不触发脏标记、不写 `assignments`**——否则一次批量求解会污染存档，
 * 并把整批结果记成“最后一次赋值”。`overlayKey` 保证记忆化缓存按等级隔离
 * （`P(1) == P(5)` 的静默错误）。
 */
export function evaluateCostAt(deps: PurchaseDeps, state: EntryState, level: Decimal): CostEvaluation {
  const quotes: CostQuote[] = []
  let failed = 0
  const costs = costsOf(state)
  const boughtKey = `${entityKeyOf(state.kind, state.id)}.bought`
  const read = levelOverlayReader(deps.attrs.read, boughtKey, level as Value)
  const overlay = levelOverlayKey(boughtKey, level)

  costs.forEach((cost, index) => {
    const materialId = deps.attrs.textOr(state, `costs[${index}].materialId`)
    if (!deps.attrs.materialExists(materialId)) {
      Diagnostics.record('E_DANGLING_REF', `costs[${index}].materialId`, `购买材料 "${materialId}" 不存在`)
      failed += 1
      return
    }
    const where = `${entityKeyOf(state.kind, state.id)}.costs[${index}].amount`
    const text = deps.attrs.textOr(state, `costs[${index}].amount`)
    let price: Decimal
    try {
      price = deps.runtime.evaluateNumber(text, 'price', where, { read, overlayKey: overlay })
    } catch {
      failed += 1
      return
    }
    quotes.push({ materialKey: entityKeyOf('resource', materialId), materialId, price })
  })

  return { quotes, failed }
}

/** 用真实 `bought` 求单件价格（`buyOne` 与仪表盘预测用）。 */
export function evaluateSingleCost(deps: PurchaseDeps, state: EntryState): CostEvaluation {
  return evaluateCostAt(deps, state, deps.attrs.value(state, 'bought'))
}

/**
 * 价格行是否**全部可用**（引用可解析 ∧ 表达式可求值 ∧ 价格文本不是中性占位值）。
 *
 * | `costs` 声明 | 结果 |
 * | --- | --- |
 * | 空 | `true`——本来就没有价格，是合法的免费条目（点击器、纯靠 `create()` 的动态条目） |
 * | 非空且每一行都求出了价格、且都不是占位值 | `true` |
 * | 非空但有任何一行被跳过，或价格文本是占位值 | `false` |
 *
 * **不允许**把「跳过坏行」当成「没有价格」：`deductCosts([])` 会返回 `true`
 * （没有可扣的材料），`buyOne`/`solveBatch` 就会把条目白送出去。
 * 悬空引用在 D-38 的口径下是**必须暴露的错误**（不做级联改写），不是“免费”。
 *
 * 第三条（占位值）是同一条原则的另一半：装载/热更新时作者写坏的价格表达式会被换成
 * 中性值 `'0'`（5.7 的 last-good，`E_PARSE` 已入库）。`0` **不是**作者定的价格，
 * 按它结算同样是白送——所以 `EntryState.neutralized` 里的键一律视为不可用。
 *
 * @param evaluation 已经求好的结果；不给则内部按当前 `bought` 求一次
 *   （`buyOne`/`solveBatch` 都要用到它，传入可避免重复求值）。
 */
export function priceRowsUsable(deps: PurchaseDeps, state: EntryState, evaluation?: CostEvaluation): boolean {
  const declared = costsOf(state).length
  if (declared === 0) return true
  for (let index = 0; index < declared; index += 1) {
    if (deps.attrs.isNeutralText(state, `costs[${index}].amount`)) return false
  }
  const result = evaluation ?? evaluateSingleCost(deps, state)
  return result.failed === 0 && result.quotes.length === declared
}

/**
 * 记一条「价格行不可用」的诊断（购买路径共用）。
 *
 * 单独再记一次而不是只靠 `evaluateCostAt` 的 `E_DANGLING_REF`：那一条是**每次求值**
 * 都记的，作者在诊断面板里看到的是成百上千条“引用了已删除的条目”，看不出
 * “因此购买被拒绝了”这条因果。位置给 `costs`（行级信息由 `evaluateCostAt` 提供）。
 */
export function rejectBrokenPrice(deps: PurchaseDeps, state: EntryState, mode: BuyMode): false {
  Diagnostics.record(
    'E_DANGLING_REF',
    `${entityKeyOf(state.kind, state.id)}.costs`,
    `价格行无效（购买材料不存在或价格无法求值），已拒绝本次购买（mode=${mode}）`,
  )
  return false
}

/**
 * `buyable(target)` 的前置判定（8.5 伪码第 1 段）。
 *
 * 返回失败原因以便调用方记对应诊断码；`undefined` 表示通过。
 */
export function buyable(deps: PurchaseDeps, state: EntryState, mode: BuyMode): ForgeError | undefined {
  if (state.kind !== 'generator' && state.kind !== 'upgrade') {
    return new ForgeError('E_READONLY_TARGET', { message: '资源没有购买路径（D-20）' })
  }
  // 点击器硬约束（D-28）：三种模式一律拒绝。
  if (deps.judge.isClicker(state)) {
    return new ForgeError('E_CLICKER_NOT_BUYABLE', {
      where: entityKeyOf(state.kind, state.id),
      message: '点击器不可购买，请使用“点击”按钮',
    })
  }
  if (!deps.judge.isVisible(state)) {
    return new ForgeError('E_HIDDEN', { where: entityKeyOf(state.kind, state.id), message: '条目不可见' })
  }
  if (deps.judge.isDisabled(state)) {
    return new ForgeError('E_DISABLED', { where: entityKeyOf(state.kind, state.id), message: '条目已禁用' })
  }
  const owned = deps.attrs.value(state, 'owned')
  const cap = deps.attrs.capOf(state)
  if (owned.gte(cap)) {
    return new ForgeError('E_CAP', { where: entityKeyOf(state.kind, state.id), message: '已达数量上限' })
  }
  if (state.kind === 'upgrade' && !conditionsAllTrue(deps, state)) {
    return new ForgeError('E_DISABLED', {
      where: entityKeyOf(state.kind, state.id),
      message: '升级购买条件未满足（AND 判定，PRD 补充 4）',
    })
  }
  void mode
  return undefined
}

/** 购买模式（8.6 的三态，由归一化后的 `buyAmount` 决定）。 */
export type BuyMode = 'count' | 'max' | 'free'

/**
 * 归一化后的 `buyAmount` -> 模式（8.6 的表）。
 *
 * | 值 | 行为 |
 * | --- | --- |
 * | `n ≥ 1` | `count`：连续购买直到不满足条件/价格，或达到 `min(n, 100)` 次 |
 * | `n = 0` | `max`：最大购买（无 100 上限），需支付材料 |
 * | `n < 0` | `free`：自动最大购买（无上限、免费、只校验最后一件） |
 */
export function modeOf(buyAmount: Decimal): BuyMode {
  if (buyAmount.eq(0)) return 'max'
  return buyAmount.gt(0) ? 'count' : 'free'
}

/** 升级的购买条件是否全部为真（AND，PRD 补充 4）。任一条求值失败按“不成立”处理（8.7）。 */
export function conditionsAllTrue(deps: PurchaseDeps, state: EntryState, level?: Decimal): boolean {
  if (state.kind !== 'upgrade') return true
  const conditions = conditionsOf(state)
  if (conditions.length === 0) return true
  const boughtKey = `${entityKeyOf('upgrade', state.id)}.bought`
  const effective = level ?? deps.attrs.value(state, 'bought')
  const read = levelOverlayReader(deps.attrs.read, boughtKey, effective as Value)
  const overlay = levelOverlayKey(boughtKey, effective)
  for (let index = 0; index < conditions.length; index += 1) {
    const where = `up.${state.id}.conditions[${index}]`
    try {
      const text = deps.attrs.textOr(state, `conditions[${index}]`)
      if (!deps.runtime.evaluateBoolean(text, 'condition', where, { read, overlayKey: overlay })) return false
    } catch {
      return false // 8.7：前提求值失败按“不成立”处理
    }
  }
  return true
}

/**
 * 条件的前缀语义判定（8.6.2）。
 *
 * ```
 * k* = max { k | 对每个 j ∈ [0, k−1]：condition(bought + j) 为真 ∧ 第 j 级价格可支付 }
 * ```
 *
 * ## 为什么下标从 **0** 开始（`bought + j` 而不是 `bought + j + 1`）
 *
 * `j` 是“第几次购买”的序号，而第 `j` 次购买**发生在**等级 `bought + j` 这个状态上——
 * 条件与价格都必须按**成交时**的状态判定，而不是按成交之后的状态。这与 8.6.2 伪码
 * 第 1 步的 `conditionsAllTrue(target, atLevel = target.bought + k − 1)`、`free` 模式的
 * `lastLevelHolds`（同样是 `bought + k − 1`）以及卡片件数 `affordableInCountMode`
 * （`bought + level`，`level ∈ [0, limit)`）**逐字一致**。三处口径必须相同，
 * 否则“按钮写 ×N、点下去只买到 0 件”这类“按钮说谎”的缺陷就会回来。
 *
 * ## 早先写成 `bought + j`（`j ∈ [1, k]`）为什么是错的
 *
 * 它把条件读在**成交之后**的一级，于是两种最常见的写法全被打歪：
 *
 * | 条件写法 | `bought + j`（错） | `bought + j` 起点为 0（对） |
 * | --- | --- | --- |
 * | 阈值型 `up.u1.bought >= 5` | `bought = 4` 时末级 `>= 5` 为真 -> **一次买满 10 件** | `bought = 4` 时第 1 级 `>= 5` 为假 -> 买 0 件；`bought = 5` 时才买 |
 * | “下一档”型 `(up.u2.bought==k && gen.gN.bought>=1) \|\| …` | 要求**再往后一档**的生成器 -> 最后一档的条件永远不成立，`up.u2` 永远买不到 `max` | 第 `k` 件按 `bought == k` 判定 -> 买满 `max` |
 *
 * 第二行就是「反物质维度」项目里 `购买维度`（`u2`）买不了、进而 `up.u2.effectValues[i]`
 * 永远停在 0、所有生成器的产出表达式 `(…)*(up.u2.effectValues[i]+1)` 永远乘不上那个
 * 倍率的**同一条根因**。
 *
 * ## 为什么仍然要逐级确认（而不是只校验末级）
 *
 * **只校验最后一级是不正确的**：条件形如 `gen.g1.bought != 5` 时末级为真会越过中间
 * 为假的等级（8.6.2、R-23/D-24）。这里做**逐级确认**（正确性保证，O(k)）；
 * `solveByConditionPrefix` 在此基础上用二分缩小候选 k，把逐级确认的成本降到实际需要的范围。
 *
 * 单调条件（`bought >= n` 这类阈值型比较）走快路径：末级为真即全程为真，
 * 只需抽查首、中、末三级（8.6.2「单调条件快路径」）。
 */
export function prefixHolds(
  deps: PurchaseDeps,
  state: EntryState,
  k: Decimal,
  affordable: (level: Decimal) => boolean,
  monotonic: boolean,
): { ok: boolean; confirmed: Decimal } {
  const bought = deps.attrs.value(state, 'bought')
  if (k.lte(0)) return { ok: true, confirmed: Num.fromNumber(0) }
  if (monotonic) {
    // 单调条件：“末级为真 ⇒ 全程为真”，因此抽查首、中、末三级即可（8.6.2 的 O(log k) 快路径）。
    // 探针落在**成交时**的等级 `bought + j`（`j ∈ [0, k)`）上。
    const last = Num.sub(k, Num.fromNumber(1))
    const probes = [Num.fromNumber(0), Num.floor(Num.div(last, Num.fromNumber(2))), last]
    let allPass = true
    for (const level of probes) {
      if (level.lt(0) || level.gte(k)) continue
      const at = Num.add(bought, level)
      if (!conditionsAllTrue(deps, state, at) || !affordable(at)) {
        allPass = false
        break
      }
    }
    // 三级都通过 ⇒ 单调性保证整段成立。**任何一级不通过就退回逐级确认**：
    // 单调只保证“后面的不会比前面的更假”，并不能从“中段为假”推出“中段之前都可买”，
    // 直接按探针位置回退会多买（早先的 `level − 1` 就是这么错的）。
    if (allPass) return { ok: true, confirmed: k }
  }
  // 非单调（或单调但抽查未通过）：逐级确认，第一个违例之前的前缀即为答案。
  // `level` 是“第 level 次购买”，它发生在等级 `bought + level` 上（8.6.2 的 j 从 0 起）。
  for (let level = 0; ; level += 1) {
    const at = Num.add(bought, Num.fromNumber(level))
    if (!conditionsAllTrue(deps, state, at) || !affordable(at)) {
      return { ok: false, confirmed: Num.fromNumber(level) }
    }
    if (level + 1 >= k.toNumber()) return { ok: true, confirmed: k }
  }
}

/** `free` 模式的末级校验（8.6.2）。
 *
 * PRD 生成器 8 写“仍要满足最后一件的购买价格”，PRD 升级 9 写“仍要满足最后一级的购买条件和价格”，
 * 即免费模式本身就是**末级语义**。因此这里只校验末级，**不做前缀回退**，
 * 也不施加比 PRD 更严的前缀约束（否则等于把 PRD 规定偷换成逐级判定）。
 */
export function lastLevelHolds(deps: PurchaseDeps, state: EntryState, k: Decimal, affordable: (level: Decimal) => boolean): boolean {
  if (k.lte(0)) return true
  const at = Num.add(deps.attrs.value(state, 'bought'), Num.sub(k, Num.fromNumber(1)))
  if (!affordable(at)) return false
  return conditionsAllTrue(deps, state, at)
}

/**
 * 扣材料（不足返回 `false` 且不扣）。
 *
 * **前置条件**：调用方必须先过 `priceRowsUsable()`。本函数对空 `quotes` 返回 `true`
 * （“没有要扣的材料”），因此它**不能**用来判断“价格是否可用”——那正是
 * `priceRowsUsable()` 存在的理由。
 */
export function deductCosts(deps: PurchaseDeps, quotes: readonly CostQuote[]): boolean {
  // 先检查再扣：材料之间不可互换，任一不足即整批失败（8.6「多材料」）。
  for (const quote of quotes) {
    const resource = deps.attrs.find(quote.materialKey)
    if (!resource) return false
    if (deps.attrs.value(resource, 'amount').lt(quote.price)) return false
  }
  for (const quote of quotes) {
    const resource = deps.attrs.find(quote.materialKey)
    if (!resource) continue
    const next = Num.sub(deps.attrs.value(resource, 'amount'), quote.price)
    deps.attrs.writeQuantity(resource, 'amount', next, quote.materialKey, '<purchase>')
  }
  return true
}

/**
 * `buyOne(target)`：单件购买（8.5）。
 *
 * 同步函数：材料、`bought/owned` **即时**生效；升级的效果副作用走统一提交阶段，
 * 在**下一个**提交阶段应用（8.3.1）。
 */
export function buyOne(deps: PurchaseDeps, state: EntryState): boolean {
  const failure = buyable(deps, state, 'count')
  if (failure) {
    Diagnostics.record(failure.code, failure.where, failure.message)
    return false
  }
  const evaluation = evaluateSingleCost(deps, state)
  // 价格行不可用必须**拒绝购买**，不能退化成“没有价格 → 免费”（见 `priceRowsUsable`）。
  if (!priceRowsUsable(deps, state, evaluation)) return rejectBrokenPrice(deps, state, 'count')
  if (!deductCosts(deps, evaluation.quotes)) {
    Diagnostics.record('E_NOT_ENOUGH', entityKeyOf(state.kind, state.id), '材料不足')
    return false
  }
  const entity = entityKeyOf(state.kind, state.id)
  deps.attrs.writeQuantity(state, 'bought', Num.add(deps.attrs.value(state, 'bought'), Num.fromNumber(1)), entity, '<buyOne>')
  deps.attrs.writeQuantity(state, 'owned', Num.add(deps.attrs.value(state, 'owned'), Num.fromNumber(1)), entity, '<buyOne>')
  if (state.kind === 'upgrade') {
    // 触发点 ①：单件购买成功后立即结算自身全部效果（8.7）。
    applyEffect(deps, state)
  }
  return true
}

/** 把 `k` 件写入 `bought`/`owned`（`owned` 受 `max` 约束）。 */
export function advanceCounters(deps: PurchaseDeps, state: EntryState, k: Decimal): void {
  if (!k.gt(0)) return
  const entity = entityKeyOf(state.kind, state.id)
  deps.attrs.writeQuantity(state, 'bought', Num.add(deps.attrs.value(state, 'bought'), k), entity, '<batch>')
  deps.attrs.writeQuantity(state, 'owned', Num.add(deps.attrs.value(state, 'owned'), k), entity, '<batch>')
}
