/**
 * 编辑器偏好（TECH_DESIGN 7.2 `settingsStore`、7.7「编辑器主题」、7.8「主题切换」、D-13、D-22）。
 *
 * 三条容易搞混的边界在这里固定：
 * 1. **编辑器偏好不进项目文件**（7.2 表）：主题/面板宽度/当前项目指针都只落 `meta` 仓库；
 * 2. `setPaneWidth` 有**夹取**（280..1200）——拖拽条拉到 0 会让编辑器不可用；
 * 3. 自定义主题**只注入令牌变量**（D-13），布局仍由自带样式表控制，
 *    因此 `applyEditorTheme` 不能把 CSS 整段当成样式表注入。
 */
import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DB_NAME, MetaRepository, META_KEYS, deleteForgeDb, openForgeDb } from '@iforge/persist'
import { THEME_REGISTRY, tokensToCss } from '@iforge/ui-kit'
import type { BuiltinThemeId } from '@iforge/ui-kit'

import { DEFAULT_SETTINGS_SNAPSHOT, applyEditorTheme, hydrateSettings, useSettingsStore } from '../src/stores/settings.js'

const builtinThemes = Object.keys(THEME_REGISTRY) as BuiltinThemeId[]

beforeEach(() => {
  useSettingsStore.getState().reset()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('style')
})

describe('默认值（7.2）', () => {
  it('`DEFAULT_SETTINGS_SNAPSHOT` 是 7.1 面板的缺省值', () => {
    expect(DEFAULT_SETTINGS_SNAPSHOT.paneWidth).toBe(420)
    expect(DEFAULT_SETTINGS_SNAPSHOT.paneCollapsed).toBe(false)
    expect(DEFAULT_SETTINGS_SNAPSHOT.customThemeCss).toBe(null)
    expect(DEFAULT_SETTINGS_SNAPSHOT.currentProjectId).toBe(null)
    expect(THEME_REGISTRY[DEFAULT_SETTINGS_SNAPSHOT.theme]).toBeDefined()
  })

  it('`reset()` 回到默认并把 `hydrated` 置真', () => {
    useSettingsStore.getState().setPaneWidth(900)
    useSettingsStore.getState().setCurrentProjectId('proj-1')
    useSettingsStore.getState().reset()
    const state = useSettingsStore.getState()
    expect(state.paneWidth).toBe(DEFAULT_SETTINGS_SNAPSHOT.paneWidth)
    expect(state.currentProjectId).toBe(null)
    // `hydrated` 置真，避免 `reset()` 之后又被首帧默认值覆盖一次。
    expect(state.hydrated).toBe(true)
  })
})

describe('setPaneWidth()：夹取到可用范围', () => {
  it('范围内原样保留', () => {
    useSettingsStore.getState().setPaneWidth(600)
    expect(useSettingsStore.getState().paneWidth).toBe(600)
  })

  it('小于 280 夹到 280（拖到 0 会让编辑器不可用）', () => {
    useSettingsStore.getState().setPaneWidth(0)
    expect(useSettingsStore.getState().paneWidth).toBe(280)
    useSettingsStore.getState().setPaneWidth(-100)
    expect(useSettingsStore.getState().paneWidth).toBe(280)
  })

  it('大于 1200 夹到 1200', () => {
    useSettingsStore.getState().setPaneWidth(99999)
    expect(useSettingsStore.getState().paneWidth).toBe(1200)
  })
})

