/**
 * 上传资产的安全过滤（TECH_DESIGN 13 第 4/5 条、11.2 体积约束、10.1 资产解析链路）。
 *
 * 两条过滤链：
 * - **图片 / SVG**（第 4 条）：白名单标签与属性；剥掉 `script`/`foreignObject`/`use`/`image`/
 *   `animate*`/`set`、全部 `on*` 事件属性、`style` 中的 `url()`/`javascript:`。
 * - **自定义主题 CSS**（第 5 条）：剥掉 `@import`、`expression()`、`javascript:`/`vbscript:`
 *   （含 `url(java\script:…)` 这类注释绕过），**禁止一切非 `data:` 的 `url()`**，
 *   并转义 `<` / `>` 以防 `</style>` 逃逸。
 *
 * ## 为什么过滤放在载入时而不是渲染时
 *
 * 过滤有成本（DOM 解析 + 逐属性判定），而渲染每帧都可能触发。资产是**持久化**的，
 * 因此在写入资产库（10.1「上传落库」）时过滤一次，之后只信任已通过的值。
 *
 * 本模块允许导入 DOM API（3.2：`packages/*` 中只有 `persist`、`ui-kit` 除外）。
 */
import { ForgeError } from '@iforge/num'

import { REQUIRED_TOKEN_KEYS } from './tokens.js'

/** 允许的上传 MIME（13 第 4 条）。 */
export const ALLOWED_ICON_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const
export type AllowedIconMime = (typeof ALLOWED_ICON_MIMES)[number]

/** 单资产硬上限 64KB（10.1「体积约束」、11.2）。 */
export const MAX_ASSET_BYTES = 64 * 1024

/** 上传图标压缩目标 ≤ 32KB（11.2）。 */
export const MAX_ICON_TARGET_BYTES = 32 * 1024

/** 项目文件整体上限 16MB（13 第 6 条）。 */
export const MAX_PROJECT_BYTES = 16 * 1024 * 1024

/** SVG 元素嵌套深度上限（13 第 4 条：超限报 `E_ASSET_INVALID`）。 */
export const MAX_SVG_DEPTH = 16

/** SVG 允许的标签白名单（13 第 4 条“形状/文本/渐变/描边类标签与安全属性”）。 */
const SVG_ALLOWED_TAGS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'title',
  'desc',
])

/** SVG 允许的属性白名单。`style` 单独过滤（值里禁止 `url()`/`javascript:`）。 */
const SVG_ALLOWED_ATTRS = new Set([
  'viewbox',
  'xmlns',
  'width',
  'height',
  'd',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'transform',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'x1',
  'y',
  'y1',
  'x2',
  'y2',
  'points',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'clip-path',
  'mask',
  'font-size',
  'font-family',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'id',
  'class',
  'preserveaspectratio',
  'version',
])

/** 属性值里一旦出现就拒绝（协议/事件注入）。 */
const DANGEROUS_VALUE = /(javascript|vbscript|data:text\/html|expression\s*\()/i

/** CSS 注释与转义序列（`\6a` 这类十六进制转义也是协议混淆手段）。 */
const CSS_ESCAPE = /\\([0-9a-f]{1,6})\s?|\\(.)/gi

function assertSize(text: string, where: string): void {
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_ASSET_BYTES) {
    throw new ForgeError('E_ASSET_TOO_LARGE', { where, message: `资产 ${bytes} 字节，超过 ${MAX_ASSET_BYTES} 上限` })
  }
}

/** 去掉 CSS 注释、解开转义、压掉空白——让用注释拆开协议的绕过回到明文。 */
function normalizeCss(text: string): string {
  const uncommented = text.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const unescaped = uncommented.replace(CSS_ESCAPE, (_whole, hex: string | undefined, literal: string | undefined) =>
    hex !== undefined ? String.fromCharCode(Number.parseInt(hex, 16)) : (literal ?? ''),
  )
  return unescaped.replace(/\s+/g, '').toLowerCase()
}

