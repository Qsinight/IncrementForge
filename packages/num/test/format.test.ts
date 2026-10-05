/**
 * `@iforge/num` 显示格式化用例（TECH_DESIGN 4.5、D-17）。
 *
 * 覆盖五种格式枚举、`NUM_INF` 的无穷输出，以及 14.2「格式化缓存键」用例
 * （负值、0、饱和值、mantissa 相同但 layer 不同的值互不命中彼此缓存条目）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { Decimal, NUM_INF, NUM_MAX, NUMBER_FORMATS, format, formatCacheSize, resetFormatCache } from '../src/index.js'

const d = (text: string) => Decimal.fromString(text)
const fmt = (text: string, formatName: (typeof NUMBER_FORMATS)[number]) => format(d(text), formatName)

beforeEach(() => {
  resetFormatCache()
})

describe('4.5 standard（默认格式）', () => {
  it('小于 1e6 用定点表示', () => {
    expect(fmt('0', 'standard')).toBe('0')
    expect(fmt('1', 'standard')).toBe('1')
    expect(fmt('42', 'standard')).toBe('42')
    expect(fmt('0.5', 'standard')).toBe('0.5')
    expect(fmt('1234.5678', 'standard')).toBe('1234.57')
  })

  it('整数不补小数位（4.5「小于 1e6 直接整数」）', () => {
    expect(fmt('1500', 'standard')).toBe('1500')
    expect(fmt('999999', 'standard')).toBe('999999')
  })

  it('1e6 起按量级切换 K/M/B/T/Qa/Qi', () => {
    expect(fmt('1.5e6', 'standard')).toBe('1.5M')
    expect(fmt('2.3e9', 'standard')).toBe('2.3B')
    expect(fmt('1e12', 'standard')).toBe('1T')
    expect(fmt('1e15', 'standard')).toBe('1Qa')
    expect(fmt('1e18', 'standard')).toBe('1Qi')
  })

  it('后缀表用尽后切科学计数', () => {
    expect(fmt('1e33', 'standard')).toBe('1Dc')
    expect(fmt('1e36', 'standard')).toBe('1e36')
  })

  it('小于 1e-3 走科学计数，避免定点压成 0.00', () => {
    expect(fmt('0.000123', 'standard')).toBe('1.23e-4')
    expect(fmt('1e-5', 'standard')).toBe('1e-5')
  })

  it('负数带符号且不重复前缀', () => {
    expect(fmt('-1500', 'standard')).toBe('-1500')
    expect(fmt('-1.5e6', 'standard')).toBe('-1.5M')
  })

  it('幂塔级走分层记法', () => {
    expect(fmt('1e1e10', 'standard')).toBe('1e10000000000')
    expect(fmt('1e1e1e10', 'standard')).toBe('1e2e10000000000')
  })
})

describe('4.5 scientific', () => {
  it('统一科学计数', () => {
    expect(fmt('1234.5678', 'scientific')).toBe('1.23e3')
    expect(fmt('1.5e6', 'scientific')).toBe('1.5e6')
    expect(fmt('0.000123', 'scientific')).toBe('1.23e-4')
    expect(fmt('-1500', 'scientific')).toBe('-1.5e3')
  })

  it('尾数进位到 10 时同步抬指数（999999 -> 1e6）', () => {
    expect(fmt('999999', 'scientific')).toBe('1e6')
    expect(fmt('9999.99', 'scientific')).toBe('1e4')
  })
})

describe('4.5 engineering', () => {
  it('指数取 3 的倍数', () => {
    expect(fmt('1234.5678', 'engineering')).toBe('1.23e3')
    expect(fmt('1.23e456', 'engineering')).toBe('1.23e456')
    // 1500 的自然指数是 3，本身已是 3 的倍数，尾数落在 [1,1000) 内故不再放大。
    expect(fmt('1500', 'engineering')).toBe('1.5e3')
    expect(fmt('-1500', 'engineering')).toBe('-1.5e3')
    // 指数 4/5 会被压到 3，尾数相应放大到 [1,1000)。
    expect(fmt('12345', 'engineering')).toBe('12.34e3')
  })
})

describe('4.5 letters', () => {
  it('字母记数 A/B/…/Z/Za', () => {
    expect(fmt('1.5e3', 'letters')).toBe('1.5A')
    expect(fmt('2.3e6', 'letters')).toBe('2.3B')
    expect(fmt('1e9', 'letters')).toBe('1C')
    expect(fmt('1.1e78', 'letters')).toBe('1.1Z')
    expect(fmt('1.1e81', 'letters')).toBe('1.1Za')
  })

  it('小于 1e3 回落到 standard', () => {
    expect(fmt('0.5', 'letters')).toBe('0.5')
    expect(fmt('1234.5678', 'letters')).toBe('1.23A')
  })
})

describe('4.5 layered', () => {
  it('flat 值按单层塔表示', () => {
    expect(fmt('1234.5678', 'layered')).toBe('1.23e3')
    expect(fmt('1e1e10', 'layered')).toBe('1e10000000000')
  })

  it('layer >= 2 带层数', () => {
    expect(fmt('1e1e1e10', 'layered')).toBe('1e2e10000000000')
  })
})

describe('4.4 第 6 条 + 4.5：特殊值', () => {
  it('NUM_INF 五种格式统一输出无穷号', () => {
    for (const name of NUMBER_FORMATS) {
      expect(format(NUM_INF, name)).toBe('\u221e')
    }
  })

  it('NaN 不抛异常且输出 NaN', () => {
    const nan = d('0').div(d('0'))
    for (const name of NUMBER_FORMATS) {
      expect(format(nan, name)).toBe('NaN')
    }
  })

  it('NUM_MAX 五种格式都不抛异常、不输出 NaN/undefined（14.2 饱和边界）', () => {
    for (const name of NUMBER_FORMATS) {
      const text = format(NUM_MAX, name)
      expect(text).not.toContain('NaN')
      expect(text).not.toContain('undefined')
      expect(text.length).toBeGreaterThan(0)
    }
  })

  it('五种格式覆盖 4.5 枚举定义（D-17）', () => {
    expect([...NUMBER_FORMATS]).toEqual(['standard', 'scientific', 'engineering', 'letters', 'layered'])
  })
})

describe('4.5 格式化缓存', () => {
  it('同值同格式命中缓存并返回一致结果', () => {
    resetFormatCache()
    format(d('1234.5678'), 'standard')
    const sizeAfterFirst = formatCacheSize()
    format(d('1234.5678'), 'standard')
    expect(formatCacheSize()).toBe(sizeAfterFirst)
  })

  it('负值、0、饱和值互不命中彼此的缓存条目（14.2）', () => {
    resetFormatCache()
    expect(formatCacheSize()).toBe(0)
    format(d('-1.5'), 'standard')
    format(d('1.5'), 'standard')
    format(d('0'), 'standard')
    expect(formatCacheSize()).toBe(3)
    // 若缓存键漏掉符号，-1.5 与 1.5 会共用一条，size 会停在 2。
    expect(format(d('-1.5'), 'standard')).toBe('-1.5')
    expect(format(d('1.5'), 'standard')).toBe('1.5')
  })

  it('mantissa 相同但 layer 不同的值互不命中（14.2）', () => {
    resetFormatCache()
    format(d('1e3'), 'standard')
    format(d('1e1e10'), 'standard')
    expect(formatCacheSize()).toBe(2)
  })

  it('缓存上限 4096 条，超出按 LRU 淘汰', () => {
    resetFormatCache()
    for (let i = 0; i < 5000; i += 1) format(d(String(i)), 'standard')
    expect(formatCacheSize()).toBeLessThanOrEqual(4096)
  })

  it('places 参与缓存键，不同位数不互串', () => {
    resetFormatCache()
    expect(format(d('1.5e6'), 'standard', { places: 1 })).toBe('1.5M')
    // `places` 是最大精度而非固定宽度：尾零被剥掉，但有效数字受其约束。
    expect(format(d('1.56789e6'), 'standard', { places: 3 })).toBe('1.568M')
    expect(formatCacheSize()).toBe(2)
  })

  it('places 控制实际有效精度（默认 2 位）', () => {
    expect(format(d('1.5e6'), 'standard', { places: 1 })).toBe('1.5M')
    expect(format(d('1.56789e6'), 'standard', { places: 1 })).toBe('1.6M')
    expect(format(d('1.56789e6'), 'standard', { places: 2 })).toBe('1.57M')
    expect(format(d('1234.5678'), 'standard', { places: 1 })).toBe('1234.6')
  })
})
