/**
 * 游戏内设置页（PRD 预览区 9、8.10，10.3，D-18、D-22、R-24）。
 *
 * ## 来源徽标是**强制** UI 元素
 *
 * 8.10 明确：每个可改设置旁显示来源徽标（“项目默认”/“本会话覆盖”），已被覆盖的项高亮并提示
 * “仅本会话有效，不会改写作者的项目默认设置”。8.10 同时把它定性为 R-24 的界面侧防线——
 * **不可配置隐藏**，缺失即视为实现偏差。因此 `data-testid="settings-source-badge"`
 * 在每一行都渲染，单测逐行断言其存在（见 `test/view.test.tsx`）。
 *
 * ## 设置改动的去向（D-22）
 *
 * 页面只把改动交给 `GameController.setGameSetting()`：
 * - 预览态：控制器写 `settingsOverride` 并回传 `game:event{type:'settings'}`，
 *   宿主只写 `previewStore`（**不写项目文件**，R-24）；
 * - 打包态：`build` 包把覆盖值落 `localStorage`（M5）。
 *
 * 两条路径都不碰 `projectStore`，因此“玩一次预览改写作者设计默认值”不可能发生。
 */
import type { SettingsFieldView, SettingsPageView } from '@iforge/runtime'
import { THEME_FOLLOW_PAGE } from '@iforge/runtime'
import { t } from '@iforge/i18n'
import { themesOfScope } from '@iforge/ui-kit'

export interface SettingsPageProps {
  settings: SettingsPageView
  onChange(key: string, value: string): void
  /** “页面主题”开关：只改会话偏好（D-22 同层），不改作者的页面主题。 */
  onChangeTheme(value: string): void
  onResetDefaults(): void
  onExportSave(): void
  onImportSave(): void
  onRestart(): void
  /** 暂停态提示（8.3.1 末条：预览诊断面板可提示“已暂停，副作用待恢复后生效”）。 */
  paused: boolean
}

/**
 * “页面主题”这一行（内置设置页的主题切换，8.10）。
 *
 * 复用 `SettingsRow` 而不是单写一行：来源徽标（8.10 的强制 UI 元素）与高亮样式
 * 因此**不可能**漏掉——主题偏好与 `settings` 同属玩家偏好层，徽标口径必须一致
 * （R-24 的界面侧防线：“不回写项目文件”这件事要让人看得见）。
 *
 * 选项里的“跟随页面”用**空串**表示（`THEME_FOLLOW_PAGE`），它是 `<option value="">`，
 * 因此不需要额外哨兵就能被选中（见 view-model 里该常量的注释）。
 */
function ThemeRow({ settings, onChange }: { settings: SettingsPageView; onChange(value: string): void }) {
  const field: SettingsFieldView = {
    key: 'theme',
    label: t('game.theme'),
    kind: 'select',
    options: [
      { value: THEME_FOLLOW_PAGE, label: t('game.themeFollowPage') },
      ...themesOfScope('page').map((id) => ({ value: `builtin:${id}`, label: id })),
    ],
    value: settings.theme.value,
    effective: settings.theme.value,
    overridden: settings.theme.overridden,
    // “项目默认” = 作者给当前页面设定的主题；停在内置设置页时由视图模型给出初始页面的主题。
    projectDefault: settings.theme.projectTheme,
  }
  return <SettingsRow field={field} onChange={(_key, value) => onChange(value)} testId="settings-theme" />
}