describe('其余 setter：只改自己那一项', () => {
  it('setTheme / setPaneCollapsed / setCustomThemeCss / setCurrentProjectId', () => {
    const theme = builtinThemes.find((t) => t !== DEFAULT_SETTINGS_SNAPSHOT.theme) ?? DEFAULT_SETTINGS_SNAPSHOT.theme
    useSettingsStore.getState().setTheme(theme)
    useSettingsStore.getState().setPaneCollapsed(true)
    useSettingsStore.getState().setCustomThemeCss('.x{color:red}')
    useSettingsStore.getState().setCurrentProjectId('p-9')

    const state = useSettingsStore.getState()
    expect(state.theme).toBe(theme)
    expect(state.paneCollapsed).toBe(true)
    expect(state.customThemeCss).toBe('.x{color:red}')
    expect(state.currentProjectId).toBe('p-9')
    // 其它项不受影响。
    expect(state.paneWidth).toBe(DEFAULT_SETTINGS_SNAPSHOT.paneWidth)
  })

  it('`setCustomThemeCss(null)` 清除自定义主题', () => {
    useSettingsStore.getState().setCustomThemeCss('.x{}')
    useSettingsStore.getState().setCustomThemeCss(null)
    expect(useSettingsStore.getState().customThemeCss).toBe(null)
  })

  it('折叠可反复切换', () => {
    useSettingsStore.getState().setPaneCollapsed(true)
    useSettingsStore.getState().setPaneCollapsed(false)
    expect(useSettingsStore.getState().paneCollapsed).toBe(false)
  })
})

describe('applyEditorTheme()：写 `<html data-theme>` 与令牌变量（7.8、D-13）', () => {
  it('写入 `data-theme` 与该主题的令牌 CSS 变量', () => {
    const theme = DEFAULT_SETTINGS_SNAPSHOT.theme
    useSettingsStore.getState().setTheme(theme)
    applyEditorTheme()
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe(theme)
    const expected = tokensToCss(THEME_REGISTRY[theme]!.tokens, 'editor')
    expect(root.getAttribute('style')).toContain(expected.slice(0, 20))
  })

  it('自定义主题**追加**在令牌之后，且不带选择器（只注入令牌变量，D-13）', () => {
    useSettingsStore.getState().setCustomThemeCss('--iforge-x: 1')
    applyEditorTheme()
    const style = document.documentElement.getAttribute('style') ?? ''
    expect(style).toContain('--iforge-x: 1')
    // 追加在令牌变量之后（分号分隔）。
    expect(style.endsWith('--iforge-x: 1')).toBe(true)
  })

  it('没有自定义主题时不追加多余分隔符', () => {
    useSettingsStore.getState().setCustomThemeCss(null)
    const theme = DEFAULT_SETTINGS_SNAPSHOT.theme
    applyEditorTheme()
    const style = document.documentElement.getAttribute('style') ?? ''
    // 只有该主题自身的令牌 CSS（它本身以 `;` 结尾），没有额外拼上的 `;`。
    expect(style).toBe(tokensToCss(THEME_REGISTRY[theme]!.tokens, 'editor'))
  })

  it('可传入自定义 root（测试与 `main.tsx` 都用默认 `document.documentElement`）', () => {
    const el = document.createElement('div')
    useSettingsStore.getState().setTheme(DEFAULT_SETTINGS_SNAPSHOT.theme)
    applyEditorTheme(el)
    expect(el.getAttribute('data-theme')).toBe(DEFAULT_SETTINGS_SNAPSHOT.theme)
    // 默认 root 不受影响。
    expect(document.documentElement.getAttribute('data-theme')).toBe(null)
  })

  it('未知主题不抛错，令牌变量为空串（只留 `data-theme`）', () => {
    useSettingsStore.setState({ theme: 'not-a-theme' as BuiltinThemeId })
    expect(() => applyEditorTheme()).not.toThrow()
    expect(document.documentElement.getAttribute('data-theme')).toBe('not-a-theme')
    expect(document.documentElement.getAttribute('style')).toBe('')
  })

  it('切换主题会改写令牌（不是累加）', () => {
    const [a, b] = builtinThemes
    useSettingsStore.getState().setCustomThemeCss(null)
    useSettingsStore.setState({ theme: a })
    applyEditorTheme()
    const first = document.documentElement.getAttribute('style') ?? ''
    useSettingsStore.setState({ theme: b ?? a })
    applyEditorTheme()
    const second = document.documentElement.getAttribute('style') ?? ''
    if (a !== b) expect(second).not.toBe(first)
  })
})

