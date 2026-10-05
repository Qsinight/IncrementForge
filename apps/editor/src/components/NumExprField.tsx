/**
 * `NumExprField` —— 数值/表达式双模式字段（TECH_DESIGN 7.6、D-29、D-36）。
 *
 * ## 为什么要显式区分两种模式（7.6 末条）
 *
 * `initial`/`max`/`buyAmount` 与 `costs[i].amount` 等字段在数据模型里都是**字符串**（`NumExpr`），
 * 但运行时赋值写入的是**求值后的常量文本**（D-29）。若输入框不区分模式，作者会把
 * “我要写表达式”和“我要写一个数”混为一谈，并在运行时赋值后困惑于表达式被替换成常量。
 * 因此：
 *
 * - **数值模式**：只接受数值字面量（含 `1e10`、`1e1e10`、`Infinity`），不编译；
 * - **表达式模式**：按所属上下文编译校验（5.5），显示错误码、可用函数与片段。
 *
 * 模式选择本身**不入项目文件**：它只是同一段文本的编辑视图，按内容自动判断初值。
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import { isForgeError } from '@iforge/num'
import type { ContextKind } from '@iforge/expr'
import { t } from '@iforge/i18n'

import { CONTEXT_LABEL, checkExpression, describeContext, snippetsFor, tryEvaluate } from '../lib/expression-check.js'
import { Field } from './fields.js'

/** 试算节流延迟（5.8「输入停顿 300ms」）。 */
export const EVALUATE_DEBOUNCE_MS = 300

export interface NumExprFieldProps {
  label: string
  value: string
  onChange(value: string): void
  /** 求值上下文（5.5）：决定编译期权限与提示。 */
  context: ContextKind
  hint?: string
  /** 片段基准路径（形如 `gen.g1`），给出后显示常用片段（5.8）。 */
  snippetBase?: string
  disabled?: boolean
  /** 额外行内的简短提示（例如 5.9.3 的 D-29 说明）。 */
  inlineHint?: string
}

/**
 * 判断文本是否为纯数值字面量。
 *
 * 用**正则**而不是 `Num.fromString`：break_eternity 的解析器很宽松，会把 `10 * rand()`
 * 解析成 `10` 并忽略尾部垃圾（实测），那会让含随机函数的价格文本被误判为“数值模式”，
 * 于是 `E_RAND_DISABLED` 这类**编译期**错误在界面上被静默吞掉（PRD 补充 1）。
 *
 * 允许的分层指数写法（5.2）：`1e1e10` 由多个指数段组成。
 */
const NUMERIC_LITERAL = /^[+-]?(?:\d+(?:\.\d+)?)(?:[eE][+-]?\d+)*$/

export function isNumericLiteral(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  // `Infinity` 是合法数字字面量（D-46），表示“无上限”。
  if (/^[+-]?Infinity$/.test(trimmed)) return true
  return NUMERIC_LITERAL.test(trimmed)
}

export function NumExprField({ label, value, onChange, context, hint, snippetBase, disabled, inlineHint }: NumExprFieldProps) {
  const [mode, setMode] = useState<'numeric' | 'expression'>(() => (isNumericLiteral(value) ? 'numeric' : 'expression'))
  const [preview, setPreview] = useState<{ text: string; ms: number; error?: string } | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 外部改值（例如撤销/重做、切换选中条目）时重新判断模式。
  useEffect(() => {
    setMode(isNumericLiteral(value) ? 'numeric' : 'expression')
  }, [value])

  const check = useMemo(() => (mode === 'expression' ? checkExpression(value, context) : { ok: true }), [mode, value, context])
  const hints = useMemo(() => describeContext(context), [context])
  const snippets = useMemo(() => (snippetBase ? snippetsFor(snippetBase) : []), [snippetBase])

  // 5.8：失焦与“输入停顿 300ms”时在影子运行时试算。
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (!check.ok || mode !== 'expression') {
      setPreview(undefined)
      return
    }
    timer.current = setTimeout(() => {
      try {
        const result = tryEvaluate(value, context)
        setPreview(result)
      } catch (error) {
        setPreview({ text: '—', ms: 0, error: isForgeError(error) ? error.code : String(error) })
      }
    }, EVALUATE_DEBOUNCE_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [value, context, check.ok, mode])

  const numericError = mode === 'numeric' && !isNumericLiteral(value) ? `${t('expr.invalid')}：不是数值字面量` : undefined

  return (
    <div className="numexpr">
      <div className="numexpr-head">
        <span className="numexpr-label">{label}</span>
        <div className="segmented" role="group" aria-label={label}>
          <button
            type="button"
            className={mode === 'numeric' ? 'seg active' : 'seg'}
            aria-pressed={mode === 'numeric'}
            onClick={() => setMode('numeric')}
          >
            {t('expr.numericMode')}
          </button>
          <button
            type="button"
            className={mode === 'expression' ? 'seg active' : 'seg'}
            aria-pressed={mode === 'expression'}
            onClick={() => setMode('expression')}
          >
            {t('expr.expressionMode')}
          </button>
        </div>
      </div>
      <Field
        label={`${label} · ${CONTEXT_LABEL[context]}`}
        hint={mode === 'expression' ? (inlineHint ?? t('expr.modeHint')) : hint}
        error={check.ok ? numericError : `${check.code}: ${check.message ?? ''}`}
      >
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            className="input textarea expr"
            rows={mode === 'expression' ? 2 : 1}
            value={value}
            disabled={disabled}
            spellCheck={false}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </Field>

      {mode === 'expression' && !check.ok ? null : mode === 'expression' ? (
        <div className="numexpr-meta">
          <span className={check.ok ? 'badge ok' : 'badge error'}>{check.ok ? t('expr.valid') : t('expr.invalid')}</span>
          {preview ? (
            <span className="badge muted">
              {t('expr.preview')}：{preview.text}（{preview.ms.toFixed(2)}ms{preview.error ? ` · ${preview.error}` : ''}）
            </span>
          ) : (
            <span className="badge muted">{t('expr.previewUnavailable')}</span>
          )}
          <details className="numexpr-help">
            <summary>{t('expr.dosAndDonts')}</summary>
            <ul className="numexpr-fn">
              {hints.map((hintItem) => (
                <li key={hintItem.name}>
                  <code>
                    {hintItem.name}({hintItem.arity})
                  </code>
                  {hintItem.random ? ' · rand' : ''}
                  {hintItem.effect ? ' · side-effect' : ''}
                </li>
              ))}
            </ul>
            {snippets.length > 0 ? (
              <div className="numexpr-snippets">
                {snippets.map((snippet) => (
                  <button key={snippet.label} type="button" className="chip" onClick={() => onChange(value + snippet.code)}>
                    {snippet.label}
                  </button>
                ))}
              </div>
            ) : null}
          </details>
        </div>
      ) : null}
    </div>
  )
}
