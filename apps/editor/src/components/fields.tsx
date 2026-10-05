/**
 * 基础表单控件（TECH_DESIGN 7.6「通用控件」、7.1 可访问性基线）。
 *
 * 可访问性基线（7.1 末条）在本文件统一落实：
 * ① 每个控件都有 `<label for>` 绑定，Tab 顺序与视觉顺序一致；
 * ② 校验错误用 `aria-invalid` + `aria-describedby` 关联，**不只用颜色**传达；
 * ③ 纯图标按钮必须有 `aria-label`（见 `IconButton`）。
 */
import type { ChangeEvent, ReactNode } from 'react'

import { t } from '@iforge/i18n'

let seq = 0
/** 稳定 id：`useId` 之外的场景（模块级函数生成 id）也能拿到不重复的值。 */
export function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

export interface FieldProps {
  label: string
  /** 字段说明（PRD/7.6 要求的提示文案，如“数量上限必定大于零”）。 */
  hint?: string
  /** 错误码 + 文案；非空即渲染红框（6.4 的定位结果）。 */
  error?: string
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode
}

/** 字段外壳：label + 控件 + 提示 + 错误。 */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = nextId('field')
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** 单行文本。 */
export function TextField(props: {
  label: string
  value: string
  onChange(value: string): void
  hint?: string
  error?: string
  placeholder?: string
  disabled?: boolean
}) {
  const { label, value, onChange, hint, error, placeholder, disabled } = props
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          className="input"
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        />
      )}
    </Field>
  )
}

/** 多行文本。 */
export function TextAreaField(props: { label: string; value: string; onChange(value: string): void; hint?: string; error?: string; rows?: number }) {
  const { label, value, onChange, hint, error, rows = 3 } = props
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <textarea
          id={id}
          className="input textarea"
          rows={rows}
          value={value}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
        />
      )}
    </Field>
  )
}

/** 布尔开关（PRD 各编辑器的“游戏可见/是否禁用/是否点击器/每秒生效”）。 */
export function ToggleField(props: { label: string; value: boolean; onChange(value: boolean): void; hint?: string; disabled?: boolean }) {
  const { label, value, onChange, hint, disabled } = props
  return (
    <Field label={label} hint={hint}>
      {({ id, describedBy }) => (
        <input
          id={id}
          className="toggle"
          type="checkbox"
          checked={value}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
        />
      )}
    </Field>
  )
}

/** 数值输入（逻辑帧率、列数、tick 间隔等普通数字字段）。 */
export function NumberField(props: {
  label: string
  value: number
  onChange(value: number): void
  hint?: string
  error?: string
  min?: number
  max?: number
  step?: number
}) {
  const { label, value, onChange, hint, error, min, max, step } = props
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          className="input"
          type="number"
          value={Number.isFinite(value) ? value : 0}
          min={min}
          max={max}
          step={step}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const next = Number(event.target.value)
            if (Number.isFinite(next)) onChange(next)
          }}
        />
      )}
    </Field>
  )
}

/** 下拉选择（数字格式、主题等枚举）。 */
export function SelectField<T extends string>(props: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange(value: T): void
  hint?: string
  error?: string
  disabled?: boolean
}) {
  const { label, value, options, onChange, hint, error, disabled } = props
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          className="input"
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}

/** 只读文本（PRD 设置页 5 的四项不可编辑字段）。 */
export function ReadonlyField(props: { label: string; value: string; hint?: string }) {
  const { label, value, hint } = props
  return (
    <Field label={label} hint={hint}>
      {({ id }) => (
        <output className="input readonly" id={id}>
          {value || t('common.unknown')}
        </output>
      )}
    </Field>
  )
}
