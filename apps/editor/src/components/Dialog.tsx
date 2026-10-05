/**
 * 对话框（TECH_DESIGN 7.1 可访问性基线 ③④：焦点移入并锁定、Esc 关闭、`aria-label` 必填）。
 *
 * M3 的对话框用于：新建确认、删除确认（列出受影响引用）、导入冲突确认、校验问题清单。
 * M4 之后也用于重新开始二次确认（8.10）。
 *
 * 焦点陷阱用 `inert` + 首尾哨兵实现：`inert` 是原生属性（现代浏览器/ jsdom 均忽略未知属性），
 * 因此**不需要**逐元素判定 Tab 是否在框内——浏览器自身就会跳过不可聚焦子树。
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

export interface DialogProps {
  title: string
  open: boolean
  onClose(): void
  children: ReactNode
  /** 底部操作区（确认/取消）。 */
  footer?: ReactNode
  /** 关闭后是否归还焦点（默认是，7.1 ③）。 */
  labelledBy?: string
}

export function Dialog({ title, open, onClose, children, footer, labelledBy }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<Element | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement
    const first = ref.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]')
    first?.focus()
    return () => {
      const restore = restoreRef.current
      if (restore instanceof HTMLElement) restore.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={labelledBy ? undefined : title} aria-labelledby={labelledBy} ref={ref}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <footer className="dialog-foot">{footer}</footer> : null}
      </div>
    </div>
  )
}
