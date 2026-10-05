/**
 * 图标渲染（TECH_DESIGN 7.8、17.4、11.2、13 第 4 条）。
 *
 * 提供两条渲染路径：
 * - `renderIconSvg()`：拼成 **SVG 字符串**（导出 HTML、快照测试、`srcdoc` 注入）；
 * - `resolveIconRef()`：把 `IconRef`（6.1）归一成“画 SVG 还是 `<img>`”，供 React 组件分派。
 *
 * 上传的 data URL / 资产**不在这里校验**——过滤发生在 `sanitize.ts`（13 第 4 条），
 * 且只在导入/上传时执行一次；渲染期信任已通过过滤的值。
 */
import type { IconRef } from '@iforge/model'

import { iconOf } from './icons.js'
import type { IconDefinition, IconShape } from './icons.js'

/** HTML 属性值转义（图标 id 来自项目文件，不能直接拼进属性）。 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function shapeToSvg(shape: IconShape): string {
  const attrs = Object.entries(shape.attrs)
    .map(([name, value]) => `${name}="${escapeAttr(String(value))}"`)
    .join(' ')
  if (shape.fill) return `<${shape.tag} ${attrs} fill="currentColor" stroke="none"/>`
  return `<${shape.tag} ${attrs} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
}

/** 渲染选项。 */
export interface RenderIconOptions {
  /** 像素尺寸（宽高相同）。 */
  size?: number
  /** 附加到 `<svg>` 的 class。 */
  className?: string
  /** `<title>` 文案；缺省时由 `aria-hidden` 表达纯装饰图标。 */
  title?: string
}

/**
 * 内置图标 -> SVG 字符串。
 *
 * @param id 内置图标 id（未知 id 走兜底图标）
 */
export function renderIconSvg(id: string, options: RenderIconOptions = {}): string {
  const icon: IconDefinition = iconOf(id)
  const size = options.size ?? 20
  const classAttr = options.className ? ` class="${escapeAttr(options.className)}"` : ''
  const label = options.title ?? icon.label
  const a11y = options.title ? `role="img" aria-label="${escapeAttr(label)}"` : 'aria-hidden="true" focusable="false"'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${escapeAttr(icon.viewBox)}" width="${size}" height="${size}"` +
    `${classAttr} ${a11y} fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    icon.shapes.map(shapeToSvg).join('') +
    '</svg>'
  )
}

/** `IconRef` 的渲染分派结果。 */
export type ResolvedIcon = { kind: 'svg'; definition: IconDefinition } | { kind: 'img'; src: string; alt: string }

/**
 * 把 `IconRef`（6.1）解析为渲染指令。
 *
 * | `kind` | 结果 |
 * | --- | --- |
 * | `builtin` | SVG path 内联（不占体积、跟随文字颜色） |
 * | `data` | `<img src="data:…">` |
 * | `asset` | 同 data——但 10.1 的载入链路应已把资产解析为 data URL；未解析时回落默认图标 |
 */
export function resolveIconRef(ref: IconRef | undefined, alt = ''): ResolvedIcon {
  if (!ref) return { kind: 'svg', definition: iconOf('star') }
  if (ref.kind === 'builtin') return { kind: 'svg', definition: iconOf(ref.value) }
  if (ref.kind === 'data') return { kind: 'img', src: ref.value, alt }
  // 资产库引用若未被解析（未载入项目 / 打包前漏内联），退回首字母图标而不是空白。
  return { kind: 'svg', definition: iconOf('star') }
}