export function SettingsPage({
  settings,
  onChange,
  onChangeTheme,
  onResetDefaults,
  onExportSave,
  onImportSave,
  onRestart,
  paused,
}: SettingsPageProps) {
  return (
    <section className="game-settings" aria-label={t('game.settingsTitle')}>
      <h2 className="settings-title" data-testid="settings-title">
        {t('game.settingsTitle')}
      </h2>

      <dl className="settings-info" data-testid="settings-info">
        <div>
          <dt>{t('game.projectName')}</dt>
          <dd data-testid="info-name">{settings.projectName}</dd>
        </div>
        <div>
          <dt>{t('game.author')}</dt>
          <dd data-testid="info-author">{settings.author}</dd>
        </div>
        <div>
          <dt>{t('game.projectDescription')}</dt>
          <dd data-testid="info-description">{settings.description}</dd>
        </div>
        <div>
          <dt>{t('game.gameTime')}</dt>
          <dd data-testid="info-gametime">{settings.gameTime}</dd>
        </div>
        <div>
          <dt>{t('game.offlineTime')}</dt>
          <dd data-testid="info-offlinetime">{settings.offlineTime}</dd>
        </div>
        <div>
          <dt>{t('game.playtime')}</dt>
          <dd data-testid="info-playtime">{settings.playtime}</dd>
        </div>
        <div>
          <dt>{t('game.lastSave')}</dt>
          <dd data-testid="info-savedat">{settings.savedAt}</dd>
        </div>
      </dl>

      <div className="settings-fields" data-testid="settings-fields">
        {/* 主题开关排在游戏设置之前：它决定的是“整屏长什么样”，
            放在最上面才能让玩家立刻看到自己的选择生效。 */}
        <ThemeRow settings={settings} onChange={onChangeTheme} />
        {settings.settings.map((field) => (
          <SettingsRow key={field.key} field={field} onChange={onChange} />
        ))}
      </div>

      <div className="settings-actions">
        <button type="button" className="btn" data-testid="settings-restore-defaults" onClick={onResetDefaults}>
          {t('game.restoreDefaults')}
        </button>
        <button type="button" className="btn" data-testid="settings-export-save" onClick={onExportSave}>
          {t('game.exportSave')}
        </button>
        <button type="button" className="btn" data-testid="settings-import-save" onClick={onImportSave}>
          {t('game.importSave')}
        </button>
        <button type="button" className="btn danger" data-testid="settings-restart" onClick={onRestart}>
          {t('game.restart')}
        </button>
      </div>

      {paused ? (
        <p className="muted small" data-testid="settings-paused-hint">
          {t('game.pausedSideEffectHint')}
        </p>
      ) : null}
      <p className="muted small" data-testid="settings-dynamic-count">
        {t('game.dynamicCount', { count: settings.dynamicCount, limit: settings.dynamicLimit })}
      </p>
    </section>
  )
}

/** 一行可改设置。`testId` 让“非 settings 的那一行”（主题开关）也有稳定的定位点。 */
function SettingsRow({
  field,
  onChange,
  testId = 'settings-row',
}: {
  field: SettingsFieldView
  onChange(key: string, value: string): void
  testId?: string
}) {
  // 主题开关那行（`testId = 'settings-theme'`）另给一组 testid：它不是
  // `ProjectSettings` 的字段，与 settings 共用 testid 会让
  // `getAllByTestId('settings-source-badge').first()` 先命中主题行，
  // 读到与被测行无关的徽标。
  const badgeTestId = testId === 'settings-row' ? 'settings-source-badge' : 'settings-theme-source-badge'
  const inputTestId = testId === 'settings-row' ? 'settings-input' : 'settings-theme-input'
  return (
    <div className={field.overridden ? 'settings-row overridden' : 'settings-row'} data-testid={testId} data-key={field.key}>
      <label className="settings-label" htmlFor={`setting-${field.key}`}>
        {field.label}
      </label>
      <div className="settings-control">
        {field.kind === 'select' ? (
          <select
            id={`setting-${field.key}`}
            className="input"
            data-testid={inputTestId}
            value={field.value}
            onChange={(event) => onChange(field.key, event.target.value)}
          >
            {field.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : field.kind === 'boolean' ? (
          <input
            id={`setting-${field.key}`}
            type="checkbox"
            data-testid="settings-input"
            checked={field.value === 'true'}
            onChange={(event) => onChange(field.key, event.target.checked ? 'true' : 'false')}
          />
        ) : (
          <input
            id={`setting-${field.key}`}
            type="number"
            className="input"
            data-testid="settings-input"
            value={field.value}
            onChange={(event) => onChange(field.key, event.target.value)}
          />
        )}
        {/* 来源徽标：8.10 的强制 UI 元素（R-24 的界面侧防线），逐行渲染。 */}
        <span
          className={field.overridden ? 'badge override' : 'badge'}
          data-testid={badgeTestId}
          data-source={field.overridden ? 'session' : 'project'}
          title={field.overridden ? t('game.settingsOverrideHint', { value: field.projectDefault }) : t('game.settingsProjectDefault')}
        >
          {field.overridden ? t('game.sourceOverride') : t('game.sourceProject')}
        </span>
      </div>
    </div>
  )
}
