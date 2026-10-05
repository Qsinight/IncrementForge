/**
 * 四类左侧列表（TECH_DESIGN 7.5「条目列表交互规格」、PRD 各工作区的列表要求）。
 *
 * PRD 对四类列表给出**统一结构**：顶部栏左侧列表标题、右侧“添加”按钮；
 * 条目行左侧图标、中间名称、右侧“排序（上移/下移）· 复制 · 删除”三个图标按钮。
 * 因此这里只做一个组件，标题文案与“添加”后的默认字段由调用方给出（7.5 首段）。
 *
 * ## 键盘可达（7.5「键盘可达」行、7.1 全局快捷键表）
 *
 * 列表容器 `tabIndex=0`，处理 `↑/↓`（选中）、`Alt+↑/Alt+↓`（排序）、`Ctrl+D`（复制）、
 * `Delete`（删除）。这四个键与顶部标题栏的快捷键走**同一套 store 动作**（7.1 末条：
 * “快捷键触发的操作与按钮点击走同一条 store 事务，不存在旁路实现”）。
 */
import type { KeyboardEvent } from 'react'
import { useRef } from 'react'

import { t } from '@iforge/i18n'
import type { EntryKind, IconRef } from '@iforge/model'
import { sortByOrder } from '@iforge/model'

import { Icon } from './Icon.js'

export interface EntryListItem {
  id: string
  name: string
  icon: IconRef
  order: number
}

export interface EntryListProps {
  kind: EntryKind
  /** 列表标题（PRD：“资源列表 / 生成器列表 / 升级列表 / 页面列表”）。 */
  title: string
  items: readonly EntryListItem[]
  selectedId: string | null
  onSelect(id: string): void
  onAdd(): void
  onMove(id: string, direction: -1 | 1): void
  onDuplicate(id: string): void
  onDelete(id: string): void
  /** 行内副标题（如资源的工作区里显示“资源 · 已分配页面”）。 */
  describe?(item: EntryListItem): string | undefined
}

export function EntryList(props: EntryListProps) {
  const { kind, title, items, selectedId, onSelect, onAdd, onMove, onDuplicate, onDelete, describe } = props
  const listRef = useRef<HTMLUListElement>(null)
  const ordered = sortByOrder(items)

  const moveSelection = (delta: -1 | 1): void => {
    if (!selectedId) return
    const index = ordered.findIndex((item) => item.id === selectedId)
    const next = ordered[index + delta]
    if (next) onSelect(next.id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (!selectedId) return
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      if (event.altKey) onMove(selectedId, event.key === 'ArrowUp' ? -1 : 1)
      else moveSelection(event.key === 'ArrowUp' ? -1 : 1)
      return
    }
    if (event.key === 'd' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      onDuplicate(selectedId)
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      onDelete(selectedId)
    }
  }

  return (
    <div className="entry-list">
      <div className="entry-list-head">
        <span className="entry-list-title">{title}</span>
        <button type="button" className="btn primary" aria-label={t('list.add')} onClick={onAdd} data-testid={`add-${kind}`}>
          <Icon builtinId="plus" size={14} /> {t('list.add')}
        </button>
      </div>
      {ordered.length === 0 ? (
        <p className="muted pad">{t('list.empty')}</p>
      ) : (
        <ul className="entry-list-items" ref={listRef} tabIndex={0} role="listbox" aria-label={title} onKeyDown={onKeyDown}>
          {ordered.map((item, index) => (
            <li
              key={item.id}
              role="option"
              aria-selected={item.id === selectedId}
              className={item.id === selectedId ? 'entry-row active' : 'entry-row'}
              data-testid={`entry-${item.id}`}
              onClick={() => onSelect(item.id)}
            >
              <span className="entry-row-icon">
                <Icon icon={item.icon} size={16} />
              </span>
              <span className="entry-row-main">
                <span className="entry-row-name">{item.name}</span>
                {describe?.(item) ? <span className="entry-row-desc">{describe(item)}</span> : null}
              </span>
              <span className="entry-row-actions">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`${t('list.row.moveUp')} ${item.name}`}
                  aria-keyshortcuts="Alt+ArrowUp"
                  disabled={index === 0}
                  onClick={(event) => {
                    event.stopPropagation()
                    onMove(item.id, -1)
                  }}
                >
                  <Icon builtinId="sort-up" size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`${t('list.row.moveDown')} ${item.name}`}
                  aria-keyshortcuts="Alt+ArrowDown"
                  disabled={index === ordered.length - 1}
                  onClick={(event) => {
                    event.stopPropagation()
                    onMove(item.id, 1)
                  }}
                >
                  <Icon builtinId="sort-down" size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`${t('list.row.duplicate')} ${item.name}`}
                  aria-keyshortcuts="Control+D"
                  onClick={(event) => {
                    event.stopPropagation()
                    onDuplicate(item.id)
                  }}
                >
                  <Icon builtinId="copy" size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  aria-label={`${t('list.row.delete')} ${item.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onDelete(item.id)
                  }}
                >
                  <Icon builtinId="trash" size={14} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
