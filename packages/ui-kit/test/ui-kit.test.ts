import { describe, expect, it } from 'vitest'

import { ForgeError } from '@iforge/num'

import {
  BUILTIN_ICON_IDS,
  BUILTIN_THEME_IDS,
  ICONS,
  REQUIRED_TOKEN_KEYS,
  THEME_SCOPE,
  assertAllowedMime,
  completeTokens,
  isBuiltinTheme,
  parseCustomTheme,
  renderIconSvg,
  resolveEntryTokens,
  resolveIconRef,
  resolveThemeTokens,
  sanitizeSvg,
  sanitizeTheme,
  sanitizeThemeCss,
  themesOfScope,
  tokensToCss,
} from '../src/index.js'

/** 17.4 表中的必备清单（与文档逐项对应，`tools/docs-check.ts` 也用同一份常量比对）。 */
const DOC_17_4_ICONS = [
  'gem',
  'coin',
  'crystal',
  'energy',
  'ingot',
  'factory',
  'drill',
  'mine',
  'lab',
  'reactor',
  'hand',
  'hammer',
  'pick',
  'click',
  'star',
  'arrow-up',
  'bolt',
  'shield',
  'grid',
  'map',
  'book',
  'gear',
  'plus',
  'copy',
  'trash',
  'sort-up',
  'sort-down',
  'undo',
  'redo',
  'save',
  'import',
  'export',
  'package',
  'menu',
  'play',
  'pause',
  'restart',
  'iforge-logo',
]

describe('@iforge/ui-kit 主题令牌（TECH_DESIGN 7.8、17.4、D-13）', () => {
  it('17.4 的 9 个内置主题 id 全部存在，且作用域分组正确', () => {
    for (const id of ['dark', 'light', 'midnight', 'page-dark', 'page-light', 'page-midnight', 'entry-dark', 'entry-light', 'entry-midnight']) {
      expect(BUILTIN_THEME_IDS).toContain(id)
    }
    expect(themesOfScope('editor')).toEqual(['dark', 'light', 'midnight'])
    expect(themesOfScope('page')).toEqual(['page-dark', 'page-light', 'page-midnight'])
    expect(themesOfScope('entry')).toEqual(['entry-dark', 'entry-light', 'entry-midnight'])
    expect(THEME_SCOPE['page-midnight']).toBe('page')
  })

  it('每个内置主题都声明全部必需令牌（17.4 末条 + 7.1 可访问性基线的 focus）', () => {
    for (const id of BUILTIN_THEME_IDS) {
      const css = tokensToCss(resolveThemeTokens({ kind: 'builtin', value: id }, 'editor'), 'editor')
      for (const key of REQUIRED_TOKEN_KEYS) {
        expect(css).toContain(`--iforge-${key}:`)
      }
    }
  })

  it('自定义主题缺变量时逐键回退（D-13），且解析覆盖三套命名空间', () => {
    const parsed = parseCustomTheme(':root{--iforge-bg:#111;--iforge-page-text:#eee;--iforge-entry-accent:#f00}')
    expect(parsed.editor?.bg).toBe('#111')
    expect(parsed.page?.text).toBe('#eee')
    expect(parsed.entry?.accent).toBe('#f00')
    const tokens = resolveThemeTokens({ kind: 'data', value: ':root{--iforge-bg:#111}' }, 'editor')
    expect(tokens.bg).toBe('#111')
    // 未声明的键回退内置默认，而不是 undefined（缺 `text` 会让文字不可见）。
    expect(tokens.text).toBe('#e8eaed')
  })

  it('条目主题缺省跟随页面主题（PRD 页面编辑器 8）', () => {
    const page = { kind: 'builtin', value: 'page-light' } as const
    const follow = resolveEntryTokens(page, undefined)
    const explicit = resolveEntryTokens(page, { kind: 'builtin', value: 'entry-midnight' })
    const lightCard = resolveThemeTokens({ kind: 'builtin', value: 'entry-light' }, 'entry')
    expect(follow.card).toBe(lightCard.card)
    expect(explicit.card).not.toBe(lightCard.card)
  })

  it('未知内置 id 回退默认主题，不抛异常', () => {
    expect(resolveThemeTokens({ kind: 'builtin', value: 'no-such-theme' }, 'page')).toEqual(
      resolveThemeTokens({ kind: 'builtin', value: 'page-dark' }, 'page'),
    )
    expect(completeTokens({ bg: '#000' }).bg).toBe('#000')
    expect(isBuiltinTheme({ kind: 'builtin', value: 'dark' })).toBe(true)
    expect(isBuiltinTheme({ kind: 'data', value: '' })).toBe(false)
  })
})

