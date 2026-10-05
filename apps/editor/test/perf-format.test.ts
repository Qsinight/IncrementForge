/**
 * 诊断面板与产物体积的数字格式化（TECH_DESIGN 12 性能预算末条、11.2 体积预算）。
 *
 * 这里刻意**不复用** `Num.format`：`Num.format` 服务于游戏内数值（`1.23e456`、分层指数、`∞`），
 * 而这里要显示的是工程量（字节数、百分比、tick 次数）。混用会出现两种难看的输出：
 * `204800` 被显示成 `204.8K`（读者要看的是“离 1.5MB 还有多远”），
 * 而 `0.9734` 这种命中率根本不该走数字格式。
 *
 * 因此本文件把“为什么不复用”以及**每条边界**都固定下来：
 * 越界/非有限值一律显示 `—`，绝不出现 `NaN%`（`NaN%` 在诊断面板上等同于没有信息）。
 */
import { describe, expect, it } from 'vitest'

import { formatBytes, formatPercent } from '../src/app/perf-format.js'

describe('formatBytes()：字节数 -> 十进制单位（11.2 的「1.5MB」口径）', () => {
  it('小于 1KB 用字节，不带小数', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('KB 保留一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(204800)).toBe('200.0 KB')
  })

  it('MB 保留一位小数（预算判定读的就是这个）', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    // 11.2 的合并门禁是 1.5MB。
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
  })

  it('GB 是最后一档，再大也不继续升档', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
    expect(formatBytes(1024 ** 4)).toBe('1024.0 GB')
  })

  it('不给 gzip 时只输出原始体积', () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(formatBytes(2 * 1024 * 1024, 0)).toBe('2.0 MB')
  })

  it('给 gzip 时追加 `（gzip X）`，两段各自带单位', () => {
    expect(formatBytes(2 * 1024 * 1024, 400 * 1024)).toBe('2.0 MB（gzip 400.0 KB）')
  })

  it('负数、非有限值显示 `—` 而不是 `-1 B` / `NaN B`', () => {
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('gzip <= 0（不可用）时不追加 gzip 段', () => {
    expect(formatBytes(2048, 0)).toBe('2.0 KB')
    expect(formatBytes(2048, -5)).toBe('2.0 KB')
  })

  it('gzip 为 `NaN` 时仍走“可用”分支并显示 `—`（`NaN <= 0` 为假）', () => {
    // 记录现状而非理想行为：`packageGame` 在拿不到 zlib 时给的是 `0` 而不是 `NaN`，
    // 所以这条分支实际不可达。留它是为了钉住“不会抛错、也不显示 NaN”。
    expect(formatBytes(2048, Number.NaN)).toBe('2.0 KB（gzip —）')
  })
})

describe('formatPercent()：比率 -> 百分比（12 的缓存命中率）', () => {
  it('0..1 映射到 0.0%..100.0%，保留一位小数', () => {
    expect(formatPercent(0)).toBe('0.0%')
    expect(formatPercent(0.5)).toBe('50.0%')
    expect(formatPercent(0.9734)).toBe('97.3%')
    expect(formatPercent(1)).toBe('100.0%')
  })

  it('大于 1 被夹到 100%（命中率不可能超过 100%，显示 130% 会误导）', () => {
    expect(formatPercent(1.3)).toBe('100.0%')
    expect(formatPercent(Number.MAX_VALUE)).toBe('100.0%')
  })

  it('负数与非有限值显示 `—`，绝不出现 `NaN%`', () => {
    expect(formatPercent(-0.01)).toBe('—')
    expect(formatPercent(Number.NaN)).toBe('—')
    expect(formatPercent(Number.NEGATIVE_INFINITY)).toBe('—')
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('输出永不含 `NaN`（面板上的 `NaN` 等同于没有信息）', () => {
    const inputs = [0, 1, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e9]
    for (const input of inputs) {
      expect(formatPercent(input)).not.toContain('NaN')
      expect(formatBytes(input)).not.toContain('NaN')
    }
  })
})

describe('两个格式化器都不引入 `Intl`（保持快照稳定）', () => {
  it('输出用固定的 `zh-CN` 口径：小数点与千分位不随环境变', () => {
    // 千分位分隔符若出现，跨环境快照会漂；这里固定“不出现千分位”。
    expect(formatBytes(1234567)).toBe('1.2 MB')
    expect(formatPercent(0.123)).toBe('12.3%')
    expect(formatBytes(1234567)).not.toContain(',')
  })
})
