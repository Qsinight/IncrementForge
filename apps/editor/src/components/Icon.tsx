/**
 * 图标渲染组件（TECH_DESIGN 7.8、17.4）。
 *
 * 内置图标走内联 SVG（跟随文字颜色令牌），上传图标走 `<img src="data:…">`——
 * 分派规则由 `ui-kit` 的 `resolveIconRef` 决定（ADR-10：打包时内联，不占体积）。
 */
import { createElement } from 'react'
import type { CSSProperties } from 'react'

import type { IconRef } from '@iforge/model'
import { iconOf } from '@iforge/ui-kit'

export interface IconProps {
  /** `IconRef`；缺省用 `star`。 */
  icon?: IconRef
  /** 直接指定内置图标 id（工具栏按钮用，省去构造 `IconRef`）。 */
  builtinId?: string
  size?: number
  className?: string
  style?: CSSProperties
}

/** 单个形状的 SVG 元素（与 `IconDefinition.shapes` 同构）。 */
// 用 `createElement` 而不是小写开头的 `tag`：JSX 会把 `<tag …>` 当成**自定义元素名**，
// 而内置图标里 `tag` 是运行期数据（`path`/`circle`/…），只有 `createElement` 才能按字符串建元素。
// 不写显式返回类型：React 19 的 JSX 命名空间在 `React.JSX` 下（全局 `JSX` 已废弃），
// 交给 TS 推断可避免随 React 版本变动而失效。
function Shape({ tag, attrs, fill }: { tag: string; attrs: Record<string, string | number>; fill?: boolean }) {
  return createElement(tag, {
    ...attrs,
    fill: fill ? 'currentColor' : 'none',
    stroke: fill ? 'none' : 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  })
}

export function Icon({ icon, builtinId, size = 18, className, style }: IconProps) {
  const definition = icon ? (icon.kind === 'builtin' ? iconOf(icon.value) : undefined) : iconOf(builtinId ?? 'star')
  if (icon?.kind === 'data') {
    return <img className={className} src={icon.value} alt="" width={size} height={size} style={style} />
  }
  const resolved = definition ?? iconOf('star')
  return (
    <svg
      className={className}
      viewBox={resolved.viewBox}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {resolved.shapes.map((shape, index) => (
        <Shape key={index} tag={shape.tag} attrs={shape.attrs as Record<string, string | number>} fill={shape.fill} />
      ))}
    </svg>
  )
}