describe('@iforge/ui-kit 内置图标（TECH_DESIGN 17.4、11.2）', () => {
  it('17.4 的必备清单逐项存在，且不重复', () => {
    for (const id of DOC_17_4_ICONS) expect(BUILTIN_ICON_IDS).toContain(id)
    expect(new Set(BUILTIN_ICON_IDS).size).toBe(BUILTIN_ICON_IDS.length)
  })

  it('渲染出的 SVG 自包含：不含外链、无 script/事件属性（13 第 4 条同理）', () => {
    const svg = renderIconSvg('factory', { size: 24 })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox="0 0 24 24"')
    expect(svg).not.toMatch(/<script/i)
    expect(svg).not.toMatch(/\son\w+=/i)
    expect(svg).not.toMatch(/href/i)
  })

  it('未知内置 id 回落默认图标而不是抛错', () => {
    expect(renderIconSvg('not-an-icon')).toContain('<svg')
  })

  it('IconRef 分派：builtin 走 SVG，data 走 img，未解析的 asset 回落图标', () => {
    expect(resolveIconRef({ kind: 'builtin', value: 'gem' }).kind).toBe('svg')
    expect(resolveIconRef({ kind: 'data', value: 'data:image/png;base64,AA' }).kind).toBe('img')
    expect(resolveIconRef({ kind: 'asset', value: 'a1' }).kind).toBe('svg')
  })

  it('所有内置图标都能渲染成 SVG（几何数据没有语法错误）', () => {
    for (const icon of ICONS) {
      const svg = renderIconSvg(icon.id)
      expect(svg).toContain('</svg>')
      expect(svg.length).toBeGreaterThan(60)
    }
  })
})

describe('@iforge/ui-kit 资产安全过滤（TECH_DESIGN 13 第 4/5 条）', () => {
  it('SVG：剥掉 script/foreignObject/use/image/animate 与全部 on* 事件属性', () => {
    const svg = `<svg viewBox="0 0 24 24" onload="alert(1)"><script>alert(2)</script><foreignObject><div/></foreignObject><use href="http://x/#a"/><image href="http://x/a.png"/><animate/><set/><path d="M0 0h24" onclick="alert(3)"/></svg>`
    const out = sanitizeSvg(svg)
    expect(out).toContain('<path')
    expect(out).not.toMatch(/script/i)
    expect(out).not.toMatch(/foreignObject/i)
    expect(out).not.toMatch(/<use/i)
    expect(out).not.toMatch(/<image/i)
    expect(out).not.toMatch(/<animate/i)
    expect(out).not.toMatch(/<set/i)
    expect(out).not.toMatch(/onload|onclick/i)
  })

  it('SVG：style 中的 url()/javascript: 被剔除，但保留安全的 style 声明', () => {
    const svg = `<svg><path style="fill:red" d="M0 0"/><path style="fill:url(http://x)" d="M0 0"/><path style="background:url(javascript:alert(1))" d="M0 0"/></svg>`
    const out = sanitizeSvg(svg)
    expect(out).toContain('fill:red')
    expect(out).not.toContain('url(http://x)')
    expect(out).not.toContain('javascript')
  })

  it('CSS 主题：剥 @import、非 data: 的 url()、并转义 < > 防 </style> 逃逸', () => {
    const css = '@import url("http://evil/x.css"); :root{--iforge-bg:url(http://evil/bg.png);--iforge-surface:#fff}</style><script>alert(1)</script>'
    const out = sanitizeThemeCss(css)
    expect(out).not.toContain('@import')
    expect(out).not.toContain('http://evil')
    expect(out).not.toContain('</style')
    expect(out).not.toContain('<script')
    expect(out).toContain('--iforge-surface:#fff')
  })

  it('CSS 主题：注释绕过（url(java/*x*/script:…）被识别为 javascript: 并拒绝', () => {
    expect(() => sanitizeThemeCss(':root{--iforge-bg:url(java/*x*/script:alert(1))}')).toThrow(ForgeError)
  })

  it('自定义主题：报告缺失的必需令牌（D-13 的提示依据）', () => {
    const result = sanitizeTheme(':root{--iforge-bg:#123}')
    expect(result.missing).toContain('--iforge-surface')
    expect(result.missing).not.toContain('--iforge-bg')
  })

  it('超体积的资产报 E_ASSET_TOO_LARGE（10.1 体积约束）', () => {
    const huge = `<svg>${'<path d="M0 0h1"/>'.repeat(6000)}</svg>`
    expect(() => sanitizeSvg(huge)).toThrowError(/E_ASSET_TOO_LARGE|资产/)
  })

  it('非法 MIME 被拒（13 第 4 条白名单）', () => {
    expect(() => assertAllowedMime('image/svg+xml')).not.toThrow()
    expect(() => assertAllowedMime('image/gif')).toThrowError(/不支持的类型/)
  })
})
