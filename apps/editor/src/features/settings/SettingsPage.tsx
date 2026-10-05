/**
 * 设置页面（TECH_DESIGN 7.7、PRD 设置页面 1–6、D-22、6.5.5）。
 *
 * | PRD 字段 | 控件 | 存储 | 可改 |
 * | --- | --- | --- | --- |
 * | 1 编辑器主题 | `ThemePicker`（内置 + 上传 CSS） | `settingsStore` + `meta` 仓库 | ✅ |
 * | 2 项目名称 | 文本框 | `ProjectFile.meta.name` | ✅（改后立即同步标题栏与预览，7.7） |
 * | 3 项目作者 | 文本框 | `meta.author` | ✅ |
 * | 4 项目描述 | 文本域 | `meta.description` | ✅ |
 * | 5 创建时间/最后修改/引擎版本/当前引擎 | 只读文本 | `meta.createdAt`/`modifiedAt`/`engineVersion`/常量 | ❌ |
 * | 6 游戏默认设置 | 6 个控件 + 来源徽标 | `ProjectFile.settings` | ✅ |
 *
 * **来源徽标是强制 UI 元素**（8.10、7.7 末条、R-24）：每一项旁显示“项目默认 / 本会话覆盖”，
 * 并提供“恢复默认设置”。项目级默认值只在**编辑器**修改（D-22）；
 * 游戏内设置页产生的会话覆盖由预览上报、只写 `previewStore`（M4 接入）。
 */
import type { ReactNode } from 'react'

import { t } from '@iforge/i18n'
import { DEFAULT_SETTINGS, ENGINE_VERSION } from '@iforge/model'
import type { NumberFormat, ProjectFile, ProjectSettings } from '@iforge/model'
import { THEME_REGISTRY } from '@iforge/ui-kit'

import { ThemePicker } from '../../components/ThemePicker.js'
import { NumberField, ReadonlyField, SelectField, TextAreaField, TextField, ToggleField } from '../../components/fields.js'
import { commitProject } from '../../stores/form.js'
import { usePreviewStore } from '../../stores/preview.js'
import { applyEditorTheme, useSettingsStore } from '../../stores/settings.js'
import type { EditorThemeId } from '../../stores/settings.js'

/** 数字格式枚举（4.5、D-17）。 */
const NUMBER_FORMATS: ReadonlyArray<{ value: NumberFormat; label: string }> = [
  { value: 'standard', label: 'standard（默认）' },
  { value: 'scientific', label: 'scientific（科学计数）' },
  { value: 'engineering', label: 'engineering（工程计数）' },
  { value: 'letters', label: 'letters（字母记数）' },
  { value: 'layered', label: 'layered（分层指数）' },
]

