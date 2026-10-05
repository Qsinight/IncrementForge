/**
 * 性能基准（TECH_DESIGN 12 性能预算）。
 *
 * 目标值与手段：
 * | 指标 | 目标 | 手段 |
 * | 单 tick（200 生成器 + 100 升级 + 50 资源） | p95 < 4ms | tick 记忆化 + 版本号脏标记 + 稳定排序 + 预编译闭包 |
 * | 表达式编译 | < 1ms/条，缓存命中 ~0 | 编译缓存（8192）+ 常量折叠 |
 * | 表达式求值预算 | 20000 次/tick | 硬上限 + 诊断告警 |
 * | 格式化 | >= 10000 次/s | LRU 缓存 |
 *
 * 本文件用 `bench()` 而非 `it()`，因此只在 `vitest bench` 下运行（`vitest.config.ts`
 * 已把 `*.bench.ts` 排除在单测之外）。M1 不设硬阈值——阈值回归由 M5 的 `bench:ci`
 * 接入 CI 门禁（14.3）。
 */
import { Decimal, Num, format, resetFormatCache } from '@iforge/num'
import { bench, describe } from 'vitest'

import type { Value } from '../src/ast.js'
import { EffectSink } from '../src/effects.js'
import { Evaluator, resetCompileCache } from '../src/evaluator.js'

const num = (n: number): Decimal => Num.fromNumber(n)

describe('表达式编译', () => {
  const sources = Array.from({ length: 200 }, (_, i) => `10 * 1.15 ^ gen.g${i}.bought + res.r1.amount`)

  bench('编译（缓存未命中）', () => {
    const evaluator = new Evaluator('price', { read: () => num(0), emit: () => num(0) })
    for (const source of sources) {
      resetCompileCache()
      evaluator.compile(source)
    }
  })

  bench('编译缓存命中', () => {
    const evaluator = new Evaluator('price', { read: () => num(0), emit: () => num(0) })
    for (const source of sources) evaluator.compile(source)
    for (const source of sources) evaluator.compile(source)
  })
})

describe('单 tick 求值（200 生成器 + 100 升级 + 50 资源）', () => {
  bench('产出/效果/资源全量求值', () => {
    resetCompileCache()
    const values = new Map<string, Decimal | string>()
    for (let i = 0; i < 50; i += 1) values.set(`res.r${i}.amount`, num(10 ** i))
    for (let i = 0; i < 200; i += 1) {
      values.set(`gen.g${i}.bought`, num(i))
      // `produces[i].amount` 是表达式文本属性，真实值是字符串（6.2）。
      values.set(`gen.g${i}.produces[0].amount`, '1')
    }
    for (let i = 0; i < 100; i += 1) values.set(`up.u${i}.owned`, num(i))

    const sink = new EffectSink()
    const read = (key: string): Value => values.get(key) ?? num(0)
    const evaluator = new Evaluator('production', {
      read,
      emit: (kind, payload, expr) => sink.emit(kind, payload, expr),
      rollbackCurrentBucket: () => sink.rollbackCurrent(),
    })

    evaluator.beginTick(1)
    for (let i = 0; i < 200; i += 1) {
      sink.startBucket(`gen.g${i}`)
      evaluator.evaluate(`gen.g${i}.owned * gen.g${i}.produces[0].amount`)
      sink.endBucket()
    }
    for (let i = 0; i < 100; i += 1) {
      sink.startBucket(`up.u${i}#effects[0]`)
      evaluator.evaluate(`effValue = 1.15 ^ gen.g${i}.bought * up.u${i}.owned`, { effValue: num(0) })
      sink.endBucket()
    }
    for (let i = 0; i < 50; i += 1) evaluator.evaluate(`res.r${i}.amount * 1.1`)
    sink.commit(() => {})
  })
})

describe('只读等级视图（8.6.1）', () => {
  const PRICE = '10 * 1.15 ^ gen.g1.bought'

  bench('批量求解 20 个等级（缓存键按覆盖层隔离）', () => {
    resetCompileCache()
    const evaluator = new Evaluator('price', { read: () => num(0), emit: () => num(0) })
    evaluator.beginTick(1)
    for (let j = 0; j < 20; j += 1) {
      evaluator.evaluate(PRICE, {}, `gen.g1.bought=${j}`)
    }
  })
})

describe('格式化（4.5 LRU 缓存）', () => {
  bench('缓存命中', () => {
    resetFormatCache()
    const value = Decimal.fromString('1.2345e678')
    for (let i = 0; i < 20_000; i += 1) format(value, 'standard')
  })

  bench('缓存未命中（遍历不同数值）', () => {
    resetFormatCache()
    for (let i = 0; i < 5_000; i += 1) format(Decimal.fromString(`1.${i}e${i}`), 'standard')
  })
})

describe('大数运算（4.2 / 4.4 饱和）', () => {
  bench('1e1e10 量级乘加', () => {
    const big = Decimal.fromString('1e1e10')
    for (let i = 0; i < 10_000; i += 1) {
      Num.mul(big, Decimal.fromString('1.15'))
      Num.add(big, Decimal.fromNumber(1))
    }
  })
})
