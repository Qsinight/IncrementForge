/**
 * `@iforge/num` 数值层的饱和语义用例。
 *
 * 覆盖 4.4 的六条规则与 14.2「数值饱和边界」用例；PRD 核心功能 1「安全的四则/指对运算，
 * 能够在指数级乃至幂塔级数量运算中防止上下溢出」的验收落点。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  Decimal,
  Diagnostics,
  NUM_INF,
  NUM_MAX,
  NUM_MAX_LAYER,
  Num,
  applyCap,
  clampLower0,
  clampQuantity,
  isFinite,
  isInf,
  isNaN,
  isSaturated,
  normalizeCap,
  saturate,
} from '../src/index.js'

const d = (text: string) => Decimal.fromString(text)

/** `Decimal` 没有 `isZero()` 实例方法，统一走本包导出的 `Num.isZero`（4.3 比较 API）。 */
const isZero = (value: Decimal) => Num.isZero(value)

/** `NaN` 只能由算术产生（`Decimal.fromString('0/0')` 会得到 0 而不是 NaN）。 */
const nan = () => Num.div(d('0'), d('0'))

beforeEach(() => {
  Num.resetDiagnostics()
})

describe('4.2 分层表示', () => {
  it('L0/L1/L2/L3+ 四层都可构造、比较与序列化', () => {
    const l0 = d('1e15')
    const l1 = d('1e1e10')
    const l2 = d('1e1e1e10')
    const l3 = d('1e1e1e1e10')
    for (const value of [l0, l1, l2, l3]) {
      expect(value.isFinite()).toBe(true)
      expect(value.toString()).not.toContain('NaN')
    }
    expect(l0.lt(l1)).toBe(true)
    expect(l1.lt(l2)).toBe(true)
    expect(l2.lt(l3)).toBe(true)
  })

  it('1e1e10 量级可参与四则运算（PRD 补充 2）', () => {
    const a = d('1e1e10')
    expect(Num.mul(a, d('2')).gt(a)).toBe(true)
    expect(Num.div(a, d('2')).lt(a)).toBe(true)
    expect(Num.add(a, a).eq(Num.mul(a, d('2')))).toBe(true)
    expect(isZero(Num.sub(a, a))).toBe(true)
  })
})

describe('4.4 第 1 条：饱和上界', () => {
  it('NUM_MAX = 10 ↑↑ 1e15 可构造且层数不超过 NUM_MAX_LAYER', () => {
    expect(NUM_MAX.isFinite()).toBe(true)
    expect(NUM_MAX.layer).toBeLessThanOrEqual(NUM_MAX_LAYER)
    expect(NUM_MAX.gt(d('1e1e1e10'))).toBe(true)
  })

  it('NUM_MAX 参与运算后饱和为自身并置标记', () => {
    const results = [Num.add(NUM_MAX, d('1')), Num.mul(NUM_MAX, d('2')), Num.pow(NUM_MAX, d('2'))]
    for (const result of results) {
      expect(result.eq(NUM_MAX)).toBe(true)
      expect(isSaturated(result)).toBe(true)
    }
  })

  it('超出上界的值一律钳到 NUM_MAX，不抛异常（D-02）', () => {
    // `NUM_MAX` 之上没有可表示的层数：库把任何更高的层数压回上界，
    // 因此“层数达到上界”即等价于“已饱和”，这也是 `saturate` 用 `gte` 判定的依据。
    // 注意 `1e1e1e10 × 1e1e1e10` 只到 layer 2，离上界的 layer 1e15 差 13 个数量级，不触发饱和。
    const result = Num.pow(NUM_MAX, NUM_MAX)
    expect(result.eq(NUM_MAX)).toBe(true)
    expect(isSaturated(result)).toBe(true)
    expect(() => Num.pow(d('1e1e1e10'), d('1e1e1e10'))).not.toThrow()
    expect(Num.mul(d('1e1e1e10'), d('1e1e1e10')).layer).toBe(2)
  })

  it('饱和值参与购买/价格求解类运算时结果仍有限且不超时', () => {
    // 对应 14.2「饱和值参与购买/产出/价格求解时结果有限且不超时」。
    const price = Num.mul(NUM_MAX, d('1.15'))
    expect(isFinite(price)).toBe(true)
    const rate = Num.div(NUM_MAX, d('20'))
    expect(isFinite(rate)).toBe(true)
  })
})

