/**
 * 诊断面板里的数字格式化（12 性能预算末条、11.2 体积预算）。
 *
 * ## 为什么不复用 `@iforge/num` 的 `format`
 *
 * `Num.format` 处理的是**游戏内数值**（`1.23e456`、分层指数、`∞`）。这里要显示的是
 * **诊断与产物的工程量**：字节数、百分比、tick 次数。
 *
 * 用 `Num.format` 会出现两种难看的输出：`204800` 被显示成 `204.8K`（读者要看的是
 * “离 1.5MB 还有多远”），而 `0.9734` 这种命中率根本不该走数字格式。
 *
 * 刻意保持**极简**：不引入 `Intl.NumberFormat`（宿主页面语言固定 `zh-CN`，PRD 补充 9），
 * 也不做本地化单位——这两条都会让快照测试变得脆弱，而收益为零。
 */

/** 字节数 -> `1.2 MB`（十进制，与 11.2 的「1.5MB」口径一致）。 */
export function formatBytes(bytes: number, gzipBytes = 0): string {
  const raw = byteUnit(bytes)
  if (gzipBytes <= 0) return raw
  return `${raw}（gzip ${byteUnit(gzipBytes)}）`
}

function byteUnit(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${units[index]}`
}

/** 比率 -> `97.3%`（`0`..`1`；越界与非有限值显示为 `—`，不显示 `NaN%`）。 */
export function formatPercent(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0) return '—'
  return `${(Math.min(1, rate) * 100).toFixed(1)}%`
}
