/**
 * 条目图标（PRD 预览区 3/4/5/6 的“图标”字段，8.11，13 第 4 条）。
 *
 * ## 为什么不直接把 SVG 塞进 `srcdoc`
 *
 * 9.1 的 iframe 处于**不透明源**，因此它不能访问编辑器的 DOM 与存储——图标只能有两种来源：
 * 内置图标（`ui-kit` 的内联 path，`kind: 'builtin'`，无网络请求，17.4 末条）与
 * `data:` URL（`kind: 'data'`；上传资产在 10.1 的资产解析链路里已被规范化为 data URL）。
 *
 * SVG 用 `dangerouslySetInnerHTML` 插入是**必须的**（`ui-kit` 的 `renderIconSvg` 返回 path
 * 字符串），因此这里必须保证输入可信：13 第 4 条的 SVG 白名单过滤是**上传侧**的责任，
 * 而 `builtin` 分支只取 `ui-kit` 注册表里的 id，未知 id 回退内置图标——
 * 也就是说这里渲染的要么是可信常量，要么是已经过滤过的 `data:` URL。
 */
import { useMemo } from 'react'

import { renderIconSvg } from '@iforge/ui-kit'

/** 图标引用的解析结果（8.11 的 `icon` 字段形态：`builtin:<id>` / `data:<url>`）。 */
export interface ResolvedIcon {
  kind: 'svg' | 'img'
  /** `svg` 分支的内联 markup（已由 ui-kit 生成）。 */
  svg?: string
  /** `img` 分支的 data URL。 */
  src?: string
  alt: string
}

/**
 * 把 `IconRef` 字符串解析成可渲染的形式。
 *
 * 拆分 `builtin:` / `data:` 前缀由 `view-model` 的 `iconKeyOf()` 生成（10.1 资产解析链路
 * 在载入时已把 `kind: 'asset'` 换成 `data`）。这里对未知前缀一律按内置处理并回退，
 * 保证一条坏引用不会让整个卡片渲染失败。
 */
export function resolveGameIcon(iconKey: string, alt: string): ResolvedIcon {
  const separator = iconKey.indexOf(':')
  const kind = separator < 0 ? 'builtin' : iconKey.slice(0, separator)
  const value = separator < 0 ? iconKey : iconKey.slice(separator + 1)
  if (kind === 'data') return { kind: 'img', src: value, alt }
  return { kind: 'svg', svg: renderIconSvg(value, { size: 24 }), alt }
}

export interface IconProps {
  /** `view-model` 的 `icon` 字段。 */
  icon: string
  /** 无障碍标签（条目名称）。 */
  alt: string
  className?: string
}

/** 渲染条目图标。 */
export function Icon({ icon, alt, className }: IconProps) {
  const resolved = useMemo(() => resolveGameIcon(icon, alt), [icon, alt])
  if (resolved.kind === 'img') {
    return <img className={className} src={resolved.src} alt={resolved.alt} width={24} height={24} />
  }
  return <span className={className} role="img" aria-label={resolved.alt} dangerouslySetInnerHTML={{ __html: resolved.svg ?? '' }} />
}