export function SettingsPage({ project }: { project: ProjectFile }) {
  const theme = useSettingsStore((state) => state.theme)
  const setTheme = useSettingsStore((state) => state.setTheme)
  // 预览态里游戏内设置页产生的**会话覆盖**（D-22，M4 上报后写入 `previewStore`）。
  // M3 尚未接 iframe，恒为空对象——但徽标逻辑已按它分支，接上预览即自动生效。
  const overrides = usePreviewStore((state) => state.settingsOverride)

  const setSetting = <K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]): void => {
    commitProject('settings', (draft) => {
      draft.settings[key] = value
    })
  }

  /** 来源徽标：项目级默认值 vs 本会话覆盖（8.10 的强制 UI 元素，R-24）。 */
  const badgeOf = (key: keyof ProjectSettings): string => (key in overrides ? t('settings.source.override') : t('settings.source.project'))

  return (
    <div className="settings-page" data-testid="settings-page">
      <section className="form-section">
        <h3>{t('settings.editorTheme')}</h3>
        <ThemePicker
          label={t('settings.editorTheme')}
          scope="editor"
          value={{ kind: 'builtin', value: theme }}
          hint={t('settings.editorThemeHint')}
          onChange={(next) => {
            if (!next || next.kind !== 'builtin' || !(next.value in THEME_REGISTRY)) return
            setTheme(next.value as EditorThemeId)
            applyEditorTheme()
          }}
        />
      </section>

      <section className="form-section">
        <h3>{t('lifecycle.projectName')}</h3>
        <TextField
          label={t('settings.projectName')}
          value={project.meta.name}
          onChange={(name) => commitProject('meta-name', (draft) => void (draft.meta.name = name), 'meta.name')}
        />
        <TextField
          label={t('settings.author')}
          value={project.meta.author}
          onChange={(author) => commitProject('meta-author', (draft) => void (draft.meta.author = author), 'meta.author')}
        />
        <TextAreaField
          label={t('settings.projectDescription')}
          value={project.meta.description}
          onChange={(description) => commitProject('meta-desc', (draft) => void (draft.meta.description = description), 'meta.description')}
        />
        <div className="grid-2">
          <ReadonlyField label={t('lifecycle.createdAt')} value={project.meta.createdAt} />
          <ReadonlyField label={t('lifecycle.modifiedAt')} value={project.meta.modifiedAt} />
          <ReadonlyField label={t('lifecycle.engineVersion')} value={project.engineVersion} />
          <ReadonlyField label={t('lifecycle.currentEngine')} value={ENGINE_VERSION} />
        </div>
      </section>

      <section className="form-section">
        <h3>{t('settings.game')}</h3>
        <p className="muted">{t('settings.gameHint')}</p>
        <p className="muted small">{t('settings.validation')}</p>
        <div className="grid-2">
          <SettingRow label={t('settings.numberFormat')} badge={badgeOf('numberFormat')}>
            <SelectField
              label={t('settings.numberFormat')}
              value={project.settings.numberFormat}
              options={NUMBER_FORMATS}
              onChange={(value) => setSetting('numberFormat', value)}
            />
          </SettingRow>
          <SettingRow label={t('settings.tickRate')} badge={badgeOf('tickRate')}>
            <NumberField
              label={t('settings.tickRate')}
              value={project.settings.tickRate}
              min={1}
              step={1}
              onChange={(value) => setSetting('tickRate', Math.max(1, Math.round(value)))}
            />
          </SettingRow>
          <SettingRow label={t('settings.maxFrameStep')} badge={badgeOf('maxFrameStep')}>
            <NumberField
              label={t('settings.maxFrameStep')}
              value={project.settings.maxFrameStep}
              min={1}
              step={10}
              onChange={(value) => setSetting('maxFrameStep', Math.max(1, value))}
            />
          </SettingRow>
          <SettingRow label={t('settings.autosaveInterval')} badge={badgeOf('autosaveInterval')}>
            <NumberField
              label={t('settings.autosaveInterval')}
              value={project.settings.autosaveInterval}
              min={1}
              step={5}
              onChange={(value) => setSetting('autosaveInterval', Math.max(1, value))}
            />
          </SettingRow>
          <SettingRow label={t('settings.offlineEnabled')} badge={badgeOf('offlineEnabled')}>
            <ToggleField
              label={t('settings.offlineEnabled')}
              value={project.settings.offlineEnabled}
              onChange={(value) => setSetting('offlineEnabled', value)}
            />
          </SettingRow>
          <SettingRow label={t('settings.offlineCap')} badge={badgeOf('offlineCap')}>
            <NumberField
              label={t('settings.offlineCap')}
              value={project.settings.offlineCap}
              min={0}
              step={1}
              onChange={(value) => setSetting('offlineCap', Math.max(0, value))}
            />
          </SettingRow>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() =>
            commitProject('settings-reset', (draft) => {
              draft.settings = { ...DEFAULT_SETTINGS }
            })
          }
        >
          {t('settings.restoreDefaults')}
        </button>
      </section>
    </div>
  )
}

/** 设置项 + 来源徽标（8.10 的强制 UI 元素，不可配置隐藏）。 */
function SettingRow({ label, badge, children }: { label: string; badge: string; children: ReactNode }) {
  return (
    <div className="setting-row" data-setting={label}>
      <span className="badge source" title={t('settings.gameHint')}>
        {badge}
      </span>
      {children}
    </div>
  )
}