/** 元素属性白名单过滤（13 第 4 条）。根元素与所有子元素共用，避免 `<svg onload>` 漏网。 */
function filterSvgAttributes(element: Element, where: string): void {
  for (const attr of [...element.attributes]) {
    const name = attr.name.toLowerCase()
    const value = attr.value
    const styleLike = name === 'style' || name.endsWith('style')
    const urlOrEvent = /url\s*\(/i.test(value) && !/url\(\s*['"]?data:/i.test(value)
    if (name.startsWith('on') || styleLike || name === 'href' || name.includes(':href')) {
      // `style` 只在不含 `url()`/`javascript:` 时保留；`href`/`xlink:href`（外部引用、`<use>`）一律剔除。
      const safeStyle = styleLike && !urlOrEvent && !DANGEROUS_VALUE.test(value)
      if (!safeStyle) element.removeAttribute(attr.name)
      continue
    }
    if (!SVG_ALLOWED_ATTRS.has(name) || DANGEROUS_VALUE.test(value)) {
      element.removeAttribute(attr.name)
    }
  }
  if (element.localName.toLowerCase() === 'svg' && element.getAttribute('xmlns') === null) {
    element.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  }
  void where
}

/**
 * SVG 白名单过滤。
 *
 * 走 `DOMParser` 而不是正则：白名单语义必须落在**结构**上，正则无法可靠处理
 * 注释/CDATA/自闭合/属性引号等变体（`onload=` 与 `onload =`、`<script/x>` 等）。
 *
 * @throws {ForgeError} `E_ASSET_INVALID`（含禁止标签/属性/危险值/超深）或 `E_ASSET_TOO_LARGE`
 */
export function sanitizeSvg(svg: string, where = 'icon'): string {
  assertSize(svg, where)
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const parserError = doc.querySelector('parsererror')
  if (parserError) {
    throw new ForgeError('E_ASSET_INVALID', { where, message: 'SVG 解析失败' })
  }
  const root = doc.documentElement
  if (!root || root.localName !== 'svg') {
    throw new ForgeError('E_ASSET_INVALID', { where, message: 'SVG 根元素必须是 <svg>' })
  }

  const walk = (element: Element, depth: number): void => {
    if (depth > MAX_SVG_DEPTH) {
      throw new ForgeError('E_ASSET_INVALID', { where, message: `SVG 嵌套深度超过 ${MAX_SVG_DEPTH}` })
    }
    for (const child of [...element.children]) {
      walk(child, depth + 1)
      const tag = child.localName.toLowerCase()
      if (!SVG_ALLOWED_TAGS.has(tag)) {
        child.remove()
        continue
      }
      filterSvgAttributes(child, where)
    }
  }
  // 根元素的属性同样要过滤：`onload` 挂在 `<svg>` 上是最常见的注入方式，
  // 只遍历子元素会把它漏掉。
  filterSvgAttributes(root, where)
  walk(root, 1)

  // `<style>` 元素本身不在白名单里（上面的 children 循环已移除），这里再兜一次根级同名标签。
  for (const style of [...root.querySelectorAll('style, script, foreignObject, image, use, animate, set')]) {
    style.remove()
  }

  const serialized = new XMLSerializer().serializeToString(root)
  assertSize(serialized, where)
  return serialized
}

/**
 * 自定义主题 CSS 过滤（13 第 5 条）。
 *
 * 过滤顺序有讲究：**先剥注释**再判危险模式——`url(java…script:…)` 这类用注释拆开协议的绕过，
 * 只有在注释被剥掉之后才会暴露为 `javascript:`。转义 `<`/`>` 放在最后
 * （防止过滤逻辑本身引入尖括号）。
 *
 * @throws {ForgeError} `E_ASSET_INVALID` / `E_ASSET_TOO_LARGE`
 */
export function sanitizeThemeCss(css: string, where = 'theme'): string {
  assertSize(css, where)
  let out = css
  // 1) 去注释（CSS 注释是协议混淆的主要载体）
  out = out.replace(/\/\*[\s\S]*?\*\//g, ' ')
  // 2) 剥 @import / @charset / @namespace（自定义主题不得引入外部资源）
  out = out.replace(/@(?:import|charset|namespace)[^;]*;?/gi, '')
  // 3) 逐个 `url()` 判定协议：脚本协议直接拒绝；其余非 `data:` 引用一律中性化
  out = out.replace(/url\(\s*([^)]*?)\s*\)/gi, (_whole, payload: string) => {
    const normalized = normalizeCss(payload).replace(/^['"]|['"]$/g, '')
    if (DANGEROUS_VALUE.test(normalized)) {
      throw new ForgeError('E_ASSET_INVALID', { where, message: `自定义主题含脚本 url(): ${payload}` })
    }
    return normalized.startsWith('data:') ? `url(${payload})` : 'url(about:blank)'
  })
  // 4) 拒绝散落在 url() 之外的 javascript:/vbscript:/expression()
  const normalized = normalizeCss(out)
  if (DANGEROUS_VALUE.test(normalized)) {
    throw new ForgeError('E_ASSET_INVALID', { where, message: '自定义主题含 javascript:/vbscript:/expression()' })
  }
  // 5) 转义 `<`/`>`，防止 `</style>` 逃逸出 style 标签
  out = out.replace(/</g, '\\3c ').replace(/>/g, '\\3e ')
  assertSize(out, where)
  return out
}

/** 断言 MIME 在白名单内（13 第 4 条）。 */
export function assertAllowedMime(mime: string, where = 'asset'): void {
  if (!(ALLOWED_ICON_MIMES as readonly string[]).includes(mime)) {
    throw new ForgeError('E_ASSET_INVALID', { where, message: `不支持的类型 ${mime}` })
  }
}

/**
 * 上传图片 -> data URL（13 第 4 条“解码后重编码为 data URL，禁用外部引用 URL”）。
 *
 * 位图走 `createImageBitmap` + canvas **重新编码**（顺带压缩到 ≤ 32KB，11.2）；
 * SVG 走白名单过滤后以文本内联。
 *
 * @param file 浏览器 `File`（由 `IconPicker` 的 `<input type=file>` 提供）
 * @throws {ForgeError} `E_ASSET_INVALID`（类型/解码失败）或 `E_ASSET_TOO_LARGE`
 */
export async function imageFileToDataUrl(file: File, where = 'asset'): Promise<string> {
  assertAllowedMime(file.type, where)
  if (file.type === 'image/svg+xml') {
    const text = await file.text()
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(sanitizeSvg(text, where))))}`
  }
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d')
  if (!context) throw new ForgeError('E_ASSET_INVALID', { where, message: '无法创建 canvas 上下文' })
  context.drawImage(bitmap, 0, 0)
  // 质量从 0.9 起逐级下调，直到落进 32KB 目标（11.2）。
  let quality = 0.9
  let url = canvas.toDataURL('image/webp', quality)
  while (url.length > MAX_ICON_TARGET_BYTES && quality > 0.3) {
    quality -= 0.15
    url = canvas.toDataURL('image/webp', quality)
  }
  assertSize(url, where)
  return url
}

/**
 * 把主题 CSS 过滤成可注入的文本（并做令牌完整性校验，D-13）。
 *
 * 缺 `--iforge-*` 必需令牌**不回退整个主题**——过滤后的 CSS 原样注入，
 * 缺失的单个变量由 `tokens.ts` 的 `completeTokens()` 逐键回退（那条路径不依赖运行时 CSS）。
 * 这里只报告，供上传后提示作者。
 */
export interface SanitizeThemeResult {
  css: string
  /** 相对 `required` 缺失的令牌（形如 `--iforge-bg`）。 */
  missing: string[]
}

/** 必需令牌的前缀形式（`required` 形如 `['bg','surface',…]`）。 */
export function requiredTokenNames(prefix = '--iforge-', required: readonly string[] = REQUIRED_TOKEN_KEYS): string[] {
  return required.map((key) => `${prefix}${key}`)
}

export function sanitizeTheme(css: string, where = 'theme'): SanitizeThemeResult {
  const filtered = sanitizeThemeCss(css, where)
  const declared = new Set([...filtered.matchAll(/(--iforge-[a-z-]*)\s*:/gi)].map((match) => (match[1] ?? '').toLowerCase()))
  const missing = requiredTokenNames().filter((name) => !declared.has(name))
  return { css: filtered, missing }
}
