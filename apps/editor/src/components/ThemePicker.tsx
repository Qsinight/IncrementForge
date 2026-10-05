/**
 * 主题选择器（TECH_DESIGN 7.6「ThemePicker」、7.8、13 第 5 条、D-13、17.4）。
 *
 * 三类作用域各自提供三档内置主题（17.4），另可上传自定义 CSS：
 * 1. 选内置 → `{kind:'builtin', value}`；
 * 2. 选自定义 → 走 `ui-kit` 的 `sanitizeTheme`（剥 `@import`/非 data URL/脚本协议、转义尖括号），
 *    缺 `--iforge-*` 必需令牌时**提示但仍允许**（D-13：缺失的单个变量由 `completeTokens` 逐键回退，
 *    不因为缺一个变量就丢掉作者的整段主题）；
 * 3. 上传后由编辑器写入资产库，项目内以 `{kind:'asset', value: assetId}` 引用（D-12）。
 */
import { useRef, useState } from 'react'

import { t } from '@iforge/i18n'
import { sanitizeTheme, themesOfScope } from '@iforge/ui-kit'
import type { TokenScope } from '@iforge/ui-kit'
import type { ThemeRef } from '@iforge/model'

import { Field } from './fields.js'

export interface ThemePickerProps {
  label?: string
  /** `undefined` 表示“跟随”（条目主题，PRD 页面编辑器 8）或“用默认主题”。 */
  value: ThemeRef | undefined
  onChange(value: ThemeRef | undefined): void
  scope: TokenScope
  hint?: string
  /** 允许“跟随页面主题”（条目主题专用，PRD 页面编辑器 8）。 */
  allowFollow?: boolean
  followLabel?: string
  disabled?: boolean
}

export function ThemePicker({ label = t('field.theme'), value, onChange, scope, hint, allowFollow, followLabel, disabled }: ThemePickerProps) {
  const [customCss, setCustomCss] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const fileRef = useRef<HTMLInputElement>(null)
  const builtinIds = themesOfScope(scope)

  const current = value?.kind === 'builtin' ? value.value : undefined

  const applyCustom = (): void => {
    try {
      const result = sanitizeTheme(customCss, 'theme')
      setError(result.missing.length > 0 ? `缺少令牌：${result.missing.join('、')}（将按默认值回退）` : undefined)
      onChange({ kind: 'data', value: result.css })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Field label={label} hint={hint ?? t('settings.editorThemeHint')} error={error}>
      {({ id }) => (
        <div className="theme-picker" id={id}>
          <div className="theme-grid">
            {allowFollow ? (
              <button
                type="button"
                disabled={disabled}
                className={value === undefined ? 'theme-cell active' : 'theme-cell'}
                aria-pressed={value === undefined}
                onClick={() => onChange(undefined)}
              >
                {followLabel ?? t('page.entryThemeFollow')}
              </button>
            ) : null}
            {builtinIds.map((id_) => (
              <button
                key={id_}
                type="button"
                disabled={disabled}
                className={current === id_ ? 'theme-cell active' : 'theme-cell'}
                aria-pressed={current === id_}
                onClick={() => onChange({ kind: 'builtin', value: id_ })}
              >
                {id_}
              </button>
            ))}
          </div>
          <div className="theme-custom">
            <textarea
              className="input textarea"
              rows={3}
              placeholder={
                ':root{--iforge-bg:#14161a;--iforge-surface:#1c1f25;--iforge-text:#e8eaed;--iforge-accent:#4c8dff;--iforge-danger:#ff5c5c}'
              }
              value={customCss}
              aria-label="自定义主题 CSS"
              onChange={(event) => setCustomCss(event.target.value)}
            />
            <div className="theme-custom-actions">
              <button type="button" className="btn" disabled={disabled || customCss === ''} onClick={applyCustom}>
                {t('common.confirm')}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".css,text/css"
                aria-label={t('common.upload')}
                onChange={async (event) => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  const text = await file.text()
                  setCustomCss(text)
                  try {
                    const result = sanitizeTheme(text, 'theme')
                    setError(result.missing.length > 0 ? `缺少令牌：${result.missing.join('、')}（将按默认值回退）` : undefined)
                    onChange({ kind: 'data', value: result.css })
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause))
                  }
                  event.target.value = ''
                }}
              />
            </div>
          </div>
        </div>
      )}
    </Field>
  )
}
