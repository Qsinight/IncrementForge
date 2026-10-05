/**
 * 主题令牌（TECH_DESIGN 7.8、17.4）。
 *
 * ## 三套命名空间，一套机制
 *
 * | 作用域 | 令牌前缀 | 用途 |
 * | --- | --- | --- |
 * | 编辑器 | `--iforge-*` | 编辑器自身 UI（PRD 设置页 1） |
 * | 页面 | `--iforge-page-*` | 预览/游戏里的页面底色与文字（PRD 页面编辑器 6） |
 * | 条目 | `--iforge-entry-*` | 卡片样式（PRD 页面编辑器 8） |
 *
 * 命名空间共用同一套机制，因此任意组合都能工作（7.8 末条）。**必需令牌**取 17.4
 * 的清单（`bg`/`surface`/`text`/`accent`/`danger`，页面与条目加前缀），
 * 另加 7.1 可访问性基线第 ⑤ 条要求的 `--iforge-focus`——它若被自定义主题抹掉，
 * 键盘用户就失去焦点指示，因此它同样是必需令牌。
 */
export const REQUIRED_TOKEN_KEYS = ['bg', 'surface', 'text', 'accent', 'danger', 'focus'] as const

/** 必需令牌的短名（不含前缀），如 `bg`。 */
export type RequiredTokenKey = (typeof REQUIRED_TOKEN_KEYS)[number]

/** 令牌作用域。 */
export type TokenScope = 'editor' | 'page' | 'entry'

/** 令牌前缀映射（7.8「统一命名空间」）。 */
export const TOKEN_PREFIX: Readonly<Record<TokenScope, string>> = {
  editor: '--iforge-',
  page: '--iforge-page-',
  entry: '--iforge-entry-',
}

/** 令牌名（不含前缀）。除必需令牌外还有若干扩展令牌，缺失时回退默认值（D-13）。 */
export interface TokenSet {
  bg: string
  surface: string
  text: string
  accent: string
  danger: string
  focus: string
  /** 次要文字（描述、条件说明等）。 */
  muted: string
  /** 边框与分隔线。 */
  border: string
  /** 成功/提示色（离线提示条、校验通过）。 */
  ok: string
  /** 警告色（`E_BATCH_*` 提示）。 */
  warning: string
  /** 卡片底色（条目主题用；页面主题缺省沿用 surface）。 */
  card: string
}

/**
 * 三档内置主题（17.4 表）：`dark` / `light` / `midnight`。
 *
 * 每个作用域一套，共 9 个（编辑器 3 + 页面 3 + 条目 3）。条目主题**缺省跟随页面主题**
 * （PRD 页面编辑器 8），由 `resolveTheme()` 的 `followPage` 实现。
 */
export const BUILTIN_TOKENS: Readonly<Record<'dark' | 'light' | 'midnight', TokenSet>> = {
  dark: {
    bg: '#14161a',
    surface: '#1c1f25',
    text: '#e8eaed',
    accent: '#4c8dff',
    danger: '#ff5c5c',
    focus: '#7fb0ff',
    muted: '#9aa3b2',
    border: '#2c313b',
    ok: '#4cc38a',
    warning: '#e5a13a',
    card: '#21252d',
  },
  light: {
    bg: '#f4f5f7',
    surface: '#ffffff',
    text: '#1b1e24',
    accent: '#2563eb',
    danger: '#d93636',
    focus: '#1d4ed8',
    muted: '#5b6472',
    border: '#d7dae0',
    ok: '#1f9254',
    warning: '#b45309',
    card: '#ffffff',
  },
  midnight: {
    bg: '#070a14',
    surface: '#0d1220',
    text: '#d6e2ff',
    accent: '#7c5cff',
    danger: '#ff4d6d',
    focus: '#a48bff',
    muted: '#7e8bb0',
    border: '#1b2440',
    ok: '#3ecf9a',
    warning: '#ffb547',
    card: '#101728',
  },
}

/** 缺省回退用的令牌集（D-13：自定义主题缺变量时回退内置默认值）。 */
export const FALLBACK_TOKEN_SET: TokenSet = BUILTIN_TOKENS.dark

/** 必需令牌 + 扩展令牌的完整键集合（回退与校验都按它遍历）。 */
export const TOKEN_KEYS: readonly (keyof TokenSet)[] = [...REQUIRED_TOKEN_KEYS, 'muted', 'border', 'ok', 'warning', 'card']

/** 补全一个不完整的令牌集：缺失键回退 `FALLBACK_TOKEN_SET`（D-13）。 */
export function completeTokens(partial: Partial<TokenSet> | undefined, fallback: TokenSet = FALLBACK_TOKEN_SET): TokenSet {
  const out = {} as TokenSet
  for (const key of TOKEN_KEYS) {
    out[key] = partial?.[key] ?? fallback[key]
  }
  return out
}

/**
 * 从 CSS 文本里抽取 `:root { --iforge-*: … }` 声明（自定义主题的加载路径）。
 *
 * 只认 `--iforge-` / `--iforge-page-` / `--iforge-entry-` 前缀，其它声明一律忽略——
 * 自定义主题的契约是“**以 `--iforge-*` 变量声明**”（6.1 注释、D-13），
 * 顺手放进来一堆选择器规则既不可控也无法校验。
 */
export function parseCustomTheme(css: string): Partial<Record<TokenScope, Partial<TokenSet>>> {
  const out: Partial<Record<TokenScope, Partial<TokenSet>>> = {}
  // 覆盖 3 套命名空间；同一段 CSS 可以同时声明 editor/page/entry（7.8 末条的“任意组合”）。
  const scopeOf = (prefix: string): TokenScope | undefined => {
    if (prefix.startsWith('--iforge-page-')) return 'page'
    if (prefix.startsWith('--iforge-entry-')) return 'entry'
    if (prefix.startsWith('--iforge-')) return 'editor'
    return undefined
  }
  const declarations = css.matchAll(/--iforge-[a-z-]*\s*:\s*([^;}]+)/gi)
  for (const match of declarations) {
    const raw = match[0]
    const name = raw.slice(0, raw.indexOf(':')).trim()
    const value = (match[1] ?? '').trim()
    const scope = scopeOf(name)
    if (!scope) continue
    const key = name.slice(TOKEN_PREFIX[scope].length) as keyof TokenSet
    if (!TOKEN_KEYS.includes(key)) continue
    const bucket = (out[scope] ??= {})
    bucket[key] = value
  }
  return out
}

/** 令牌集 -> CSS 声明文本（`--name: value;`），供 `style` 标签或内联样式使用。 */
export function tokensToCss(tokens: TokenSet, scope: TokenScope): string {
  const prefix = TOKEN_PREFIX[scope]
  return TOKEN_KEYS.map((key) => `${prefix}${key}: ${tokens[key]};`).join(' ')
}
