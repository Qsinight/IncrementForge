/**
 * 批量购买编辑器（TECH_DESIGN 7.6「BatchBuyEditor」、PRD 生成器 8 / 升级 9、D-36、D-48）。
 *
 * 三个档位对应 `buyAmount` 的三种语义（8.6 表）：
 *
 * | 档位 | `buyAmount` | 行为 |
 * | --- | --- | --- |
 * | 固定次数 | `1..100` | 连续购买直到不满足条件/价格，或达到该次数（100 为上限） |
 * | 最大购买 | `0` | 买到买不起为止（无 100 上限） |
 * | 自动最大 | `<0` | 免费、自动、每 `buyDelay` tick 一次、离线不触发 |
 *
 * **归一化在提交时就做**（5.9.3 的 ①~④：求值 → 有限性 → `floor` → `n≥1` 夹 100）：
 * 这里的输入是“作者直接写的表达式/数字”，因此先把常见写法折叠成规范文本，
 * 避免作者写出 `1e1e10` 时以为会买 1e1e10 件（会被夹到 100）。
 */
import { useMemo } from 'react'

import { Num } from '@iforge/num'
import { t } from '@iforge/i18n'

import { NumExprField } from './NumExprField.js'

export type BatchMode = 'count' | 'max' | 'free'

/** 依据 `buyAmount` 文本判定档位（非数值一律按 `count`，交给校验报错）。 */
export function batchModeOf(text: string): BatchMode {
  const normalized = normalizeCountText(text)
  const value = Number(normalized)
  if (!Number.isFinite(value)) return 'count'
  if (value < 0) return 'free'
  if (value === 0) return 'max'
  return 'count'
}

/**
 * 归一化（5.9.3 的 ③④ 两步，纯数值写法时可用；表达式由运行时归一化）。
 *
 * 用 `Num.fromString` 而不是 `Number()`：分层指数写法（`1e1e10`）在 JS 里是 `NaN`，
 * 直接用 `Number` 会把它当成“非法值”原样返回，作者就会以为 `1e1e10` 件是合法的
 * ——而运行时会把任何 `≥1` 的值夹到 100（PRD 生成器 8 的上限）。
 */
export function normalizeCountText(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return trimmed
  let value: number
  try {
    const decimal = Num.fromString(trimmed)
    if (decimal === null || Number.isNaN(Number(decimal.toString()))) return trimmed
    // 极大值在 toNumber 处饱和到 Number.MAX_VALUE，`≥ 100` 的结论不受影响。
    value = Num.toNumber(decimal)
  } catch {
    return trimmed
  }
  if (!Number.isFinite(value)) return trimmed
  const floored = Math.floor(value)
  if (floored >= 1) return String(Math.min(floored, 100))
  return String(floored)
}

export interface BatchBuyEditorProps {
  value: string
  onChange(value: string): void
  /** 条目在项目里的路径前缀（片段用），如 `gen.g2` / `up.u3`。 */
  pathPrefix: string
  disabled?: boolean
}

export function BatchBuyEditor({ value, onChange, pathPrefix, disabled }: BatchBuyEditorProps) {
  const mode = useMemo(() => batchModeOf(value), [value])

  const setMode = (next: BatchMode): void => {
    if (next === mode) return
    // 切换档位写的是**规范文本**：0 / -1；回到固定次数时保留一个合法值（1）。
    if (next === 'max') onChange('0')
    else if (next === 'free') onChange('-1')
    else onChange(normalizeCountText(value) === '0' || normalizeCountText(value) === '-1' ? '1' : normalizeCountText(value))
  }

  return (
    <div className="batch-buy">
      <div className="segmented" role="group" aria-label={t('field.buyAmount')}>
        <button
          type="button"
          className={mode === 'count' ? 'seg active' : 'seg'}
          aria-pressed={mode === 'count'}
          disabled={disabled}
          onClick={() => setMode('count')}
        >
          {t('generator.buyAmount.count')}
        </button>
        <button
          type="button"
          className={mode === 'max' ? 'seg active' : 'seg'}
          aria-pressed={mode === 'max'}
          disabled={disabled}
          onClick={() => setMode('max')}
        >
          {t('generator.buyAmount.max')}
        </button>
        <button
          type="button"
          className={mode === 'free' ? 'seg active' : 'seg'}
          aria-pressed={mode === 'free'}
          disabled={disabled}
          onClick={() => setMode('free')}
        >
          {t('generator.buyAmount.auto')}
        </button>
      </div>
      {mode === 'count' ? (
        <NumExprField
          label={t('field.buyAmount')}
          value={value}
          context="field"
          snippetBase={pathPrefix}
          disabled={disabled}
          hint={t('generator.buyAmount.hint')}
          onChange={onChange}
        />
      ) : (
        <p className="muted">
          {mode === 'max'
            ? `${t('generator.buyAmount.max')}：buyAmount = ${Num.format(Num.fromNumber(0), 'standard')}`
            : t('generator.buyAmount.hint')}
        </p>
      )}
    </div>
  )
}
