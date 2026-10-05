/**
 * 表达式运行时：五个上下文的 `Evaluator` + `EffectSink` + 随机源 + 动态条目宿主（TECH_DESIGN 5.5~5.7、8.3 第 1 步）。
 *
 * ## 为什么单独一个模块
 *
 * `AttributeStore` 需要“按上下文求值”，求值器需要“从 store 读属性”——两者互相需要，
 * 若在同一个类里构造就会有一半字段是空的。这里拆成**两个对象 + 显式接线**：
 * `ExpressionRuntime` 先建好五个求值器与 sink，`GameState` 再把它们与 store 互绑
 * （`store.attach()` / `runtime.attachStore()`）。依赖方向因此在构造顺序上是单向的。
 *
 * ## 每 tick 的两件事（8.3 第 1 步）
 *
 * - `tickCache.clear()`：五个求值器各自 `beginTick`（5.7 的记忆化）；
 * - 刷新随机源：由 `tick` 派生的确定性伪随机源，保证同 tick 内结果一致
 *   （回放/复现得到相同结果，也让“随机”不会成为测试的干扰项）。
 */
import type { ConstantObject, ContextKind, DynamicHost, Effect, EffectBucket, FunctionCallContext, Value } from '@iforge/expr'
import { EffectSink, Evaluator, createOfflineRandomSource, createRandomSource } from '@iforge/expr'
import { ForgeError, Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'

import type { AttributeStore, ExpressionHost } from './attribute-store.js'

/** 五个上下文的求值器（5.5）。 */
const CONTEXTS = ['field', 'price', 'production', 'condition', 'effect'] as const
export type Context = (typeof CONTEXTS)[number]

/** 属性读取函数（8.6.1 的只读等级视图通过覆盖它实现）。 */
export type Reader = (key: string) => Value

/** 求值选项。 */
export interface EvaluateOptions {
  /** 只读等级视图：覆盖某个属性的读取值（8.6.1）。 */
  read?: Reader
  /**
   * 覆盖层标识（8.6.1 的记忆化隔离）。
   *
   * **必须**与 `read` 同时传入：不同 `j` 用不同键，否则同一段表达式在 `j = 1` 与
   * `j = 5` 处会命中彼此的 tick 缓存值（`P(1) == P(5)` 的静默错误）。
   */
  overlayKey?: string
  /** `effect` 上下文的局部变量 `effValue` 及其赋值标记（8.7）。 */
  scope?: { effValue?: Decimal; effValueAssigned?: boolean }
}

/**
 * 表达式运行时。
 */
export class ExpressionRuntime implements ExpressionHost {
  /** 副作用收集器（5.6）：按表达式实例分桶，在固定提交阶段统一应用。 */
  readonly sink = new EffectSink()

  /** 属性读取（在 `attachStore` 之前是占位实现）。 */
  private readImpl: Reader = () => {
    throw new ForgeError('E_UNKNOWN_ATTR', { message: 'AttributeStore 尚未接线（ExpressionRuntime.attachStore）' })
  }

  /** 动态条目宿主（`has`/`count`）。 */
  dynamic: DynamicHost = { has: () => false, count: () => Num.fromNumber(0) }

  /** 离线标记（8.8）：为真时随机函数不可用（PRD 补充 1）。 */
  offline = false

  /** 当前逻辑帧序号。 */
  private currentTick = 0

  private readonly evaluators = new Map<Context, Evaluator>()

  constructor() {
    for (const context of CONTEXTS) {
      this.evaluators.set(
        context,
        new Evaluator(
          context,
          {
            read: (key) => this.readImpl(key),
            emit: (kind, payload, expr) => this.sink.emit(kind, payload, expr),
            dynamic: {
              has: (kind, id) => this.dynamic.has(kind, id),
              count: (kind) => this.dynamic.count(kind),
            },
            // 5.6：某条表达式求值抛错时，丢弃它**已经收集**的全部副作用（含 `effValue` 写回），
            // 其它表达式已收集的不受影响。接线到 `EffectSink.rollbackCurrent()`。
            rollbackCurrentBucket: () => this.sink.rollbackCurrent(),
          },
          0,
        ),
      )
    }
  }

  /** 把属性存储接进来（`GameState` 构造时调用一次）。 */
  attachStore(store: AttributeStore): void {
    this.readImpl = store.read
  }

  /** 取某个上下文的求值器。 */
  evaluator(context: ContextKind): Evaluator {
    const found = this.evaluators.get(context as Context)
    if (!found) throw new ForgeError('E_TYPE', { message: `未知上下文 ${context}` })
    return found
  }

  // -------------------------------------------------------------------------
  // 每 tick 归零（8.3 第 1 步）
  // -------------------------------------------------------------------------

  /**
   * 每 tick 归零：清空记忆化与配额，刷新随机上下文。
   *
   * 随机源由 `tick` 派生（`createRandomSource`），因此同 tick 内所有求值取到同一条序列，
   * 跨 tick 则不同——“随机”因此是确定性的、可复现的。
   */
  beginTick(tick: number, offline: boolean): void {
    this.currentTick = tick
    this.offline = offline
    for (const evaluator of this.evaluators.values()) evaluator.beginTick(tick)
  }

  /** 清除副作用队列（`reset()` / 卸载项目，5.6「清空队列」）。 */
  resetSink(): void {
    this.sink.reset()
  }

  /** 当前 tick 序号。 */
  tick(): number {
    return this.currentTick
  }

  /**
   * 丢弃本 tick 的表达式缓存（`ExpressionHost` 的实现，由 `AttributeStore.bump` 调用）。
   *
   * 所有上下文都要清：写入改的是**存储**，而每个上下文（`price`/`production`/
   * `condition`/`field`）都可能是读那条存储的那条表达式。少清一个就会出现
   * “价格刷新了但条件还是旧值”这种半新半旧的状态。
   */
  invalidateExpressions(): void {
    for (const evaluator of this.evaluators.values()) evaluator.invalidateCache()
  }

  /** 本 tick 的求值次数合计（诊断面板，12 性能预算）。 */
  evaluations(): number {
    let total = 0
    for (const evaluator of this.evaluators.values()) total += evaluator.evaluations()
    return total
  }

  /**
   * 本 tick 命中 tick 缓存的次数合计（12 性能预算「缓存命中率」）。
   *
   * 与 `evaluations()` 一起构成命中率：`hits / (hits + evaluations)`。必须成对使用——
   * 单独看 `hits` 没有意义（命中越多说明算得越少，也说明缓存越有效，两者都要）。
   */
  cacheHits(): number {
    let total = 0
    for (const evaluator of this.evaluators.values()) total += evaluator.cacheHits()
    return total
  }

  /** 本 tick 是否有任一上下文耗尽了求值预算（5.7 配额、`E_BUDGET`）。 */
  budgetExhausted(): boolean {
    for (const evaluator of this.evaluators.values()) {
      if (evaluator.isBudgetExhausted()) return true
    }
    return false
  }

  /** 随机源：离线时给的是“必抛 `E_RAND_DISABLED`”的实现（PRD 补充 1、8.8）。 */
  randomSource(salt = 0): FunctionCallContext['random'] {
    return this.offline ? createOfflineRandomSource() : createRandomSource(this.currentTick, salt)
  }

  /** 函数调用上下文：随机源、动态条目宿主、副作用登记（5.6）。 */
  callContext(salt = 0): Omit<FunctionCallContext, 'context'> {
    return {
      offline: this.offline,
      random: this.randomSource(salt),
      dynamic: this.dynamic,
      emit: (kind, payload, expr) => this.sink.emit(kind, payload, expr),
    }
  }

  // -------------------------------------------------------------------------
  // 求值
  // -------------------------------------------------------------------------

  /**
   * 通用求值入口（保留 last-good / 预算 / 循环检测的原始结果）。
   *
   * `options.scope` 是**就地复用**而非拷贝：`Evaluator.evaluate` 在求值结束后把
   * `effValue` / `effValueAssigned` 回写到这个对象上（8.7 的“写回登记”）。若在这里
   * 展开成新对象，回写就落在临时副本上，`runEffectAction` 永远看不到
   * `effValueAssigned` —— 表现为“升级的 `effectValues[i]` 永远是 0”，而且不报任何错。
   */
  evaluate(text: string, context: ContextKind, options: EvaluateOptions = {}) {
    const scope = (options.scope ?? {}) as Record<string, unknown>
    scope['call'] = { context, ...this.callContext() }
    if (options.read) scope['read'] = options.read
    return this.evaluator(context).evaluate(text, scope as never, options.overlayKey ?? '')
  }

  /**
   * 求值成数值（`ExpressionHost` 的实现）。
   *
   * 失败时抛错由调用方决定怎么处理——`evaluateNumber` 供 `AttributeStore` 用，
   * 它把“文本型字段求值失败”交给 last-good 机制（D-07）。
   *
   * @param options 8.6.1 的只读等级视图（`read` 与 `overlayKey` **必须成对传入**）
   */
  evaluateNumber(text: string, context: ContextKind, where: string, options?: EvaluateOptions): Decimal {
    const result = this.evaluate(text, context, options)
    const value = result.value
    if (typeof value === 'object' && value !== null && typeof (value as Decimal).cmp === 'function') {
      return value as Decimal
    }
    // 条件类表达式可能返回布尔：`true` 参与数值运算按 1、`false` 按 0。
    if (typeof value === 'boolean') return Num.fromNumber(value ? 1 : 0)
    throw new ForgeError('E_TYPE', { where, message: `表达式结果不是数值（收到 ${typeof value}）` })
  }

  /** 求值成布尔（条件/效果前提）。last-good 或类型不符时按“前提不成立”处理（8.7）。 */
  evaluateBoolean(text: string, context: ContextKind, where: string, options?: EvaluateOptions): boolean {
    const result = this.evaluate(text, context, options)
    const value = result.value
    if (typeof value === 'boolean') return value
    if (typeof value === 'object' && value !== null && typeof (value as Decimal).cmp === 'function') {
      return !(value as Decimal).eq(0)
    }
    throw new ForgeError('E_TYPE', { where, message: `表达式结果不是布尔（收到 ${typeof value}）` })
  }

  // -------------------------------------------------------------------------
  // 升级效果（8.7）
  // -------------------------------------------------------------------------

  /**
   * 在独立分桶里求值一条效果的动作（8.7 伪码的 `run(e.action, ctx=effect)` + `commitEffValue`）。
   *
   * 分桶的“同生共死”在这里落地：`action` 抛错时求值器已经回滚了整个桶
   * （`rollbackCurrentBucket`），因此 `commitEffValue` 只在**成功**时登记；
   * 未对 `effValue` 赋值则**不登记**、也不递增该属性 `version`（8.7、5.6）。
   *
   * @param effectValuePath 该效果的 `up.<id>.effectValues[i]` 路径（写回目标）
   * @param current 该效果当前持久化的数值（载入为 `effValue` 的初值）
   * @returns 本次求值是否成功（失败时调用方应把该效果视为“未生效”）
   */
  runEffectAction(label: string, text: string, effectValuePath: string, current: Decimal): { ok: boolean; effValue: Decimal } {
    const bucket = this.sink.startBucket(label)
    const scope: { effValue: Decimal; effValueAssigned?: boolean } = { effValue: current }
    try {
      const result = this.evaluate(text, 'effect', { scope })
      if (result.lastGood) {
        // 桶已由求值器回滚（或因预算耗尽根本没跑）：不登记写回。
        return { ok: false, effValue: current }
      }
      bucket.commitEffValue(scope.effValueAssigned === true, effectValuePath, scope.effValue ?? current)
      return { ok: true, effValue: scope.effValue ?? current }
    } finally {
      this.sink.endBucket()
    }
  }

  /** 副作用提交（8.3 第 6 步）：把队列按顺序交给宿主应用。 */
  commit(apply: (effect: Effect, bucket: EffectBucket) => void): number {
    return this.sink.commit(apply)
  }

  /** `create()` 的 spec 常量（编译期已折叠，原样透传，8.7「字段形态」）。 */
  static specOf(value: Value): ConstantObject | undefined {
    return typeof value === 'object' && value !== null && !('cmp' in value) ? (value as ConstantObject) : undefined
  }
}

export { EffectSink }
