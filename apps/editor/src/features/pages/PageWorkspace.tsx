/**
 * 页面工作区（TECH_DESIGN 7.6「页面：`PageList` + `PageForm` + `EntryGridEditor`」、PRD 页面编辑器 1–8）。
 *
 * | PRD 字段 | 落点 |
 * | --- | --- |
 * | 1 图标 / 2 名称 / 3 描述 | 表单顶部三字段 |
 * | 4 是否禁用 / 5 游戏可见 | 开关 + 提示（禁用只让生成器/升级置灰，不可见才隐藏全部条目，8.4） |
 * | 6 页面主题 | `ThemePicker`（`scope="page"`） |
 * | 7 页面布局 | `columns` 数字输入 + 网格实时预览（D-41：实际列数 = min(列数, 断点列数)） |
 * | 8 页面条目 | `EntryGridEditor`：分配/移除/排序/条目主题 |
 *
 * **条目页面唯一性**（PRD 补充 7）：`assignEntryToPage` 对已归属的条目直接报错并指出原页面，
 * 重复分配由 `E_DUPLICATE_PAGE_ENTRY` 在保存时二次兜底（6.4）。
 */
import { t } from '@iforge/i18n'
import { sortByOrder } from '@iforge/model'
import type { PageDef, ProjectFile } from '@iforge/model'

import { EntryList } from '../../components/EntryList.js'
import { Icon } from '../../components/Icon.js'
import { IconPicker } from '../../components/IconPicker.js'
import { ThemePicker } from '../../components/ThemePicker.js'
import { NumberField, TextAreaField, TextField, ToggleField } from '../../components/fields.js'
import { addEntry, assignEntryToPage, duplicateEntry, moveEntry, movePageEntry, removePageEntry } from '../../stores/entries.js'
import { commitPageField } from '../../stores/form.js'
import { requestDeleteFor } from '../shell/deleteFlow.js'

/** 条目类型（供条目网格展示 icon 与跳转）。 */
function entryOf(project: ProjectFile, id: string) {
  return (
    project.resources.find((item) => item.id === id) ??
    project.generators.find((item) => item.id === id) ??
    project.upgrades.find((item) => item.id === id)
  )
}