describe('4.4 第 2 条：饱和下界与数量类下限', () => {
  it('数量类结果小于零被 clampLower0 截断为 0（PRD 补充 3）', () => {
    expect(isZero(clampLower0(d('-5')))).toBe(true)
    expect(isZero(clampLower0(d('0')))).toBe(true)
    expect(clampLower0(d('5')).toNumber()).toBe(5)
  })

  it('纯数学结果下溢到 1e-323 以下时饱和为 0（4.4 第 2 条）', () => {
    // 库把 1e-600 保留为 layer 1 的负指数（不是 0），由 `saturate` 的量级判定钳到 0。
    const tiny = Num.mul(d('1e-300'), d('1e-300'))
    expect(isZero(tiny)).toBe(true)
    expect(isSaturated(tiny)).toBe(true)
    expect(Diagnostics.count('E_UNDERFLOW')).toBeGreaterThan(0)
  })

  it('库直接返回精确 0 的函数下溢同样被标记（exp(-1e308)）', () => {
    Num.resetDiagnostics()
    const tiny = Num.exp(d('-1e308'))
    expect(isZero(tiny)).toBe(true)
    expect(Diagnostics.count('E_UNDERFLOW')).toBeGreaterThan(0)
  })

  it('本身为 0 的运算不算下溢（不误报 E_UNDERFLOW）', () => {
    Num.resetDiagnostics()
    Num.mul(d('0'), d('5'))
    Num.mul(d('0'), d('0'))
    expect(Diagnostics.count('E_UNDERFLOW')).toBe(0)
  })

  it('clampLower0 不改写已饱和的值语义（饱和标记仍可观测）', () => {
    const negative = clampLower0(d('-1'))
    expect(isSaturated(negative)).toBe(true)
  })
})

describe('4.4 第 3 条：饱和标记可观测', () => {
  it('溢出记 E_OVERFLOW、下溢记 E_UNDERFLOW，且不抛异常', () => {
    Num.resetDiagnostics()
    Num.mul(NUM_MAX, d('2'))
    expect(Diagnostics.count('E_OVERFLOW')).toBe(1)
    Num.mul(d('1e-300'), d('1e-300'))
    expect(Diagnostics.count('E_UNDERFLOW')).toBe(1)
    expect(Diagnostics.total()).toBe(2)
  })

  it('resetDiagnostics 同时清空计数与饱和标记', () => {
    const saturated = Num.mul(NUM_MAX, d('2'))
    expect(isSaturated(saturated)).toBe(true)
    Num.resetDiagnostics()
    expect(Diagnostics.total()).toBe(0)
    expect(isSaturated(saturated)).toBe(false)
  })

  it('饱和标记挂在值上而非全局，不会污染未饱和的值', () => {
    const saturated = Num.mul(NUM_MAX, d('2'))
    const normal = Num.mul(d('2'), d('3'))
    expect(isSaturated(saturated)).toBe(true)
    expect(isSaturated(normal)).toBe(false)
  })
})

describe('4.4 第 4 条：数量上限', () => {
  it('max <= 0 按 1 处理并记 E_CAP_NON_POSITIVE', () => {
    expect(normalizeCap(d('0')).toNumber()).toBe(1)
    expect(normalizeCap(d('-100')).toNumber()).toBe(1)
    expect(Diagnostics.count('E_CAP_NON_POSITIVE')).toBe(2)
  })

  it('max 求值为 NaN（0/0）时同样按 1 处理', () => {
    expect(isNaN(nan())).toBe(true)
    expect(normalizeCap(nan()).toNumber()).toBe(1)
    expect(Diagnostics.count('E_CAP_NON_POSITIVE')).toBe(1)
  })

  it('applyCap 取 min(value, max)', () => {
    const cap = normalizeCap(d('100'))
    expect(applyCap(d('50'), cap).toNumber()).toBe(50)
    expect(applyCap(d('500'), cap).toNumber()).toBe(100)
  })

  it('clampQuantity 组合下界与上限（PRD 补充 3）', () => {
    const cap = normalizeCap(d('100'))
    expect(isZero(clampQuantity(d('-5'), cap))).toBe(true)
    expect(clampQuantity(d('500'), cap).toNumber()).toBe(100)
    expect(clampQuantity(d('42'), cap).toNumber()).toBe(42)
  })
})

describe('4.4 第 5 条：取整退化（R-02）', () => {
  it('超过 MAX_SAFE_INTEGER 的值取整后返回自身', () => {
    const big = d('1e1e10')
    expect(Num.floor(big)).toBe(big)
    expect(Num.ceil(big)).toBe(big)
    expect(Num.round(big)).toBe(big)
    expect(Num.trunc(big)).toBe(big)
  })

  it('安全范围内仍正常取整', () => {
    expect(Num.floor(d('2.7')).toNumber()).toBe(2)
    expect(Num.ceil(d('2.1')).toNumber()).toBe(3)
    expect(Num.round(d('2.5')).toNumber()).toBe(3)
    expect(Num.trunc(d('-2.7')).toNumber()).toBe(-2)
  })
})

