/**
 * 数值层性能基准（TECH_DESIGN 12 性能预算）。
 *
 * 预算：格式化 >= 10000 次/s、单 tick 运算 p95 < 4ms。
 * 用 `bench()` 而非 `it()`，只在 `vitest bench` 下运行；阈值回归在 M5 接入 CI（14.3）。
 */
import { Decimal, NUM_MAX, Num, format, resetFormatCache } from '@iforge/num'
import { bench, describe } from 'vitest'

describe('格式化（4.5：目标 >= 10000 次/s）', () => {
  bench('缓存命中（同一数值重复格式化）', () => {
    resetFormatCache()
    const value = Decimal.fromString('1.2345e678')
    for (let i = 0; i < 20_000; i += 1) format(value, 'standard')
  })

  bench('缓存未命中（遍历不同数值）', () => {
    resetFormatCache()
    for (let i = 0; i < 5_000; i += 1) format(Decimal.fromString(`1.${i}e${i}`), 'standard')
  })

  bench('五种格式各格式化一次', () => {
    const value = Decimal.fromString('1.2345e678')
    for (let i = 0; i < 5_000; i += 1) {
      format(value, 'standard')
      format(value, 'scientific')
      format(value, 'engineering')
      format(value, 'letters')
      format(value, 'layered')
    }
  })
})

describe('大数运算（4.2 分层表示 / 4.4 饱和）', () => {
  bench('1e1e10 量级乘加', () => {
    const big = Decimal.fromString('1e1e10')
    for (let i = 0; i < 10_000; i += 1) {
      Num.mul(big, Decimal.fromString('1.15'))
      Num.add(big, Decimal.fromNumber(1))
    }
  })

  bench('饱和边界运算（NUM_MAX 参与的钳制路径）', () => {
    for (let i = 0; i < 10_000; i += 1) {
      Num.mul(NUM_MAX, Decimal.fromNumber(2))
      Num.pow(NUM_MAX, Decimal.fromNumber(2))
    }
  })

  bench('比较与取整', () => {
    const a = Decimal.fromString('1e1e10')
    for (let i = 0; i < 10_000; i += 1) {
      Num.cmp(a, Decimal.fromString('1e1e9'))
      Num.floor(a)
      Num.round(a)
    }
  })
})