/** 页面表单（PRD 页面编辑器 1–8）。 */
export function PageForm({ page, project }: { page: PageDef; project: ProjectFile }) {
  const id = page.id
  const commit = (label: string, recipe: Parameters<typeof commitPageField>[2], mergeKey?: string): void =>
    commitPageField(id, label, recipe, mergeKey)

  const entries = sortByOrder(page.entries)
  const unassigned = [
    ...project.resources.map((item) => ({ id: item.id, name: item.name, kind: 'resource' as const })),
    ...project.generators.map((item) => ({ id: item.id, name: item.name, kind: 'generator' as const })),
    ...project.upgrades.map((item) => ({ id: item.id, name: item.name, kind: 'upgrade' as const })),
  ].filter((item) => !entries.some((entry) => entry.id === item.id))
  const assignedElsewhere = (entryId: string): string | undefined =>
    project.pages.find((other) => other.id !== id && other.entries.some((entry) => entry.id === entryId))?.name

  return (
    <div className="form" data-testid="page-form">
      <IconPicker value={page.icon} onChange={(icon) => commit('page-icon', (d) => void (d.icon = icon))} groups={['page', 'system']} />
      <TextField label={t('field.name')} value={page.name} onChange={(name) => commit('page-name', (d) => void (d.name = name), `${id}.name`)} />
      <TextAreaField
        label={t('field.description')}
        value={page.description}
        onChange={(description) => commit('page-desc', (d) => void (d.description = description), `${id}.description`)}
      />
      <ToggleField
        label={t('field.visible')}
        value={page.visible}
        hint={t('page.visibleHint')}
        onChange={(visible) => commit('page-visible', (d) => void (d.visible = visible))}
      />
      <ToggleField
        label={t('field.disabled')}
        value={page.disabled}
        hint={t('page.disabledHint')}
        onChange={(disabled) => commit('page-disabled', (d) => void (d.disabled = disabled))}
      />
      <ThemePicker
        label={t('field.theme')}
        scope="page"
        value={page.theme}
        onChange={(theme) => commit('page-theme', (d) => void (d.theme = theme ?? { kind: 'builtin', value: 'page-dark' }))}
      />
      <NumberField
        label={t('field.columns')}
        value={page.columns}
        min={1}
        step={1}
        hint={t('page.columnsHint')}
        onChange={(columns) => commit('page-columns', (d) => void (d.columns = Math.max(1, Math.round(columns))))}
      />

      <section className="form-section">
        <h3>{t('field.entries')}</h3>
        <p className="muted">{t('page.assignHint')}</p>
        {entries.length === 0 ? (
          <p className="muted">{t('page.empty')}</p>
        ) : (
          <div className="entry-grid-preview" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(page.columns, 3))}, 1fr)` }}>
            {entries.map((entry, index) => {
              const def = entryOf(project, entry.id)
              return (
                <div className="entry-grid-cell" key={entry.id}>
                  <Icon icon={def?.icon} size={16} />
                  <span className="entry-grid-name">{def?.name ?? entry.id}</span>
                  <span className="entry-grid-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`${t('common.moveUp')} ${def?.name ?? entry.id}`}
                      disabled={index === 0}
                      onClick={() => movePageEntry(id, entry.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`${t('common.moveDown')} ${def?.name ?? entry.id}`}
                      disabled={index === entries.length - 1}
                      onClick={() => movePageEntry(id, entry.id, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label={`${t('common.remove')} ${def?.name ?? entry.id}`}
                      onClick={() => removePageEntry(id, entry.id)}
                    >
                      ✕
                    </button>
                  </span>
                  <ThemePicker
                    label={t('page.entryTheme')}
                    scope="entry"
                    allowFollow
                    followLabel={t('page.entryThemeFollow')}
                    value={entry.theme}
                    onChange={(theme) =>
                      commit('page-entry-theme', (d) => {
                        const target = d.entries.find((item) => item.id === entry.id)
                        if (!target) return
                        // “跟随页面主题”就是**不写** `theme`（6.2 的可选字段，PRD 页面编辑器 8）。
                        // 写成某个具体主题会把跟随态固化成显式值，之后页面换主题卡片再也不跟着变。
                        if (theme === undefined) delete target.theme
                        else target.theme = theme
                      })
                    }
                  />
                </div>
              )
            })}
          </div>
        )}

        <h4 className="sub">{t('page.unassigned')}</h4>
        <ul className="assign-list">
          {unassigned.length === 0 ? <li className="muted">{t('list.empty')}</li> : null}
          {unassigned.map((item) => {
            const owner = assignedElsewhere(item.id)
            return (
              <li key={item.id}>
                <span className="assign-name">{item.name}</span>
                <span className="muted small">{owner ? `→ ${owner}` : item.id}</span>
                <button
                  type="button"
                  className="btn"
                  data-testid={`assign-${item.id}`}
                  onClick={() => {
                    const result = assignEntryToPage(id, item.id)
                    if (!result.ok) {
                      // PRD 补充 7：已归属别的页面时明确指出，不自动搬家。
                      window.alert(t('page.duplicateEntry', { id: item.id, page: result.message ?? '' }))
                    }
                  }}
                >
                  {t('page.assign')}
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}

/** 页面工作区（7.6）。 */
export function PageWorkspace(props: { project: ProjectFile; selectedId: string | null; onSelect(id: string): void }) {
  const { project, selectedId, onSelect } = props
  const selected = project.pages.find((item) => item.id === selectedId) ?? null
  return (
    <div className="workspace">
      <EntryList
        kind="page"
        title={t('list.pages')}
        items={project.pages}
        selectedId={selectedId}
        onSelect={onSelect}
        onAdd={() => addEntry('page')}
        onMove={(id, direction) => moveEntry('page', id, direction)}
        onDuplicate={(id) => duplicateEntry('page', id)}
        onDelete={(id) => requestDeleteFor('page', id)}
      />
      <div className="workspace-form">
        {selected ? <PageForm page={selected} project={project} /> : <p className="muted pad">{t('list.empty')}</p>}
      </div>
    </div>
  )
}

/** 供设置页复用：把条目分配到第一个页面（示例项目用）。 */
export function assignToFirstPage(project: ProjectFile, entryId: string): void {
  const first = project.pages[0]
  if (first) assignEntryToPage(first.id, entryId)
}
