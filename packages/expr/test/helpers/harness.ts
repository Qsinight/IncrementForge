/**
 * 求值夹具：把 `Evaluator` + `EffectSink` + `FixtureStore` 组装成可断言的最小运行时。
 *
 * 覆盖 5.7 的记忆化 / 循环检测 / last-good / 预算，以及 5.6 的分桶提交与回滚。
 */
import { Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'

import type { ContextKind, Effect, Value } from '../../src/ast.js'
import { EffectSink } from '../../src/effects.js'
import { Evaluator } from '../../src/evaluator.js'

import type { DynamicHost } from '../../src/functions.js'
import { FixtureStore } from './fixture-store.js'

export interface HarnessOptions {
  context?: ContextKind
  entries?: Record<string, Value>
  readOverride?: (key: string) => Value | undefined
  dynamic?: DynamicHost
}

/** 求值夹具。 */
export class Harness {
  readonly store: FixtureStore
  readonly sink = new EffectSink()
  readonly evaluator: Evaluator
  /** 已提交的副作用（提交阶段按顺序应用的结果）。 */
  readonly applied: Effect[] = []
  /** 离线标记（8.8）。 */
  offline = false

  constructor(options: HarnessOptions = {}) {
    const context = options.context ?? 'field'
    this.store = new FixtureStore({ context, entries: options.entries, readOverride: options.readOverride })
    this.evaluator = new Evaluator(context, {
      read: (key) => this.store.read(key),
      emit: (kind, payload, expr) => this.sink.emit(kind, payload, expr),
      // 5.6：表达式求值抛错时回滚该表达式已收集的全部副作用。
      rollbackCurrentBucket: () => this.sink.rollbackCurrent(),
      ...(options.dynamic ? { dynamic: options.dynamic } : {}),
    })
  }

  /** 每 tick 归零（8.3 第 1 步）。 */
  beginTick(tick: number): void {
    this.evaluator.beginTick(tick)
  }

  /** 求值一条表达式。 */
  evaluate(text: string, scope: Record<string, unknown> = {}, overlayKey = ''): Value {
    return this.evaluator.evaluate(text, scope, overlayKey).value
  }

  /**
   * 带分桶的求值（模拟一条升级效果：条件 + 动作，8.7）。
   *
   * 求值成功后按 8.7 的伪码登记 `effValue` 写回：`effValueAssigned` 为真才登记，
   * 否则**不登记、也不递增 `version`**。
   */
  evaluateEffect(label: string, text: string, scope: Record<string, unknown> = {}): Value {
    const bucket = this.sink.startBucket(label)
    try {
      const value = this.evaluator.evaluate(text, scope).value
      const assigned = scope['effValueAssigned'] === true
      bucket.commitEffValue(assigned, 'up.u1.effectValues[0]', (scope['effValue'] as Decimal) ?? Num.fromNumber(0))
      return value
    } finally {
      this.sink.endBucket()
    }
  }

  /** 提交阶段（8.3 第 6 步）：把队列交给宿主应用。 */
  commit(): number {
    return this.sink.commit((effect) => {
      this.applied.push(effect)
    })
  }

  /** 只读等级视图（8.6.1）：把 `targetKey` 的读取值覆盖为 `level`，不改存储。 */
  levelOverlay(targetKey: string, level: Decimal): { read: (key: string) => Value; key: string } {
    return {
      read: (key: string) => (key === targetKey ? level : this.store.read(key)),
      key: `${targetKey}=${level.toString()}`,
    }
  }
}