describe('4.4 第 6 条：Infinity 字面量与“无上限”（D-46）', () => {
  it('NUM_INF 作为 max 时 applyCap 完全跳过钳制', () => {
    expect(isInf(NUM_INF)).toBe(true)
    expect(applyCap(d('1e1e10'), NUM_INF).eq(d('1e1e10'))).toBe(true)
  })

  it('isInf(max) 与 max === NUM_MAX 两种写法效果一致', () => {
    const value = d('1e1e10')
    expect(applyCap(value, NUM_INF).eq(applyCap(value, normalizeCap(NUM_MAX)))).toBe(true)
  })

  it('NUM_INF 参与算术折算为 NUM_MAX 并打标记', () => {
    const sum = Num.add(d('1'), NUM_INF)
    expect(sum.eq(NUM_MAX)).toBe(true)
    expect(isSaturated(sum)).toBe(true)
    const diff = Num.sub(d('1'), NUM_INF)
    expect(isZero(diff)).toBe(true)
    expect(isSaturated(diff)).toBe(true)
  })

  it('NUM_INF 比较时等同 +∞，不折算不饱和', () => {
    expect(NUM_INF.gt(d('1e1e10'))).toBe(true)
    expect(d('1e1e10').lt(NUM_INF)).toBe(true)
    expect(NUM_INF.lt(NUM_INF)).toBe(false)
    expect(NUM_INF.gte(NUM_INF)).toBe(true)
  })

  it('normalizeCap 对 NUM_INF 原样返回，不误报 E_CAP_NON_POSITIVE', () => {
    expect(normalizeCap(NUM_INF)).toBe(NUM_INF)
    expect(Diagnostics.count('E_CAP_NON_POSITIVE')).toBe(0)
  })

  it('NaN 不是 Inf', () => {
    expect(isInf(nan())).toBe(false)
    expect(isNaN(nan())).toBe(true)
  })
})

describe('4.3 比较与算术', () => {
  it('比较全部走 Decimal.cmp，不使用 JS number（R-02）', () => {
    expect(Num.cmp(d('1e1e10'), d('1e1e10'))).toBe(0)
    expect(Num.cmp(d('1'), d('2'))).toBe(-1)
    expect(Num.cmp(d('1e1e10'), d('1'))).toBe(1)
    expect(Num.eq(d('5'), d('5'))).toBe(true)
    expect(Num.lte(d('5'), d('5'))).toBe(true)
  })

  it('sign / abs / neg', () => {
    expect(Num.sign(d('-5'))).toBe(-1)
    expect(Num.sign(d('0'))).toBe(0)
    expect(Num.sign(d('5'))).toBe(1)
    expect(Num.abs(d('-5')).toNumber()).toBe(5)
    expect(Num.neg(d('5')).toNumber()).toBe(-5)
  })

  it('对数与指数（pow 支持分层指数）', () => {
    expect(Num.pow(d('10'), d('3')).toNumber()).toBe(1000)
    expect(Num.ln(d('1')).toNumber()).toBe(0)
    expect(Num.log10(d('1000')).toNumber()).toBe(3)
    expect(Num.log(d('8'), d('2')).toNumber()).toBe(3)
    expect(Num.sqrt(d('16')).toNumber()).toBe(4)
    expect(Num.exp(d('0')).toNumber()).toBe(1)
  })

  it('min / max / clamp / lerp（变参走 Decimal.cmp）', () => {
    expect(Num.min(d('3'), d('1'), d('2')).toNumber()).toBe(1)
    expect(Num.max(d('3'), d('1'), d('2')).toNumber()).toBe(3)
    expect(Num.clamp(d('5'), d('1'), d('3')).toNumber()).toBe(3)
    expect(Num.lerp(d('0'), d('10'), d('0.5')).toNumber()).toBe(5)
  })

  it('mod 与除零行为被饱和吸收，不抛异常', () => {
    expect(Num.mod(d('7'), d('3')).toNumber()).toBe(1)
    expect(() => Num.div(d('1'), d('0'))).not.toThrow()
  })

  it('pow 的指数可以是分层数值（4.2 L2/L3+）', () => {
    const result = Num.pow(d('10'), d('1e10'))
    expect(result.gt(d('1e1e9'))).toBe(true)
  })
})

describe('4.3 转换', () => {
  it('toNumber 在超界时夹到 ±Number.MAX_VALUE 并置饱和标记（4.3）', () => {
    expect(Num.toNumber(d('1e1e10'))).toBe(Number.MAX_VALUE)
    expect(Num.toNumber(d('-1e1e10'))).toBe(-Number.MAX_VALUE)
    expect(Diagnostics.count('E_OVERFLOW')).toBeGreaterThan(0)
  })

  it('isSafeNumber 区分可安全转换的值', () => {
    expect(Num.isSafeNumber(d('100'))).toBe(true)
    expect(Num.isSafeNumber(d('1e1e10'))).toBe(false)
  })

  it('requireSafeNumber 对不安全值抛 E_TYPE', () => {
    expect(() => Num.requireSafeNumber(d('1e1e10'))).toThrowError(/类型不匹配|数值/)
    expect(Num.requireSafeNumber(d('42'))).toBe(42)
  })
})

describe('4.4 saturate 的显式入口', () => {
  it('saturate 不改变已饱和的值语义', () => {
    const result = saturate(d('1e1e10'))
    expect(result.eq(d('1e1e10'))).toBe(true)
    expect(isSaturated(result)).toBe(false)
  })

  it('saturate 处理无穷输入', () => {
    expect(saturate(NUM_INF).eq(NUM_MAX)).toBe(true)
  })
})
