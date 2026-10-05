/**
 * 编辑器偏好（TECH_DESIGN 7.2 `settingsStore`、7.7「编辑器主题」、D-22）。
 *
 * | 内容 | 存储 | 是否进项目文件 |
 * | --- | --- | --- |
 * | 编辑器主题（PRD 设置页 1） | `meta` 仓库（`persist`） | ❌ |
 * | 预览面板宽度 / 折叠（7.1） | `meta` 仓库 | ❌ |
 * | 当前项目指针 | `meta` 仓库 | ❌ |
 * | 项目默认设置（游戏默认设置） | `projectStore.project.settings` | ✅（随“保存”落盘，7.7） |
 *
 * 主题切换写 `<html data-theme>`（7.8「主题切换」）——本模块只管状态与持久化，
 * 写 DOM 的动作放在 `applyEditorTheme()`，由 `main.tsx` 与设置页共同调用。
 */
import { create } from 'zustand'

import { META_KEYS } from '@iforge/persist'
import type { MetaRepository } from '@iforge/persist'
import { DEFAULT_THEME, THEME_REGISTRY, tokensToCss } from '@iforge/ui-kit'
import type { BuiltinThemeId } from '@iforge/ui-kit'

/** 编辑器主题取值：内置三档（17.4）。自定义主题属“设置页 1 的上传”，落在 `ThemePicker`。 */
export type EditorThemeId = BuiltinThemeId

interface SettingsState {
  theme: EditorThemeId
  /** 预览面板宽度（px）；`null` 表示用默认宽度。 */
  paneWidth: number
  paneCollapsed: boolean
  /** 自定义主题 CSS（PRD 设置页 1「也可由用户自行上传」，D-13）。 */
  customThemeCss: string | null
  /** 当前项目 id（7.9「新建/载入后切换当前项目」）。 */
  currentProjectId: string | null
  /** 是否已从 `meta` 载入（避免首帧用默认值覆盖已存偏好）。 */
  hydrated: boolean

  setTheme(theme: EditorThemeId): void
  setPaneWidth(width: number): void
  setPaneCollapsed(collapsed: boolean): void
  setCustomThemeCss(css: string | null): void
  setCurrentProjectId(id: string | null): void
  hydrate(snapshot: Partial<SettingsSnapshot>): void
  reset(): void
}

/** `meta` 仓库里的偏好快照。 */
export interface SettingsSnapshot {
  theme: EditorThemeId
  paneWidth: number
  paneCollapsed: boolean
  customThemeCss: string | null
  currentProjectId: string | null
}

/** 默认值（7.1 面板可拖拽，给一个适合 1440 宽屏的初值）。 */
export const DEFAULT_SETTINGS_SNAPSHOT: SettingsSnapshot = {
  theme: DEFAULT_THEME.editor,
  paneWidth: 420,
  paneCollapsed: false,
  customThemeCss: null,
  currentProjectId: null,
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ...DEFAULT_SETTINGS_SNAPSHOT,
  hydrated: false,

  setTheme: (theme) => set({ theme }),
  setPaneWidth: (paneWidth) => set({ paneWidth: Math.max(280, Math.min(1200, paneWidth)) }),
  setPaneCollapsed: (paneCollapsed) => set({ paneCollapsed }),
  setCustomThemeCss: (customThemeCss) => set({ customThemeCss }),
  setCurrentProjectId: (currentProjectId) => set({ currentProjectId }),
  hydrate: (snapshot) => set({ ...snapshot, hydrated: true }),
  reset: () => set({ ...DEFAULT_SETTINGS_SNAPSHOT, hydrated: true }),
}))

/**
 * 把当前主题写到 `<html data-theme>` 与令牌变量（7.8「主题切换写 `<html data-theme>`」）。
 *
 * 自定义主题**只注入令牌变量**（D-13），布局由自带样式表控制，因此自定义主题不会破坏布局。
 */
export function applyEditorTheme(root: HTMLElement | undefined = document.documentElement): void {
  const { theme, customThemeCss } = useSettingsStore.getState()
  root.setAttribute('data-theme', theme)
  const tokens = THEME_REGISTRY[theme]?.tokens
  root.setAttribute('style', `${tokens ? tokensToCss(tokens, 'editor') : ''}${customThemeCss ? `;${customThemeCss}` : ''}`)
}

/** 把 `meta` 仓库里的偏好读进 store（`main.tsx` 启动时调用一次）。 */
export async function hydrateSettings(meta: MetaRepository): Promise<void> {
  const [theme, paneWidth, paneCollapsed, currentProjectId] = await Promise.all([
    meta.get<EditorThemeId>(META_KEYS.theme),
    meta.get<number>(META_KEYS.paneWidth),
    meta.get<boolean>(META_KEYS.paneCollapsed),
    meta.get<string>(META_KEYS.currentProjectId),
  ])
  useSettingsStore.getState().hydrate({
    theme: theme && theme in THEME_REGISTRY ? theme : DEFAULT_SETTINGS_SNAPSHOT.theme,
    paneWidth: typeof paneWidth === 'number' ? paneWidth : DEFAULT_SETTINGS_SNAPSHOT.paneWidth,
    paneCollapsed: paneCollapsed === true,
    customThemeCss: null,
    currentProjectId: currentProjectId ?? null,
  })
  applyEditorTheme()
}