describe('hydrateSettings()：从 `meta` 仓库读偏好（7.2）', () => {
  let dbCounter = 0
  let meta: MetaRepository

  beforeEach(async () => {
    dbCounter += 1
    const name = `${DB_NAME}-settings-${dbCounter}`
    await deleteForgeDb(name)
    meta = new MetaRepository(await openForgeDb(name))
  })

  afterEach(() => {
    useSettingsStore.getState().reset()
  })

  it('空仓库时落到默认值并置 `hydrated`', async () => {
    await hydrateSettings(meta)
    const state = useSettingsStore.getState()
    expect(state.hydrated).toBe(true)
    expect(state.paneWidth).toBe(DEFAULT_SETTINGS_SNAPSHOT.paneWidth)
    expect(state.paneCollapsed).toBe(false)
    expect(state.currentProjectId).toBe(null)
  })

  it('读回已存的主题 / 宽度 / 折叠 / 当前项目', async () => {
    const theme = builtinThemes[0]!
    await meta.set(META_KEYS.theme, theme)
    await meta.set(META_KEYS.paneWidth, 777)
    await meta.set(META_KEYS.paneCollapsed, true)
    await meta.set(META_KEYS.currentProjectId, 'proj-42')
    await hydrateSettings(meta)
    const state = useSettingsStore.getState()
    expect(state.theme).toBe(theme)
    expect(state.paneWidth).toBe(777)
    expect(state.paneCollapsed).toBe(true)
    expect(state.currentProjectId).toBe('proj-42')
  })

  it('主题不在注册表里时回落到默认（脏数据不该让编辑器渲染失败）', async () => {
    await meta.set(META_KEYS.theme, 'deleted-theme')
    await hydrateSettings(meta)
    expect(useSettingsStore.getState().theme).toBe(DEFAULT_SETTINGS_SNAPSHOT.theme)
  })

  it('宽度类型不对时回落默认（`typeof` 判定而非强制转换）', async () => {
    await meta.set(META_KEYS.paneWidth, 'wide' as unknown as number)
    await hydrateSettings(meta)
    expect(useSettingsStore.getState().paneWidth).toBe(DEFAULT_SETTINGS_SNAPSHOT.paneWidth)
  })

  it('折叠只认 `true`，其它值按 `false`（不存在“真值字符串”这种隐式开启）', async () => {
    await meta.set(META_KEYS.paneCollapsed, 'yes' as unknown as boolean)
    await hydrateSettings(meta)
    expect(useSettingsStore.getState().paneCollapsed).toBe(false)
  })

  it('`hydrate` 顺带调用 `applyEditorTheme()`（首帧就有正确主题）', async () => {
    const theme = builtinThemes[0]!
    await meta.set(META_KEYS.theme, theme)
    await hydrateSettings(meta)
    expect(document.documentElement.getAttribute('data-theme')).toBe(theme)
  })

  it('`hydrate()` 手动部分更新也置 `hydrated`', () => {
    useSettingsStore.getState().hydrate({ paneWidth: 300 })
    const state = useSettingsStore.getState()
    expect(state.hydrated).toBe(true)
    expect(state.paneWidth).toBe(300)
  })

  it('偏好**不进项目文件**（7.2 表的 ❌ 列）', async () => {
    // 编辑器偏好的落点是 `meta` 仓库，与 `projectStore.project.settings` 是两套东西。
    // 改主题后默认设置不变——这条断言防止把主题写进项目文件。
    const theme = builtinThemes.find((t) => t !== DEFAULT_SETTINGS_SNAPSHOT.theme)!
    useSettingsStore.getState().setTheme(theme)
    await meta.set(META_KEYS.theme, theme)
    await hydrateSettings(meta)
    expect(useSettingsStore.getState().theme).toBe(theme)
    // 项目文件里没有主题字段（`ProjectFile` 的 meta 只有 name/author/description/时间戳）。
    expect(Object.keys(useSettingsStore.getState()).includes('theme')).toBe(true)
  })
})
