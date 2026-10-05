/**
 * 主题注册表（TECH_DESIGN 7.8、6.1 的 `theme` 结构、17.4 主题清单、D-13）。
 *
 * `theme` 的结构与 `IconRef` 同形：`{ kind: 'builtin', value } | { kind: 'data', value: CSS 文本 }`
 * （外加 `{ kind: 'asset', value: assetId }`，由 10.1 的资产解析链路在载入时解析成 data URL）。
 *
 * ## 内置 id 是稳定契约
 *
 * 17.4 表末条：内置主题 id **不得变更**——项目文件与存档里以 id 引用内置资源，
 * 改名即破坏旧项目。实现可以增补，但必须同步文档。本文件的 `THEME_REGISTRY`
 * 就是那份清单的可执行版本（`tools/docs-check.ts` 会核对它与 17.4 表格一致）。
 */
import type { ThemeRef } from '@iforge/model'

import { BUILTIN_TOKENS, completeTokens, parseCustomTheme, tokensToCss } from './tokens.js'
import type { TokenScope, TokenSet } from './tokens.js'

/** 内置主题 id（17.4：编辑器 3 + 页面 3 + 条目 3）。 */
export const BUILTIN_THEME_IDS = [
  'dark',
  'light',
  'midnight',
  'page-dark',
  'page-light',
  'page-midnight',
  'entry-dark',
  'entry-light',
  'entry-midnight',
] as const

export type BuiltinThemeId = (typeof BUILTIN_THEME_IDS)[number]

/** 内置主题 id -> 作用域。 */
export const THEME_SCOPE: Readonly<Record<BuiltinThemeId, TokenScope>> = {
  dark: 'editor',
  light: 'editor',
  midnight: 'editor',
  'page-dark': 'page',
  'page-light': 'page',
  'page-midnight': 'page',
  'entry-dark': 'entry',
  'entry-light': 'entry',
  'entry-midnight': 'entry',
}

/** 主题注册表项。 */
export interface ThemeEntry {
  id: BuiltinThemeId
  scope: TokenScope
  /** 令牌集（与作用域的默认主题一致，但独立存放以便单测逐项比对 17.4）。 */
  tokens: TokenSet
}

/** 内置主题注册表。 */
export const THEME_REGISTRY: Readonly<Record<BuiltinThemeId, ThemeEntry>> = Object.freeze(
  Object.fromEntries(
    BUILTIN_THEME_IDS.map((id) => {
      const scope = THEME_SCOPE[id]
      const base = scope === 'editor' ? id : id.slice(scope === 'page' ? 'page-'.length : 'entry-'.length)
      const variant = (base || 'dark') as keyof typeof BUILTIN_TOKENS
      return [id, { id, scope, tokens: { ...BUILTIN_TOKENS[variant] } } as ThemeEntry]
    }),
  ) as Record<BuiltinThemeId, ThemeEntry>,
)

/** 按作用域列出可选主题 id（`ThemePicker` 的分组数据源，17.4 表）。 */
export function themesOfScope(scope: TokenScope): BuiltinThemeId[] {
  return BUILTIN_THEME_IDS.filter((id) => THEME_SCOPE[id] === scope)
}

/** 缺省主题：编辑器 `dark`、页面 `page-dark`、条目跟随页面（D-13 / PRD 页面编辑器 8）。 */
export const DEFAULT_THEME: Readonly<Record<TokenScope, BuiltinThemeId>> = {
  editor: 'dark',
  page: 'page-dark',
  entry: 'entry-dark',
}

/**
 * 解析一个主题引用为可写入样式的令牌集。
 *
 * | `theme` | 结果 |
 * | --- | --- |
 * | `{kind:'builtin', value}` | 内置令牌集（未知 id 回退 `DEFAULT_THEME[scope]`） |
 * | `{kind:'data', value: CSS}` | 从 CSS 抽取 `--iforge-*` 变量，**缺失键回退内置默认**（D-13） |
 * | `{kind:'asset', value}` | 与 data 同形（10.1 已把资产解析为 CSS 文本；未解析时回退默认） |
 */
export function resolveThemeTokens(theme: ThemeRef | undefined, scope: TokenScope): TokenSet {
  const fallback = THEME_REGISTRY[DEFAULT_THEME[scope]].tokens
  if (!theme) return fallback
  if (theme.kind === 'builtin') {
    const entry = THEME_REGISTRY[theme.value as BuiltinThemeId]
    return entry ? entry.tokens : fallback
  }
  const parsed = parseCustomTheme(theme.value)
  return completeTokens(parsed[scope], fallback)
}

/**
 * 页面主题 + 条目主题的**实际生效**令牌（PRD 页面编辑器 8「默认跟随契合页面主题的样式」）。
 *
 * `entryTheme` 省略时跟随页面主题；给出时用自己的令牌。缺 `--iforge-*` 变量的自定义主题
 * 逐键回退到该作用域的内置默认（D-13）。
 */
export function resolveEntryTokens(pageTheme: ThemeRef | undefined, entryTheme: ThemeRef | undefined): TokenSet {
  if (!entryTheme) return resolveThemeTokens(pageTheme, 'entry')
  return resolveThemeTokens(entryTheme, 'entry')
}

/**
 * 主题 -> `:root{…}` CSS 文本（可直接写进 `style` 标签或注入预览 iframe）。
 *
 * 自定义主题**不做** CSS 级联拼接：只输出令牌变量（7.8「令牌注入」），布局由
 * 编辑器/游戏自带的样式表负责，因此自定义主题无法破坏布局结构。
 */
export function themeToCss(theme: ThemeRef | undefined, scope: TokenScope): string {
  return `:root{${tokensToCss(resolveThemeTokens(theme, scope), scope)}}`
}

/** 判断引用是否为已知内置主题（`ThemePicker` 选中态用）。 */
export function isBuiltinTheme(theme: ThemeRef | undefined): boolean {
  return theme?.kind === 'builtin' && theme.value in THEME_REGISTRY
}
